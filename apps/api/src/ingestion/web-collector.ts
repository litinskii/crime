import { load } from "cheerio/slim";
import {
  fetchText,
  PoliceTelegramCollector,
  robotsAllows,
  SourceAccessError,
} from "./collector";
import { sourceById } from "./sources";
import { hash } from "./hash";
import { classify, isCandidate, isMediaViolenceTitle } from "./processor";
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
const mediaProfiles = {
  dnepr: { path: /^\/ua\/post\/[a-z0-9-]+$/, fullText: true },
  citysites: { path: /^\/news\/[1-9][0-9]*\/[a-z0-9-]+$/, fullText: true },
  poltava: { path: /^\/news\/[1-9][0-9]*\/$/, fullText: false },
  lb: {
    path: /^\/society\/\d{4}\/\d{2}\/\d{2}\/[1-9][0-9]*_[a-z0-9_]+\.html$/,
    fullText: false,
  },
} as const;
const mediaItemLimit = 12;
const mediaScanLimit = 160;
const mediaLookback = 7 * 86400000;
// These are explanatory articles or war/collaboration proceedings, not a
// report of a supported ordinary incident. Generic "suspected" headlines
// otherwise let a passing mention of traffic rules become a false ДТП point.
const mediaNonEvent =
  /^(?:Як|Чому|Що робити|Поради|Військове капеланство)(?=\s|[,:.!?]|$)|колаборан|колаборац|окупац|державн.{0,30}зрад|співпрац.{0,40}(?:рф|росі)|російськ.{0,30}(?:адмірал|військов|удар)|воєнн.{0,20}злочин/iu;

/** Remove publisher recommendations before extracting dates and places. */
function mediaText(html: string): string {
  const $ = load(html.slice(0, 60000));
  $(
    'script,style,noscript,aside,nav,iframe,.related,.related-news,.read-also,.inset,.inset-read,[class*="inset-"],[class*="related"],.author',
  ).remove();
  $("br").replaceWith("\n");
  $("p,h2,h3,li").append("\n");
  const paragraphs = $.root()
    .text()
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .split(/\n+/);
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    const line = paragraph.trim();
    if (
      kept.length &&
      /^(?:(?:Нагадаємо|Раніше|Читайте також)(?=\s|[,:.!?]|$)|Джерело\s*:)/iu.test(
        line,
      )
    )
      break;
    if (line) kept.push(line);
  }
  return kept.join("\n").slice(0, 20000);
}
const decodeXml = (s: string) =>
  s.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi,
    (entity, code: string) => {
      if (code.startsWith("#")) {
        const n =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n)
          : entity;
      }
      return (
        (
          { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<
            string,
            string
          >
        )[code.toLowerCase()] ?? entity
      );
    },
  );
function xmlField(item: string, field: string): string {
  const value =
    new RegExp(`<${field}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${field}\\s*>`, "i")
      .exec(item)?.[1]
      ?.trim() ?? "";
  return value.startsWith("<![CDATA[") && value.endsWith("]]>")
    ? value.slice(9, -3)
    : decodeXml(value);
}

function mediaArticleBlock(
  html: string,
  profile: NonNullable<SourceDefinition["rssProfile"]>,
): string {
  for (const start of html.matchAll(/<(div|article)\b([^>]{0,2000})>/gi)) {
    const classes =
      /\bclass=["']([^"']*)["']/i.exec(start[2])?.[1]?.split(/\s+/) ?? [];
    const matches =
      profile === "lb"
        ? /\bitemprop=["']articleBody["']/i.test(start[2])
        : profile === "poltava"
          ? start[1].toLowerCase() === "article" &&
            classes.includes("wym") &&
            classes.includes("content")
          : profile === "dnepr"
            ? classes.includes("content") && classes.includes("mb-5")
            : classes.includes("article-details__text");
    if (!matches) continue;
    const tags = new RegExp(`<\\/?${start[1]}\\b[^>]*>`, "gi");
    tags.lastIndex = start.index! + start[0].length;
    let depth = 1,
      end = tags.lastIndex,
      match: RegExpExecArray | null;
    while ((match = tags.exec(html)) && match.index - start.index! < 120000) {
      depth += match[0].startsWith("</") ? -1 : 1;
      end = tags.lastIndex;
      if (!depth) return html.slice(start.index, end);
    }
    return "";
  }
  return "";
}

async function parseMediaFeed(
  xml: string,
  source: SourceDefinition,
  retrievedAt: string,
): Promise<RawItem[]> {
  // Read small candidate items only: never construct a DOM for a multi-MB feed.
  if (
    xml.length > 2_000_000 ||
    /<!DOCTYPE/i.test(xml) ||
    !/<rss\b/i.test(xml) ||
    !/<\/rss\s*>\s*$/i.test(xml)
  )
    throw new SourceAccessError("Source RSS invalid or exceeds size limit");
  const now = Date.parse(retrievedAt),
    candidates = new Map<
      string,
      { title: string; url: string; publishedAt: string; body: string }
    >();
  let scanned = 0;
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    if (++scanned > mediaScanLimit) break;
    const item = match[1],
      title = textOf(xmlField(item, "title")),
      url = allowedArticle(source, xmlField(item, "link")),
      publishedAt = dateOf(
        xmlField(item, "pubDate") || xmlField(item, "dc:date"),
      );
    if (
      !url ||
      mediaNonEvent.test(title) ||
      !(isCandidate(title) || isMediaViolenceTitle(title)) ||
      !publishedAt ||
      !Number.isFinite(now) ||
      Date.parse(publishedAt) < now - mediaLookback ||
      Date.parse(publishedAt) > now + 300000
    )
      continue;
    candidates.set(url, {
      title,
      url,
      publishedAt,
      body: xmlField(item, "content:encoded") || xmlField(item, "description"),
    });
  }
  if (!scanned)
    throw new SourceAccessError("Source feed empty or layout changed");
  const result: RawItem[] = [];
  for (const item of [...candidates.values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, mediaItemLimit)) {
    const body = mediaText(item.body),
      content = `${item.title}\n${body}`;
    if (mediaProfiles[source.rssProfile!].fullText && body.length < 100)
      throw new SourceAccessError(
        "Source RSS full text missing; collection stopped",
      );
    result.push({
      sourceId: source.id,
      externalId: item.url,
      sourceUrl: item.url,
      canonicalUrl: item.url,
      title: item.title,
      content,
      publishedAt: item.publishedAt,
      retrievedAt,
      contentHash: await hash(content),
    });
  }
  return result;
}
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
    const valid = source.rssProfile
      ? mediaProfiles[source.rssProfile].path.test(url.pathname)
      : source.id === "zaxid-news"
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
  if (source.rssProfile) return parseMediaFeed(xml, source, retrievedAt);
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
export function parseArticle(
  html: string,
  source?: SourceDefinition,
): {
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
  if (source?.rssProfile) {
    const body = mediaArticleBlock(html, source.rssProfile);
    content = body ? mediaText(body) : content ? mediaText(content) : "";
  } else if (!content) {
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
      if (!items.length && !this.source.rssProfile)
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
        (!this.articleUrls &&
          !(
            isCandidate(item.title) ||
            (this.source.rssProfile && isMediaViolenceTitle(item.title))
          )) ||
        this.source.id === "patrol-rss" ||
        (!this.articleUrls &&
          this.source.rssProfile &&
          mediaProfiles[this.source.rssProfile].fullText)
      )
        continue;
      const article = parseArticle(
        await this.get(item.sourceUrl, options.signal),
        this.source,
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
      (item) =>
        isCandidate(item.title) ||
        (this.source.rssProfile && isMediaViolenceTitle(item.title)) ||
        classify(item.content) !== null,
    );
  }
}
export function createCollector(
  id: string,
): SourceCollector & { nextBefore?: number } {
  const source = sourceById(id);
  if (!source || source.enabled === false || source.transport === "court")
    throw new SourceAccessError("Source is not a scheduled web collector");
  return source.transport === "telegram"
    ? new PoliceTelegramCollector(source)
    : new WebCollector(source);
}
