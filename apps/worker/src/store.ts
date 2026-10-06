import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { incidentDate, type Incident } from "@crime-radar/shared";
import { similarity, ruleVersion } from "../../api/src/ingestion/processor";
import type {
  IngestionStore,
  Processed,
  RawItem,
  RunResult,
  SourceDefinition,
} from "../../api/src/ingestion/types";
export class D1IngestionStore implements IngestionStore {
  constructor(readonly db: D1Database) {}
  private sql(sql: string, ...values: unknown[]) {
    return this.db.prepare(sql).bind(...values);
  }
  async stage(items: RawItem[], sourceId = items[0]?.sourceId) {
    if (
      !sourceId ||
      items.length > 30 ||
      items.some((item) => item.sourceId !== sourceId)
    )
      throw new Error("Unexpected source page size");
    if (items.length) {
      const old = await this.sql(
        `SELECT external_id,content_hash,rules,status,published_at,canonical_url FROM raw_source_items WHERE source_id=? AND external_id IN (${items.map(() => "?").join(",")})`,
        items[0].sourceId,
        ...items.map((item) => item.externalId),
      ).all<{
        external_id: string;
        content_hash: string;
        rules: string;
        status: string;
        published_at: string | null;
        canonical_url: string | null;
      }>();
      const previous = new Map(
        old.results.map((row) => [row.external_id, row]),
      );
      const changed = items.filter((item) => {
        const row = previous.get(item.externalId);
        return (
          !row ||
          row.content_hash !== item.contentHash ||
          row.rules !== ruleVersion ||
          row.published_at !== item.publishedAt ||
          row.canonical_url !== (item.canonicalUrl ?? null)
        );
      });
      // Multi-row statements keep each run below D1 Free's per-request query limit.
      for (let start = 0; start < changed.length; start += 6) {
        const chunk = changed.slice(start, start + 6);
        const original = this.sql(
          `INSERT INTO raw_source_items(id,source_id,external_id,source_url,title,content,published_at,retrieved_at,content_hash,rules,canonical_url,status)
        VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,'collected')").join(",")}
        ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,content=excluded.content,published_at=excluded.published_at,retrieved_at=excluded.retrieved_at,content_hash=excluded.content_hash,rules=excluded.rules,canonical_url=excluded.canonical_url,status='collected',reason=NULL,attempts=0`,
          ...chunk.flatMap((item) => [
            crypto.randomUUID(),
            item.sourceId,
            item.externalId,
            item.sourceUrl,
            item.title,
            item.content,
            item.publishedAt,
            item.retrievedAt,
            item.contentHash,
            ruleVersion,
            item.canonicalUrl ?? null,
          ]),
        );
        const version = this.sql(
          `INSERT OR IGNORE INTO raw_source_item_versions(raw_id,content_hash,title,content,published_at,retrieved_at)
        SELECT id,content_hash,title,content,published_at,retrieved_at FROM raw_source_items WHERE source_id=? AND external_id IN (${chunk.map(() => "?").join(",")})`,
          items[0].sourceId,
          ...chunk.map((item) => item.externalId),
        );
        await this.db.batch([original, version]);
      }
      await this.sql(
        `UPDATE raw_source_items SET retrieved_at=? WHERE source_id=? AND external_id IN (${items.map(() => "?").join(",")})`,
        items[0].retrievedAt,
        items[0].sourceId,
        ...items.map((item) => item.externalId),
      ).run();
    }
    const queue = await this.sql(
      "SELECT * FROM raw_source_items WHERE source_id=? AND (status='collected' OR (status='failed' AND attempts<3) OR (rules<>? AND content NOT IN ('[expired]','[withdrawn]'))) ORDER BY CASE WHEN rules<>? THEN 0 ELSE 1 END,retrieved_at,external_id LIMIT 3",
      sourceId,
      ruleVersion,
      ruleVersion,
    ).all<{
      source_id: string;
      external_id: string;
      source_url: string;
      title: string;
      content: string;
      published_at: string | null;
      retrieved_at: string;
      content_hash: string;
      canonical_url: string | null;
    }>();
    return queue.results.map((row) => ({
      sourceId: row.source_id,
      externalId: row.external_id,
      sourceUrl: row.source_url,
      title: row.title,
      content: row.content,
      publishedAt: row.published_at,
      retrievedAt: row.retrieved_at,
      contentHash: row.content_hash,
      canonicalUrl: row.canonical_url ?? undefined,
    }));
  }
  async begin(source: SourceDefinition) {
    await this.sql(
      "INSERT INTO sources(id,name,url,metadata) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,name=excluded.name,url=excluded.url",
      source.id,
      source.name,
      source.url,
      JSON.stringify({
        verificationUrl: source.verificationUrl,
        rules: ruleVersion,
        rawRetentionDays: 90,
        kind: source.kind ?? "official",
      }),
    ).run();
    const lease = await this.sql(
      "UPDATE sources SET lease_until=?,last_attempt_at=? WHERE id=? AND lease_until<?",
      Date.now() + 600000,
      new Date().toISOString(),
      source.id,
      Date.now(),
    ).run();
    if (!lease.meta.changes) return null;
    const id = crypto.randomUUID();
    await this.sql(
      "INSERT INTO ingestion_runs(id,source_id,status,started_at) VALUES(?,?,'running',?)",
      id,
      source.id,
      new Date().toISOString(),
    ).run();
    return id;
  }
  async saveRaw(item: RawItem) {
    const old = await this.sql(
      "SELECT id,content_hash,rules,status,published_at,canonical_url FROM raw_source_items WHERE source_id=? AND external_id=?",
      item.sourceId,
      item.externalId,
    ).first<{
      id: string;
      content_hash: string;
      rules: string;
      status: string;
      published_at: string | null;
      canonical_url: string | null;
    }>();
    if (
      old &&
      old.content_hash === item.contentHash &&
      old.rules === ruleVersion &&
      old.published_at === item.publishedAt &&
      old.canonical_url === (item.canonicalUrl ?? null)
    ) {
      if (old.status === "collected" || old.status === "failed")
        return { id: old.id, changed: true };
      await this.sql(
        "UPDATE raw_source_items SET retrieved_at=? WHERE id=?",
        item.retrievedAt,
        old.id,
      ).run();
      return { id: old.id, changed: false };
    }
    const id = old?.id ?? crypto.randomUUID();
    await this.db.batch([
      this.sql(
        `INSERT INTO raw_source_items(id,source_id,external_id,source_url,title,content,published_at,retrieved_at,content_hash,rules,canonical_url,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'collected') ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,published_at=excluded.published_at,retrieved_at=excluded.retrieved_at,content_hash=excluded.content_hash,rules=excluded.rules,canonical_url=excluded.canonical_url,status='collected',reason=NULL`,
        id,
        item.sourceId,
        item.externalId,
        item.sourceUrl,
        item.title,
        item.content,
        item.publishedAt,
        item.retrievedAt,
        item.contentHash,
        ruleVersion,
        item.canonicalUrl ?? null,
      ),
      this.sql(
        "INSERT INTO raw_source_item_versions(raw_id,content_hash,title,content,published_at,retrieved_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        id,
        item.contentHash,
        item.title,
        item.content,
        item.publishedAt,
        item.retrievedAt,
      ),
    ]);
    return { id, changed: true };
  }
  async record(id: string, result: Processed, raw: RawItem) {
    let status: "published" | "duplicate" | "review" | "rejected" =
      result.status;
    let reason = result.status === "published" ? null : result.reason;
    const batch: D1PreparedStatement[] = [];
    if (result.status !== "published") {
      batch.push(
        this.sql(
          "UPDATE incidents SET is_published=0 WHERE id IN (SELECT incident_id FROM incident_sources WHERE raw_id=?)",
          id,
        ),
      );
    } else {
      const incident = result.incident;
      const existing = await this.sql(
        "SELECT id,public_data FROM incidents WHERE canonical_key=? OR fingerprint=? LIMIT 1",
        result.canonicalKey,
        result.fingerprint,
      ).first<{ id: string; public_data: string }>();
      const candidates =
        raw.sourceId === "court-decisions"
          ? { results: [] }
          : await this.sql(
              `SELECT r.title FROM incidents i JOIN incident_sources s ON s.incident_id=i.id JOIN raw_source_items r ON r.id=s.raw_id
        WHERE i.category=? AND i.city=? AND i.effective_date BETWEEN ? AND ? AND i.id<>? LIMIT 30`,
              incident.category,
              incident.location.city,
              Date.parse(raw.publishedAt!) - 7 * 86400000,
              Date.parse(raw.publishedAt!) + 7 * 86400000,
              incident.id,
            ).all<{ title: string }>();
      if (
        !existing &&
        candidates.results.some(
          (candidate) => similarity(raw.title, candidate.title) >= 0.7,
        )
      ) {
        status = "review";
        reason = "possible-duplicate";
        batch.push(
          this.sql(
            "UPDATE incidents SET is_published=0 WHERE id IN (SELECT incident_id FROM incident_sources WHERE raw_id=?)",
            id,
          ),
        );
      } else {
        if (existing) {
          const old = JSON.parse(existing.public_data) as Incident;
          incident.id = existing.id;
          incident.sources = [
            ...old.sources.filter((source) => source.url !== raw.sourceUrl),
            ...incident.sources,
          ];
          if (old.sources.every((source) => source.url !== raw.sourceUrl))
            status = "duplicate";
        }
        const search = [
          incident.title.uk,
          incident.title.en,
          incident.description?.uk,
          incident.description?.en,
          ...incident.keywords,
          incident.legalQualification?.article,
        ]
          .join(" ")
          .toLocaleLowerCase("uk");
        batch.push(
          this.sql(
            "UPDATE incidents SET is_published=0 WHERE id IN (SELECT incident_id FROM incident_sources WHERE raw_id=?) AND id<>?",
            id,
            incident.id,
          ),
        );
        batch.push(
          this.sql(
            `INSERT INTO incidents(id,category,latitude,longitude,effective_date,published_at,city,public_data,search_text,canonical_key,fingerprint,is_published)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET category=excluded.category,latitude=excluded.latitude,longitude=excluded.longitude,effective_date=excluded.effective_date,published_at=excluded.published_at,city=excluded.city,public_data=excluded.public_data,search_text=excluded.search_text,fingerprint=excluded.fingerprint,is_published=1`,
            incident.id,
            incident.category,
            incident.location.latitude,
            incident.location.longitude,
            Date.parse(incidentDate(incident)!),
            incident.publishedAt,
            incident.location.city,
            JSON.stringify(incident),
            search,
            result.canonicalKey,
            result.fingerprint,
          ),
        );
        batch.push(
          this.sql(
            "INSERT INTO incident_sources(incident_id,raw_id,source_url) VALUES(?,?,?) ON CONFLICT(incident_id,source_url) DO UPDATE SET raw_id=excluded.raw_id",
            incident.id,
            id,
            raw.sourceUrl,
          ),
        );
        batch.push(
          this.sql(
            "INSERT INTO geocoding_cache(place_key,provider,result,updated_at) VALUES(?,'city-gazetteer-v1',?,?) ON CONFLICT(place_key) DO UPDATE SET result=excluded.result,updated_at=excluded.updated_at",
            incident.location.city,
            JSON.stringify(incident.location),
            new Date().toISOString(),
          ),
        );
      }
    }
    batch.push(
      this.sql(
        "UPDATE raw_source_items SET status=?,reason=? WHERE id=?",
        status,
        reason,
        id,
      ),
    );
    batch.push(
      this.sql(
        "INSERT INTO processing_jobs(id,raw_id,stage,status,reason,created_at) VALUES(?,?,'normalize-and-publish',?,?,?)",
        crypto.randomUUID(),
        id,
        status,
        reason,
        new Date().toISOString(),
      ),
    );
    await this.db.batch(batch);
    return status;
  }
  async failItem(id: string, reason: string) {
    await this.db.batch([
      this.sql(
        "UPDATE raw_source_items SET status='failed',reason=?,attempts=attempts+1 WHERE id=?",
        reason,
        id,
      ),
      this.sql(
        "UPDATE incidents SET is_published=0 WHERE id IN (SELECT incident_id FROM incident_sources WHERE raw_id=?)",
        id,
      ),
    ]);
  }
  async finish(
    runId: string,
    source: SourceDefinition,
    result: RunResult,
    error?: string,
  ) {
    const now = new Date().toISOString(),
      cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    await this.db.batch([
      this.sql(
        "UPDATE ingestion_runs SET status=?,finished_at=?,counts=?,error=? WHERE id=?",
        error ? "failed" : "complete",
        now,
        JSON.stringify(result),
        error ?? null,
        runId,
      ),
      this.sql(
        `UPDATE sources SET lease_until=0,${error ? "last_failure_at" : "last_success_at"}=?,last_error=?,next_attempt_at=? + ${error ? "MIN(21600000,3600000*(1 << MIN(consecutive_failures,3)))" : "3600000"},consecutive_failures=${error ? "consecutive_failures+1" : "0"} WHERE id=?`,
        now,
        error ?? null,
        Date.now(),
        source.id,
      ),
      this.sql(
        "DELETE FROM raw_source_item_versions WHERE retrieved_at<?",
        cutoff,
      ),
      this.sql(
        "UPDATE raw_source_items SET content='[expired]',title='[expired]',rules='expired' WHERE retrieved_at<? AND content<>'[expired]'",
        cutoff,
      ),
      this.sql("DELETE FROM processing_jobs WHERE created_at<?", cutoff),
      this.sql("DELETE FROM ingestion_runs WHERE finished_at<?", cutoff),
    ]);
  }
}
