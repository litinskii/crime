import type {
  D1Database,
  RateLimit,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { querySchema } from "../../api/src/schemas";
import {
  PoliceTelegramCollector,
  policeSource,
} from "../../api/src/ingestion/collector";
import { ingest } from "../../api/src/ingestion/runner";
import { D1IncidentsRepository } from "./repository";
import { D1IngestionStore } from "./store";
export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  RATE_LIMITER?: RateLimit;
  INGESTION_SECRET?: string;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function authorized(request: Request, secret?: string) {
  if (!secret || secret.length < 32) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(request.headers.get("Authorization") ?? ""),
    ),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`)),
  ]);
  const a = new Uint8Array(left),
    b = new Uint8Array(right);
  let delta = 0;
  for (let i = 0; i < a.length; i++) delta |= a[i] ^ b[i];
  return delta === 0;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/internal/ingest") {
        if (request.method !== "POST")
          return json({ error: "Method not allowed" }, 405);
        if (!(await authorized(request, env.INGESTION_SECRET)))
          return json({ error: "Unauthorized" }, 401);
        const before = url.searchParams.has("before")
          ? Number(url.searchParams.get("before"))
          : undefined;
        if (
          before !== undefined &&
          (!Number.isSafeInteger(before) || before < 1)
        )
          return json({ error: "Invalid cursor" }, 400);
        const collector = new PoliceTelegramCollector();
        const result = await ingest(collector, new D1IngestionStore(env.DB), {
          pages: 1,
          before,
        });
        return json({
          result,
          skipped: !result,
          nextBefore: collector.nextBefore,
        });
      }
      if (url.pathname === "/health") {
        await env.DB.prepare("SELECT 1").first();
        return json({ status: "ok", storage: "d1", ingestion: "npu-telegram" });
      }
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405);
      if (
        env.RATE_LIMITER &&
        !(await env.RATE_LIMITER.limit({
          key: request.headers.get("CF-Connecting-IP") ?? "unknown",
        }).then((r) => r.success))
      )
        return json({ error: "Too many requests" }, 429);
      if (url.pathname === "/api/v1/status") {
        const source = await env.DB.prepare(
          "SELECT name,url,last_success_at,last_failure_at FROM sources WHERE id=?",
        )
          .bind(policeSource.id)
          .first();
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM incidents WHERE is_published=1",
        ).first<{ total: number }>();
        return json({
          mode: "live",
          sources: source ? [source] : [],
          total: count?.total ?? 0,
          locationPrecision: "city",
          coverage:
            "Selected city-level reports from one official source; not complete crime coverage.",
        });
      }
      const repo = new D1IncidentsRepository(env.DB);
      const detail = url.pathname.match(
        /^\/api\/v1\/incidents\/([a-zA-Z0-9_-]{1,100})$/,
      );
      if (detail) {
        try {
          return json(await repo.getIncident(detail[1]));
        } catch (error) {
          if (error instanceof Error && error.message === "Incident not found")
            return json({ error: "Incident not found" }, 404);
          throw error;
        }
      }
      if (!["/api/v1/incidents", "/api/v1/statistics"].includes(url.pathname))
        return json({ error: "Not found" }, 404);
      const parsed = querySchema.safeParse(
        Object.fromEntries(url.searchParams),
      );
      if (!parsed.success) return json({ error: "Invalid query" }, 400);
      return json(
        url.pathname.endsWith("/statistics")
          ? await repo.getStatistics(parsed.data)
          : await repo.getIncidents(parsed.data),
      );
    } catch {
      console.error(
        JSON.stringify({ event: "request-failed", path: url.pathname }),
      );
      return json({ error: "Service temporarily unavailable" }, 503);
    }
  },
  scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(
      ingest(new PoliceTelegramCollector(), new D1IngestionStore(env.DB), {
        pages: 1,
      })
        .then((result) => {
          console.log(
            JSON.stringify({
              event: "ingestion",
              source: policeSource.id,
              result,
            }),
          );
        })
        .catch(() => {
          console.error(
            JSON.stringify({
              event: "ingestion-failed",
              source: policeSource.id,
            }),
          );
        }),
    );
  },
};
