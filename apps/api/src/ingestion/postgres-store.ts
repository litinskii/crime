import type { Pool, PoolClient } from "pg";
import type { Incident } from "@crime-radar/shared";
import { similarity, ruleVersion } from "./processor";
import type {
  IngestionStore,
  Processed,
  RawItem,
  RunResult,
  SourceDefinition,
} from "./types";

export class PostgresIngestionStore implements IngestionStore {
  private client?: PoolClient;
  constructor(readonly pool: Pool) {}
  private get db() {
    if (!this.client) throw new Error("Run not started");
    return this.client;
  }
  async begin(source: SourceDefinition) {
    const client = await this.pool.connect();
    const locked = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [source.id],
    );
    if (!locked.rows[0].locked) {
      client.release();
      return null;
    }
    this.client = client;
    try {
      await client.query(
        `INSERT INTO sources(id,name,base_url,enabled,schedule,metadata) VALUES($1,$2,$3,true,'hourly',$4)
        ON CONFLICT(id) DO UPDATE SET enabled=true,metadata=excluded.metadata`,
        [
          source.id,
          source.name,
          source.url,
          {
            verificationUrl: source.verificationUrl,
            rules: ruleVersion,
            rawRetentionDays: 90,
          },
        ],
      );
      const run = await client.query<{ id: string }>(
        "INSERT INTO ingestion_runs(source_id) VALUES($1) RETURNING id",
        [source.id],
      );
      return run.rows[0].id;
    } catch (error) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
        source.id,
      ]);
      client.release();
      this.client = undefined;
      throw error;
    }
  }
  async saveRaw(item: RawItem) {
    const old = await this.db.query<{
      id: string;
      content_hash: string;
      metadata: { rules?: string; canonicalUrl?: string };
      processing_status: string;
      published_at: Date | null;
    }>(
      "SELECT id,content_hash,metadata,processing_status,published_at FROM raw_source_items WHERE source_id=$1 AND external_id=$2 LIMIT 1",
      [item.sourceId, item.externalId],
    );
    const previous = old.rows[0];
    if (
      previous?.content_hash === item.contentHash &&
      previous.metadata.rules === ruleVersion &&
      ["published", "duplicate", "review", "rejected"].includes(
        previous.processing_status,
      ) &&
      (previous.published_at?.toISOString() ?? null) === item.publishedAt &&
      previous.metadata.canonicalUrl === item.canonicalUrl
    ) {
      await this.db.query(
        "UPDATE raw_source_items SET retrieved_at=$2 WHERE id=$1",
        [previous.id, item.retrievedAt],
      );
      return { id: previous.id, changed: false };
    }
    await this.db.query("BEGIN");
    try {
      let id: string;
      if (previous) {
        id = previous.id;
        await this.db.query(
          "UPDATE raw_source_items SET title=$2,content=$3,content_hash=$4,published_at=$5,retrieved_at=$6,processing_status='collected',processing_error=NULL,metadata=$7 WHERE id=$1",
          [
            id,
            item.title,
            item.content,
            item.contentHash,
            item.publishedAt,
            item.retrievedAt,
            { canonicalUrl: item.canonicalUrl, rules: ruleVersion },
          ],
        );
      } else {
        const inserted = await this.db.query<{ id: string }>(
          `INSERT INTO raw_source_items(source_id,external_id,source_url,title,content,language,published_at,retrieved_at,content_hash,metadata)
          VALUES($1,$2,$3,$4,$5,'uk',$6,$7,$8,$9) RETURNING id`,
          [
            item.sourceId,
            item.externalId,
            item.sourceUrl,
            item.title,
            item.content,
            item.publishedAt,
            item.retrievedAt,
            item.contentHash,
            { canonicalUrl: item.canonicalUrl, rules: ruleVersion },
          ],
        );
        id = inserted.rows[0].id;
      }
      await this.db.query(
        `INSERT INTO raw_source_item_versions(raw_source_item_id,content_hash,title,content,published_at,retrieved_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          id,
          item.contentHash,
          item.title,
          item.content,
          item.publishedAt,
          item.retrievedAt,
        ],
      );
      await this.db.query("COMMIT");
      return { id, changed: true };
    } catch (error) {
      await this.db.query("ROLLBACK");
      throw error;
    }
  }
  async record(id: string, result: Processed, raw: RawItem) {
    await this.db.query("BEGIN");
    try {
      let status: "published" | "duplicate" | "review" | "rejected" =
        result.status;
      let reason = result.status === "published" ? null : result.reason;
      if (result.status !== "published") {
        // An edited post which no longer passes publication retracts its linked public record.
        await this.db.query(
          "UPDATE incidents SET is_published=false,updated_at=now() WHERE id IN (SELECT incident_id FROM incident_sources WHERE raw_source_item_id=$1)",
          [id],
        );
      } else {
        const incident = result.incident;
        const same = await this.db.query<{ id: string; public_data: Incident }>(
          "SELECT id,public_data FROM incidents WHERE canonical_key=$1 OR fingerprint=$2 ORDER BY created_at LIMIT 1",
          [result.canonicalKey, result.fingerprint],
        );
        const existing = same.rows[0];
        const candidates = await this.db.query<{ title: string }>(
          `SELECT r.title FROM incidents i JOIN incident_sources s ON s.incident_id=i.id JOIN raw_source_items r ON r.id=s.raw_source_item_id
          WHERE i.category=$1 AND i.public_data->'location'->>'city'=$2 AND i.published_at BETWEEN $3::timestamptz-interval '7 days' AND $3::timestamptz+interval '7 days' AND i.id<>$4 LIMIT 30`,
          [
            incident.category,
            incident.location.city,
            incident.publishedAt,
            incident.id,
          ],
        );
        if (
          !existing &&
          candidates.rows.some(
            (candidate) => similarity(raw.title, candidate.title) >= 0.7,
          )
        ) {
          status = "review";
          reason = "possible-duplicate";
          await this.db.query(
            "UPDATE incidents SET is_published=false,updated_at=now() WHERE id IN (SELECT incident_id FROM incident_sources WHERE raw_source_item_id=$1)",
            [id],
          );
        } else {
          if (existing) {
            incident.id = existing.id;
            incident.sources = [
              ...existing.public_data.sources.filter(
                (source) => source.url !== raw.sourceUrl,
              ),
              ...incident.sources,
            ];
            if (
              existing.public_data.sources.every(
                (source) => source.url !== raw.sourceUrl,
              )
            )
              status = "duplicate";
          }
          const search = [
            incident.title.uk,
            incident.title.en,
            incident.description?.uk,
            incident.description?.en,
            ...incident.keywords,
          ]
            .join(" ")
            .toLocaleLowerCase("uk");
          await this.db.query(
            "UPDATE incidents SET is_published=false,updated_at=now() WHERE id IN (SELECT incident_id FROM incident_sources WHERE raw_source_item_id=$1) AND id<>$2",
            [id, incident.id],
          );
          await this.db.query(
            `INSERT INTO incidents(id,category,occurred_at,published_at,public_location,location_precision,public_data,search_text,confidence,is_published,canonical_key,fingerprint)
            VALUES($1,$2,NULL,$3,ST_SetSRID(ST_MakePoint($4,$5),4326),'city',$6,$7,$8,true,$9,$10)
            ON CONFLICT(id) DO UPDATE SET category=excluded.category,published_at=excluded.published_at,public_location=excluded.public_location,public_data=excluded.public_data,search_text=excluded.search_text,confidence=excluded.confidence,is_published=true,fingerprint=excluded.fingerprint,updated_at=now()`,
            [
              incident.id,
              incident.category,
              incident.publishedAt,
              incident.location.longitude,
              incident.location.latitude,
              incident,
              search,
              incident.confidence,
              result.canonicalKey,
              result.fingerprint,
            ],
          );
          await this.db.query(
            `INSERT INTO incident_sources(incident_id,source_id,source_url,raw_source_item_id,published_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(incident_id,source_id,source_url) DO UPDATE SET raw_source_item_id=excluded.raw_source_item_id,published_at=excluded.published_at`,
            [incident.id, raw.sourceId, raw.sourceUrl, id, raw.publishedAt],
          );
          await this.db.query(
            `INSERT INTO geocoding_city_cache(normalized_key,provider,result) VALUES($1,'city-gazetteer-v1',$2) ON CONFLICT(normalized_key) DO UPDATE SET result=excluded.result,updated_at=now()`,
            [incident.location.city, incident.location],
          );
        }
      }
      await this.db.query(
        "UPDATE raw_source_items SET processing_status=$2,processing_error=$3 WHERE id=$1",
        [id, status, reason],
      );
      await this.db.query(
        "INSERT INTO processing_jobs(source_id,raw_source_item_id,stage,status,attempts,error) VALUES($1,$2,'normalize-and-publish',$3,1,$4)",
        [raw.sourceId, id, status, reason],
      );
      await this.db.query("COMMIT");
      return status;
    } catch (error) {
      await this.db.query("ROLLBACK");
      throw error;
    }
  }
  async failItem(id: string, reason: string) {
    await this.db.query(
      "UPDATE raw_source_items SET processing_status='failed',processing_error=$2 WHERE id=$1",
      [id, reason],
    );
  }
  async finish(
    runId: string,
    source: SourceDefinition,
    result: RunResult,
    error?: string,
  ) {
    try {
      await this.db.query(
        "UPDATE ingestion_runs SET status=$2,counts=$3,error=$4,finished_at=now() WHERE id=$1",
        [runId, error ? "failed" : "complete", result, error ?? null],
      );
      await this.db.query(
        `UPDATE sources SET last_success_at=CASE WHEN $2::text IS NULL THEN now() ELSE last_success_at END,last_failure_at=CASE WHEN $2::text IS NOT NULL THEN now() ELSE last_failure_at END WHERE id=$1`,
        [source.id, error ?? null],
      );
      await this.db.query(
        "DELETE FROM raw_source_item_versions WHERE retrieved_at < now()-interval '90 days'",
      );
      // Preserve provenance, but expire private originals (no public raw endpoint).
      await this.db.query(
        "UPDATE raw_source_items SET content='[expired]',title='[expired]',metadata=jsonb_set(metadata,'{rules}','\"expired\"') WHERE retrieved_at < now()-interval '90 days' AND content<>'[expired]'",
      );
    } finally {
      await this.db.query("SELECT pg_advisory_unlock(hashtext($1))", [
        source.id,
      ]);
      this.client?.release();
      this.client = undefined;
    }
  }
}
