import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { Incident } from "@crime-radar/shared";
import { PostgresIngestionStore } from "./postgres-store";
import { IncidentProcessor } from "./processor";
import { policeSource } from "./collector";
import { hash } from "./hash";
import type { RawItem } from "./types";

interface StoredIncident {
  id: string;
  occurred_at: Date | null;
  published_at: Date | null;
  is_published: boolean;
  public_data: Incident;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "PostgreSQL source provenance integration",
  () => {
    it("migrates existing proof and preserves dates and provenance through confirmation, rejection and recovery", async () => {
      const suffix = randomUUID().replaceAll("-", "");
      const schema = `source_dates_test_${suffix}`;
      const admin = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema},public`,
        connectionTimeoutMillis: 5000,
      });
      const store = new PostgresIngestionStore(pool);
      const processor = new IncidentProcessor();
      // A unique advisory-lock key keeps this fixture independent of other runs.
      const source = { ...policeSource, id: `fixture-police-${suffix}` };
      let runId: string | null = null;

      async function raw(
        number: number,
        dated: boolean,
        publishedAt: string,
        canonicalUrl?: string,
        day = "30",
      ): Promise<RawItem> {
        const content = dated
          ? `${day} вересня 2026 року у Києві чоловік викрав велосипед. Деталі повідомлення ${number}.`
          : `У Києві чоловік викрав велосипед. Поліція встановлює обставини. Деталі ${number}.`;
        return {
          sourceId: policeSource.id,
          externalId: `UA_National_Police/${number}`,
          sourceUrl: `https://t.me/UA_National_Police/${number}`,
          title: "У Києві чоловік викрав велосипед",
          content,
          publishedAt,
          canonicalUrl,
          retrievedAt: new Date().toISOString(),
          contentHash: await hash(content),
        };
      }
      async function processed(original: RawItem) {
        const result = await processor.process(original);
        expect(result.status).toBe("published");
        if (result.status !== "published")
          throw new Error("Fixture did not describe a publishable event");
        return result;
      }
      async function publish(original: RawItem) {
        const result = await processed(original);
        const item = { ...original, sourceId: source.id };
        const saved = await store.saveRaw(item);
        const status = await store.record(saved.id, result, item);
        return { id: saved.id, item, status };
      }
      async function reject(saved: Awaited<ReturnType<typeof publish>>) {
        await store.record(
          saved.id,
          { status: "review", reason: "confirmed-ambiguous-edit-fixture" },
          saved.item,
        );
      }
      async function current() {
        return (
          await pool.query<StoredIncident>(
            "SELECT id,occurred_at,published_at,is_published,public_data FROM incidents ORDER BY id",
          )
        ).rows;
      }
      async function reset() {
        const tables = [
          "incident_sources",
          "processing_jobs",
          "raw_source_item_versions",
          "raw_source_items",
          "incidents",
        ];
        await pool.query(
          `TRUNCATE ${tables.map((table) => `${schema}.${table}`).join(",")} CASCADE`,
        );
      }
      try {
        // TEST_DATABASE_URL points to a prepared PostGIS test database.
        const postgis = await admin.query<{ installed: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') AS installed",
        );
        expect(postgis.rows[0].installed).toBe(true);
        await admin.query(`CREATE SCHEMA ${schema}`);
        for (const name of ["001_initial.sql", "002_ingestion.sql"])
          await pool.query(
            await readFile(
              new URL(`../database/${name}`, import.meta.url),
              "utf8",
            ),
          );
        for (const table of [
          "sources",
          "raw_source_items",
          "incidents",
          "incident_sources",
          "processing_jobs",
          "raw_source_item_versions",
          "ingestion_runs",
          "geocoding_city_cache",
        ])
          expect(
            (
              await pool.query("SELECT to_regclass($1) AS table_name", [
                `${schema}.${table}`,
              ])
            ).rows[0].table_name,
          ).toBeTruthy();

        // Backfill a document written before per-source proof was introduced.
        const old = await processed(
          await raw(901, true, "2026-10-01T09:00:00.000Z"),
        );
        await pool.query(
          "INSERT INTO sources(id,name,enabled) VALUES('legacy','Legacy',true)",
        );
        const saved = (
          await pool.query<{ id: string }>(
            "INSERT INTO raw_source_items(source_id,external_id,source_url,title,content,content_hash,published_at,processing_status) VALUES('legacy','901',$1,'Legacy','Legacy','legacy',$2,'published') RETURNING id",
            ["https://t.me/UA_National_Police/901", old.incident.publishedAt],
          )
        ).rows[0];
        await pool.query(
          "INSERT INTO incidents(id,category,occurred_at,published_at,public_location,public_data,search_text,is_published) VALUES('legacy','theft','2026-09-30',$1,ST_SetSRID(ST_MakePoint(30.5,50.4),4326),$2,'',true)",
          [old.incident.publishedAt, old.incident],
        );
        await pool.query(
          "INSERT INTO incident_sources(incident_id,source_id,source_url,raw_source_item_id,published_at) VALUES('legacy','legacy',$1,$2,$3)",
          [
            "https://t.me/UA_National_Police/901",
            saved.id,
            old.incident.publishedAt,
          ],
        );
        const migration = await readFile(
          new URL("../database/003_date_basis.sql", import.meta.url),
          "utf8",
        );
        await pool.query(migration);
        await pool.query(migration);
        const backfill = (
          await pool.query<{
            active: boolean;
            event_date: Date;
            event_data: Incident;
            published_at: Date;
          }>(
            "SELECT active,event_date,event_data,published_at FROM incident_sources WHERE incident_id='legacy'",
          )
        ).rows[0];
        expect(backfill.active).toBe(true);
        expect(backfill.event_date.toISOString()).toBe(
          "2026-09-30T00:00:00.000Z",
        );
        expect(backfill.event_data.occurredOn).toBe("2026-09-30");
        expect(backfill.published_at.toISOString()).toBe(
          old.incident.publishedAt,
        );

        await reset();
        runId = await store.begin(source);
        expect(runId).toBeTruthy();
        const canonicalUrl = "https://example.test/shared-report";
        const first = await publish(
          await raw(101, true, "2026-10-03T09:00:00.000Z", canonicalUrl),
        );
        const second = await publish(
          await raw(102, false, "2026-10-01T09:00:00.000Z", canonicalUrl),
        );
        let rows = await current();
        expect(rows).toHaveLength(1);
        expect(rows[0].public_data).toMatchObject({
          occurredOn: "2026-09-30",
          publishedAt: "2026-10-03T09:00:00.000Z",
        });
        expect(rows[0].published_at?.toISOString()).toBe(
          "2026-10-03T09:00:00.000Z",
        );
        expect(rows[0].public_data.sources).toHaveLength(2);
        const third = await publish(
          await raw(103, true, "2026-10-02T09:00:00.000Z", canonicalUrl),
        );
        rows = await current();
        expect(rows[0].public_data.sources).toHaveLength(3);
        expect(rows[0].public_data.publishedAt).toBe(
          "2026-10-03T09:00:00.000Z",
        );

        await reject(first);
        let [row] = await current();
        expect(row.is_published).toBe(true);
        expect(row.public_data.sources).toHaveLength(2);
        expect(row.public_data.eventDateEvidence?.sourceUrl).toBe(
          third.item.sourceUrl,
        );
        expect(row.occurred_at?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
        expect(row.public_data.publishedAt).toBe("2026-10-02T09:00:00.000Z");

        await reject(third);
        [row] = await current();
        expect(row.is_published).toBe(true);
        expect(row.occurred_at).toBeNull();
        expect(row.public_data.occurredOn).toBeUndefined();
        expect(row.public_data.eventDateEvidence).toBeUndefined();
        expect(row.public_data.sources.map((item) => item.url)).toEqual([
          second.item.sourceUrl,
        ]);
        expect(row.public_data.publishedAt).toBe("2026-10-01T09:00:00.000Z");

        await reject(second);
        [row] = await current();
        expect(row.is_published).toBe(false);
        expect(
          (
            await pool.query<{ n: number }>(
              "SELECT COUNT(*)::int AS n FROM incident_sources WHERE active",
            )
          ).rows[0].n,
        ).toBe(0);

        const recovered = await publish(
          await raw(101, true, "2026-10-03T09:00:00.000Z", canonicalUrl),
        );
        [row] = await current();
        expect(row.is_published).toBe(true);
        expect(row.public_data.sources.map((item) => item.url)).toEqual([
          recovered.item.sourceUrl,
        ]);
        expect(recovered.status).toBe("published");

        // Similar titles on explicitly different days describe distinct events.
        await reset();
        expect(
          (
            await publish(
              await raw(201, true, "2026-10-01T09:00:00.000Z", undefined, "30"),
            )
          ).status,
        ).toBe("published");
        expect(
          (
            await publish(
              await raw(202, true, "2026-10-01T09:00:00.000Z", undefined, "29"),
            )
          ).status,
        ).toBe("published");
        expect(
          (await current()).filter((item) => item.is_published),
        ).toHaveLength(2);
      } finally {
        try {
          if (runId)
            await store.finish(runId, source, {
              discovered: 0,
              changed: 0,
              published: 0,
              duplicates: 0,
              review: 0,
              rejected: 0,
              failed: 0,
            });
        } finally {
          try {
            await pool.end();
          } finally {
            try {
              await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            } finally {
              await admin.end();
            }
          }
        }
      }
    }, 30000);
  },
);
