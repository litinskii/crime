import { describe, it, expect } from "vitest";
import { Pool } from "pg";
import { PostgresIncidentsRepository } from "./repository";
describe.skipIf(!process.env.TEST_DATABASE_URL)("PostGIS integration", () => {
  it("queries public bounds and traverses stable cursors without duplicate rows", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const repository = new PostgresIncidentsRepository(pool, "demo");
    const q = {
      north: 53,
      south: 44,
      east: 40,
      west: 22,
      from: new Date(Date.now() - 365 * 86400000).toISOString(),
      to: new Date().toISOString(),
      limit: 17,
    };
    try {
      let cursor: string | undefined;
      const ids = new Set<string>();
      do {
        const page = await repository.getIncidents({ ...q, cursor });
        expect(page.total).toBe(270);
        for (const item of page.items) {
          expect(ids.has(item.id)).toBe(false);
          ids.add(item.id);
          expect(item.sources.length).toBeGreaterThan(0);
          expect(item).not.toHaveProperty("originalLatitude");
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids.size).toBe(270);
      const stats = await repository.getStatistics({
        ...q,
        north: 50.6,
        south: 50.3,
        west: 30.2,
        east: 30.8,
      });
      expect(stats.total).toBe(27);
      expect(Object.values(stats.categories).reduce((a, b) => a + b, 0)).toBe(
        27,
      );
      const privateTables = await pool.query(
        "SELECT count(*) FROM information_schema.tables WHERE table_name='incident_private_locations'",
      );
      expect(Number(privateTables.rows[0].count)).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
