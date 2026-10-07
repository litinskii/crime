import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncidentProcessor } from "./processor";
import { sourceById } from "./sources";
import {
  allowedArticle,
  parseArticle,
  parseFeed,
  WebCollector,
} from "./web-collector";

const retrievedAt = "2026-10-07T12:00:00.000Z";
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url), "utf8");
const configured = (id: string) => {
  const source = sourceById(id);
  if (!source) throw new Error(`Missing media source: ${id}`);
  return source;
};

afterEach(() => vi.unstubAllGlobals());

describe("regional media article provenance", () => {
  it.each([
    ["dnepr-news", "https://dnepr.express/ua/post/incident-report"],
    ["zaporizhzhia-061", "https://www.061.ua/news/4163789/incident-report"],
    ["poltava-events", "https://poltava.to/news/88457/"],
    [
      "lb-society",
      "https://lb.ua/society/2026/10/06/771614_incident_report.html",
    ],
  ])("accepts the publisher's article path for %s", (id, url) => {
    const source = configured(id);
    expect(allowedArticle(source, `${url}?utm_source=feed#content`)).toBe(url);
    const parsed = new URL(url);
    for (const unsafe of [
      `https://evil.test${parsed.pathname}`,
      `https://${parsed.hostname}.evil.test${parsed.pathname}`,
      `http://${parsed.hostname}${parsed.pathname}`,
      `https://user:password@${parsed.hostname}${parsed.pathname}`,
      `https://${parsed.hostname}:444${parsed.pathname}`,
      `https://${parsed.hostname}${parsed.pathname}/another`,
      `https://${parsed.hostname}${parsed.pathname}%2Fanother`,
    ])
      expect(allowedArticle(source, unsafe)).toBeNull();
  });

  it.each([
    ["dnepr-news", "https://dnepr.express/ua/category/proischestvija"],
    ["zaporizhzhia-061", "https://www.061.ua/news"],
    ["poltava-events", "https://poltava.to/news/events/"],
    ["lb-society", "https://lb.ua/society"],
  ])("refuses section links from %s", (id, url) => {
    expect(allowedArticle(configured(id), url)).toBeNull();
  });
});

describe("bounded media RSS parsing", () => {
  it.each([
    ["dnepr-news", "dnepr.xml", "2026-10-05T09:04:00.000Z"],
    ["zaporizhzhia-061", "061.xml", "2026-10-06T14:36:00.000Z"],
    ["poltava-events", "poltava.xml", "2026-10-04T06:54:51.000Z"],
    ["lb-society", "lb.xml", "2026-10-06T14:57:00.000Z"],
  ])(
    "reads trusted provenance and publication timezone for %s",
    async (id, file, publishedAt) => {
      const source = configured(id);
      const items = await parseFeed(fixture(file), source, retrievedAt);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sourceId: id,
        publishedAt,
        retrievedAt,
      });
      expect(items[0].sourceUrl).toBe(items[0].canonicalUrl);
      expect(items[0].externalId).toBe(items[0].sourceUrl);
      expect(items[0].contentHash).toHaveLength(64);
    },
  );

  it.each([
    ["dnepr-news", "dnepr.xml", "5 жовтня"],
    ["zaporizhzhia-061", "061.xml", "6 жовтня"],
  ])(
    "keeps the full body and removes related reminders for %s",
    async (id, file, date) => {
      const [item] = await parseFeed(
        fixture(file),
        configured(id),
        retrievedAt,
      );
      expect(item.content).toContain(date);
      expect(item.content).not.toContain("Короткий опис");
      expect(item.content).not.toContain("unrelated_");
      expect(item.content).not.toContain("<p>");
    },
  );

  it("finds eligible reports below thirty unrelated headlines", async () => {
    const source = configured("dnepr-news");
    const unrelated = Array.from(
      { length: 35 },
      (_, i) =>
        `<item><title>Економічний огляд ${i}</title><link>https://dnepr.express/ua/post/economy-${i}</link><pubDate>Wed, 07 Oct 2026 10:00:00 +0300</pubDate><description>Огляд цін.</description></item>`,
    ).join("");
    const report = fixture("dnepr.xml").match(/<item>[\s\S]*?<\/item>/)![0];
    const items = await parseFeed(
      `<rss><channel>${unrelated}${report}</channel></rss>`,
      source,
      retrievedAt,
    );
    expect(items).toHaveLength(1);
    expect(items[0].sourceUrl).toContain("/ua/post/vranci-nad-and-");
  });

  it("caps eligible originals before staging a large regional feed", async () => {
    const items = Array.from(
      { length: 64 },
      (_, i) =>
        `<item><title>У Дніпрі сталася пожежа ${i}</title><link>https://dnepr.express/ua/post/fire-${i}</link><pubDate>Wed, 07 Oct 2026 10:00:00 +0300</pubDate><description>7 жовтня у Дніпрі сталася пожежа. За повідомленням рятувальників, вогонь ліквідували. Ніхто не постраждав. Обставини займання встановлюються.</description></item>`,
    ).join("");
    const parsed = await parseFeed(
      `<rss><channel>${items}</channel></rss>`,
      configured("dnepr-news"),
      retrievedAt,
    );
    expect(parsed).toHaveLength(12);
    expect(new Set(parsed.map((item) => item.sourceUrl)).size).toBe(12);
  });
  it("does not turn collaboration proceedings or advice into ordinary incidents", async () => {
    const articles = [
      "Чотирьом експравоохоронцям з Бердянська повідомлено про підозру через роботу в окупаційній поліції",
      "Як поліція кваліфікує домашнє насильство",
    ];
    for (const [i, title] of articles.entries()) {
      const xml = `<rss><channel><item><title>${title}</title><link>https://dnepr.express/ua/post/report-${i}</link><pubDate>Wed, 07 Oct 2026 10:00:00 +0300</pubDate><description>У Мелітополі застосовували правила дорожнього руху. Це не описує ДТП, місце або дату дорожнього зіткнення. Кримінальне провадження стосується співпраці з окупантами.</description></item></channel></rss>`;
      expect(
        await parseFeed(xml, configured("dnepr-news"), retrievedAt),
      ).toEqual([]);
    }
  });
  it("locates a media fire by its explicitly named urban district without using the publisher city", async () => {
    const [raw] = await parseFeed(
      fixture("dnepr.xml"),
      configured("dnepr-news"),
      retrievedAt,
    );
    const result = await new IncidentProcessor().process(raw);
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("Expected publication");
    expect(result.incident.location.city).toBe("Дніпро");
  });
  it("recognizes an axe attack headline but keeps a shooting after a collision on review", async () => {
    const source = configured("dnepr-news");
    const make = (title: string) =>
      `<rss><channel><item><title>${title}</title><link>https://dnepr.express/ua/post/incident</link><pubDate>Wed, 07 Oct 2026 10:00:00 +0300</pubDate><description>7 жовтня у Дніпрі стався напад. За повідомленням поліції, людина отримала тілесні ушкодження. Обставини події встановлюються.</description></item></channel></rss>`;
    const [attack] = await parseFeed(
      make("У Дніпрі чоловік узяв сокиру та поранив людей"),
      source,
      retrievedAt,
    );
    const result = await new IncidentProcessor().process(attack);
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("Expected publication");
    expect(result.incident.category).toBe("violence");
    const [mixed] = await parseFeed(
      make("У Дніпрі чоловіка розстріляли після ДТП"),
      source,
      retrievedAt,
    );
    expect(await new IncidentProcessor().process(mixed)).toEqual({
      status: "review",
      reason: "multiple-headline-categories",
    });
  });
  it("does not let additional violence headline forms bypass war, memorial or training exclusions", async () => {
    for (const title of [
      "У Дніпрі росіяни розстріляли цивільного",
      "У Дніпрі російські окупанти розстріляли цивільного",
      "Роковини стрілянини у Дніпрі",
      "Навчання у Дніпрі: стрілянина на полігоні",
    ]) {
      const xml = `<rss><channel><item><title>${title}</title><link>https://dnepr.express/ua/post/report</link><pubDate>Wed, 07 Oct 2026 10:00:00 +0300</pubDate><description>7 жовтня у Дніпрі повідомили про подію. У повідомленні також згадано розслідування. Це не підтверджує звичайне кримінальне происшествие з місцем та датою.</description></item></channel></rss>`;
      expect(
        await parseFeed(xml, configured("dnepr-news"), retrievedAt),
      ).toEqual([]);
    }
  });

  it("skips old publications without turning them into current incidents", async () => {
    const xml = fixture("dnepr.xml").replace(
      "Mon, 05 Oct 2026 12:04:00 +0300",
      "Mon, 05 Oct 2020 12:04:00 +0300",
    );
    expect(await parseFeed(xml, configured("dnepr-news"), retrievedAt)).toEqual(
      [],
    );
  });

  it("reports an empty layout and ignores an item with untrusted provenance", async () => {
    const source = configured("dnepr-news");
    await expect(
      parseFeed("<rss><channel /></rss>", source, retrievedAt),
    ).rejects.toThrow("layout changed");
    expect(
      await parseFeed(
        "<rss><channel><item><title>У Дніпрі сталася пожежа</title><link>https://evil.test/ua/post/incident</link></item></channel></rss>",
        source,
        retrievedAt,
      ),
    ).toEqual([]);
  });

  it("refuses truncated XML and DTDs before producing partial originals", async () => {
    const source = configured("dnepr-news");
    const xml = fixture("dnepr.xml");
    for (const invalid of [
      xml.replace(/<\/rss>\s*$/, ""),
      `<!DOCTYPE rss [<!ENTITY incident "Untrusted">]>${xml}`,
    ])
      await expect(parseFeed(invalid, source, retrievedAt)).rejects.toThrow(
        "Source RSS invalid",
      );
  });
});

describe("publisher article extraction", () => {
  it("extracts Poltava's article including nested intro and excludes other stories", async () => {
    const source = configured("poltava-events");
    const article = parseArticle(fixture("poltava.html"), source);
    expect(article.title).toBe("У Полтаві сталася ДТП за участю тролейбуса");
    expect(article.content).toContain("сталася 3 жовтня у Полтаві");
    expect(article.content).toContain("адміністративний протокол");
    expect(article.content).not.toContain("unrelated_");
    expect(article.publishedAt).toBe("2026-10-04T06:54:51.000Z");

    const [raw] = await parseFeed(fixture("poltava.xml"), source, retrievedAt);
    const result = await new IncidentProcessor().process({
      ...raw,
      title: article.title,
      content: article.content,
      publishedAt: article.publishedAt,
    });
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("Expected publication");
    expect(result.incident.location.city).toBe("Полтава");
    expect(result.incident.occurredOn).toBe("2026-10-03");
  });

  it("uses LB's body with accurate JSON-LD time and ignores linked inset text", () => {
    const article = parseArticle(fixture("lb.html"), configured("lb-society"));
    expect(article.title).toBe("У Ковелі розслідують побиття");
    expect(article.content).toContain("5 жовтня у Ковелі");
    expect(article.content).toContain("потерпілому надали допомогу");
    expect(article.content).not.toContain("unrelated_");
    // The visible <time> incorrectly says Z; JSON-LD supplies +03:00.
    expect(article.publishedAt).toBe("2026-10-06T14:57:00.000Z");
  });
});

describe("media collection request budget", () => {
  it("treats a readable feed with no eligible incidents as a successful empty poll", async () => {
    const source = configured("dnepr-news");
    const xml = `<rss><channel><item><title>Економічний огляд</title><link>https://dnepr.express/ua/post/economy-report</link><pubDate>${new Date().toUTCString()}</pubDate><description>Огляд економічних показників.</description></item></channel></rss>`;
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === new URL("/robots.txt", source.url).href)
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      if (url === source.url) return new Response(xml, { status: 200 });
      throw new Error(`Unexpected article request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await new WebCollector(source).collect()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["dnepr-news", "dnepr.xml"],
    ["zaporizhzhia-061", "061.xml"],
  ])(
    "does not fetch articles already supplied by the full RSS for %s",
    async (id, file) => {
      const source = configured(id);
      const xml = fixture(file).replace(
        /<pubDate>[^<]*<\/pubDate>/,
        `<pubDate>${new Date().toUTCString()}</pubDate>`,
      );
      const fetchMock = vi.fn(async (value: string | URL | Request) => {
        const url = String(value);
        if (url === new URL("/robots.txt", source.url).href)
          return new Response("User-agent: *\nAllow: /", { status: 200 });
        if (url === source.url) return new Response(xml, { status: 200 });
        throw new Error(`Unexpected article request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const items = await new WebCollector(source).collect();
      expect(items).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("refuses a feed exceeding the existing response byte limit", async () => {
    const source = configured("dnepr-news");
    const fetchMock = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      return url.endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /", { status: 200 })
        : new Response("x".repeat(2_000_001), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new WebCollector(source).collect()).rejects.toThrow(
      "size limit",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
