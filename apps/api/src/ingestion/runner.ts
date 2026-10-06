import { IncidentProcessor } from "./processor";
import type { IngestionStore, RunResult, SourceCollector } from "./types";

export async function ingest(
  collector: SourceCollector,
  store: IngestionStore,
  options: { pages?: number; before?: number; signal?: AbortSignal } = {},
): Promise<RunResult | null> {
  const runId = await store.begin(collector.source);
  if (!runId) return null;
  const stats: RunResult = {
    discovered: 0,
    changed: 0,
    published: 0,
    duplicates: 0,
    review: 0,
    rejected: 0,
    failed: 0,
  };
  const processor = new IncidentProcessor();
  try {
    const items = await collector.collect(options);
    stats.discovered = items.length;
    const work = store.stage ? await store.stage(items) : items;
    for (const raw of work) {
      const saved = await store.saveRaw(raw);
      if (!saved.changed) continue;
      stats.changed++;
      try {
        const result = await processor.process(raw);
        const status = await store.record(saved.id, result, raw);
        if (status === "duplicate") stats.duplicates++;
        else stats[status]++;
      } catch {
        stats.failed++;
        await store.failItem(saved.id, "processing-failed");
      }
    }
    await store.finish(runId, collector.source, stats);
    return stats;
  } catch (error) {
    const reason =
      error instanceof Error && /^Source /.test(error.message)
        ? error.message
        : "collection-or-storage-failed";
    await store.finish(runId, collector.source, stats, reason);
    throw new Error(reason);
  }
}
