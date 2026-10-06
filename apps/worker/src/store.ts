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

export type RunKind = "poll" | "process" | "backfill";
export function sourceCadence(source: SourceDefinition) {
  return Math.max(1, Math.min(1440, source.cadenceMinutes ?? 60)) * 60000;
}
function rawMetadata(item: RawItem) {
  return JSON.stringify({
    ...(item.isRepost !== undefined ? { isRepost: item.isRepost } : {}),
    ...(item.originalPublishedAt
      ? { originalPublishedAt: item.originalPublishedAt }
      : {}),
  });
}
function timestamp(value?: string | null) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
interface StoredRaw {
  id: string;
  external_id: string;
  content_hash: string;
  rules: string;
  status: string;
  published_at: string | null;
  canonical_url: string | null;
  title: string;
  metadata: string;
}

export class D1IngestionStore implements IngestionStore {
  readonly runKind: RunKind;
  readonly clock: () => number;
  constructor(
    readonly db: D1Database,
    options: { runKind?: RunKind; now?: () => number } = {},
  ) {
    this.runKind = options.runKind ?? "poll";
    this.clock = options.now ?? Date.now;
  }
  private sql(sql: string, ...values: unknown[]) {
    return this.db.prepare(sql).bind(...values);
  }
  private changed(item: RawItem, row?: StoredRaw) {
    return (
      !row ||
      row.content_hash !== item.contentHash ||
      row.rules !== ruleVersion ||
      row.published_at !== item.publishedAt ||
      row.canonical_url !== (item.canonicalUrl ?? null) ||
      row.title !== item.title ||
      row.metadata !== rawMetadata(item)
    );
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
        `SELECT id,external_id,content_hash,rules,status,published_at,canonical_url,title,metadata FROM raw_source_items WHERE source_id=? AND external_id IN (${items.map(() => "?").join(",")})`,
        sourceId,
        ...items.map((item) => item.externalId),
      ).all<StoredRaw>();
      const previous = new Map(
        old.results.map((row) => [row.external_id, row]),
      );
      const changed = items.filter((item) =>
        this.changed(item, previous.get(item.externalId)),
      );
      // 6 rows / 78 bindings per statement and at most 3 processed items keep
      // a scheduled poll (including selection) within D1 Free's 50-query limit.
      for (let start = 0; start < changed.length; start += 6) {
        const chunk = changed.slice(start, start + 6);
        await this.db.batch([
          this.sql(
            `INSERT INTO raw_source_items(id,source_id,external_id,source_url,title,content,published_at,retrieved_at,content_hash,rules,canonical_url,first_seen_at,metadata,status)
            VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,'collected')").join(",")}
            ON CONFLICT(source_id,external_id) DO UPDATE SET source_url=excluded.source_url,title=excluded.title,content=excluded.content,published_at=excluded.published_at,retrieved_at=excluded.retrieved_at,content_hash=excluded.content_hash,rules=excluded.rules,canonical_url=excluded.canonical_url,metadata=excluded.metadata,status='collected',reason=NULL,attempts=0`,
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
              item.retrievedAt,
              rawMetadata(item),
            ]),
          ),
          this.sql(
            `INSERT OR IGNORE INTO raw_source_item_versions(raw_id,content_hash,version_key,title,content,published_at,retrieved_at,metadata)
            SELECT id,content_hash,content_hash || char(31) || COALESCE(published_at,'') || char(31) || title || char(31) || metadata,title,content,published_at,retrieved_at,metadata
            FROM raw_source_items WHERE source_id=? AND external_id IN (${chunk.map(() => "?").join(",")})`,
            sourceId,
            ...chunk.map((item) => item.externalId),
          ),
        ]);
      }
      await this.sql(
        `UPDATE raw_source_items SET retrieved_at=? WHERE source_id=? AND external_id IN (${items.map(() => "?").join(",")})`,
        items[0].retrievedAt,
        sourceId,
        ...items.map((item) => item.externalId),
      ).run();
    }
    const queue = await this.sql(
      "SELECT * FROM raw_source_items WHERE source_id=? AND (status='collected' OR (status='failed' AND attempts<3) OR (rules<>? AND content NOT IN ('[expired]','[withdrawn]'))) ORDER BY CASE WHEN rules<>? THEN 0 ELSE 1 END,first_seen_at,external_id LIMIT 3",
      sourceId,
      ruleVersion,
      ruleVersion,
    ).all<
      StoredRaw & {
        source_id: string;
        source_url: string;
        content: string;
        retrieved_at: string;
      }
    >();
    return queue.results.map((row): RawItem => ({
      sourceId: row.source_id,
      externalId: row.external_id,
      sourceUrl: row.source_url,
      title: row.title,
      content: row.content,
      publishedAt: row.published_at,
      retrievedAt: row.retrieved_at,
      contentHash: row.content_hash,
      canonicalUrl: row.canonical_url ?? undefined,
      ...JSON.parse(row.metadata),
    }));
  }
  async begin(source: SourceDefinition) {
    const now = this.clock(),
      iso = new Date(now).toISOString();
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
        cadenceMinutes: source.cadenceMinutes ?? 60,
      }),
    ).run();
    const lease = await this.sql(
      `UPDATE sources SET lease_until=?${this.runKind === "poll" ? ",last_attempt_at=?" : ""} WHERE id=? AND lease_until<?`,
      now + 600000,
      ...(this.runKind === "poll" ? [iso] : []),
      source.id,
      now,
    ).run();
    if (!lease.meta.changes) return null;
    const id = crypto.randomUUID();
    await this.sql(
      "INSERT INTO ingestion_runs(id,source_id,status,started_at,run_kind) VALUES(?,?,'running',?,?)",
      id,
      source.id,
      iso,
      this.runKind,
    ).run();
    return id;
  }
  async saveRaw(item: RawItem) {
    const old = await this.sql(
      "SELECT id,external_id,content_hash,rules,status,published_at,canonical_url,title,metadata FROM raw_source_items WHERE source_id=? AND external_id=?",
      item.sourceId,
      item.externalId,
    ).first<StoredRaw>();
    if (old && !this.changed(item, old)) {
      if (old.status === "collected" || old.status === "failed")
        return { id: old.id, changed: true };
      return { id: old.id, changed: false };
    }
    const id = old?.id ?? crypto.randomUUID(),
      metadata = rawMetadata(item);
    await this.db.batch([
      this.sql(
        `INSERT INTO raw_source_items(id,source_id,external_id,source_url,title,content,published_at,retrieved_at,content_hash,rules,canonical_url,first_seen_at,metadata,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'collected') ON CONFLICT(id) DO UPDATE SET source_url=excluded.source_url,title=excluded.title,content=excluded.content,published_at=excluded.published_at,retrieved_at=excluded.retrieved_at,content_hash=excluded.content_hash,rules=excluded.rules,canonical_url=excluded.canonical_url,metadata=excluded.metadata,status='collected',reason=NULL,attempts=0`,
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
        item.retrievedAt,
        metadata,
      ),
      this.sql(
        "INSERT OR IGNORE INTO raw_source_item_versions(raw_id,content_hash,version_key,title,content,published_at,retrieved_at,metadata) VALUES(?,?,?,?,?,?,?,?)",
        id,
        item.contentHash,
        [item.contentHash, item.publishedAt ?? "", item.title, metadata].join(
          "\x1f",
        ),
        item.title,
        item.content,
        item.publishedAt,
        item.retrievedAt,
        metadata,
      ),
    ]);
    return { id, changed: true };
  }
  /** Only a confirmed changed original or registry withdrawal removes support.
   * A fetch/processing failure and leaving a recent feed never call this path. */
  private retract(rawSelector: string, values: unknown[], except?: string) {
    const restriction = except ? " AND incident_id<>?" : "";
    const bindings = [...values, ...(except ? [except] : [])];
    return [
      this.sql(
        `UPDATE incident_sources SET active=0 WHERE raw_id IN (${rawSelector})${restriction}`,
        ...bindings,
      ),
      this.sql(
        `WITH remaining AS (
          SELECT i.id,(SELECT json_object('date',support.event_date,'data',json(support.event_data)) FROM incident_sources support WHERE support.incident_id=i.id AND support.active=1 AND support.event_date IS NOT NULL AND support.event_data IS NOT NULL ORDER BY support.source_url LIMIT 1) AS proof,
          (SELECT json_object('date',support.publication_date,'text',support.published_at) FROM incident_sources support WHERE support.incident_id=i.id AND support.active=1 AND support.publication_date IS NOT NULL ORDER BY support.publication_date DESC,support.source_url LIMIT 1) AS publication
          FROM incidents i WHERE i.id IN (SELECT incident_id FROM incident_sources WHERE raw_id IN (${rawSelector})${restriction})
        ) UPDATE incidents SET is_published=CASE WHEN EXISTS(SELECT 1 FROM incident_sources support WHERE support.incident_id=incidents.id AND support.active=1) THEN 1 ELSE 0 END,
        event_date=json_extract((SELECT proof FROM remaining WHERE id=incidents.id),'$.date'),
        publication_date=json_extract((SELECT publication FROM remaining WHERE id=incidents.id),'$.date'),
        published_at=COALESCE(json_extract((SELECT publication FROM remaining WHERE id=incidents.id),'$.text'),published_at),
        effective_date=COALESCE(json_extract((SELECT proof FROM remaining WHERE id=incidents.id),'$.date'),json_extract((SELECT publication FROM remaining WHERE id=incidents.id),'$.date'),effective_date),
        public_data=json_set(json_patch(json_remove(public_data,'$.occurredAt','$.occurredOn','$.eventDateEvidence'),COALESCE(json_extract((SELECT proof FROM remaining WHERE id=incidents.id),'$.data'),'{}')),
          '$.occurredAt',json_extract((SELECT proof FROM remaining WHERE id=incidents.id),'$.data.occurredAt'),
          '$.publishedAt',COALESCE(json_extract((SELECT publication FROM remaining WHERE id=incidents.id),'$.text'),json_extract(public_data,'$.publishedAt')),
          '$.reportedAt',COALESCE(json_extract((SELECT publication FROM remaining WHERE id=incidents.id),'$.text'),json_extract(public_data,'$.reportedAt')),
          '$.sources',json(COALESCE((SELECT json_group_array(json(j.value)) FROM json_each(incidents.public_data,'$.sources') j WHERE EXISTS(SELECT 1 FROM incident_sources support WHERE support.incident_id=incidents.id AND support.active=1 AND support.source_url=json_extract(j.value,'$.url'))),'[]')))
        WHERE id IN (SELECT id FROM remaining)`,
        ...bindings,
      ),
    ];
  }
  async withdraw(sourceId: string, externalIds: string[]) {
    if (!externalIds.length) return;
    if (externalIds.length > 100)
      throw new Error("Unexpected withdrawal batch size");
    // Include the source binding in D1's 100-bound-parameter limit.
    for (let start = 0; start < externalIds.length; start += 99) {
      const chunk = externalIds.slice(start, start + 99);
      const selector = `SELECT id FROM raw_source_items WHERE source_id=? AND external_id IN (${chunk.map(() => "?").join(",")})`;
      const values = [sourceId, ...chunk];
      await this.db.batch([
        ...this.retract(selector, values),
        this.sql(
          `UPDATE raw_source_items SET status='rejected',reason='withdrawn-from-registry',content='[withdrawn]',title='[withdrawn]',metadata='{}' WHERE id IN (${selector})`,
          ...values,
        ),
        this.sql(
          `DELETE FROM raw_source_item_versions WHERE raw_id IN (${selector})`,
          ...values,
        ),
      ]);
    }
  }
  async record(id: string, result: Processed, raw: RawItem) {
    let status: "published" | "duplicate" | "review" | "rejected" =
      result.status;
    let reason = result.status === "published" ? null : result.reason;
    const batch: D1PreparedStatement[] = [];
    if (result.status !== "published") {
      batch.push(...this.retract("SELECT ?", [id]));
    } else {
      const incident = result.incident;
      let eventDate = timestamp(incidentDate(incident, "event"));
      const ownEventDate = eventDate;
      const ownEventData =
        eventDate === null
          ? null
          : JSON.stringify({
              occurredAt: incident.occurredAt,
              occurredOn: incident.occurredOn,
              eventDateEvidence: incident.eventDateEvidence,
            });
      let publicationDate = timestamp(incident.publishedAt);
      const ownPublicationDate = publicationDate,
        ownPublishedAt = incident.publishedAt;
      const day =
        eventDate === null ? null : Math.floor(eventDate / 86400000) * 86400000;
      const dateClause =
        eventDate === null
          ? "event_date IS NULL AND publication_date BETWEEN ? AND ?"
          : "event_date BETWEEN ? AND ?";
      const dateValues =
        eventDate === null
          ? [
              (publicationDate ?? 0) - 7 * 86400000,
              (publicationDate ?? 0) + 7 * 86400000,
            ]
          : [day!, day! + 86400000 - 1];
      const existing = await this.sql(
        `SELECT id,public_data,canonical_key,is_published,(SELECT support.event_data FROM incident_sources support WHERE support.incident_id=incidents.id AND support.active=1 AND support.raw_id<>? AND support.event_date IS NOT NULL AND support.event_data IS NOT NULL ORDER BY support.source_url LIMIT 1) AS support_event_data,
        (SELECT support.published_at FROM incident_sources support WHERE support.incident_id=incidents.id AND support.active=1 AND support.raw_id<>? AND support.publication_date IS NOT NULL ORDER BY support.publication_date DESC,support.source_url LIMIT 1) AS support_published_at
        FROM incidents WHERE id=? OR canonical_key=? OR (fingerprint=? AND ${dateClause}) ORDER BY (id=? OR canonical_key=?) DESC LIMIT 1`,
        id,
        id,
        incident.id,
        result.canonicalKey,
        result.fingerprint,
        ...dateValues,
        incident.id,
        result.canonicalKey,
      ).first<{
        id: string;
        public_data: string;
        canonical_key: string;
        is_published: number;
        support_event_data: string | null;
        support_published_at: string | null;
      }>();
      const candidates =
        existing || raw.sourceId === "court-decisions"
          ? { results: [] }
          : await this.sql(
              `SELECT r.title FROM incidents i JOIN incident_sources s ON s.incident_id=i.id JOIN raw_source_items r ON r.id=s.raw_id
        WHERE i.is_published=1 AND s.active=1 AND i.category=? AND i.city=? AND ${dateClause.split("event_date").join("i.event_date").split("publication_date").join("i.publication_date")} AND i.id<>? LIMIT 30`,
              incident.category,
              incident.location.city,
              ...dateValues,
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
        batch.push(...this.retract("SELECT ?", [id]));
      } else {
        let canonicalKey = result.canonicalKey;
        if (existing) {
          const old = JSON.parse(existing.public_data) as Incident;
          const supportedPublication = timestamp(existing.support_published_at);
          if (
            supportedPublication !== null &&
            supportedPublication > (publicationDate ?? 0)
          ) {
            publicationDate = supportedPublication;
            incident.publishedAt = existing.support_published_at!;
            incident.reportedAt = existing.support_published_at!;
          }
          if (eventDate === null && existing.support_event_data) {
            const proof = JSON.parse(existing.support_event_data) as Pick<
              Incident,
              "occurredAt" | "occurredOn" | "eventDateEvidence"
            >;
            incident.occurredAt = proof.occurredAt ?? null;
            incident.occurredOn = proof.occurredOn ?? undefined;
            incident.eventDateEvidence = proof.eventDateEvidence ?? undefined;
            eventDate = timestamp(incidentDate(incident, "event"));
          }
          if (
            existing.id !== incident.id &&
            existing.canonical_key !== result.canonicalKey &&
            old.sources.every((source) => source.url !== raw.sourceUrl)
          )
            canonicalKey = existing.canonical_key;
          incident.id = existing.id;
          incident.sources = [
            ...old.sources.filter((source) => source.url !== raw.sourceUrl),
            ...incident.sources,
          ];
          if (
            existing.is_published &&
            old.sources.every((source) => source.url !== raw.sourceUrl)
          )
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
        batch.push(...this.retract("SELECT ?", [id], incident.id));
        batch.push(
          this.sql(
            `INSERT INTO incidents(id,category,latitude,longitude,effective_date,event_date,publication_date,published_at,city,public_data,search_text,canonical_key,fingerprint,is_published)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET category=excluded.category,latitude=excluded.latitude,longitude=excluded.longitude,effective_date=excluded.effective_date,event_date=excluded.event_date,publication_date=excluded.publication_date,published_at=excluded.published_at,city=excluded.city,public_data=excluded.public_data,search_text=excluded.search_text,canonical_key=excluded.canonical_key,fingerprint=excluded.fingerprint,is_published=1`,
            incident.id,
            incident.category,
            incident.location.latitude,
            incident.location.longitude,
            Date.parse(incidentDate(incident)!),
            eventDate,
            publicationDate,
            incident.publishedAt,
            incident.location.city,
            JSON.stringify(incident),
            search,
            canonicalKey,
            result.fingerprint,
          ),
          this.sql(
            "INSERT INTO incident_sources(incident_id,raw_id,source_url,active,event_date,event_data,publication_date,published_at) VALUES(?,?,?,1,?,?,?,?) ON CONFLICT(incident_id,source_url) DO UPDATE SET raw_id=excluded.raw_id,active=1,event_date=excluded.event_date,event_data=excluded.event_data,publication_date=excluded.publication_date,published_at=excluded.published_at",
            incident.id,
            id,
            raw.sourceUrl,
            ownEventDate,
            ownEventData,
            ownPublicationDate,
            ownPublishedAt ?? null,
          ),
          this.sql(
            "INSERT INTO geocoding_cache(place_key,provider,result,updated_at) VALUES(?,'city-gazetteer-v1',?,?) ON CONFLICT(place_key) DO UPDATE SET result=excluded.result,updated_at=excluded.updated_at",
            incident.location.city,
            JSON.stringify(incident.location),
            new Date(this.clock()).toISOString(),
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
      this.sql(
        "INSERT INTO processing_jobs(id,raw_id,stage,status,reason,created_at) VALUES(?,?,'normalize-and-publish',?,?,?)",
        crypto.randomUUID(),
        id,
        status,
        reason,
        new Date(this.clock()).toISOString(),
      ),
    );
    await this.db.batch(batch);
    return status;
  }
  async failItem(id: string, reason: string) {
    await this.sql(
      "UPDATE raw_source_items SET status='failed',reason=?,attempts=attempts+1 WHERE id=?",
      reason,
      id,
    ).run();
  }
  async finish(
    runId: string,
    source: SourceDefinition,
    result: RunResult,
    error?: string,
  ) {
    const now = this.clock(),
      iso = new Date(now).toISOString();
    const poll = this.runKind === "poll";
    await this.db.batch([
      this.sql(
        "UPDATE ingestion_runs SET status=?,finished_at=?,counts=?,error=? WHERE id=?",
        error ? "failed" : "complete",
        iso,
        JSON.stringify(result),
        error ?? null,
        runId,
      ),
      poll
        ? this.sql(
            `UPDATE sources SET lease_until=0,${error ? "last_failure_at" : "last_success_at"}=?,last_error=?,next_attempt_at=? + ${error ? "MIN(21600000,3600000*(1 << MIN(consecutive_failures,3)))" : "?"},consecutive_failures=${error ? "consecutive_failures+1" : "0"},last_processed_at=CASE WHEN ? THEN ? ELSE last_processed_at END WHERE id=?`,
            iso,
            error ?? null,
            now,
            ...(!error ? [sourceCadence(source)] : []),
            result.changed > 0 ? 1 : 0,
            iso,
            source.id,
          )
        : this.sql(
            "UPDATE sources SET lease_until=0,last_processed_at=?,processing_error=?,next_process_at=? WHERE id=?",
            iso,
            error ?? (result.failed ? "processing-failed" : null),
            now + 60000,
            source.id,
          ),
    ]);
  }
}

/** Daily bounded maintenance is independent of polling and queue draining. */
export async function maintainPrivateData(db: D1Database, now = Date.now()) {
  const cutoff = new Date(now - 90 * 86400000).toISOString();
  return db.batch([
    db
      .prepare(
        "DELETE FROM raw_source_item_versions WHERE rowid IN (SELECT rowid FROM raw_source_item_versions WHERE retrieved_at<? LIMIT 500)",
      )
      .bind(cutoff),
    db
      .prepare(
        "UPDATE raw_source_items SET content='[expired]',title='[expired]',metadata='{}',rules='expired',status=CASE WHEN status IN ('collected','failed') THEN 'rejected' ELSE status END,reason=CASE WHEN status IN ('collected','failed') THEN 'raw-retention-expired' ELSE reason END WHERE id IN (SELECT id FROM raw_source_items WHERE retrieved_at<? AND content NOT IN ('[expired]','[withdrawn]') LIMIT 500)",
      )
      .bind(cutoff),
    db
      .prepare(
        "DELETE FROM processing_jobs WHERE id IN (SELECT id FROM processing_jobs WHERE created_at<? LIMIT 500)",
      )
      .bind(cutoff),
    db
      .prepare(
        "DELETE FROM ingestion_runs WHERE id IN (SELECT id FROM ingestion_runs WHERE finished_at<? LIMIT 500)",
      )
      .bind(cutoff),
  ]);
}
