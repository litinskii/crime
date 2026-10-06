import { Pool } from "pg";
import { createMockIncidents } from "@crime-radar/shared";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = await pool.connect();
try {
  await connection.query("BEGIN");
  await connection.query(
    "INSERT INTO sources(id,name,enabled) VALUES('demo','Synthetic dataset',false) ON CONFLICT(id) DO NOTHING",
  );
  for (const item of createMockIncidents()) {
    const search = [
      item.title.uk,
      item.title.en,
      item.description?.uk,
      item.description?.en,
      ...item.keywords,
      item.location.city,
      item.location.cityEn,
      item.legalQualification?.article,
    ].join(" ");
    await connection.query(
      "INSERT INTO incidents(id,category,occurred_at,reported_at,public_location,public_data,search_text,confidence,is_published) VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326),$7,$8,1,true) ON CONFLICT(id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,reported_at=EXCLUDED.reported_at,public_data=EXCLUDED.public_data,search_text=EXCLUDED.search_text,updated_at=now()",
      [
        item.id,
        item.category,
        item.occurredAt,
        item.reportedAt,
        item.location.longitude,
        item.location.latitude,
        JSON.stringify(item),
        search,
      ],
    );
    await connection.query(
      "INSERT INTO incident_sources(incident_id,source_id,source_url) VALUES($1,'demo','urn:crime-radar:synthetic') ON CONFLICT DO NOTHING",
      [item.id],
    );
  }
  await connection.query("COMMIT");
  console.log("Seeded 270 fictional bilingual incidents");
} catch (error) {
  await connection.query("ROLLBACK");
  throw error;
} finally {
  connection.release();
  await pool.end();
}
