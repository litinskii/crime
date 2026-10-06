import type { Pool, PoolClient } from "pg";
import { incidentDate, type Incident } from "@crime-radar/shared";
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
            ...source,
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
      metadata: {
        rules?: string;
        canonicalUrl?: string;
        isRepost?: boolean;
        originalPublishedAt?: string;
      };
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
      previous.metadata.canonicalUrl === item.canonicalUrl &&
      Boolean(previous.metadata.isRepost) === Boolean(item.isRepost) &&
      previous.metadata.originalPublishedAt === item.originalPublishedAt
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
            {
              canonicalUrl: item.canonicalUrl,
              rules: ruleVersion,
              isRepost: item.isRepost,
              originalPublishedAt: item.originalPublishedAt,
            },
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
            {
              canonicalUrl: item.canonicalUrl,
              rules: ruleVersion,
              isRepost: item.isRepost,
              originalPublishedAt: item.originalPublishedAt,
            },
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
        await this.retractRaw(id);
      } else {
        const incident = result.incident;
        const eventDate =
          incident.occurredAt ??
          (incident.occurredOn ? `${incident.occurredOn}T00:00:00Z` : null);
        const ownPublishedAt = incident.publishedAt;
        const ownProof = eventDate
          ? {
              occurredAt: incident.occurredAt,
              occurredOn: incident.occurredOn,
              eventDateEvidence: incident.eventDateEvidence,
            }
          : null;
        const same = await this.db.query<{
          id: string;
          public_data: Incident;
          canonical_key: string;
          is_published: boolean;
        }>(
          `SELECT id,public_data,canonical_key,is_published FROM incidents WHERE id=$3 OR canonical_key=$1 OR (fingerprint=$2 AND (($4::timestamptz IS NOT NULL AND occurred_at >= date_trunc('day',$4::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND occurred_at < (date_trunc('day',$4::timestamptz AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC') OR ($4::timestamptz IS NULL AND occurred_at IS NULL AND published_at BETWEEN $5::timestamptz-interval '7 days' AND $5::timestamptz+interval '7 days'))) ORDER BY (id=$3 OR canonical_key=$1) DESC,created_at LIMIT 1`,
          [
            result.canonicalKey,
            result.fingerprint,
            incident.id,
            eventDate,
            incident.publishedAt,
          ],
        );
        const existing = same.rows[0];
        const candidates =
          existing || raw.sourceId === "court-decisions"
            ? { rows: [] }
            : await this.db.query<{ title: string }>(
                `SELECT r.title FROM incidents i JOIN incident_sources s ON s.incident_id=i.id JOIN raw_source_items r ON r.id=s.raw_source_item_id
          WHERE i.is_published=true AND s.active AND i.category=$1 AND i.public_data->'location'->>'city'=$2
          AND (($5::timestamptz IS NOT NULL AND i.occurred_at >= date_trunc('day',$5::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND i.occurred_at < (date_trunc('day',$5::timestamptz AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC')
          OR ($5::timestamptz IS NULL AND i.occurred_at IS NULL AND i.published_at BETWEEN $3::timestamptz-interval '7 days' AND $3::timestamptz+interval '7 days'))
          AND i.id<>$4 LIMIT 30`,
                [
                  incident.category,
                  incident.location.city,
                  incident.publishedAt,
                  incident.id,
                  eventDate,
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
          await this.retractRaw(id);
        } else {
          let canonicalKey = result.canonicalKey;
          if (existing) {
            if (
              existing.id !== incident.id &&
              existing.canonical_key !== result.canonicalKey
            )
              canonicalKey = existing.canonical_key;
            incident.id = existing.id;
            const support = await this.db.query<{
              event_data: typeof ownProof;
              published_at: Date | null;
              source_url: string;
            }>(
              "SELECT event_data,published_at,source_url FROM incident_sources WHERE incident_id=$1 AND active AND raw_source_item_id IS DISTINCT FROM $2 ORDER BY source_url",
              [incident.id, id],
            );
            const proof = support.rows.find(
              (row) => row.event_data,
            )?.event_data;
            if (!eventDate && proof) {
              incident.occurredAt = proof.occurredAt ?? null;
              incident.occurredOn = proof.occurredOn ?? undefined;
              incident.eventDateEvidence = proof.eventDateEvidence ?? undefined;
            }
            const latest = support.rows.reduce(
              (date, row) =>
                row.published_at &&
                row.published_at.getTime() > Date.parse(date!)
                  ? row.published_at.toISOString()
                  : date,
              ownPublishedAt,
            );
            if (latest) incident.publishedAt = incident.reportedAt = latest;
            const activeUrls = new Set(
              support.rows.map((row) => row.source_url),
            );
            incident.sources = [
              ...existing.public_data.sources.filter(
                (source) => source.url && activeUrls.has(source.url),
              ),
              ...incident.sources,
            ];
            if (
              existing.is_published &&
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
          await this.retractRaw(id, incident.id);
          await this.db.query(
            `INSERT INTO incidents(id,category,occurred_at,published_at,public_location,location_precision,public_data,search_text,confidence,is_published,canonical_key,fingerprint)
            VALUES($1,$2,$11,$3,ST_SetSRID(ST_MakePoint($4,$5),4326),'city',$6,$7,$8,true,$9,$10)
            ON CONFLICT(id) DO UPDATE SET category=excluded.category,occurred_at=excluded.occurred_at,published_at=excluded.published_at,public_location=excluded.public_location,public_data=excluded.public_data,search_text=excluded.search_text,confidence=excluded.confidence,is_published=true,canonical_key=excluded.canonical_key,fingerprint=excluded.fingerprint,updated_at=now()`,
            [
              incident.id,
              incident.category,
              incident.publishedAt ?? null,
              incident.location.longitude,
              incident.location.latitude,
              incident,
              search,
              incident.confidence,
              canonicalKey,
              result.fingerprint,
              incident.occurredAt ??
                (incident.occurredOn
                  ? `${incident.occurredOn}T00:00:00Z`
                  : null),
            ],
          );
          await this.db.query(
            `INSERT INTO incident_sources(incident_id,source_id,source_url,raw_source_item_id,published_at,active,event_date,event_data) VALUES($1,$2,$3,$4,$5,true,$6,$7) ON CONFLICT(incident_id,source_id,source_url) DO UPDATE SET raw_source_item_id=excluded.raw_source_item_id,published_at=excluded.published_at,active=true,event_date=excluded.event_date,event_data=excluded.event_data`,
            [
              incident.id,
              raw.sourceId,
              raw.sourceUrl,
              id,
              ownPublishedAt,
              eventDate,
              ownProof,
            ],
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
  private async retractRaw(rawId: string, except?: string) {
    const changed = await this.db.query<{ incident_id: string }>(
      "UPDATE incident_sources SET active=false WHERE raw_source_item_id=$1 AND active AND ($2::text IS NULL OR incident_id<>$2) RETURNING incident_id",
      [rawId, except ?? null],
    );
    for (const incidentId of new Set(
      changed.rows.map((row) => row.incident_id),
    )) {
      const supports = await this.db.query<{
        source_url: string;
        published_at: Date | null;
        event_data: Pick<
          Incident,
          "occurredAt" | "occurredOn" | "eventDateEvidence"
        > | null;
      }>(
        "SELECT source_url,published_at,event_data FROM incident_sources WHERE incident_id=$1 AND active ORDER BY source_url",
        [incidentId],
      );
      if (!supports.rows.length) {
        await this.db.query(
          "UPDATE incidents SET is_published=false,updated_at=now() WHERE id=$1",
          [incidentId],
        );
        continue;
      }
      const row = await this.db.query<{ public_data: Incident }>(
        "SELECT public_data FROM incidents WHERE id=$1",
        [incidentId],
      );
      const incident = row.rows[0].public_data;
      const urls = new Set(supports.rows.map((s) => s.source_url));
      incident.sources = incident.sources.filter(
        (s) => s.url && urls.has(s.url),
      );
      const proof = supports.rows.find((s) => s.event_data)?.event_data;
      incident.occurredAt = proof?.occurredAt ?? null;
      incident.occurredOn = proof?.occurredOn ?? undefined;
      incident.eventDateEvidence = proof?.eventDateEvidence ?? undefined;
      const latest = supports.rows.reduce(
        (timestamp, s) => Math.max(timestamp, s.published_at?.getTime() ?? 0),
        0,
      );
      incident.publishedAt = latest
        ? new Date(latest).toISOString()
        : undefined;
      incident.reportedAt = incident.publishedAt;
      await this.db.query(
        "UPDATE incidents SET public_data=$2,occurred_at=$3,published_at=$4,is_published=true,updated_at=now() WHERE id=$1",
        [
          incidentId,
          incident,
          incidentDate(incident, "event") ?? null,
          incident.publishedAt ?? null,
        ],
      );
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
