import { describe, it, expect } from "vitest";
import {
  createMockIncidents,
  filterIncidents,
  calculateStatistics,
  paginate,
  categories,
  type IncidentQuery,
} from "./index";
const data = createMockIncidents(new Date("2026-10-06T12:00:00Z"));
const q: IncidentQuery = {
  north: 53,
  south: 44,
  west: 22,
  east: 40,
  from: "2025-10-06T00:00:00Z",
  to: "2026-10-06T12:00:00Z",
};
describe("public incident queries", () => {
  it("covers ten cities and every category with bilingual synthetic content", () => {
    expect(data).toHaveLength(270);
    expect(new Set(data.map((x) => x.location.city)).size).toBe(10);
    expect(new Set(data.map((x) => x.category)).size).toBe(categories.length);
    expect(
      data.every((x) => x.title.uk && x.title.en && x.location.approximate),
    ).toBe(true);
  });
  it("combines bounds, time, categories and bilingual search", () => {
    const found = filterIncidents(data, {
      ...q,
      north: 50.6,
      south: 50.3,
      west: 30.2,
      east: 30.8,
      categories: ["theft"],
      query: "велосипед",
    });
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.every((x) => x.category === "theft" && x.location.city === "Київ"),
    ).toBe(true);
    expect(filterIncidents(data, { ...q, query: "nonexistent" })).toEqual([]);
  });
  it("uses reported time for unknown event times", () => {
    const item = {
      ...data[0],
      occurredAt: null,
      reportedAt: "2026-10-01T00:00:00Z",
    };
    expect(filterIncidents([item], q)).toHaveLength(1);
  });
  it("paginates without losing rows or inflating statistics", () => {
    const items = filterIncidents(data, q);
    const first = paginate(items, { ...q, limit: 20 });
    const second = paginate(items, {
      ...q,
      limit: 20,
      cursor: first.nextCursor!,
    });
    expect(first.total).toBe(270);
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(40);
    expect(calculateStatistics(data, q).total).toBe(270);
  });
  it("compares equal periods without including the boundary twice", () => {
    const stats = calculateStatistics(data, {
      ...q,
      from: "2026-09-29T12:00:00Z",
    });
    expect(stats.total).toBeGreaterThan(0);
    expect(Object.values(stats.categories).reduce((a, b) => a + b, 0)).toBe(
      stats.total,
    );
    expect(stats.previousPeriodTotal).toBeGreaterThan(0);
  });
  it("keeps cursor order for equivalent timestamps with different offsets", () => {
    const items = filterIncidents(
      [
        { ...data[0], id: "a", occurredAt: "2026-10-01T08:00:00Z" },
        { ...data[0], id: "b", occurredAt: "2026-10-01T11:00:00+03:00" },
      ],
      q,
    );
    const first = paginate(items, { ...q, limit: 1 });
    const second = paginate(items, {
      ...q,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(first.items[0].id).toBe("a");
    expect(second.items[0].id).toBe("b");
  });
});
