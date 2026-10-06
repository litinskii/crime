import { describe, expect, it } from "vitest";
import {
  calculateStatistics,
  createMockIncidents,
  decodeCursor,
  filterIncidents,
  paginate,
  kyivCalendarRange,
  queryDateBounds,
  type Incident,
  type IncidentQuery,
} from "./index";
const base = createMockIncidents(new Date("2026-10-06T12:00:00Z"))[0];
const items: Incident[] = [
  {
    ...base,
    id: "old",
    occurredAt: null,
    occurredOn: "2025-11-27",
    publishedAt: "2026-10-05T09:00:00Z",
  },
  {
    ...base,
    id: "unknown",
    occurredAt: null,
    publishedAt: "2026-10-05T10:00:00Z",
    reportedAt: "2026-10-05T08:00:00Z",
  },
  {
    ...base,
    id: "fresh",
    occurredAt: null,
    occurredOn: "2026-10-05",
    publishedAt: "2026-10-06T09:00:00Z",
  },
];
const q: IncidentQuery = {
  north: 53,
  south: 44,
  east: 40,
  west: 22,
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-06T23:59:59Z",
};
describe("event and publication periods", () => {
  it("compares date-only events against preceding, non-overlapping calendar days", () => {
    const partialDay = {
      ...q,
      dateBasis: "event" as const,
      from: "2026-10-05T12:00:00Z",
      to: "2026-10-06T12:00:00Z",
    };
    const data: Incident[] = [3, 4, 5, 6].map((day) => ({
      ...base,
      id: String(day),
      occurredAt: null,
      occurredOn: `2026-10-0${day}`,
    }));
    expect(calculateStatistics(data, partialDay)).toMatchObject({
      total: 2,
      previousPeriodTotal: 2,
    });
  });
  it("rejects impossible cursor dates before they reach the database", () => {
    const cursor = btoa(
      JSON.stringify({
        date: "2026-02-30T00:00:00Z",
        id: "x",
        dateBasis: "event",
      }),
    );
    expect(() => decodeCursor(cursor)).toThrow("Invalid cursor");
    expect(() => kyivCalendarRange("2026-02-28", "2026-02-30")).toThrow(
      "Invalid calendar date",
    );
  });
  it("includes a Kyiv date-only event immediately after local midnight", () => {
    const query: IncidentQuery = {
      ...q,
      dateBasis: "event",
      from: "2026-10-05T21:00:00Z",
      to: "2026-10-05T22:00:00Z",
    };
    const nightItems: Incident[] = [
      {
        ...base,
        id: "today",
        occurredAt: null,
        occurredOn: "2026-10-06",
        publishedAt: query.to,
      },
      {
        ...base,
        id: "yesterday",
        occurredAt: null,
        occurredOn: "2026-10-05",
        publishedAt: query.to,
      },
      {
        ...base,
        id: "exact-in-range",
        occurredAt: "2026-10-05T21:30:00Z",
        publishedAt: query.to,
      },
      {
        ...base,
        id: "exact-after-range",
        occurredAt: "2026-10-06T00:00:00Z",
        occurredOn: "2026-10-06",
        publishedAt: query.to,
      },
      { ...base, id: "unknown", occurredAt: null, publishedAt: query.to },
    ];
    expect(filterIncidents(nightItems, query).map((item) => item.id)).toEqual([
      "today",
      "exact-in-range",
    ]);
    expect(queryDateBounds(query)).toMatchObject({
      dayFrom: Date.parse("2026-10-06T00:00:00Z"),
      dayTo: Date.parse("2026-10-06T00:00:00Z"),
    });
  });
  it("uses the chosen Ukrainian custom day instead of the browser's timezone", () => {
    const range = kyivCalendarRange("2026-10-05", "2026-10-05");
    expect(range).toEqual({
      from: "2026-10-04T21:00:00.000Z",
      to: "2026-10-05T20:59:59.999Z",
    });
    const dayItems: Incident[] = [4, 5, 6].map((day) => ({
      ...base,
      id: `day-${day}`,
      occurredAt: null,
      occurredOn: `2026-10-0${day}`,
    }));
    expect(
      filterIncidents(dayItems, { ...q, ...range, dateBasis: "event" }).map(
        (item) => item.id,
      ),
    ).toEqual(["day-5"]);
  });
  it.each([
    ["2026-03-29", "2026-03-28T22:00:00.000Z", "2026-03-29T20:59:59.999Z", 23],
    ["2026-10-25", "2026-10-24T21:00:00.000Z", "2026-10-25T21:59:59.999Z", 25],
  ])(
    "uses the actual duration of the Kyiv day across DST (%s)",
    (day, from, to, hours) => {
      const range = kyivCalendarRange(day, day);
      expect(range).toEqual({ from, to });
      expect(Date.parse(range.to) - Date.parse(range.from) + 1).toBe(
        Number(hours) * 3600000,
      );
    },
  );
  it("excludes old and unknown event dates from fresh events", () => {
    expect(
      filterIncidents(items, { ...q, dateBasis: "event" }).map((i) => i.id),
    ).toEqual(["fresh"]);
    expect(calculateStatistics(items, { ...q, dateBasis: "event" }).total).toBe(
      1,
    );
  });
  it("includes recent publications about old and unknown events", () => {
    expect(
      filterIncidents(items, { ...q, dateBasis: "publication" }).map(
        (i) => i.id,
      ),
    ).toEqual(["fresh", "unknown", "old"]);
    expect(
      calculateStatistics(items, { ...q, dateBasis: "publication" }).total,
    ).toBe(3);
  });
  it("paginates by the selected date and refuses a cursor from another basis", () => {
    const query = { ...q, dateBasis: "publication" as const, limit: 1 };
    const ordered = filterIncidents(items, query);
    const first = paginate(ordered, query);
    expect(decodeCursor(first.nextCursor!).dateBasis).toBe("publication");
    const second = paginate(ordered, { ...query, cursor: first.nextCursor! });
    const third = paginate(ordered, { ...query, cursor: second.nextCursor! });
    expect([first, second, third].map((p) => p.items[0].id)).toEqual([
      "fresh",
      "unknown",
      "old",
    ]);
    expect(() =>
      paginate(ordered, {
        ...query,
        dateBasis: "event",
        cursor: first.nextCursor!,
      }),
    ).toThrow("date basis");
  });
});
