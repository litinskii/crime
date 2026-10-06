import { describe, expect, it } from "vitest";
import { querySchema } from "./schemas";
import { createMockIncidents, encodeCursor } from "@crime-radar/shared";
import { where } from "./database/repository";
const q = {
  north: 53,
  south: 44,
  east: 40,
  west: 22,
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-06T23:59:59Z",
};
describe("date basis validation and PostGIS query", () => {
  it("validates explicit bases and refuses mixed or malformed cursors", () => {
    const item = createMockIncidents(new Date(q.to))[0];
    const cursor = encodeCursor(item, "publication");
    expect(
      querySchema.safeParse({ ...q, dateBasis: "publication", cursor }).success,
    ).toBe(true);
    expect(
      querySchema.safeParse({ ...q, dateBasis: "event", cursor }).success,
    ).toBe(false);
    expect(querySchema.safeParse({ ...q, dateBasis: "received" }).success).toBe(
      false,
    );
    expect(
      querySchema.safeParse({ ...q, dateBasis: "event", cursor: "bad" })
        .success,
    ).toBe(false);
    expect(
      querySchema.safeParse({ ...q, query: Array(33).fill("a").join(" ") })
        .success,
    ).toBe(false);
  });
  it("keeps strict event filtering separate from publication filtering", () => {
    const event = where({ ...q, dateBasis: "event" });
    const publication = where({ ...q, dateBasis: "publication" });
    expect(event.text).toContain("occurred_at >=");
    expect(event.text).not.toContain("COALESCE(occurred_at");
    expect(publication.text).toContain("published_at >=");
    expect(event.values.slice(0, 6)).toEqual(publication.values);
    expect(event.values.slice(6)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-07T00:00:00.000Z",
    ]);
  });
});
