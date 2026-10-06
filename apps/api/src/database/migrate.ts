import { readFile } from "node:fs/promises";
import { Pool } from "pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  for (const name of [
    "001_initial.sql",
    "002_ingestion.sql",
    "003_date_basis.sql",
  ])
    await pool.query(await readFile(new URL(name, import.meta.url), "utf8"));
  console.log("PostGIS schema ready");
} finally {
  await pool.end();
}
