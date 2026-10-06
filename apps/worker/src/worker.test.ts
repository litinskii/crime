import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { D1IngestionStore } from "./store";
import { D1IncidentsRepository } from "./repository";
import worker, { type Env } from "./index";
import { policeSource } from "../../api/src/ingestion/collector";
import { hash } from "../../api/src/ingestion/hash";
import { ingest } from "../../api/src/ingestion/runner";
import type { RawItem } from "../../api/src/ingestion/types";

// Execute the actual D1 SQL against SQLite, including transactional batch semantics.
class Statement {
  values: SQLInputValue[] = [];
  constructor(
    readonly owner: SQLite,
    readonly text: string,
  ) {}
  bind(...values: SQLInputValue[]) {
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
    this.sqlite.exec(
      readFileSync(
        new URL("../migrations/0001_data.sql", import.meta.url),
        "utf8",
      ),
    );
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
  it("protects collection and exposes no private raw routes", async () => {
    const env: Env = {
      DB: sqlite.db,
      ASSETS: { fetch: async () => new Response("asset") },
      INGESTION_SECRET: "x".repeat(64),
    };
    const fetch = (path: string, method = "GET") =>
      worker.fetch(new Request(`https://example.test${path}`, { method }), env);
    expect((await fetch("/internal/ingest", "POST")).status).toBe(401);
    expect((await fetch("/api/v1/raw")).status).toBe(404);
    expect((await fetch("/api/v1/incidents?north=bad")).status).toBe(400);
    expect((await fetch("/api/v1/incidents/no-such-id")).status).toBe(404);
    expect((await fetch("/health")).status).toBe(200);
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
      sqlite.sqlite.prepare("SELECT content,rules FROM raw_source_items").get(),
    ).toMatchObject({ content: "[expired]", rules: "expired" });
    expect((await repo.getIncidents(query)).items[0].sources[0].url).toBe(
      "https://t.me/UA_National_Police/1",
    );
  });
});
