import type { D1Database, Queue } from "@cloudflare/workers-types";
import { sources, sourceById } from "../../api/src/ingestion/sources";
import { ruleVersion } from "../../api/src/ingestion/processor";
import { createCollector } from "../../api/src/ingestion/web-collector";
import { ingest } from "../../api/src/ingestion/runner";
import type {
  SourceCollector,
  SourceDefinition,
} from "../../api/src/ingestion/types";
import { D1IngestionStore } from "./store";

export interface IngestionTask {
  id: string;
}
type Task = IngestionTask & {
  source_id: string;
  cycle: number;
  step: number;
  kind: "poll" | "process";
  status: string;
  lease_until: number;
  dispatched_at: number | null;
};
type Producer = Pick<Queue<IngestionTask>, "send" | "sendBatch">;
const hour = 3600000;
// Reserve capacity for every hourly web poll. 640 processing messages/day can
// normalize 1,920 originals; normal read/write/delete operations fit Queues Free.
export const dailyProcessBudget = 640;
export const maxCycleSteps = 256;
const pending =
  "(r.status='collected' OR (r.status='failed' AND r.attempts<3) OR (r.rules<>? AND r.content NOT IN ('[expired]','[withdrawn')))";
const taskId = (source: string, cycle: number, step: number) =>
  `${cycle}:${source}:${step}`;
const dayStart = (now: number) => Math.floor(now / 86400000) * 86400000;

async function sendTasks(
  db: D1Database,
  queue: Producer,
  tasks: Task[],
  now: number,
) {
  if (!tasks.length) return 0;
  await queue.sendBatch(tasks.map(({ id }) => ({ body: { id } })));
  await db
    .prepare(
      `UPDATE ingestion_tasks SET dispatched_at=? WHERE id IN (${tasks.map(() => "?").join(",")})`,
    )
    .bind(now, ...tasks.map(({ id }) => id))
    .run();
  return tasks.length;
}

/** Hourly fan-out schedules feed polls; each consumer job has its own D1 budget. */
export async function dispatchHourly(
  db: D1Database,
  queue: Producer,
  now = Date.now(),
  definitions: readonly SourceDefinition[] = sources,
) {
  if (!definitions.length) return { dispatched: 0 };
  if (definitions.length > 20)
    throw new Error("Scheduled source bound exceeded");
  const cycle = Math.floor(now / hour) * hour;
  await db
    .prepare(
      `INSERT INTO sources(id,name,url,metadata) VALUES ${definitions.map(() => "(?,?,?,?)").join(",")} ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      ...definitions.flatMap((s) => [
        s.id,
        s.name,
        s.url,
        JSON.stringify({
          kind: s.kind,
          cadenceMinutes: s.cadenceMinutes ?? 60,
        }),
      ]),
    )
    .run();
  const ids = definitions.map((s) => s.id);
  const candidates = await db
    .prepare(
      `SELECT s.id,s.next_attempt_at,EXISTS(SELECT 1 FROM raw_source_items r WHERE r.source_id=s.id AND ${pending}) AS pending FROM sources s WHERE s.id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(ruleVersion, ...ids)
    .all<{ id: string; next_attempt_at: number; pending: number }>();
  for (const candidate of candidates.results) {
    const source = definitions.find((s) => s.id === candidate.id)!;
    const kind =
      source.transport !== "court" && candidate.next_attempt_at < cycle + hour
        ? "poll"
        : "process";
    if (kind === "process" && !candidate.pending) continue;
    await db
      .prepare(
        "INSERT OR IGNORE INTO ingestion_tasks(id,source_id,cycle,step,kind,created_at) SELECT ?,?,?,0,?,? WHERE ?='poll' OR (SELECT COUNT(*) FROM ingestion_tasks WHERE kind='process' AND created_at>=?)<?",
      )
      .bind(
        taskId(source.id, cycle, 0),
        source.id,
        cycle,
        kind,
        now,
        kind,
        dayStart(now),
        dailyProcessBudget,
      )
      .run();
  }
  // Unsent work and expired deliveries are recovered independently of new polls.
  const outbox = await db
    .prepare(
      "SELECT * FROM ingestion_tasks WHERE status<>'done' AND lease_until<? AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY cycle DESC,step,id LIMIT 40",
    )
    .bind(now, now - 15 * 60000)
    .all<Task>();
  return { dispatched: await sendTasks(db, queue, outbox.results, now) };
}

async function sendSuccessor(
  db: D1Database,
  queue: Producer,
  task: Task,
  now: number,
) {
  const next = await db
    .prepare(
      "SELECT * FROM ingestion_tasks WHERE source_id=? AND cycle=? AND step=? AND status='pending' AND dispatched_at IS NULL",
    )
    .bind(task.source_id, task.cycle, task.step + 1)
    .first<Task>();
  if (next) await sendTasks(db, queue, [next], now);
}

export async function consumeTask(
  db: D1Database,
  queue: Producer,
  input: IngestionTask,
  now = Date.now(),
  collectorFactory: (id: string) => SourceCollector = createCollector,
) {
  const task = await db
    .prepare("SELECT * FROM ingestion_tasks WHERE id=?")
    .bind(input.id)
    .first<Task>();
  if (!task) return { skipped: true };
  if (task.status === "done") {
    await sendSuccessor(db, queue, task, now);
    return { skipped: true };
  }
  const source = sourceById(task.source_id);
  if (!source) throw new Error("Unknown queued source");
  // An old hourly poll never becomes an extra feed fetch in a later cycle.
  if (task.kind === "poll" && task.cycle < Math.floor(now / hour) * hour)
    task.kind = "process";
  const state = await db
    .prepare("SELECT lease_until,next_attempt_at FROM sources WHERE id=?")
    .bind(source.id)
    .first<{ lease_until: number; next_attempt_at: number }>();
  if (!state) throw new Error("Unknown source state");
  const waitUntil = Math.max(
    task.lease_until,
    state.lease_until,
    task.kind === "poll" ? state.next_attempt_at : 0,
  );
  // A completed poll on redelivery is processed without another network request.
  if (
    task.kind === "poll" &&
    state.next_attempt_at > now &&
    task.status === "running" &&
    task.lease_until <= now
  )
    task.kind = "process";
  else if (waitUntil > now)
    return { retryAfter: Math.max(1, Math.ceil((waitUntil - now) / 1000)) };
  const claim = await db
    .prepare(
      "UPDATE ingestion_tasks SET status='running',lease_until=? WHERE id=? AND status<>'done' AND lease_until<=?",
    )
    .bind(now + 10 * 60000, task.id, now)
    .run();
  if (!claim.meta.changes) return { retryAfter: 60 };
  let result;
  try {
    result = await ingest(
      task.kind === "poll"
        ? collectorFactory(source.id)
        : { source, collect: async () => [] },
      new D1IngestionStore(db, {
        runKind: task.kind,
        now: () => now,
        maxItems: task.kind === "poll" ? 2 : 3,
        respectCadence: true,
      }),
      { pages: 1 },
    );
    if (!result) {
      await db
        .prepare("UPDATE ingestion_tasks SET lease_until=0 WHERE id=?")
        .bind(task.id)
        .run();
      return { retryAfter: 60 };
    }
  } catch {
    // Poll errors have already updated the source's hourly backoff. Keep draining
    // persisted originals; do not repeat the HTTP fetch in this cycle.
    console.error(
      JSON.stringify({
        event: "queued-ingestion-failed",
        source: source.id,
        kind: task.kind,
      }),
    );
  }
  await db.batch([
    db
      .prepare(
        "UPDATE ingestion_tasks SET status='done',lease_until=0 WHERE id=?",
      )
      .bind(task.id),
    db
      .prepare(
        `INSERT OR IGNORE INTO ingestion_tasks(id,source_id,cycle,step,kind,created_at) SELECT ?,?,?,?,'process',? WHERE ?<? AND EXISTS(SELECT 1 FROM raw_source_items r WHERE r.source_id=? AND ${pending}) AND (SELECT COUNT(*) FROM ingestion_tasks WHERE kind='process' AND created_at>=?)<?`,
      )
      .bind(
        taskId(source.id, task.cycle, task.step + 1),
        source.id,
        task.cycle,
        task.step + 1,
        now,
        task.step + 1,
        maxCycleSteps,
        source.id,
        ruleVersion,
        dayStart(now),
        dailyProcessBudget,
      ),
  ]);
  await sendSuccessor(db, queue, task, now);
  return { source: source.id, kind: task.kind, result };
}
