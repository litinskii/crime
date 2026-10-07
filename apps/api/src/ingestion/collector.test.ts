import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchText,
  parsePolicePage,
  parseTelegramPage,
  PoliceTelegramCollector,
  SourceAccessError,
} from "./collector";
import { sourceById } from "./sources";
import { createCollector } from "./web-collector";

const source = sourceById("npu-vinnytsia-telegram")!;
const retrievedAt = "2026-10-06T12:00:00.000Z";
// Small synthetic fixtures: public originals and personal identifiers are not stored.
function message(
  post: string,
  body = "<b>У Вінниці поліцейські розслідують крадіжку</b><br>Обставини події.",
  extra = "",
  datetime = "2026-10-06T11:00:00+03:00",
) {
  return `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${post}">${extra}
    <div class="tgme_widget_message_text">${body}</div>
    <a class="tgme_widget_message_date"><time datetime="${datetime}"></time></a>
    </div></div>`;
}
function mockPages(pages: Record<string, string>, robots?: string) {
  const fetchMock = vi.fn(async (value: string | URL | Request) => {
    const url = String(value);
    if (url === "https://t.me/robots.txt")
      return new Response(robots ?? "", { status: robots ? 200 : 404 });
    if (!(url in pages)) throw new Error(`Unexpected request: ${url}`);
    return new Response(pages[url], { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe("source content negotiation", () => {
  it("accepts RSS from a publisher XML route requiring a generic MIME fallback", async () => {
    const url = "https://lb.ua/rss/ukr/society.xml";
    const xml = "<rss><channel><title>Суспільство</title></channel></rss>";
    const rssServer = vi.fn(
      async (value: string | URL | Request, init?: RequestInit) => {
        if (String(value) !== url) throw new Error("Unexpected source URL");
        const offers = (new Headers(init?.headers).get("Accept") ?? "")
          .split(",")
          .map((offer) => offer.trim().toLowerCase().split(";")[0]);
        // LB's XML route also requires a generic fallback despite returning
        // application/rss+xml. The finite old Accept list reproduces HTTP 406.
        return offers.includes("application/rss+xml") && offers.includes("*/*")
          ? new Response(xml, {
              status: 200,
              headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
            })
          : new Response("Not Acceptable", { status: 406 });
      },
    );
    vi.stubGlobal("fetch", rssServer);

    expect(await fetchText(url)).toEqual({ status: 200, text: xml });
    expect(rssServer).toHaveBeenCalledTimes(1);
  });
});

describe("configured Telegram provenance", () => {
  it("isolates channel IDs, source IDs and timestamps in mixed pages", async () => {
    const [item] = await parseTelegramPage(
      message("NPU_Rivne/1", undefined, "", "2026-10-01T00:00:00Z") +
        message("vinnpol/22") +
        message("vinnpol_evil/23") +
        message("vinnpol/9007199254740992"),
      source,
      retrievedAt,
    );
    expect(item).toMatchObject({
      sourceId: source.id,
      externalId: "vinnpol/22",
      sourceUrl: "https://t.me/vinnpol/22",
      publishedAt: "2026-10-06T08:00:00.000Z",
      retrievedAt,
      isRepost: false,
    });
    expect(item.contentHash).toHaveLength(64);
    expect(
      await parseTelegramPage(message("NPU_Rivne/22"), source, retrievedAt),
    ).toEqual([]);
  });

  it("keeps the national parser's public entry point", async () => {
    const [item] = await parsePolicePage(
      message(
        "UA_National_Police/22",
        '<b>У Києві поліцейські розслідують крадіжку</b><a href="https://dp.npu.gov.ua/news/report?v=123">Деталі</a>',
      ),
      retrievedAt,
    );
    expect(item.sourceId).toBe("npu-telegram");
    expect(item.canonicalUrl).toBe("https://dp.npu.gov.ua/news/report");
  });

  it("marks actual forwarding without inventing the original timestamp", async () => {
    const [forwarded, original] = await parseTelegramPage(
      message(
        "vinnpol/22",
        undefined,
        '<div class="tgme_widget_message_forwarded_from">Forwarded from <a href="https://t.me/UA_National_Police/1">Поліція</a></div>',
      ) +
        message(
          "vinnpol/23",
          '<b>У Вінниці поліцейські розслідують крадіжку</b><a href="https://vn.npu.gov.ua/news/report">Джерело</a>',
        ),
      source,
      retrievedAt,
    );
    expect(forwarded.isRepost).toBe(true);
    expect(forwarded.originalPublishedAt).toBeUndefined();
    expect(original.isRepost).toBe(false);
    expect(original.canonicalUrl).toBeDefined();
    expect(original.originalPublishedAt).toBeUndefined();
  });

  it("ignores unrelated official hosts and unsafe canonical URLs", async () => {
    const unsafe = [
      "https://rv.npu.gov.ua/news/report",
      "https://unverified.npu.gov.ua/news/report",
      "https://vn.npu.gov.ua.evil.test/news/report",
      "http://vn.npu.gov.ua/news/report",
      "https://user:password@vn.npu.gov.ua/news/report",
      "https://vn.npu.gov.ua:444/news/report",
      "https://vn.npu.gov.ua/news/",
      "https://vn.npu.gov.ua/news/report/related",
      "https://vn.npu.gov.ua/news/report%2Fother",
      "https://bit.ly/report",
      "javascript:alert(1)",
    ];
    const links = unsafe
      .map((url) => `<a href="${url}">Посилання</a>`)
      .join("");
    const [item] = await parseTelegramPage(
      message(
        "vinnpol/22",
        `${links}<a href="https://vn.npu.gov.ua/news/report?v=1#section">Деталі</a>`,
      ),
      source,
      retrievedAt,
    );
    expect(item.canonicalUrl).toBe("https://vn.npu.gov.ua/news/report");
    const [withoutCanonical] = await parseTelegramPage(
      message("vinnpol/23", links),
      source,
      retrievedAt,
    );
    expect(withoutCanonical.canonicalUrl).toBeUndefined();
  });

  it("keeps the richest duplicate text and strips executable markup", async () => {
    const items = await parseTelegramPage(
      message("vinnpol/22", "Коротко") +
        message(
          "vinnpol/22",
          "Довші обставини події<script>secret()</script>",
        ) +
        message("vinnpol/23", ""),
      source,
      retrievedAt,
    );
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe("Довші обставини події");
  });

  it("refuses unconfigured channels and non-public collection URLs", () => {
    for (const changes of [
      { telegramChannel: undefined },
      { telegramChannel: "another_channel" },
      { url: "https://evil.test/s/vinnpol" },
      { url: "https://user:pass@t.me/s/vinnpol" },
      { url: "https://t.me:444/s/vinnpol" },
      { url: "https://t.me/s/vinnpol?before=1" },
      { url: "https://t.me/s/vinnpol#fragment" },
      { url: "http://t.me/s/vinnpol" },
    ])
      expect(
        () => new PoliceTelegramCollector({ ...source, ...changes }),
      ).toThrow(SourceAccessError);
  });
});

describe("bounded Telegram collection", () => {
  it("factory retains the selected regional source", () => {
    const collector = createCollector(source.id);
    expect(collector).toBeInstanceOf(PoliceTelegramCollector);
    expect(collector.source).toBe(source);
  });

  it("paginates past media-only posts, ignores foreign IDs and deduplicates", async () => {
    const fetchMock = mockPages({
      [source.url]:
        message("vinnpol/12") +
        message("vinnpol/10", "") +
        message("NPU_Rivne/1"),
      [`${source.url}?before=10`]: message("vinnpol/12") + message("vinnpol/9"),
    });
    const collector = new PoliceTelegramCollector(source);
    const items = await collector.collect({ pages: 2 });
    expect(items.map((item) => item.externalId)).toEqual([
      "vinnpol/12",
      "vinnpol/9",
    ]);
    expect(collector.nextBefore).toBe(9);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://t.me/robots.txt",
      source.url,
      `${source.url}?before=10`,
    ]);
  });

  it("continues through a page containing only media and retains its cursor", async () => {
    mockPages({
      [`${source.url}?before=10`]: message("vinnpol/9", ""),
      [`${source.url}?before=9`]: message("vinnpol/8"),
    });
    const collector = new PoliceTelegramCollector(source);
    expect(
      (await collector.collect({ pages: 2, before: 10 }))[0].externalId,
    ).toBe("vinnpol/8");
    expect(collector.nextBefore).toBe(8);
  });

  it("stops when an archive page makes no progress", async () => {
    const fetchMock = mockPages({
      [`${source.url}?before=10`]: message("vinnpol/10"),
    });
    const collector = new PoliceTelegramCollector(source);
    await collector.collect({ pages: 10, before: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(collector.nextBefore).toBeUndefined();
  });

  it("fails closed for another channel's layout or robots denial", async () => {
    mockPages({ [source.url]: message("NPU_Rivne/1") });
    await expect(
      new PoliceTelegramCollector(source).collect({ pages: 1 }),
    ).rejects.toThrow("layout changed");
    const fetchMock = mockPages({}, "User-agent: *\nDisallow: /s/vinnpol");
    await expect(new PoliceTelegramCollector(source).collect()).rejects.toThrow(
      "robots policy",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks robots against the regional pagination path", async () => {
    const fetchMock = mockPages(
      {},
      "User-agent: *\nDisallow: /s/vinnpol?before=",
    );
    await expect(
      new PoliceTelegramCollector(source).collect({ pages: 1, before: 10 }),
    ).rejects.toThrow("robots policy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid cursors before making network requests", async () => {
    const fetchMock = mockPages({});
    for (const before of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      await expect(
        new PoliceTelegramCollector(source).collect({ before }),
      ).rejects.toThrow("pagination options");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
