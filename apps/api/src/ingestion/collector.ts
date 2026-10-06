import { load } from "cheerio/slim";
import { hash } from "./hash";
import { classify, isCandidate } from "./processor";
import { sourceById } from "./sources";
import type { RawItem, SourceCollector, SourceDefinition } from "./types";

export const policeSource = sourceById("npu-telegram")!;
const agent = "CrimeRadar/0.2 (+https://crime-radar.w-siteee.workers.dev)";
export class SourceAccessError extends Error {}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchText(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": agent,
          Accept: "text/html,application/xml,text/plain,application/rtf",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        redirect: "manual",
      });
    } catch (error) {
      // Transport errors cannot contain source text: no response was parsed yet.
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message.slice(0, 160)}`
          : "unknown";
      throw new SourceAccessError(`Source transport failed (${detail})`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SourceAccessError(
        "Source redirect refused; source configuration requires review",
      );
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      await pause(1000 * 2 ** attempt);
      continue;
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new SourceAccessError("Source response exceeds size limit");
        }
        chunks.push(value);
      }
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return { status: response.status, text: new TextDecoder().decode(data) };
  }
  throw new SourceAccessError("Source unavailable after retries");
}

/** Fail closed for explicit blocks and unreadable policies. Telegram currently returns 404. */
export function robotsAllows(text: string, path: string): boolean {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const pair = line.split("#")[0].match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (!pair) continue;
    const field = pair[1].trim().toLowerCase(),
      value = pair[2].trim();
    if (field === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && ["allow", "disallow"].includes(field) && value) {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  const specific = groups.filter((g) =>
    g.agents.some((a) => "crimeradar".startsWith(a) && a !== "*"),
  );
  const applicable = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  const rules = applicable
    .flatMap((g) => g.rules)
    .filter((rule) => {
      const pattern = rule.path
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")
        .replace(/\\\$$/, "$");
      return new RegExp(`^${pattern}`).test(path);
    })
    .sort(
      (a, b) =>
        b.path.length - a.path.length || Number(b.allow) - Number(a.allow),
    );
  return rules[0]?.allow ?? true;
}

function telegramChannelOf(source: SourceDefinition): string {
  const channel = source.telegramChannel;
  try {
    const url = new URL(source.url);
    if (
      source.transport === "telegram" &&
      channel &&
      /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(channel) &&
      url.protocol === "https:" &&
      url.hostname === "t.me" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === `/s/${channel}`
    )
      return channel;
  } catch {
    // Only explicitly configured public Telegram channel URLs are accepted.
  }
  throw new SourceAccessError("Invalid public Telegram source configuration");
}

function telegramPostNumber(post: string, channel: string): number | null {
  const prefix = `${channel}/`;
  if (!post.startsWith(prefix)) return null;
  const suffix = post.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return null;
  const number = Number(suffix);
  return Number.isSafeInteger(number) ? number : null;
}

/** Record a trusted article link as provenance without following it. */
function canonicalArticle(
  source: SourceDefinition,
  value: string,
): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !source.canonicalHosts?.includes(url.hostname) ||
      !/^\/news\/[a-z0-9_-]+$/.test(url.pathname)
    )
      return undefined;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

async function parseTelegramPageWithCursor(
  html: string,
  source: SourceDefinition,
  retrievedAt: string,
): Promise<{ items: RawItem[]; oldestPost: number | undefined }> {
  const channel = telegramChannelOf(source);
  const $ = load(html);
  const result = new Map<string, RawItem>();
  let oldestPost: number | undefined;
  for (const element of $(".tgme_widget_message[data-post]").toArray()) {
    const root = $(element),
      post = root.attr("data-post") ?? "";
    const postNumber = telegramPostNumber(post, channel);
    if (postNumber === null) continue;
    oldestPost = Math.min(oldestPost ?? postNumber, postNumber);
    const node = root.find(".tgme_widget_message_text").first().clone();
    node.find("script,style").remove();
    node.find("br").replaceWith("\n");
    const content = node
      .text()
      .normalize("NFC")
      .replace(/\u00a0/g, " ")
      .trim();
    const date = root
      .find(".tgme_widget_message_date time[datetime], time[datetime]")
      .first()
      .attr("datetime");
    if (!content || content.length > 50000) continue;
    const title =
      node
        .find("b")
        .toArray()
        .map((element) => $(element).text().trim())
        .find((text) => /\p{L}/u.test(text) && text.length > 12) ||
      content.split("\n").find((text) => /\p{L}/u.test(text)) ||
      "";
    let canonicalUrl: string | undefined;
    for (const link of node.find("a[href]").toArray()) {
      canonicalUrl = canonicalArticle(source, $(link).attr("href")!);
      if (canonicalUrl) break;
    }
    const item: RawItem = {
      sourceId: source.id,
      externalId: post,
      sourceUrl: `https://t.me/${post}`,
      title,
      content,
      publishedAt:
        date && Number.isFinite(Date.parse(date))
          ? new Date(date).toISOString()
          : null,
      retrievedAt,
      contentHash: await hash(content),
      canonicalUrl,
      isRepost: root.find(".tgme_widget_message_forwarded_from").length > 0,
    };
    if (!result.has(post) || result.get(post)!.content.length < content.length)
      result.set(post, item);
  }
  return { items: [...result.values()], oldestPost };
}

export async function parseTelegramPage(
  html: string,
  source: SourceDefinition,
  retrievedAt: string,
): Promise<RawItem[]> {
  return (await parseTelegramPageWithCursor(html, source, retrievedAt)).items;
}

/** Compatibility entry point for the original national channel parser. */
export async function parsePolicePage(
  html: string,
  retrievedAt: string,
): Promise<RawItem[]> {
  return parseTelegramPage(html, policeSource, retrievedAt);
}

export class PoliceTelegramCollector implements SourceCollector {
  nextBefore?: number;
  constructor(public source: SourceDefinition = policeSource) {
    telegramChannelOf(source);
  }
  async collect(
    options: { pages?: number; before?: number; signal?: AbortSignal } = {},
  ): Promise<RawItem[]> {
    const channel = telegramChannelOf(this.source);
    if (
      (options.pages !== undefined &&
        (!Number.isFinite(options.pages) || options.pages < 1)) ||
      (options.before !== undefined &&
        (!Number.isSafeInteger(options.before) || options.before < 1))
    )
      throw new SourceAccessError("Invalid Telegram pagination options");
    const pages = Math.min(10, Math.floor(options.pages ?? 3));
    this.nextBefore = undefined;
    const policy = await fetchText("https://t.me/robots.txt", options.signal);
    if (
      policy.status !== 404 &&
      (policy.status !== 200 || !robotsAllows(policy.text, `/s/${channel}`))
    ) {
      throw new SourceAccessError(
        "Source robots policy does not permit collection",
      );
    }
    const items = new Map<string, RawItem>();
    let before = options.before;
    for (let page = 0; page < pages; page++) {
      options.signal?.throwIfAborted();
      if (page) await pause(1500);
      if (
        policy.status === 200 &&
        !robotsAllows(
          policy.text,
          `/s/${channel}${before ? `?before=${before}` : ""}`,
        )
      )
        throw new SourceAccessError(
          "Source robots policy does not permit collection",
        );
      const response = await fetchText(
        this.source.url + (before ? `?before=${before}` : ""),
        options.signal,
      );
      if (response.status !== 200)
        throw new SourceAccessError(
          `Source access failed: HTTP ${response.status}`,
        );
      const parsed = await parseTelegramPageWithCursor(
        response.text,
        this.source,
        new Date().toISOString(),
      );
      if (parsed.oldestPost === undefined)
        throw new SourceAccessError(
          "Source layout changed or empty page; collection stopped",
        );
      for (const item of parsed.items) items.set(item.externalId, item);
      const next = parsed.oldestPost;
      // Media-only posts count towards the cursor. Foreign channel IDs never do.
      if (before !== undefined && next >= before) break;
      before = next;
      this.nextBefore = next;
    }
    return [...items.values()].filter(
      (item) =>
        isCandidate(item.title) ||
        classify(item.content.slice(0, 3000)) !== null,
    );
  }
}
