import { describe, it, expect } from "vitest";
import { parseFeed, parseArticle, allowedArticle } from "./web-collector";
import { scheduledSources, sourceById, sources } from "./sources";
import { rtfToText, validCourtDocument } from "./court";
import { IncidentProcessor, courtEvent, extractPlace } from "./processor";
import { hash } from "./hash";
import type { RawItem } from "./types";
async function raw(
  title: string,
  content = title,
  sourceId = "zaxid-news",
): Promise<RawItem> {
  return {
    sourceId,
    externalId: "123",
    sourceUrl: "https://zaxid.net/test_n123",
    title,
    content,
    publishedAt: "2026-10-01T12:00:00Z",
    retrievedAt: "2026-10-06T12:00:00Z",
    contentHash: await hash(content),
  };
}
describe("public-source adapters", () => {
  it("schedules only verified regional Telegram sources with bounded cadence", () => {
    const regions = sources.filter(
      (source) => source.transport === "telegram" && source.regionCode,
    );
    expect(regions.map((source) => source.telegramChannel)).toEqual([
      "vinnpol",
      "NPU_Rivne",
      "policevolyn",
      "police_bukovina",
      "zt_police",
    ]);
    expect(new Set(sources.map((source) => source.id)).size).toBe(
      sources.length,
    );
    for (const source of regions) {
      expect(source.url).toBe(`https://t.me/s/${source.telegramChannel}`);
      expect(
        new URL(source.verificationUrl).hostname.endsWith("npu.gov.ua"),
      ).toBe(true);
      expect(source.cadenceMinutes).toBeGreaterThanOrEqual(60);
      expect(source.cadenceMinutes).toBeLessThanOrEqual(60);
      expect(source.canonicalHosts).toHaveLength(1);
      expect(scheduledSources).toContain(source);
    }
    expect(sourceById("npu-rivne-telegram")?.regionCode).toBe("19");
    expect(sourceById("npu-telegram")?.cadenceMinutes).toBe(60);
  });
  it("reads namespace dates and full RSS text; refuses external or arbitrary URLs", async () => {
    const s = sourceById("zaxid-news")!;
    const [r] = await parseFeed(
      '<rss xmlns:dc="test"><channel><item><title>У Львові викрили шахрайство</title><link>https://zaxid.net/test_n123</link><description><![CDATA[<p>Текст</p>]]></description><dc:date>2026-10-01T15:00:00+03:00</dc:date></item></channel></rss>',
      s,
      "2026-10-06T12:00:00Z",
    );
    expect(r.publishedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(r.content).toContain("Текст");
    for (const url of [
      "https://evil.test/test_n123",
      "http://zaxid.net/test_n123",
      "https://zaxid.net/home/showArchive.do",
      "https://user:pass@zaxid.net/test_n123",
      "https://zaxid.net:123/test_n123",
    ])
      expect(allowedArticle(s, url)).toBeNull();
  });
  it("finds a full article in JSON-LD graphs and strips executable markup", () => {
    const metadata = JSON.stringify({
      "@graph": [
        {
          "@type": "NewsArticle",
          headline: "Подія",
          articleBody: "<p>Обставини</p><script>evil()</script>",
          datePublished: "2026-10-01T12:00:00Z",
        },
      ],
    }).replaceAll("<", "\\u003c");
    const article = parseArticle(
      `<script type="application/ld+json">${metadata}</script>`,
    );
    expect(article.content).toBe("Обставини");
    expect(article.publishedAt).toBe("2026-10-01T12:00:00.000Z");
  });
  it("decodes official ANSI and Unicode RTF and rejects foreign document hosts", () => {
    expect(
      rtfToText(
        "{\\rtf1\\ansi{\\fonttbl ignored;}\\'ca\\'e8\\'bf\\'e2\\par\\u1030?}",
      ),
    ).toBe("Київ\nІ");
    expect(
      validCourtDocument({
        id: "123",
        url: "https://evil.test/file.rtf",
        publishedAt: "2026-10-01T12:00:00Z",
        caseNumber: "1/2/26",
        category: "Крадіжка",
      }),
    ).toBe(false);
  });
});
describe("event geography and provenance", () => {
  it("extracts explicit media event dates without substituting a detention or judgment date", async () => {
    const p = new IncidentProcessor();
    const r = await p.process(
      await raw(
        "У Києві сталася крадіжка",
        "30 вересня 2026 року у Києві чоловік викрав велосипед.",
      ),
    );
    expect(r.status).toBe("published");
    if (r.status !== "published") throw Error("Expected publication");
    expect(r.incident.occurredOn).toBe("2026-09-30");
    const detention = await p.process(
      await raw(
        "У Києві розкрили крадіжку",
        "30 вересня 2026 року затримали чоловіка, який викрав велосипед.",
      ),
    );
    if (detention.status !== "published") throw Error("Expected publication");
    expect(detention.incident.occurredOn).toBeUndefined();
  });
  it("does not turn memorials, landmark words or a victim's name into settlement coordinates", async () => {
    const p = new IncidentProcessor();
    expect(
      (
        await p.process(
          await raw(
            "Роковини трагедії Бабиного Яру",
            "Згадується насильство та загиблі у Бабиному Яру.",
          ),
        )
      ).status,
    ).toBe("rejected");
    expect(
      (await p.process(await raw("У Бабин Яр сталося пограбування"))).status,
    ).toBe("review");
    expect(
      (
        await p.process(
          await raw(
            "У Варшаві викрили шахрайство",
            "У Києві раніше затримували підозрюваного.",
          ),
        )
      ).status,
    ).toBe("review");
  });
  it("covers towns outside the original eleven and disambiguates names only with region context", () => {
    expect(extractPlace("У Тернополі сталася ДТП")?.uk).toBe("Тернопіль");
    expect(extractPlace("У Рівному викрили шахрайство")).toBeNull();
    expect(
      extractPlace(
        "У Рівному викрили шахрайство",
        "Поліція Рівненщини повідомила про подію",
      )?.regionCode,
    ).toBe("19");
  });
  it("uses a location in incident text, preserves media attribution and publishes safe facts", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "На Буковині викрили хабарництво",
        "У Чернівцях поліцейські викрили хабарництво. Повідомили про підозру за ст. 368 КК України. Петренко, +380501234567.",
      ),
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.sources[0]).toMatchObject({
      name: "ZAXID.NET",
      kind: "media",
    });
    expect(result.incident.legalQualification?.article).toBe("368");
    expect(JSON.stringify(result.incident)).not.toContain("Петренко");
    expect(JSON.stringify(result.incident)).not.toContain("+380");
  });
  it("never locates a court incident at the court or defendants birthplace", async () => {
    const report = await raw(
      "Вирок: Крадіжка",
      "ВИРОК м. Київ. Обвинувачений — уродженець м. Львів. ВСТАНОВИВ: 01.09.2026 викрав майно за адресою АДРЕСА_1.",
      "court-decisions",
    );
    expect(courtEvent(report)).toBeNull();
    expect((await new IncidentProcessor().process(report)).status).toBe(
      "review",
    );
  });
  it("publishes court records only with an explicit event date and named settlement in the event narrative", async () => {
    const report = await raw(
      "Вирок: Крадіжка",
      "Справа №123/456/26\nВИРОК м. Київ\nВСТАНОВИВ:\n01.09.2026 у м. Тернополі обвинувачений викрав велосипед.\nУ судовому засіданні досліджено докази.",
      "court-decisions",
    );
    const result = await new IncidentProcessor().process(report);
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.occurredOn).toBe("2026-09-01");
    expect(result.incident.occurredAt).toBeNull();
    expect(result.incident.location.city).toBe("Тернопіль");
    expect(result.incident.status).toBe("court");
    expect(result.canonicalKey).toBe("court-document:123");
  });
});
