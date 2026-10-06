import { Pool } from "pg";
import { PoliceTelegramCollector } from "./collector";
import { PostgresIngestionStore } from "./postgres-store";
import { ingest } from "./runner";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const result = await ingest(
    new PoliceTelegramCollector(),
    new PostgresIngestionStore(pool),
    { pages: Number(process.env.INGEST_PAGES ?? 3) },
  );
  console.log(
    JSON.stringify({ source: "npu-telegram", result, skipped: !result }),
  );
} finally {
  await pool.end();
}
