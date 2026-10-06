import { Pool } from "pg";
import {
  categories,
  decodeCursor,
  encodeCursor,
  queryDateBounds,
  previousDateBounds,
  type Incident,
  type IncidentQuery,
  type IncidentResponse,
  type IncidentsRepository,
  type IncidentStatistics,
} from "@crime-radar/shared";
export function where(
  q: IncidentQuery,
  mode: "real" | "demo" = "real",
  range = queryDateBounds(q),
) {
  const values: unknown[] = [
    q.west,
    q.south,
    q.east,
    q.north,
    new Date(range.from).toISOString(),
    new Date(range.to).toISOString(),
  ];
  const dateFilter =
    q.dateBasis === "event"
      ? "((public_data->>'occurredAt' IS NOT NULL AND occurred_at >= $5::timestamptz AND occurred_at <= $6::timestamptz) OR (public_data->>'occurredAt' IS NULL AND occurred_at >= $7::timestamptz AND occurred_at <= $8::timestamptz))"
      : `${dateColumn(q)} >= $5::timestamptz AND ${dateColumn(q)} <= $6::timestamptz`;
  if (q.dateBasis === "event")
    values.push(
      new Date(range.dayFrom).toISOString(),
      new Date(range.dayTo).toISOString(),
    );
  const clauses = [
    "public_location && ST_MakeEnvelope($1,$2,$3,$4,4326)",
    dateFilter,
    "is_published = true",
    mode === "demo"
      ? "public_data->>'synthetic'='true'"
      : "COALESCE(public_data->>'synthetic','false')<>'true'",
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
function dateColumn(q: IncidentQuery) {
  return q.dateBasis === "event"
    ? "occurred_at"
    : q.dateBasis === "publication"
      ? "published_at"
      : "COALESCE(occurred_at,reported_at,published_at)";
}
export class PostgresIncidentsRepository implements IncidentsRepository {
  constructor(
    readonly pool: Pool,
    readonly mode: "real" | "demo" = "real",
  ) {}
  async getIncidents(q: IncidentQuery): Promise<IncidentResponse> {
    const w = where(q, this.mode),
      limit = q.limit ?? 500;
    const pageValues = [...w.values];
    let after = "";
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor);
      if (cursor.dateBasis !== q.dateBasis)
        throw new Error("Cursor date basis does not match query");
      pageValues.push(cursor.date, cursor.id);
      const dateIndex = pageValues.length - 1;
      after = ` AND (${dateColumn(q)} < $${dateIndex}::timestamptz OR (${dateColumn(q)} = $${dateIndex}::timestamptz AND id > $${dateIndex + 1}))`;
    }
    pageValues.push(limit + 1);
    const result = await this.pool.query<{ public_data: Incident }>(
      `SELECT public_data FROM incidents WHERE ${w.text}${after} ORDER BY ${dateColumn(q)} DESC,id ASC LIMIT $${pageValues.length}`,
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
        result.rows.length > limit
          ? encodeCursor(items.at(-1)!, q.dateBasis)
          : null,
    };
  }
  async getIncident(id: string): Promise<Incident> {
    const result = await this.pool.query<{ public_data: Incident }>(
      `SELECT public_data FROM incidents WHERE id=$1 AND is_published=true AND ${this.mode === "demo" ? "public_data->>'synthetic'='true'" : "COALESCE(public_data->>'synthetic','false')<>'true'"}`,
      [id],
    );
    if (!result.rows[0]) throw new Error("Incident not found");
    return result.rows[0].public_data;
  }
  async getStatistics(q: IncidentQuery): Promise<IncidentStatistics> {
    const w = where(q, this.mode);
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
    const p = where(q, this.mode, previousDateBounds(q));
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
