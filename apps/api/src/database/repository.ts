import { Pool } from "pg";
import {
  categories,
  decodeCursor,
  encodeCursor,
  type Incident,
  type IncidentQuery,
  type IncidentResponse,
  type IncidentsRepository,
  type IncidentStatistics,
} from "@crime-radar/shared";
export function where(q: IncidentQuery) {
  const values: unknown[] = [q.west, q.south, q.east, q.north, q.from, q.to];
  const clauses = [
    "public_location && ST_MakeEnvelope($1,$2,$3,$4,4326)",
    "COALESCE(occurred_at,reported_at,published_at) >= $5::timestamptz",
    "COALESCE(occurred_at,reported_at,published_at) <= $6::timestamptz",
    "is_published = true",
  ];
  if (q.categories?.length) {
    values.push(q.categories);
    clauses.push(`category = ANY($${values.length}::text[])`);
  }
  if (q.query?.trim()) {
    const terms = q.query
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    for (const term of terms) {
      values.push(term);
      clauses.push(`strpos(lower(search_text),$${values.length}) > 0`);
    }
  }
  return { text: clauses.join(" AND "), values };
}
export class PostgresIncidentsRepository implements IncidentsRepository {
  constructor(readonly pool: Pool) {}
  async getIncidents(q: IncidentQuery): Promise<IncidentResponse> {
    const w = where(q),
      limit = q.limit ?? 500;
    const pageValues = [...w.values];
    let after = "";
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor);
      pageValues.push(cursor.date, cursor.id);
      const dateIndex = pageValues.length - 1;
      after = ` AND (COALESCE(occurred_at,reported_at,published_at) < $${dateIndex}::timestamptz OR (COALESCE(occurred_at,reported_at,published_at) = $${dateIndex}::timestamptz AND id > $${dateIndex + 1}))`;
    }
    pageValues.push(limit + 1);
    const result = await this.pool.query<{ public_data: Incident }>(
      `SELECT public_data FROM incidents WHERE ${w.text}${after} ORDER BY COALESCE(occurred_at,reported_at,published_at) DESC,id ASC LIMIT $${pageValues.length}`,
      pageValues,
    );
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM incidents WHERE ${w.text}`,
      w.values,
    );
    const total = Number(count.rows[0].total);
    const items = result.rows.slice(0, limit).map((r) => r.public_data);
    return {
      items,
      total,
      nextCursor:
        result.rows.length > limit ? encodeCursor(items.at(-1)!) : null,
    };
  }
  async getIncident(id: string): Promise<Incident> {
    const result = await this.pool.query<{ public_data: Incident }>(
      "SELECT public_data FROM incidents WHERE id=$1 AND is_published=true",
      [id],
    );
    if (!result.rows[0]) throw new Error("Incident not found");
    return result.rows[0].public_data;
  }
  async getStatistics(q: IncidentQuery): Promise<IncidentStatistics> {
    const w = where(q);
    const counts = await this.pool.query<{
      category: Incident["category"];
      total: string;
    }>(
      `SELECT category,COUNT(*) AS total FROM incidents WHERE ${w.text} GROUP BY category`,
      w.values,
    );
    const result = Object.fromEntries(categories.map((c) => [c, 0])) as Record<
      Incident["category"],
      number
    >;
    counts.rows.forEach((r) => (result[r.category] = Number(r.total)));
    const duration = Date.parse(q.to) - Date.parse(q.from);
    const p = where({
      ...q,
      from: new Date(Date.parse(q.from) - duration - 1).toISOString(),
      to: new Date(Date.parse(q.from) - 1).toISOString(),
    });
    const previous = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM incidents WHERE ${p.text}`,
      p.values,
    );
    return {
      total: Object.values(result).reduce((a, b) => a + b, 0),
      categories: result,
      previousPeriodTotal: Number(previous.rows[0].total),
    };
  }
}
