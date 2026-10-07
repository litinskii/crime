import type {
  D1Database,
  RateLimit,
  ExecutionContext,
  ScheduledController,
  Queue,
  MessageBatch,
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
import { D1IngestionStore, maintainPrivateData, type RunKind } from "./store";
import { ruleVersion } from "../../api/src/ingestion/processor";
import { dispatchHourly, consumeTask, type IngestionTask } from "./scheduler";
export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  RATE_LIMITER?: RateLimit;
  INGESTION_SECRET?: string;
  INGESTION_QUEUE?: Queue<IngestionTask>;
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
      if (url.pathname === "/internal/dispatch") {
        if (request.method !== "POST")
          return json({ error: "Method not allowed" }, 405);
        if (!(await authorized(request, env.INGESTION_SECRET)))
          return json({ error: "Unauthorized" }, 401);
        if (!env.INGESTION_QUEUE)
          return json({ error: "Queue unavailable" }, 503);
        return json(await dispatchHourly(env.DB, env.INGESTION_QUEUE));
      }
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
          new D1IngestionStore(env.DB, {
            runKind: input.urls.length ? "backfill" : "process",
          }),
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
        const court = new CourtCollector(input.documents);
        const store = new D1IngestionStore(env.DB, { runKind: "backfill" });
        const result = await ingest(
          {
            source: court.source,
            collect: async () => {
              await store.withdraw("court-decisions", input.withdrawn!);
              return court.collect();
            },
          },
          store,
        );
        return json({
          result,
          withdrawn: result ? input.withdrawn.length : 0,
          skipped: !result,
        });
      }
      if (["/internal/ingest", "/internal/process"].includes(url.pathname)) {
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
        const source = sourceById(sourceId);
        if (!source) return json({ error: "Invalid source" }, 400);
        const page = url.searchParams.has("page")
          ? Number(url.searchParams.get("page"))
          : undefined;
        if (
          page !== undefined &&
          (!Number.isSafeInteger(page) || page < 1 || page > 1000)
        )
          return json({ error: "Invalid page" }, 400);
        const drain = url.searchParams.get("drain");
        if (drain !== null && drain !== "1")
          return json({ error: "Invalid drain flag" }, 400);
        const kind =
          url.pathname === "/internal/process" || drain === "1"
            ? "process"
            : (url.searchParams.get("runKind") ??
              (before !== undefined || page !== undefined
                ? "backfill"
                : "poll"));
        if (
          !["poll", "process", "backfill"].includes(kind) ||
          (kind === "process" &&
            (before !== undefined || page !== undefined)) ||
          (drain === "1" &&
            url.searchParams.has("runKind") &&
            url.searchParams.get("runKind") !== "process")
        )
          return json({ error: "Invalid run kind" }, 400);
        if (
          kind !== "process" &&
          !scheduledSources.some((source) => source.id === sourceId)
        )
          return json({ error: "Invalid source" }, 400);
        const collector =
          kind === "process"
            ? { source, collect: async () => [], nextBefore: undefined }
            : createCollector(sourceId);
        const result = await ingest(
          collector,
          new D1IngestionStore(env.DB, { runKind: kind as RunKind }),
          {
            pages: 1,
            before,
            page,
          },
        );
        return json({
          result,
          skipped: !result,
          nextBefore: collector.nextBefore,
          runKind: kind,
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
          `SELECT s.id,s.name,s.url,s.last_success_at,s.last_failure_at,s.last_attempt_at,s.next_attempt_at,s.consecutive_failures,s.last_error,s.last_processed_at,s.processing_error,s.next_process_at,
          (SELECT COUNT(DISTINCT x.incident_id) FROM incident_sources x JOIN raw_source_items r ON r.id=x.raw_id JOIN incidents i ON i.id=x.incident_id WHERE r.source_id=s.id AND x.active=1 AND i.is_published=1) AS published,
          (SELECT COUNT(*) FROM raw_source_items r WHERE r.source_id=s.id AND (r.status='collected' OR (r.status='failed' AND r.attempts<3) OR (r.rules<>? AND r.content NOT IN ('[expired]','[withdrawn]')))) AS pending,
          (SELECT MIN(first_seen_at) FROM raw_source_items r WHERE r.source_id=s.id AND (r.status='collected' OR (r.status='failed' AND r.attempts<3) OR (r.rules<>? AND r.content NOT IN ('[expired]','[withdrawn]')))) AS oldestPendingAt,
          (SELECT MAX(published_at) FROM raw_source_items r WHERE r.source_id=s.id) AS latestPublicationAt,
          (SELECT MAX(first_seen_at) FROM raw_source_items r WHERE r.source_id=s.id) AS lastNewItemAt
          FROM sources s ORDER BY s.id`,
        )
          .bind(ruleVersion, ruleVersion)
          .all<{ id: string; last_processed_at: string | null }>();
        const counts = await env.DB.prepare(
          "SELECT source_id,status,COUNT(*) AS total FROM raw_source_items GROUP BY source_id,status",
        ).all<{ source_id: string; status: string; total: number }>();
        const reasons = await env.DB.prepare(
          "SELECT source_id,reason,COUNT(*) AS total FROM raw_source_items WHERE status IN ('rejected','review','failed') AND reason IS NOT NULL GROUP BY source_id,reason",
        ).all<{ source_id: string; reason: string; total: number }>();
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM incidents WHERE is_published=1",
        ).first<{ total: number }>();
        return json({
          mode: "live",
          sources: sources.map((source) => ({
            ...source,
            ...state.results.find((row) => row.id === source.id),
            lastProcessedAt:
              state.results.find((row) => row.id === source.id)
                ?.last_processed_at ?? null,
            counts: Object.fromEntries(
              [
                "published",
                "duplicate",
                "review",
                "rejected",
                "failed",
                "collected",
              ].map((status) => [
                status,
                counts.results.find(
                  (row) => row.source_id === source.id && row.status === status,
                )?.total ?? 0,
              ]),
            ),
            rejectionReasons: Object.fromEntries(
              reasons.results
                .filter((row) => row.source_id === source.id)
                .map((row) => [row.reason, row.total]),
            ),
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
  async queue(batch: MessageBatch<IngestionTask>, env: Env) {
    if (!env.INGESTION_QUEUE) throw new Error("Queue binding unavailable");
    // The deployment config enforces one message per invocation (D1 Free limit).
    if (batch.messages.length !== 1)
      throw new Error("Unexpected queue batch size");
    const message = batch.messages[0];
    if (
      !message.body ||
      typeof message.body.id !== "string" ||
      message.body.id.length > 160
    ) {
      message.ack();
      return;
    }
    const result = await consumeTask(env.DB, env.INGESTION_QUEUE, message.body);
    if ("retryAfter" in result && result.retryAfter)
      message.retry({ delaySeconds: result.retryAfter });
    else {
      message.ack();
      console.log(JSON.stringify({ event: "queued-ingestion", ...result }));
    }
  },
  scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ) {
    context.waitUntil(
      (controller.cron === "15 2 * * *"
        ? maintainPrivateData(env.DB)
        : env.INGESTION_QUEUE
          ? dispatchHourly(env.DB, env.INGESTION_QUEUE)
          : Promise.reject(new Error("Queue binding unavailable"))
      )
        .then((result) => {
          console.log(
            JSON.stringify({
              event: "ingestion",
              maintenance: controller.cron === "15 2 * * *",
              result,
            }),
          );
        })
        .catch(() => {
          console.error(
            JSON.stringify({
              event: "ingestion-failed",
            }),
          );
        }),
    );
  },
};
