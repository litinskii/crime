import type {
  D1Database,
  RateLimit,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { querySchema } from "../../api/src/schemas";
import { policeSource } from "../../api/src/ingestion/collector";
import { ingest } from "../../api/src/ingestion/runner";
import {
  createCollector,
  WebCollector,
  allowedArticle,
} from "../../api/src/ingestion/web-collector";
import {
  scheduledSources,
  sources,
  sourceById,
} from "../../api/src/ingestion/sources";
import {
  CourtCollector,
  validCourtDocument,
} from "../../api/src/ingestion/court";
import { authorizedHarvester } from "./oidc";
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
      if (url.pathname === "/internal/articles") {
        if (request.method !== "POST")
          return json({ error: "Method not allowed" }, 405);
        if (!(await authorized(request, env.INGESTION_SECRET)))
          return json({ error: "Unauthorized" }, 401);
        const body = await request.text();
        if (body.length > 8000)
          return json({ error: "Payload too large" }, 413);
        let input: { source?: string; urls?: unknown[] };
        try {
          input = JSON.parse(body);
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        const source = input && sourceById(input.source ?? "");
        if (
          !source ||
          !["ukrinform-regions", "zaxid-news"].includes(source.id) ||
          !Array.isArray(input.urls) ||
          input.urls.length > 3 ||
          !input.urls.every(
            (u) => typeof u === "string" && allowedArticle(source, u) === u,
          )
        )
          return json({ error: "Invalid source URLs" }, 400);
        const result = await ingest(
          new WebCollector(source, input.urls as string[]),
          new D1IngestionStore(env.DB),
        );
        return json({ result, skipped: !result });
      }
      if (url.pathname === "/internal/court") {
        if (request.method !== "POST")
          return json({ error: "Method not allowed" }, 405);
        if (
          !(await authorized(request, env.INGESTION_SECRET)) &&
          !(await authorizedHarvester(request))
        )
          return json({ error: "Unauthorized" }, 401);
        const body = await request.text();
        if (body.length > 20000)
          return json({ error: "Payload too large" }, 413);
        let input: { documents?: unknown[]; withdrawn?: string[] };
        try {
          input = JSON.parse(body);
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (
          !input ||
          !Array.isArray(input.documents) ||
          input.documents.length > 3 ||
          !input.documents.every(validCourtDocument) ||
          !Array.isArray(input.withdrawn) ||
          input.withdrawn.length > 100 ||
          !input.withdrawn.every(
            (id) => typeof id === "string" && /^\d{1,12}$/.test(id),
          )
        )
          return json({ error: "Invalid court metadata" }, 400);
        if (input.withdrawn.length) {
          const placeholders = input.withdrawn.map(() => "?").join(",");
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE incidents SET is_published=0 WHERE id IN (SELECT x.incident_id FROM incident_sources x JOIN raw_source_items r ON r.id=x.raw_id WHERE r.source_id='court-decisions' AND r.external_id IN (${placeholders}))`,
            ).bind(...input.withdrawn),
            env.DB.prepare(
              `UPDATE raw_source_items SET status='rejected',reason='withdrawn-from-registry',content='[withdrawn]',title='[withdrawn]' WHERE source_id='court-decisions' AND external_id IN (${placeholders})`,
            ).bind(...input.withdrawn),
            env.DB.prepare(
              `DELETE FROM raw_source_item_versions WHERE raw_id IN (SELECT id FROM raw_source_items WHERE source_id='court-decisions' AND external_id IN (${placeholders}))`,
            ).bind(...input.withdrawn),
          ]);
        }
        const result =
          input.documents.length || !input.withdrawn.length
            ? await ingest(
                new CourtCollector(input.documents),
                new D1IngestionStore(env.DB),
              )
            : null;
        return json({
          result,
          withdrawn: input.withdrawn.length,
          skipped: input.documents.length > 0 && !result,
        });
      }
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
        const sourceId = url.searchParams.get("source") ?? policeSource.id;
        if (!scheduledSources.some((s) => s.id === sourceId))
          return json({ error: "Invalid source" }, 400);
        const page = url.searchParams.has("page")
          ? Number(url.searchParams.get("page"))
          : undefined;
        if (
          page !== undefined &&
          (!Number.isSafeInteger(page) || page < 1 || page > 1000)
        )
          return json({ error: "Invalid page" }, 400);
        const collector = createCollector(sourceId);
        const result = await ingest(collector, new D1IngestionStore(env.DB), {
          pages: 1,
          before,
          page,
        });
        return json({
          result,
          skipped: !result,
          nextBefore: collector.nextBefore,
        });
      }
      if (url.pathname === "/health") {
        await env.DB.prepare("SELECT 1").first();
        return json({ status: "ok", storage: "d1", ingestion: "multi-source" });
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
        const state = await env.DB.prepare(
          `SELECT s.id,s.name,s.url,s.last_success_at,s.last_failure_at,s.last_attempt_at,s.next_attempt_at,s.consecutive_failures,s.last_error,
          (SELECT COUNT(DISTINCT x.incident_id) FROM incident_sources x JOIN raw_source_items r ON r.id=x.raw_id JOIN incidents i ON i.id=x.incident_id WHERE r.source_id=s.id AND i.is_published=1) AS published,
          (SELECT COUNT(*) FROM raw_source_items r WHERE r.source_id=s.id AND r.status='collected') AS pending
          FROM sources s ORDER BY s.id`,
        ).all<{ id: string }>();
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM incidents WHERE is_published=1",
        ).first<{ total: number }>();
        return json({
          mode: "live",
          sources: sources.map((source) => ({
            ...source,
            ...state.results.find((row) => row.id === source.id),
            configured: true,
          })),
          total: count?.total ?? 0,
          locationPrecision: "city",
          coverage:
            "Public police, media and court reports; partial coverage. Markers show settlement centres; ambiguous court records remain unpublished.",
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
    let selectedSource: string | undefined;
    context.waitUntil(
      (async () => {
        await env.DB.prepare(
          `INSERT INTO sources(id,name,url,metadata) VALUES ${scheduledSources.map(() => "(?,?,?,?)").join(",")} ON CONFLICT(id) DO NOTHING`,
        )
          .bind(
            ...scheduledSources.flatMap((s) => [
              s.id,
              s.name,
              s.url,
              JSON.stringify({ kind: s.kind }),
            ]),
          )
          .run();
        const due = await env.DB.prepare(
          "SELECT id FROM sources WHERE id<>'court-decisions' AND next_attempt_at<=? AND lease_until<? ORDER BY COALESCE(last_attempt_at,''),id LIMIT 1",
        )
          .bind(Date.now(), Date.now())
          .first<{ id: string }>();
        if (!due || !scheduledSources.some((s) => s.id === due.id)) return null;
        selectedSource = due.id;
        return ingest(createCollector(due.id), new D1IngestionStore(env.DB), {
          pages: 1,
        });
      })()
        .then((result) => {
          console.log(
            JSON.stringify({
              event: "ingestion",
              source: selectedSource,
              result,
            }),
          );
        })
        .catch(() => {
          console.error(
            JSON.stringify({
              event: "ingestion-failed",
              source: selectedSource,
            }),
          );
        }),
    );
  },
};
