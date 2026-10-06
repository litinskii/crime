import type { D1Database } from "@cloudflare/workers-types";
import {
  categories,
  decodeCursor,
  encodeCursor,
  queryDateBounds,
  previousDateBounds,
  type Incident,
  type IncidentQuery,
  type IncidentsRepository,
} from "@crime-radar/shared";
function where(q: IncidentQuery, range = queryDateBounds(q)) {
  const values: (string | number)[] = [
    q.south,
    q.north,
    q.west,
    q.east,
    range.from,
    range.to,
  ];
  const dateFilter =
    q.dateBasis === "event"
      ? "((json_extract(public_data,'$.occurredAt') IS NOT NULL AND event_date BETWEEN ? AND ?) OR (json_extract(public_data,'$.occurredAt') IS NULL AND event_date BETWEEN ? AND ?))"
      : `${dateColumn(q)} BETWEEN ? AND ?`;
  if (q.dateBasis === "event") values.push(range.dayFrom, range.dayTo);
  let sql = `is_published=1 AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND ${dateFilter}`;
  if (q.categories?.length) {
    sql += ` AND category IN (${q.categories.map(() => "?").join(",")})`;
    values.push(...q.categories);
  }
  for (const term of q.query
    ?.toLocaleLowerCase("uk")
    .trim()
    .split(/\s+/)
    .filter(Boolean) ?? []) {
    sql += " AND instr(search_text,?)>0";
    values.push(term);
  }
  return { sql, values };
}
function dateColumn(q: IncidentQuery) {
  return q.dateBasis === "event"
    ? "event_date"
    : q.dateBasis === "publication"
      ? "publication_date"
      : "effective_date";
}
export class D1IncidentsRepository implements IncidentsRepository {
  constructor(readonly db: D1Database) {}
  async getIncidents(q: IncidentQuery) {
    const filter = where(q),
      values = [...filter.values],
      limit = Math.min(q.limit ?? 500, 500);
    let after = "";
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor);
      if (cursor.dateBasis !== q.dateBasis)
        throw new Error("Cursor date basis does not match query");
      after = ` AND (${dateColumn(q)}<? OR (${dateColumn(q)}=? AND id>?))`;
      values.push(Date.parse(cursor.date), Date.parse(cursor.date), cursor.id);
    }
    const [rows, total] = await this.db.batch([
      this.db
        .prepare(
          `SELECT public_data FROM incidents WHERE ${filter.sql}${after} ORDER BY ${dateColumn(q)} DESC,id ASC LIMIT ?`,
        )
        .bind(...values, limit + 1),
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM incidents WHERE ${filter.sql}`)
        .bind(...filter.values),
    ]);
    const data = rows.results as { public_data: string }[];
    const items = data
      .slice(0, limit)
      .map((r) => JSON.parse(r.public_data) as Incident);
    return {
      items,
      total: Number((total.results[0] as { total: number }).total),
      nextCursor:
        data.length > limit ? encodeCursor(items.at(-1)!, q.dateBasis) : null,
    };
  }
  async getIncident(id: string) {
    const row = await this.db
      .prepare(
        "SELECT public_data FROM incidents WHERE id=? AND is_published=1",
      )
      .bind(id)
      .first<{ public_data: string }>();
    if (!row) throw new Error("Incident not found");
    return JSON.parse(row.public_data) as Incident;
  }
  async getStatistics(q: IncidentQuery) {
    const filter = where(q);
    const previous = where(q, previousDateBounds(q));
    const [rows, prior] = await this.db.batch([
      this.db
        .prepare(
          `SELECT category,COUNT(*) AS total FROM incidents WHERE ${filter.sql} GROUP BY category`,
        )
        .bind(...filter.values),
      this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM incidents WHERE ${previous.sql}`,
        )
        .bind(...previous.values),
    ]);
    const counts = Object.fromEntries(
      categories.map((category) => [category, 0]),
    ) as Record<Incident["category"], number>;
    for (const row of rows.results as {
      category: Incident["category"];
      total: number;
    }[])
      counts[row.category] = row.total;
    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      categories: counts,
      previousPeriodTotal: Number(
        (prior.results[0] as { total: number }).total,
      ),
    };
  }
}
