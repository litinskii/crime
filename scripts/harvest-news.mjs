// Historical articles are fetched by the Worker from allowlisted publishers.
// Local checkpoints contain URLs only, never raw article text.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { load } from "cheerio/slim";
const secret =
  process.env.INGESTION_SECRET ?? readFileSync(".env.ingestion", "utf8").trim();
const base =
  process.env.WORKER_URL ?? "https://crime-radar.w-siteee.workers.dev";
const months = (
  process.argv.find((a) => a.startsWith("--months="))?.slice(9) ??
  "202609,202608,202607"
).split(",");
const limit = Number(
  process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? 600,
);
const path = ".news-harvest-state.json",
  state = new Set(
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [],
  );
const headers = {
  "User-Agent": "CrimeRadar/0.3 (+https://crime-radar.w-siteee.workers.dev)",
};
const urls = [];
for (const month of months) {
  if (!/^2026(0[1-9]|1[0-2])$/.test(month)) throw Error("Invalid month");
  const response = await fetch(
    `https://zaxid.net/resources/xml/sitemaps/sitemap${month}.xml`,
    { headers, signal: AbortSignal.timeout(60000) },
  );
  if (!response.ok) throw Error(`Sitemap HTTP ${response.status}`);
  const $ = load(await response.text(), { xmlMode: true });
  for (const element of $("url").toArray()) {
    const url = $(element).find("loc").first().text().trim();
    if (
      /^https:\/\/zaxid\.net\/[a-z0-9_]+_n\d+$/.test(url) &&
      /kradizh|kradiy|pograb|rozbiy|shahray|oshuk|vbiv|vbyv|pobiv|pobit|narkot|narkod|amfetamin|dtp|nayih|avariy|pidpal|pozhezh|habar|granat|vibuh|vibukh|zbroy/.test(
        url,
      ) &&
      !state.has(url)
    )
      urls.push(url);
  }
}
const candidates = [...new Set(urls)].slice(0, limit);
console.log(JSON.stringify({ candidates: candidates.length, months }));
const totals = {};
for (let i = 0; i < candidates.length; i += 3) {
  const batch = candidates.slice(i, i + 3);
  let body;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}/internal/articles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "zaxid-news", urls: batch }),
        signal: AbortSignal.timeout(90000),
      });
      body = await response.json();
      if (!response.ok || body.skipped)
        throw Error(`Worker HTTP ${response.status}`);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
    }
  }
  for (const [k, v] of Object.entries(body.result ?? {}))
    totals[k] = (totals[k] ?? 0) + v;
  for (const url of batch) state.add(url);
  writeFileSync(path, JSON.stringify([...state]));
  console.log(JSON.stringify({ batch: i / 3 + 1, ...body.result, totals }));
  await new Promise((r) => setTimeout(r, 1000));
}
