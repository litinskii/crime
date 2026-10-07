import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { D1IngestionStore, maintainPrivateData } from "./store";
import { D1IncidentsRepository } from "./repository";
import worker, { type Env } from "./index";
import { policeSource } from "../../api/src/ingestion/collector";
import { hash } from "../../api/src/ingestion/hash";
import { ingest } from "../../api/src/ingestion/runner";
import type { RawItem } from "../../api/src/ingestion/types";
import { IncidentProcessor } from "../../api/src/ingestion/processor";
import { sourceById, sources } from "../../api/src/ingestion/sources";
import {
  dispatchHourly,
  consumeTask,
  dailyProcessBudget,
  maxCycleSteps,
  type IngestionTask,
} from "./scheduler";
import { ruleVersion } from "../../api/src/ingestion/processor";

// Execute the actual D1 SQL against SQLite, including transactional batch semantics.
class Statement {
  values: SQLInputValue[] = [];
  constructor(
    readonly owner: SQLite,
    readonly text: string,
  ) {}
  bind(...values: SQLInputValue[]) {
    if (values.length > 100)
      throw new Error("D1 bound parameter limit exceeded");
    this.values = values;
    return this;
  }
  result() {
    this.owner.queries++;
    const statement = this.owner.sqlite.prepare(this.text);
    const results = statement.columns().length
      ? statement.all(...this.values)
      : [];
    const meta = statement.columns().length
      ? { changes: 0 }
      : statement.run(...this.values);
    return { results, meta, success: true };
  }
  async run() {
    return this.result();
  }
  async all() {
    return this.result();
  }
  async first() {
    return this.result().results[0] ?? null;
  }
}
class SQLite {
  sqlite = new DatabaseSync(":memory:");
  queries = 0;
  constructor() {
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      this.sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  prepare(text: string) {
    return new Statement(this, text);
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const result = statements.map((statement) => statement.result());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  get db() {
    return this as unknown as D1Database;
  }
}
async function item(
  id: number,
  title = "У Києві поліцейські викрили шахрайство",
  content?: string,
): Promise<RawItem> {
  content ??= `${title}\nПетренко Іван, test@example.com, +380501234567, квартира 5.`;
  return {
    sourceId: policeSource.id,
    externalId: `UA_National_Police/${id}`,
    sourceUrl: `https://t.me/UA_National_Police/${id}`,
    title,
    content,
    publishedAt: "2026-10-01T09:00:00.000Z",
    retrievedAt: new Date().toISOString(),
    contentHash: await hash(content),
  };
}
const query = {
  south: 44,
  north: 53,
  west: 22,
  east: 40,
  from: "2026-09-30T00:00:00Z",
  to: "2026-10-06T23:59:59Z",
  limit: 1,
};
describe("durable ingestion and public D1 API", () => {
  let sqlite: SQLite, store: D1IngestionStore, repo: D1IncidentsRepository;
  beforeEach(() => {
    sqlite = new SQLite();
    store = new D1IngestionStore(sqlite.db);
    repo = new D1IncidentsRepository(sqlite.db);
  });
  afterEach(() => sqlite.sqlite.close());
  async function run(items: RawItem[]) {
    sqlite.queries = 0;
    return ingest({ source: policeSource, collect: async () => items }, store);
  }
  it("stages a full page, drains older pending items, and stays below 50 queries per run", async () => {
    const items = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        item(i + 1, "Нагадуємо про правила", `fixture ${i}`),
      ),
    );
    expect((await run(items))?.changed).toBe(3);
    expect(sqlite.queries).toBeLessThan(50);
    expect(
      sqlite.sqlite.prepare("SELECT count(*) AS n FROM raw_source_items").get()
        ?.n,
    ).toBe(20);
    for (let i = 0; i < 7; i++) {
      await run([items[19]]);
      expect(sqlite.queries).toBeLessThan(50);
    }
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT count(*) AS n FROM raw_source_items WHERE status='collected'",
        )
        .get()?.n,
    ).toBe(0);
    expect((await run(items))?.changed).toBe(0);
  });
  it("publishes safe fields, exact-merges reposts, and does not duplicate repeated runs", async () => {
    const first = await item(1),
      repost = {
        ...first,
        externalId: "UA_National_Police/2",
        sourceUrl: "https://t.me/UA_National_Police/2",
      };
    const result = await run([first, repost]);
    expect(result).toMatchObject({ published: 1, duplicates: 1, failed: 0 });
    expect(sqlite.queries).toBeLessThan(50);
    const page = await repo.getIncidents(query);
    expect(page.total).toBe(1);
    expect(page.items[0].sources).toHaveLength(2);
    const publicJson = JSON.stringify(page);
    for (const privateValue of [
      "Петренко",
      "test@example.com",
      "+380501234567",
      "квартира",
    ])
      expect(publicJson).not.toContain(privateValue);
    expect((await run([first, repost]))?.changed).toBe(0);
  });
  it("stays within the free query budget for a maximum page with three publications", async () => {
    const records = [
      await item(101),
      await item(102, "В Одесі сталася ДТП"),
      await item(103, "У Луцьку викрили нарколабораторію"),
      ...(await Promise.all(
        Array.from({ length: 27 }, (_, i) =>
          item(i + 104, "Нагадуємо про правила", `fixture ${i}`),
        ),
      )),
    ];
    expect((await run(records))?.published).toBe(3);
    expect(sqlite.queries).toBeLessThanOrEqual(50);
  });
  it("preserves changed originals and retracts an edited post that fails the location gate", async () => {
    const first = await item(1);
    await run([first]);
    const id = (await repo.getIncidents(query)).items[0].id;
    await run([await item(1, "На Київщині викрили шахрайство")]);
    expect((await repo.getIncidents(query)).total).toBe(0);
    await expect(repo.getIncident(id)).rejects.toThrow("Incident not found");
    expect(
      sqlite.sqlite
        .prepare("SELECT count(*) AS n FROM raw_source_item_versions")
        .get()?.n,
    ).toBe(2);
  });
  it("reprocesses old publication rules even when the collector no longer selects that record", async () => {
    await run([await item(1)]);
    sqlite.sqlite.exec(
      "UPDATE raw_source_items SET title='Роковини трагедії Бабиного Яру',content='Пам’ять про загиблих',rules='obsolete'",
    );
    expect((await run([]))?.rejected).toBe(1);
    expect((await repo.getIncidents(query)).total).toBe(0);
  });
  it("queues similar reports for review instead of guessing a merge", async () => {
    await run([await item(1), await item(2, undefined, "Changed details")]);
    expect((await repo.getIncidents(query)).total).toBe(1);
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT status,reason FROM raw_source_items WHERE external_id='UA_National_Police/2'",
        )
        .get(),
    ).toMatchObject({ status: "review", reason: "possible-duplicate" });
  });
  it("paginates without duplicates and calculates full statistics and bilingual search", async () => {
    await run([
      await item(1),
      await item(2, "В Одесі сталася ДТП"),
      await item(3, "У Луцьку викрили нарколабораторію"),
    ]);
    const first = await repo.getIncidents(query),
      second = await repo.getIncidents({ ...query, cursor: first.nextCursor! });
    expect(first.total).toBe(3);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect((await repo.getStatistics(query)).total).toBe(3);
    expect((await repo.getIncidents({ ...query, query: "odesa" })).total).toBe(
      1,
    );
    expect(
      (await repo.getIncidents({ ...query, query: "' OR 1=1 --" })).total,
    ).toBe(0);
  });
  it("holds a source lease and limits failed item retries", async () => {
    const id = await store.begin(policeSource);
    expect(id).toBeTruthy();
    expect(
      await new D1IngestionStore(sqlite.db).begin(policeSource),
    ).toBeNull();
    const raw = await item(1);
    await store.stage([raw]);
    const saved = await store.saveRaw(raw);
    for (let i = 0; i < 3; i++)
      await store.failItem(saved.id, "processing-failed");
    expect(await store.stage([raw])).toEqual([]);
  });
  it("renews unchanged originals daily without hourly D1 writes or new versions", async () => {
    await store.begin(policeSource);
    const raw = { ...(await item(1)), retrievedAt: "2026-10-04T06:00:00.000Z" };
    await store.stage([raw]);
    const changes = () =>
      (
        sqlite.sqlite.prepare("SELECT total_changes() AS n").get() as {
          n: number;
        }
      ).n;
    const before = changes();
    await store.stage([{ ...raw, retrievedAt: "2026-10-04T07:00:00.000Z" }]);
    expect(changes()).toBe(before);
    const heartbeat = "2026-10-05T07:00:00.000Z";
    await store.stage([{ ...raw, retrievedAt: heartbeat }]);
    expect(changes()).toBe(before + 1);
    expect(
      sqlite.sqlite.prepare("SELECT retrieved_at FROM raw_source_items").get(),
    ).toMatchObject({ retrieved_at: heartbeat });
    expect(
      sqlite.sqlite
        .prepare("SELECT COUNT(*) AS n FROM raw_source_item_versions")
        .get(),
    ).toMatchObject({ n: 1 });
  });
  it("protects collection and exposes no private raw routes", async () => {
    const env: Env = {
      DB: sqlite.db,
      ASSETS: { fetch: async () => new Response("asset") },
      INGESTION_SECRET: "x".repeat(64),
    };
    const fetch = (path: string, method = "GET") =>
      worker.fetch(new Request(`https://example.test${path}`, { method }), env);
    expect((await fetch("/internal/ingest", "POST")).status).toBe(401);
    expect((await fetch("/internal/court", "POST")).status).toBe(401);
    expect((await fetch("/internal/articles", "POST")).status).toBe(401);
    expect((await fetch("/api/v1/raw")).status).toBe(404);
    expect((await fetch("/api/v1/incidents?north=bad")).status).toBe(400);
    expect((await fetch("/api/v1/incidents/no-such-id")).status).toBe(404);
    expect((await fetch("/health")).status).toBe(200);
  });
  it("retains published reports during source outages and schedules increasingly delayed retries", async () => {
    await run([await item(1)]);
    const collector = {
      source: policeSource,
      collect: async () => {
        throw new Error("Source access failed: HTTP 403");
      },
    };
    await expect(ingest(collector, store)).rejects.toThrow("HTTP 403");
    const first = sqlite.sqlite
      .prepare("SELECT * FROM sources WHERE id=?")
      .get(policeSource.id)!;
    expect(first.consecutive_failures).toBe(1);
    expect(Number(first.next_attempt_at)).toBeGreaterThanOrEqual(
      Date.now() + 3599000,
    );
    await expect(ingest(collector, store)).rejects.toThrow("HTTP 403");
    const second = sqlite.sqlite
      .prepare("SELECT * FROM sources WHERE id=?")
      .get(policeSource.id)!;
    expect(second.consecutive_failures).toBe(2);
    expect(
      Number(second.next_attempt_at) - Number(first.next_attempt_at),
    ).toBeGreaterThanOrEqual(3599000);
    expect((await repo.getIncidents(query)).total).toBe(1);
  });
  it("refuses archived court ingestion and preserves historical cards and provenance", async () => {
    const source = sourceById("court-decisions")!;
    const content =
      "Справа №123/456/26\nВСТАНОВИВ:\n01.09.2026 у м. Тернополі викрав велосипед.";
    const original = {
      ...(await item(1)),
      sourceId: source.id,
      externalId: "123",
      title: "Вирок: Крадіжка",
      content,
      contentHash: await hash(content),
      sourceUrl: "https://reyestr.court.gov.ua/Review/123",
    };
    expect(
      (await ingest({ source, collect: async () => [original] }, store))
        ?.published,
    ).toBe(1);
    const env: Env = {
      DB: sqlite.db,
      ASSETS: { fetch: async () => new Response() },
      INGESTION_SECRET: "x".repeat(64),
    };
    const queriesBefore = sqlite.queries;
    for (const path of [
      "/internal/court",
      "/internal/ingest?source=court-decisions",
      "/internal/ingest?source=court-decisions&drain=1",
      "/internal/process?source=court-decisions",
      "/internal/articles",
    ]) {
      const response = await worker.fetch(
        new Request(`https://example.test${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.INGESTION_SECRET}` },
          body: JSON.stringify({
            source: source.id,
            urls: [],
            documents: [],
            withdrawn: ["123"],
          }),
        }),
        env,
      );
      expect(response.status).toBe(410);
    }
    // Disabled requests must not touch D1, even when they ask to withdraw cards.
    expect(sqlite.queries).toBe(queriesBefore);
    expect(
      sqlite.sqlite
        .prepare("SELECT COUNT(*) AS n FROM incidents WHERE is_published=1")
        .get()?.n,
    ).toBe(1);
    expect(
      sqlite.sqlite
        .prepare("SELECT COUNT(*) AS n FROM raw_source_item_versions")
        .get()?.n,
    ).toBe(1);
    const archived = await repo.getIncidents({
      ...query,
      from: "2026-09-01T00:00:00Z",
      to: "2026-10-06T23:59:59Z",
    });
    expect(archived.items[0].sources[0].url).toBe(original.sourceUrl);
  });
  it("expires private text after 90 days while preserving public provenance", async () => {
    await run([await item(1)]);
    sqlite.sqlite.exec(
      "UPDATE raw_source_items SET retrieved_at='2020-01-01'; UPDATE raw_source_item_versions SET retrieved_at='2020-01-01'",
    );
    const id = (await store.begin(policeSource))!;
    await store.finish(id, policeSource, {
      discovered: 0,
      changed: 0,
      published: 0,
      duplicates: 0,
      review: 0,
      rejected: 0,
      failed: 0,
    });
    expect(
      sqlite.sqlite.prepare("SELECT content FROM raw_source_items").get()
        ?.content,
    ).not.toBe("[expired]");
    await maintainPrivateData(sqlite.db);
    expect(
      sqlite.sqlite.prepare("SELECT content,rules FROM raw_source_items").get(),
    ).toMatchObject({ content: "[expired]", rules: "expired" });
    expect((await repo.getIncidents(query)).items[0].sources[0].url).toBe(
      "https://t.me/UA_National_Police/1",
    );
  });
  it("supports an authenticated dedicated drain and records backfill without resetting polling", async () => {
    const raw = await item(1);
    await run([raw]);
    const before = sqlite.sqlite
      .prepare(
        "SELECT last_attempt_at,last_success_at,next_attempt_at FROM sources WHERE id=?",
      )
      .get(policeSource.id);
    await ingest(
      {
        source: policeSource,
        collect: async () => [await item(2, "В Одесі сталася ДТП")],
      },
      new D1IngestionStore(sqlite.db, { runKind: "backfill" }),
    );
    const env: Env = {
      DB: sqlite.db,
      ASSETS: { fetch: async () => new Response() },
      INGESTION_SECRET: "x".repeat(64),
    };
    expect(
      (
        await worker.fetch(
          new Request("https://example.test/internal/process", {
            method: "POST",
          }),
          env,
        )
      ).status,
    ).toBe(401);
    const response = await worker.fetch(
      new Request("https://example.test/internal/process", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.INGESTION_SECRET}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runKind: "process" });
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT last_attempt_at,last_success_at,next_attempt_at FROM sources WHERE id=?",
        )
        .get(policeSource.id),
    ).toEqual(before);
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM ingestion_runs WHERE run_kind='backfill'",
        )
        .get()?.n,
    ).toBe(1);
  });
  it("preserves surviving provenance when one confirmation is edited or withdrawn, and during a processing error", async () => {
    const first = await item(1),
      second = {
        ...first,
        externalId: "UA_National_Police/2",
        sourceUrl: "https://t.me/UA_National_Police/2",
      };
    await run([first, second]);
    const rawId = sqlite.sqlite
      .prepare("SELECT id FROM raw_source_items WHERE external_id=?")
      .get(first.externalId)?.id as string;
    await store.failItem(rawId, "processing-failed");
    expect((await repo.getIncidents(query)).total).toBe(1);
    await run([await item(1, "На Київщині викрили шахрайство")]);
    const surviving = (await repo.getIncidents(query)).items[0];
    expect(surviving.sources.map((source) => source.url)).toEqual([
      second.sourceUrl,
    ]);
    await store.withdraw(policeSource.id, [second.externalId]);
    expect((await repo.getIncidents(query)).total).toBe(0);
  });
  it("stores forwarding metadata privately and versions metadata-only corrections for reprocessing", async () => {
    const raw = {
      ...(await item(1)),
      isRepost: true,
      originalPublishedAt: "2026-09-30T09:00:00.000Z",
    };
    await run([raw]);
    const firstSeen = sqlite.sqlite
      .prepare("SELECT first_seen_at FROM raw_source_items")
      .get()?.first_seen_at;
    const changed = {
      ...raw,
      originalPublishedAt: "2026-09-29T09:00:00.000Z",
      retrievedAt: new Date(Date.now() + 1000).toISOString(),
    };
    expect((await run([changed]))?.changed).toBe(1);
    expect(
      sqlite.sqlite
        .prepare("SELECT COUNT(*) AS n FROM raw_source_item_versions")
        .get()?.n,
    ).toBe(2);
    expect(
      sqlite.sqlite.prepare("SELECT first_seen_at FROM raw_source_items").get()
        ?.first_seen_at,
    ).toBe(firstSeen);
    sqlite.sqlite.exec("UPDATE raw_source_items SET rules='obsolete'");
    expect((await store.stage([], policeSource.id))[0]).toMatchObject({
      isRepost: true,
      originalPublishedAt: changed.originalPublishedAt,
    });
    expect(JSON.stringify(await repo.getIncidents(query))).not.toContain(
      "originalPublishedAt",
    );
  });
  it("keeps events on different dates separate and does not mix event-known and publication-only duplicate candidates", async () => {
    const title = "У Києві чоловік викрав велосипед";
    await run([
      await item(
        1,
        title,
        "30 вересня 2026 року у Києві чоловік викрав велосипед.",
      ),
    ]);
    await run([
      await item(
        2,
        title,
        "29 вересня 2026 року у Києві чоловік викрав велосипед.",
      ),
    ]);
    await run([
      await item(
        3,
        title,
        "У Києві чоловік викрав велосипед. Поліція встановлює обставини.",
      ),
    ]);
    expect((await repo.getIncidents(query)).total).toBe(2);
    expect(
      (await repo.getIncidents({ ...query, from: "2026-09-01T00:00:00Z" }))
        .total,
    ).toBe(3);
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM raw_source_items WHERE reason='possible-duplicate'",
        )
        .get()?.n,
    ).toBe(0);
  });
  it("does not exact-merge identical relative-date posts anchored to different publication days", async () => {
    const first = await item(
      1,
      "У Києві чоловік викрав велосипед",
      "Учора у Києві чоловік викрав велосипед.",
    );
    await run([first]);
    const nextDay = {
      ...first,
      externalId: "UA_National_Police/2",
      sourceUrl: "https://t.me/UA_National_Police/2",
      publishedAt: "2026-10-02T09:00:00.000Z",
    };
    expect((await run([nextDay]))?.published).toBe(1);
    expect(
      (
        await repo.getIncidents({
          ...query,
          from: "2026-09-29T00:00:00Z",
          dateBasis: "event",
        })
      ).total,
    ).toBe(2);
  });
  it("retains other confirmations when the original changes after an exact fingerprint merge", async () => {
    const first = await item(1),
      second = {
        ...first,
        externalId: "UA_National_Police/2",
        sourceUrl: "https://t.me/UA_National_Police/2",
      };
    await run([first, second]);
    await run([
      await item(
        1,
        undefined,
        "У Києві поліцейські викрили шахрайство. Встановлюють обставини нового повідомлення.",
      ),
    ]);
    expect(
      (await repo.getIncidents(query)).items[0].sources
        .map((source) => source.url)
        .sort(),
    ).toEqual([first.sourceUrl, second.sourceUrl].sort());
    await run([await item(1, "На Київщині викрили шахрайство")]);
    expect(
      (await repo.getIncidents(query)).items[0].sources.map(
        (source) => source.url,
      ),
    ).toEqual([second.sourceUrl]);
  });
  it("filters and paginates separately by publication date and proven event date", async () => {
    const undated = await item(1);
    const old = await item(
      2,
      "У Києві чоловік викрав велосипед",
      "1 вересня 2026 року у Києві чоловік викрав велосипед.",
    );
    const recent = await item(
      3,
      "В Одесі сталася ДТП",
      "30 вересня 2026 року в Одесі сталася ДТП.",
    );
    await run([undated, old, recent]);
    const publication = { ...query, dateBasis: "publication" as const };
    const first = await repo.getIncidents(publication);
    expect(first.total).toBe(3);
    const second = await repo.getIncidents({
      ...publication,
      cursor: first.nextCursor!,
    });
    const third = await repo.getIncidents({
      ...publication,
      cursor: second.nextCursor!,
    });
    expect(
      new Set([first.items[0].id, second.items[0].id, third.items[0].id]).size,
    ).toBe(3);
    const event = {
      ...query,
      from: "2026-09-01T00:00:00Z",
      dateBasis: "event" as const,
    };
    const events = await repo.getIncidents(event);
    expect(events.total).toBe(2);
    expect(events.items[0].occurredOn).toBe("2026-09-30");
    expect(
      (await repo.getIncidents({ ...event, cursor: events.nextCursor! }))
        .items[0].occurredOn,
    ).toBe("2026-09-01");
    expect(
      (await repo.getIncidents({ ...query, dateBasis: "event" })).total,
    ).toBe(1);
  });
  it("preserves independently proven event dates and the latest publication while confirmations arrive out of order", async () => {
    const canonicalUrl = "https://example.test/shared-report",
      title = "У Києві чоловік викрав велосипед";
    const first = {
      ...(await item(
        1,
        title,
        "30 вересня 2026 року у Києві чоловік викрав велосипед.",
      )),
      canonicalUrl,
      publishedAt: "2026-10-03T09:00:00.000Z",
    };
    const second = {
      ...(await item(
        2,
        title,
        "У Києві чоловік викрав велосипед. Поліція встановлює обставини.",
      )),
      canonicalUrl,
      publishedAt: "2026-10-01T09:00:00.000Z",
    };
    const third = {
      ...(await item(
        3,
        title,
        "30 вересня 2026 року у Києві чоловік викрав велосипед. Поліція розслідує подію.",
      )),
      canonicalUrl,
      publishedAt: "2026-10-02T09:00:00.000Z",
    };
    await run([first]);
    await run([second]);
    let incident = (await repo.getIncidents(query)).items[0];
    expect(incident).toMatchObject({
      occurredOn: "2026-09-30",
      publishedAt: first.publishedAt,
      eventDateEvidence: { sourceUrl: first.sourceUrl },
    });
    await run([third]);
    await run([
      { ...first, content: second.content, contentHash: second.contentHash },
    ]);
    incident = (await repo.getIncidents(query)).items[0];
    expect(incident).toMatchObject({
      occurredOn: "2026-09-30",
      publishedAt: first.publishedAt,
      eventDateEvidence: { sourceUrl: third.sourceUrl },
    });
    await store.withdraw(policeSource.id, [third.externalId]);
    incident = (await repo.getIncidents(query)).items[0];
    expect(incident.occurredOn).toBeUndefined();
    expect(incident.eventDateEvidence).toBeUndefined();
    expect(incident.publishedAt).toBe(first.publishedAt);
    expect(
      (await repo.getIncidents({ ...query, dateBasis: "event" })).total,
    ).toBe(0);
    await store.withdraw(policeSource.id, [first.externalId]);
    incident = (await repo.getIncidents(query)).items[0];
    expect(incident.publishedAt).toBe(second.publishedAt);
    expect(incident.sources.map((source) => source.url)).toEqual([
      second.sourceUrl,
    ]);
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT event_date,publication_date FROM incidents WHERE is_published=1",
        )
        .get(),
    ).toMatchObject({
      event_date: null,
      publication_date: Date.parse(second.publishedAt),
    });
  });
  it("includes an event with unknown time on the matching Kyiv calendar day near a UTC boundary", async () => {
    const raw = {
      ...(await item(
        1,
        "У Києві чоловік викрав велосипед",
        "6 жовтня 2026 року у Києві чоловік викрав велосипед.",
      )),
      publishedAt: "2026-10-06T19:00:00.000Z",
    };
    await run([raw]);
    const event = {
      ...query,
      dateBasis: "event" as const,
      from: "2026-10-05T22:00:00Z",
      to: "2026-10-05T23:00:00Z",
    };
    expect((await repo.getIncidents(event)).items[0].occurredOn).toBe(
      "2026-10-06",
    );
    expect((await repo.getStatistics(event)).total).toBe(1);
    expect(
      (await repo.getIncidents({ ...event, dateBasis: "publication" })).total,
    ).toBe(0);
  });
  it("bounds a maximum confirmed registry withdrawal plus three new court publications", async () => {
    const source = sourceById("court-decisions")!;
    const store = new D1IngestionStore(sqlite.db, { runKind: "backfill" });
    const records = await Promise.all(
      ["Тернополі", "Києві", "Луцьку"].map(async (city, i) => {
        const content = `Справа №123/${i}/26\nВСТАНОВИВ:\n01.09.2026 у м. ${city} викрав велосипед.`;
        return {
          ...(await item(i + 101)),
          sourceId: source.id,
          externalId: String(i + 101),
          sourceUrl: `https://reyestr.court.gov.ua/Review/${i + 101}`,
          title: "Вирок: Крадіжка",
          content,
          contentHash: await hash(content),
        };
      }),
    );
    sqlite.queries = 0;
    const result = await ingest(
      {
        source,
        collect: async () => {
          await store.withdraw(
            source.id,
            Array.from({ length: 100 }, (_, i) => String(i + 1)),
          );
          return records;
        },
      },
      store,
    );
    expect(result?.published).toBe(3);
    expect(sqlite.queries).toBeLessThanOrEqual(50);
  });
  it("reports source diagnostics without mistaking repeated retrieval for new discovery", async () => {
    const records = await Promise.all(
      Array.from({ length: 6 }, (_, i) => item(i + 400, "Поради", "fixture")),
    );
    await run(records);
    const env: Env = {
      DB: sqlite.db,
      ASSETS: { fetch: async () => new Response() },
    };
    const readStatus = async () =>
      (await (
        await worker.fetch(
          new Request("https://example.test/api/v1/status"),
          env,
        )
      ).json()) as { sources: Array<Record<string, unknown>> };
    const first = (await readStatus()).sources.find(
      (source) => source.id === policeSource.id,
    )!;
    expect(first).toMatchObject({
      pending: 3,
      latestPublicationAt: records[0].publishedAt,
      lastNewItemAt: records.at(-1)!.retrievedAt,
      counts: { collected: 3, rejected: 3 },
    });
    expect(first.oldestPendingAt).toBeTruthy();
    await run(
      records.map((raw) => ({
        ...raw,
        retrievedAt: new Date(Date.now() + 1000).toISOString(),
      })),
    );
    const second = (await readStatus()).sources.find(
      (source) => source.id === policeSource.id,
    )!;
    expect(second.lastNewItemAt).toBe(first.lastNewItemAt);
    expect(second).toMatchObject({
      pending: 0,
      oldestPendingAt: null,
      counts: { rejected: 6 },
      rejectionReasons: { "not-single-supported-incident": 6 },
    });
  });
  it("validates the drain flag and allows only registered sources without fetching", async () => {
    const env: Env = {
      DB: sqlite.db,
      ASSETS: { fetch: async () => new Response() },
      INGESTION_SECRET: "x".repeat(64),
    };
    const drain = (query: string) =>
      worker.fetch(
        new Request(`https://example.test/internal/ingest?${query}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.INGESTION_SECRET}` },
        }),
        env,
      );
    expect((await drain("source=npu-telegram&drain=1")).status).toBe(200);
    expect((await drain("source=court-decisions&drain=1")).status).toBe(410);
    expect((await drain("source=https://example.test&drain=1")).status).toBe(
      400,
    );
    for (const query of [
      "drain=true",
      "drain=0",
      "drain=",
      "drain=1&before=123",
      "drain=1&page=1",
      "drain=1&runKind=poll",
    ])
      expect((await drain(query)).status).toBe(400);
  });
  it("applies the fresh-source migration to existing dates and version history", async () => {
    const legacy = new DatabaseSync(":memory:"),
      dir = new URL("../migrations/", import.meta.url);
    try {
      for (const file of [
        "0001_data.sql",
        "0002_retention_indexes.sql",
        "0003_source_retries.sql",
      ])
        legacy.exec(readFileSync(new URL(file, dir), "utf8"));
      const processed = await new IncidentProcessor().process(await item(1));
      expect(processed.status).toBe("published");
      if (processed.status !== "published")
        throw new Error("Fixture failed processing");
      for (const [id, occurredAt, occurredOn] of [
        ["date", null, "2026-09-30"],
        ["time", "2026-10-01T12:34:56.789Z", undefined],
        ["unknown", null, undefined],
      ] as const) {
        const incident = {
          ...processed.incident,
          id,
          occurredAt,
          occurredOn,
          publishedAt: "2026-10-01T09:00:00.123Z",
        };
        legacy
          .prepare(
            "INSERT INTO incidents(id,category,latitude,longitude,effective_date,published_at,city,public_data,search_text,canonical_key,fingerprint,is_published) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)",
          )
          .run(
            id,
            incident.category,
            incident.location.latitude,
            incident.location.longitude,
            Date.parse(incident.publishedAt),
            incident.publishedAt,
            incident.location.city!,
            JSON.stringify(incident),
            "",
            id,
            id,
          );
      }
      legacy
        .prepare("INSERT INTO sources(id,name,url,metadata) VALUES(?,?,?,'{}')")
        .run(policeSource.id, policeSource.name, policeSource.url);
      legacy
        .prepare(
          "INSERT INTO raw_source_items(id,source_id,external_id,source_url,title,content,published_at,retrieved_at,content_hash,rules,status) VALUES('raw',?,'1','https://example.test','Old title','Old text','2026-10-01','2026-10-02','hash','old','rejected')",
        )
        .run(policeSource.id);
      legacy.exec(
        "INSERT INTO raw_source_item_versions(raw_id,content_hash,title,content,published_at,retrieved_at) VALUES('raw','hash','Old title','Old text','2026-10-01','2026-10-02'); INSERT INTO incident_sources(incident_id,raw_id,source_url) VALUES('date','raw','https://example.test')",
      );
      legacy.exec(readFileSync(new URL("0004_fresh_sources.sql", dir), "utf8"));
      expect(
        legacy
          .prepare(
            "SELECT event_date,publication_date FROM incidents WHERE id='date'",
          )
          .get(),
      ).toMatchObject({
        event_date: Date.parse("2026-09-30T00:00:00Z"),
        publication_date: Date.parse("2026-10-01T09:00:00.123Z"),
      });
      expect(
        legacy.prepare("SELECT event_date FROM incidents WHERE id='time'").get()
          ?.event_date,
      ).toBe(Date.parse("2026-10-01T12:34:56.789Z"));
      expect(
        legacy
          .prepare("SELECT event_date FROM incidents WHERE id='unknown'")
          .get()?.event_date,
      ).toBeNull();
      expect(
        legacy.prepare("SELECT active FROM incident_sources").get()?.active,
      ).toBe(0);
      expect(
        legacy.prepare("SELECT first_seen_at FROM raw_source_items").get()
          ?.first_seen_at,
      ).toBe("2026-10-02");
      expect(
        legacy
          .prepare(
            "SELECT content_hash,content,metadata FROM raw_source_item_versions",
          )
          .get(),
      ).toMatchObject({
        content_hash: "hash",
        content: "Old text",
        metadata: "{}",
      });
    } finally {
      legacy.close();
    }
  });
  it("bounds each maintenance table to 500 rows and keeps public evidence", async () => {
    await run([await item(1)]);
    const insert = sqlite.sqlite.prepare(
      "INSERT INTO processing_jobs(id,raw_id,stage,status,created_at) SELECT ?,id,'fixture','rejected','2020-01-01' FROM raw_source_items LIMIT 1",
    );
    for (let i = 0; i < 501; i++) insert.run(`old-${i}`);
    sqlite.queries = 0;
    await maintainPrivateData(sqlite.db);
    expect(sqlite.queries).toBe(5);
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM processing_jobs WHERE created_at='2020-01-01'",
        )
        .get()?.n,
    ).toBe(1);
    expect((await repo.getIncidents(query)).total).toBe(1);
  });
});

class TaskQueue {
  messages: IngestionTask[] = [];
  failSend = false;
  async send(body: IngestionTask) {
    return this.sendBatch([{ body }]);
  }
  async sendBatch(batch: { body: IngestionTask }[]) {
    if (this.failSend) {
      this.failSend = false;
      throw new Error("Queue temporarily unavailable");
    }
    this.messages.push(...batch.map((m) => m.body));
  }
  get producer() {
    return this as unknown as Queue<IngestionTask>;
  }
}

describe("hourly fan-out and durable queue", () => {
  let sqlite: SQLite, queue: TaskQueue;
  const anchor = Date.parse("2026-10-07T08:00:00Z");
  beforeEach(() => {
    sqlite = new SQLite();
    queue = new TaskQueue();
  });
  afterEach(() => sqlite.sqlite.close());
  const state = (db: SQLite) =>
    db.sqlite.prepare("SELECT * FROM sources WHERE id=?").get(policeSource.id);
  async function seed(records: RawItem[]) {
    const store = new D1IngestionStore(sqlite.db, {
      runKind: "backfill",
      now: () => anchor,
    });
    await store.begin(policeSource);
    await store.stage(records, policeSource.id);
    sqlite.sqlite.prepare("UPDATE sources SET lease_until=0").run();
  }
  it("checks every registered web source in one hourly cycle and isolates a failed feed", async () => {
    const fetched: string[] = [];
    const activeCount = sources.filter(
      (s) => s.enabled !== false && s.transport !== "court",
    ).length;
    expect(
      (await dispatchHourly(sqlite.db, queue.producer, anchor)).dispatched,
    ).toBe(activeCount);
    await dispatchHourly(sqlite.db, queue.producer, anchor + 1000);
    expect(queue.messages).toHaveLength(activeCount);
    while (queue.messages.length) {
      sqlite.queries = 0;
      await consumeTask(
        sqlite.db,
        queue.producer,
        queue.messages.shift()!,
        anchor + 2000,
        (id) => ({
          source: sourceById(id)!,
          collect: async () => {
            fetched.push(id);
            if (id === "npu-news") throw new Error("Source HTTP 403");
            return [];
          },
        }),
      );
      expect(sqlite.queries).toBeLessThanOrEqual(50);
    }
    expect(new Set(fetched).size).toBe(activeCount);
    expect(
      sqlite.sqlite
        .prepare("SELECT last_error FROM sources WHERE id='npu-news'")
        .get()?.last_error,
    ).toBe("Source HTTP 403");
  });
  it("drains persisted work immediately and never re-fetches during continuation or redelivery", async () => {
    const records = await Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        item(600 + i, "Поради", `fixture ${i}`),
      ),
    );
    const fetched: string[] = [];
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    const first = queue.messages.shift()!;
    const factory = () => ({
      source: policeSource,
      collect: async () => {
        fetched.push(policeSource.id);
        return records;
      },
    });
    await consumeTask(sqlite.db, queue.producer, first, anchor, factory);
    const pollState = state(sqlite);
    await consumeTask(sqlite.db, queue.producer, first, anchor + 1000, factory);
    expect(queue.messages).toHaveLength(1);
    while (queue.messages.length) {
      sqlite.queries = 0;
      await consumeTask(
        sqlite.db,
        queue.producer,
        queue.messages.shift()!,
        anchor + 2000,
        factory,
      );
      expect(sqlite.queries).toBeLessThanOrEqual(50);
    }
    expect(fetched).toHaveLength(1);
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM raw_source_items WHERE status='collected'",
        )
        .get()?.n,
    ).toBe(0);
    expect(state(sqlite)).toMatchObject({
      last_success_at: pollState!.last_success_at,
      next_attempt_at: pollState!.next_attempt_at,
    });
  });
  it("excludes archived court work from dispatch and recovery, and safely retires old deliveries", async () => {
    sqlite.sqlite
      .prepare(
        "INSERT INTO sources(id,name,url,metadata) VALUES('court-decisions','court','https://data.gov.ua/','{}')",
      )
      .run();
    sqlite.sqlite
      .prepare(
        "INSERT INTO raw_source_items(id,source_id,external_id,source_url,title,content,retrieved_at,content_hash,rules,status,first_seen_at) VALUES('court','court-decisions','123','https://reyestr.court.gov.ua/Review/123','Поради','fixture',?,'hash',?,'collected',?)",
      )
      .run(
        new Date(anchor).toISOString(),
        ruleVersion,
        new Date(anchor).toISOString(),
      );
    await dispatchHourly(sqlite.db, queue.producer, anchor, [
      sourceById("court-decisions")!,
    ]);
    expect(queue.messages).toHaveLength(0);
    sqlite.sqlite
      .prepare(
        "INSERT INTO ingestion_tasks(id,source_id,cycle,step,kind,created_at) VALUES('archived','court-decisions',?,0,'process',?),('archived-next','court-decisions',?,1,'process',?)",
      )
      .run(anchor, anchor, anchor, anchor);
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    expect(
      queue.messages.every(
        ({ id }) => id !== "archived" && id !== "archived-next",
      ),
    ).toBe(true);
    const messagesBefore = queue.messages.length;
    const result = await consumeTask(
      sqlite.db,
      queue.producer,
      { id: "archived" },
      anchor,
      () => {
        throw new Error("Court process must not fetch");
      },
    );
    expect(result).toMatchObject({ skipped: true, archived: true });
    expect(queue.messages).toHaveLength(messagesBefore);
    expect(
      sqlite.sqlite
        .prepare("SELECT status FROM ingestion_tasks WHERE id='archived'")
        .get()?.status,
    ).toBe("done");
    await consumeTask(
      sqlite.db,
      queue.producer,
      { id: "archived" },
      anchor + 1,
    );
    expect(queue.messages).toHaveLength(messagesBefore);
    expect(
      sqlite.sqlite
        .prepare("SELECT status FROM raw_source_items WHERE id='court'")
        .get()?.status,
    ).toBe("collected");
  });
  it("delays the next hourly poll when its actual 60-minute interval has not elapsed", async () => {
    let fetches = 0;
    const factory = () => ({
      source: policeSource,
      collect: async () => {
        fetches++;
        return [];
      },
    });
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    await consumeTask(
      sqlite.db,
      queue.producer,
      queue.messages.shift()!,
      anchor + 5000,
      factory,
    );
    await dispatchHourly(sqlite.db, queue.producer, anchor + 3600000, [
      policeSource,
    ]);
    const next = queue.messages.shift()!;
    expect(
      await consumeTask(
        sqlite.db,
        queue.producer,
        next,
        anchor + 3600000,
        factory,
      ),
    ).toEqual({ retryAfter: 5 });
    expect(fetches).toBe(1);
    await consumeTask(
      sqlite.db,
      queue.producer,
      next,
      anchor + 3605000,
      factory,
    );
    expect(fetches).toBe(2);
  });
  it("recovers a failed successor send after the poll completed, without fetching twice", async () => {
    const records = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        item(950 + i, "Поради", `fixture ${i}`),
      ),
    );
    let fetches = 0;
    const factory = () => ({
      source: policeSource,
      collect: async () => {
        fetches++;
        return records;
      },
    });
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    const first = queue.messages.shift()!;
    queue.failSend = true;
    await expect(
      consumeTask(sqlite.db, queue.producer, first, anchor, factory),
    ).rejects.toThrow("Queue temporarily unavailable");
    await consumeTask(sqlite.db, queue.producer, first, anchor + 1000, factory);
    expect(fetches).toBe(1);
    expect(queue.messages).toHaveLength(1);
    await consumeTask(
      sqlite.db,
      queue.producer,
      queue.messages.shift()!,
      anchor + 1000,
      factory,
    );
    expect(
      sqlite.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM raw_source_items WHERE status='collected'",
        )
        .get()?.n,
    ).toBe(0);
  });
  it("turns a delayed previous-hour poll into process-only work", async () => {
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    const task = queue.messages.shift()!;
    expect(
      await consumeTask(
        sqlite.db,
        queue.producer,
        task,
        anchor + 3600000,
        () => {
          throw new Error("Stale poll must not fetch");
        },
      ),
    ).toMatchObject({ kind: "process" });
    expect(state(sqlite)?.last_attempt_at).toBeNull();
  });
  it("recovers an unsent outbox after queue failure and waits on a shared source lease", async () => {
    queue.failSend = true;
    await expect(
      dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]),
    ).rejects.toThrow("Queue temporarily unavailable");
    expect(
      (await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]))
        .dispatched,
    ).toBe(1);
    const task = queue.messages.shift()!;
    sqlite.sqlite
      .prepare("UPDATE sources SET lease_until=?")
      .run(anchor + 60000);
    expect(
      await consumeTask(sqlite.db, queue.producer, task, anchor, () => {
        throw new Error("No fetch under lease");
      }),
    ).toEqual({ retryAfter: 60 });
  });
  it("processes fresh collected work ahead of obsolete rules and subsequently reprocesses old work", async () => {
    await seed([
      await item(701, "Поради", "old"),
      await item(702, "Поради", "new"),
    ]);
    sqlite.sqlite
      .prepare(
        "UPDATE raw_source_items SET rules='old',status='review' WHERE external_id=?",
      )
      .run("UA_National_Police/701");
    const store = new D1IngestionStore(sqlite.db, {
      runKind: "process",
      maxItems: 2,
    });
    expect(
      (await store.stage([], policeSource.id)).map((r) => r.externalId),
    ).toEqual(["UA_National_Police/702", "UA_National_Police/701"]);
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    await consumeTask(
      sqlite.db,
      queue.producer,
      queue.messages.shift()!,
      anchor,
      () => ({ source: policeSource, collect: async () => [] }),
    );
    expect(
      sqlite.sqlite
        .prepare("SELECT COUNT(*) n FROM raw_source_items WHERE rules<>?")
        .get(ruleVersion)?.n,
    ).toBe(0);
  });
  it("keeps a full 30-item page with two new publications and an obsolete three-publication drain within 50 queries", async () => {
    const records = [
      await item(801),
      await item(802, "В Одесі сталася ДТП"),
      await item(803, "У Луцьку викрили нарколабораторію"),
      ...(await Promise.all(
        Array.from({ length: 27 }, (_, i) =>
          item(804 + i, "Поради", `fixture ${i}`),
        ),
      )),
    ];
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    sqlite.queries = 0;
    const poll = await consumeTask(
      sqlite.db,
      queue.producer,
      queue.messages.shift()!,
      anchor,
      () => ({ source: policeSource, collect: async () => records }),
    );
    expect(poll).toMatchObject({ result: { published: 2 } });
    expect(sqlite.queries).toBeLessThanOrEqual(50);
    sqlite.sqlite
      .prepare("UPDATE raw_source_items SET status='rejected'")
      .run();
    sqlite.sqlite
      .prepare(
        "UPDATE raw_source_items SET rules='old',status='review' WHERE external_id IN ('UA_National_Police/801','UA_National_Police/802','UA_National_Police/803')",
      )
      .run();
    sqlite.queries = 0;
    expect(
      await consumeTask(
        sqlite.db,
        queue.producer,
        queue.messages.shift()!,
        anchor + 1000,
      ),
    ).toMatchObject({ result: { changed: 3 } });
    expect(sqlite.queries).toBeLessThanOrEqual(50);
  });
  it("bounds continuation per cycle and daily processing capacity while reserving hourly polls", async () => {
    await seed([
      await item(901, "Поради", "fixture"),
      await item(902, "Поради", "fixture"),
      await item(903, "Поради", "fixture"),
      await item(904, "Поради", "fixture"),
    ]);
    sqlite.sqlite
      .prepare(
        "INSERT INTO ingestion_tasks(id,source_id,cycle,step,kind,created_at) VALUES('last',?,?,?,'process',?)",
      )
      .run(policeSource.id, anchor, maxCycleSteps - 1, anchor);
    await consumeTask(sqlite.db, queue.producer, { id: "last" }, anchor);
    expect(queue.messages).toHaveLength(0);
    const insert = sqlite.sqlite.prepare(
      "INSERT INTO ingestion_tasks(id,source_id,cycle,step,kind,created_at,status) VALUES(?,?,?,?,'process',?,'done')",
    );
    for (let i = 0; i < dailyProcessBudget - 1; i++)
      insert.run(`budget-${i}`, policeSource.id, anchor, i + 500, anchor);
    await dispatchHourly(sqlite.db, queue.producer, anchor, [policeSource]);
    expect(queue.messages).toHaveLength(1);
    await consumeTask(
      sqlite.db,
      queue.producer,
      queue.messages.shift()!,
      anchor,
      () => ({ source: policeSource, collect: async () => [] }),
    );
    expect(queue.messages).toHaveLength(0);
    expect(
      sqlite.sqlite
        .prepare("SELECT COUNT(*) n FROM ingestion_tasks WHERE kind='process'")
        .get()?.n,
    ).toBe(dailyProcessBudget);
  });
});
