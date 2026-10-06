import { Pool } from "pg";
import { createCollector } from "./web-collector";
import { PostgresIngestionStore } from "./postgres-store";
import { ingest } from "./runner";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const result = await ingest(
    createCollector(process.env.INGEST_SOURCE ?? "npu-telegram"),
    new PostgresIngestionStore(pool),
    {
      pages: Number(process.env.INGEST_PAGES ?? 3),
      page: Number(process.env.INGEST_PAGE) || undefined,
    },
  );
  console.log(
    JSON.stringify({
      source: process.env.INGEST_SOURCE ?? "npu-telegram",
      result,
      skipped: !result,
    }),
  );
} finally {
  await pool.end();
}
