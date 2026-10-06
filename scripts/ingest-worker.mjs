import { readFileSync } from "node:fs";
const secret =
  process.env.INGESTION_SECRET ??
  readFileSync(new URL("../.env.ingestion", import.meta.url), "utf8").trim();
const url = new URL(
  "/internal/ingest",
  process.env.WORKER_URL ?? "https://crime-radar.w-siteee.workers.dev",
);
const before = process.argv
  .find((arg) => arg.startsWith("--before="))
  ?.slice(9);
const source = process.argv
  .find((arg) => arg.startsWith("--source="))
  ?.slice(9);
if (source) url.searchParams.set("source", source);
const page = process.argv.find((arg) => arg.startsWith("--page="))?.slice(7);
if (page) url.searchParams.set("page", page);
if (before) {
  if (!/^[1-9][0-9]*$/.test(before)) throw new Error("Invalid cursor");
  url.searchParams.set("before", before);
}
const pages = Number(
  process.argv.find((arg) => arg.startsWith("--pages="))?.slice(8) ?? 1,
);
const runs = Number(
  process.argv.find((arg) => arg.startsWith("--runs="))?.slice(7) ?? 1,
);
if (
  !Number.isInteger(pages) ||
  pages < 1 ||
  pages > 10 ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 200 ||
  (pages > 1 && runs > 1)
)
  throw new Error("Use pages 1–10 or runs 1–200");
for (let i = 0; i < Math.max(pages, runs); i++) {
  if (i) await new Promise((resolve) => setTimeout(resolve, 2000));
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json().catch(() => {
    throw new Error(
      `Worker returned a non-JSON response (HTTP ${response.status})`,
    );
  });
  console.log(JSON.stringify({ status: response.status, ...body }));
  if (!response.ok) {
    process.exitCode = 1;
    break;
  }
  if (body.skipped) break;
  if (pages > 1) {
    if (!body.nextBefore) break;
    url.searchParams.set("before", String(body.nextBefore));
  } else if (runs > 1 && body.result?.changed === 0) break;
}
