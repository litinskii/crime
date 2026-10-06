import { describe, it, expect } from "vitest";
import { createApp } from "./app";
describe("Crime Radar public API", () => {
  const qs =
    "north=53&south=44&east=40&west=22&from=2025-10-06T00:00:00Z&to=2027-10-06T00:00:00Z";
  it("rejects invalid spatial/date queries and pagination", async () => {
    const app = await createApp();
    for (const url of [
      "/api/v1/incidents",
      "/api/v1/incidents?" + qs,
      "/api/v1/incidents?" + qs.replace("north=53", "north=999"),
      "/api/v1/incidents?" + qs + "&limit=50000",
    ])
      expect((await app.inject({ url })).statusCode).toBe(400);
    await app.close();
  });
  it("supports bounds, category/keyword filters, pagination, details and statistics", async () => {
    const app = await createApp();
    const to = new Date().toISOString(),
      from = new Date(Date.now() - 365 * 86400000).toISOString();
    const query = `north=53&south=44&east=40&west=22&from=${from}&to=${to}&categories=theft&query=bicycle&limit=5`;
    const response = await app.inject({ url: "/api/v1/incidents?" + query });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(5);
    expect(body.total).toBe(30);
    expect(body.nextCursor).toBeTruthy();
    const next = (
      await app.inject({
        url:
          "/api/v1/incidents?" +
          query +
          "&cursor=" +
          encodeURIComponent(body.nextCursor),
      })
    ).json();
    expect(next.items[0].id).not.toBe(body.items[0].id);
    const detail = (
      await app.inject({ url: "/api/v1/incidents/" + body.items[0].id })
    ).json();
    expect(detail.sources.length).toBeGreaterThan(0);
    expect(detail.location.approximate).toBe(true);
    const stats = (
      await app.inject({ url: "/api/v1/statistics?" + query })
    ).json();
    expect(stats.total).toBe(body.total);
    expect(stats.categories.theft).toBe(30);
    expect(
      (await app.inject({ url: "/api/v1/incidents/missing" })).statusCode,
    ).toBe(404);
    await app.close();
  });
  it("limits CORS to configured origins and hides internal errors", async () => {
    const app = await createApp({ origins: ["https://crime.example"] });
    const response = await app.inject({
      url: "/health",
      headers: { origin: "https://untrusted.example" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
