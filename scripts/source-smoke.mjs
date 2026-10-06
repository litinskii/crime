// Read-only source adapter smoke check; never prints raw articles or personal fields.
import { createCollector } from "../apps/api/src/ingestion/web-collector.ts";
import { IncidentProcessor } from "../apps/api/src/ingestion/processor.ts";
const id = process.argv[2] ?? "zaxid-news";
const items = await createCollector(id).collect({
  pages: 1,
  page: Number(process.argv[3]) || undefined,
});
const counts = { published: 0, review: 0, rejected: 0 };
for (const item of items) {
  const result = await new IncidentProcessor().process(item);
  counts[result.status]++;
  console.log(
    JSON.stringify({
      url: item.sourceUrl,
      title: item.title,
      publishedAt: item.publishedAt,
      status: result.status,
      ...(result.status === "published"
        ? {
            city: result.incident.location.city,
            category: result.incident.category,
          }
        : { reason: result.reason }),
    }),
  );
}
console.log(JSON.stringify({ source: id, total: items.length, ...counts }));
