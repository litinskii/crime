import { load } from "cheerio/slim";
import {
  fetchText,
  PoliceTelegramCollector,
  robotsAllows,
  SourceAccessError,
} from "./collector";
import { sourceById } from "./sources";
import { hash } from "./hash";
import { classify, isCandidate } from "./processor";
import type { RawItem, SourceCollector, SourceDefinition } from "./types";
const textOf = (html: string) => {
  if (!/<[a-z!/]/i.test(html))
    return html
      .normalize("NFC")
      .replace(/\u00a0/g, " ")
      .trim();
  const $ = load(html);
  $("script,style,noscript").remove();
  $("br").replaceWith("\n");
  $("p").append("\n");
  return $.root()
    .text()
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .trim();
};
const dateOf = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
export function allowedArticle(
  source: SourceDefinition,
  value: string,
): string | null {
  try {
    const url = new URL(value, source.url),
      host = new URL(source.url).hostname;
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const valid =
      source.id === "zaxid-news"
        ? /^\/[a-z0-9_]+_n\d+$/.test(url.pathname)
        : source.id === "ukrinform-regions"
          ? /^\/rubric-regions\/\d+-[^/]+\.html$/.test(url.pathname)
          : source.id === "patrol-rss"
            ? /^\/\d{4}\/\d{2}\/\d{2}\//.test(url.pathname)
            : /^\/news\/[^/]+$/.test(url.pathname);
    if (!valid) return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
export async function parseFeed(
  xml: string,
  source: SourceDefinition,
  retrievedAt: string,
): Promise<RawItem[]> {
  const $ = load(xml, { xmlMode: true }),
    result: RawItem[] = [];
  for (const node of $("item").toArray().slice(0, 30)) {
    const item = $(node),
      url = allowedArticle(source, item.find("link").first().text().trim());
    if (!url) continue;
    const title = textOf(item.find("title").first().text());
    const body =
      item.find("content\\:encoded").first().text() ||
      item.find("description").first().text();
    const content = `${title}\n${textOf(body)}`.slice(0, 50000);
    result.push({
      sourceId: source.id,
      externalId: url,
      sourceUrl: url,
      canonicalUrl: url,
      title,
      content,
      publishedAt: dateOf(
        item.find("pubDate").first().text() ||
          item.find("dc\\:date").first().text(),
      ),
      retrievedAt,
      contentHash: await hash(content),
    });
  }
  return result;
}
export function parseArticle(html: string): {
  title: string;
  content: string;
  publishedAt: string | null;
} {
  const articles: Record<string, unknown>[] = [];
  function visit(v: unknown) {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>,
      types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
    if (types.some((t) => ["NewsArticle", "Article"].includes(String(t))))
      articles.push(o);
    if (o["@graph"]) visit(o["@graph"]);
  }
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  ))
    try {
      visit(JSON.parse(match[1]));
    } catch {
      /* malformed publisher metadata */
    }
  const article =
    articles.find((a) => typeof a.articleBody === "string") ?? articles[0];
  const title = String(
    article?.headline ??
      textOf(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ""),
  ).trim();
  let content =
    typeof article?.articleBody === "string" ? textOf(article.articleBody) : "";
  if (!content) {
    // Construct a DOM only for the article, excluding menus, ads and related stories.
    const start =
      /<(div|article)\b[^>]*class=["'][^"']*\b(?:newsText|news-text|article-text|article__content|entry-content)\b[^"']*["'][^>]*>/i.exec(
        html,
      );
    if (start) {
      const tags = new RegExp("<\\/?" + start[1] + "\\b[^>]*>", "gi");
      tags.lastIndex = start.index + start[0].length;
      let depth = 1,
        end = tags.lastIndex,
        m: RegExpExecArray | null;
      while ((m = tags.exec(html)) && m.index - start.index < 120000) {
        depth += m[0].startsWith("</") ? -1 : 1;
        end = tags.lastIndex;
        if (!depth) break;
      }
      if (!depth) content = textOf(html.slice(start.index, end));
    }
  }
  const date = String(
    article?.datePublished ??
      html.match(
        /<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)/i,
      )?.[1] ??
      html.match(/<time\b[^>]*datetime=["']([^"']+)/i)?.[1] ??
      "",
  );
  return { title, content, publishedAt: dateOf(date) };
}
export class WebCollector implements SourceCollector {
  constructor(
    readonly source: SourceDefinition,
    readonly articleUrls?: string[],
  ) {}
  private policy?: { status: number; text: string };
  private async get(url: string, signal?: AbortSignal) {
    const u = new URL(url);
    if (!this.policy)
      this.policy = await fetchText(`${u.origin}/robots.txt`, signal);
    if (
      this.policy.status !== 404 &&
      (this.policy.status !== 200 ||
        !robotsAllows(this.policy.text, u.pathname + u.search))
    )
      throw new SourceAccessError(
        `Source robots policy does not permit collection (HTTP ${this.policy.status})`,
      );
    const response = await fetchText(url, signal);
    if (response.status !== 200)
      throw new SourceAccessError(
        `Source access failed: HTTP ${response.status}`,
      );
    return response.text;
  }
  async collect(
    options: { pages?: number; page?: number; signal?: AbortSignal } = {},
  ): Promise<RawItem[]> {
    const now = new Date().toISOString();
    let items: RawItem[];
    if (this.articleUrls) {
      items = this.articleUrls.map((url) => ({
        sourceId: this.source.id,
        externalId: url,
        sourceUrl: url,
        canonicalUrl: url,
        title: "",
        content: "",
        publishedAt: null,
        retrievedAt: now,
        contentHash: "",
      }));
    } else if (options.page && this.source.archiveUrl) {
      const url = `${this.source.archiveUrl}?page=${options.page}`,
        html = await this.get(url, options.signal),
        $ = load(html);
      const urls = [
        ...new Set(
          $("a[href]")
            .toArray()
            .map((n) => allowedArticle(this.source, $(n).attr("href") ?? ""))
            .filter((s): s is string => Boolean(s)),
        ),
      ];
      items = [];
      for (const articleUrl of urls.slice(0, 30)) {
        const a = $("a[href]")
          .filter(
            (_, n) =>
              allowedArticle(this.source, $(n).attr("href") ?? "") ===
              articleUrl,
          )
          .first();
        const title =
          a.attr("title") ||
          a.find("h2,h3").text() ||
          a.closest("article").find("h2,h3").text() ||
          a.text().trim();
        if (!isCandidate(title)) continue;
        items.push({
          sourceId: this.source.id,
          externalId: articleUrl,
          sourceUrl: articleUrl,
          canonicalUrl: articleUrl,
          title,
          content: title,
          publishedAt: null,
          retrievedAt: now,
          contentHash: await hash(title),
        });
      }
    } else if (this.source.transport === "rss") {
      items = await parseFeed(
        await this.get(this.source.url, options.signal),
        this.source,
        now,
      );
      if (!items.length)
        throw new SourceAccessError("Source feed empty or layout changed");
    } else {
      const $ = load(await this.get(this.source.url, options.signal));
      items = [];
      for (const node of $("a[href]").toArray()) {
        const url = allowedArticle(this.source, $(node).attr("href") ?? ""),
          title = $(node).text().trim();
        if (!url || !classify(title) || items.some((i) => i.sourceUrl === url))
          continue;
        items.push({
          sourceId: this.source.id,
          externalId: url,
          sourceUrl: url,
          canonicalUrl: url,
          title,
          content: title,
          publishedAt: null,
          retrievedAt: now,
          contentHash: await hash(title),
        });
        if (items.length === 15) break;
      }
      if (!items.length)
        throw new SourceAccessError("Source layout changed or empty page");
    }
    for (const item of items) {
      if (
        (!this.articleUrls && !isCandidate(item.title)) ||
        this.source.id === "patrol-rss"
      )
        continue;
      const article = parseArticle(
        await this.get(item.sourceUrl, options.signal),
      );
      if (!article.content || article.content.length < 100)
        throw new SourceAccessError(
          "Source article text missing; collection stopped",
        );
      if (!item.title) item.title = article.title;
      item.content = `${item.title}\n${article.content}`.slice(0, 50000);
      item.publishedAt = article.publishedAt ?? item.publishedAt;
      item.contentHash = await hash(item.content);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return items.filter(
      (item) => isCandidate(item.title) || classify(item.content) !== null,
    );
  }
}
export function createCollector(
  id: string,
): SourceCollector & { nextBefore?: number } {
  const source = sourceById(id);
  if (!source || source.transport === "court")
    throw new SourceAccessError("Source is not a scheduled web collector");
  return source.transport === "telegram"
    ? new PoliceTelegramCollector(source)
    : new WebCollector(source);
}
