import { describe, expect, it } from "vitest";
import { parsePolicePage, robotsAllows } from "./collector";
import {
  IncidentProcessor,
  classify,
  extractPlace,
  similarity,
} from "./processor";
import { hash } from "./hash";
import type { RawItem } from "./types";

const html = `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="UA_National_Police/1234">
<div class="tgme_widget_message_text"><i class="emoji"><b>⚖️</b></i><b>У Києві поліцейські викрили шахрайство</b><br>Тестовий текст.<script>bad()</script>
<a href="https://npu.gov.ua/news/test-report?utm_source=test">Детальніше</a></div><time datetime="2026-10-01T12:00:00+03:00"></time></div></div>`;
async function raw(
  title = "У Києві поліцейські викрили шахрайство",
): Promise<RawItem> {
  const content = `${title}\nТестове ім’я: Петренко Іван. Телефон +380501234567, email test@example.com. Вулиця Тестова 12, квартира 5.`;
  return {
    sourceId: "npu-telegram",
    externalId: "UA_National_Police/1234",
    sourceUrl: "https://t.me/UA_National_Police/1234",
    title,
    content,
    publishedAt: "2026-10-01T09:00:00.000Z",
    retrievedAt: "2026-10-06T10:00:00.000Z",
    contentHash: await hash(content),
  };
}
describe("official collector", () => {
  it("uses the text headline rather than bold emoji, canonicalizes provenance and publication time", async () => {
    const [item] = await parsePolicePage(html, "2026-10-06T10:00:00.000Z");
    expect(item.title).toBe("У Києві поліцейські викрили шахрайство");
    expect(item.publishedAt).toBe("2026-10-01T09:00:00.000Z");
    expect(item.canonicalUrl).toBe("https://npu.gov.ua/news/test-report");
    expect(item.content).not.toContain("bad()");
    expect(item.contentHash).toHaveLength(64);
  });
  it("rejects foreign channels and retains undated original posts for review", async () => {
    expect(
      await parsePolicePage(
        html.replaceAll("UA_National_Police/1234", "other/1234"),
        "2026-10-06T10:00:00Z",
      ),
    ).toEqual([]);
    const [undated] = await parsePolicePage(
      html.replace(/<time.*?<\/time>/, ""),
      "2026-10-06T10:00:00Z",
    );
    expect(undated.publishedAt).toBeNull();
  });
  it("respects disallows, specific user agents and the longest matching allow", () => {
    expect(
      robotsAllows("User-agent: *\nDisallow: /s/", "/s/UA_National_Police"),
    ).toBe(false);
    expect(
      robotsAllows(
        "User-agent: *\nDisallow: /\nAllow: /s/UA_National_Police",
        "/s/UA_National_Police",
      ),
    ).toBe(true);
    expect(
      robotsAllows(
        "User-agent: *\nAllow: /\nUser-agent: CrimeRadar\nDisallow: /s/",
        "/s/UA_National_Police",
      ),
    ).toBe(false);
  });
});
describe("publication gate", () => {
  it("publishes bilingual metadata without inventing event time or exposing any raw identifiers", async () => {
    const result = await new IncidentProcessor().process(await raw());
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("Not published");
    const output = JSON.stringify(result.incident);
    for (const privateValue of [
      "Петренко",
      "Іван",
      "+380501234567",
      "test@example.com",
      "Тестова",
      "квартира",
    ])
      expect(output).not.toContain(privateValue);
    expect(result.incident.occurredAt).toBeNull();
    expect(result.incident.reportedAt).toBeUndefined();
    expect(result.incident.synthetic).toBe(false);
    expect(result.incident.location).toMatchObject({
      approximate: true,
      precision: "city",
      city: "Київ",
      cityEn: "Kyiv",
    });
    expect(result.incident.description?.en).toContain("not the incident site");
  });
  it("reviews unknown/ambiguous locations, dates and unavailable geocoding", async () => {
    const processor = new IncidentProcessor();
    expect(
      (await processor.process(await raw("На Київщині викрили шахрайство")))
        .status,
    ).toBe("review");
    expect(
      (
        await processor.process(
          await raw("У Києві та Одесі викрили шахрайство"),
        )
      ).status,
    ).toBe("review");
    expect(
      (await processor.process({ ...(await raw()), publishedAt: null })).status,
    ).toBe("review");
    expect(
      (
        await new IncidentProcessor({ geocode: async () => null }).process(
          await raw(),
        )
      ).status,
    ).toBe("review");
  });
  it("does not turn advice, war reports or multi-category reports into street incidents", () => {
    expect(
      classify("Нагадуємо, як не стати жертвою шахрайства у Києві"),
    ).toBeNull();
    expect(
      classify("У Києві росіяни атакували дронами: виникла пожежа"),
    ).toBeNull();
    expect(classify("У Києві розслідують крадіжку та шахрайство")).toBeNull();
    expect(extractPlace("На Київщині")).toBeNull();
    expect(extractPlace("У Луцьку викрили шахрайство")?.en).toBe("Lutsk");
    expect(
      similarity("Крадіжка велосипеда у Києві", "У Києві крадіжка велосипеда"),
    ).toBe(1);
  });
  it("keeps the same identity across edits and honors canonical article identity", async () => {
    const processor = new IncidentProcessor();
    const first = await processor.process(await raw());
    const second = await processor.process({
      ...(await raw()),
      content: "changed",
      contentHash: await hash("changed"),
    });
    if (first.status !== "published" || second.status !== "published")
      throw new Error("Not published");
    expect(first.incident.id).toBe(second.incident.id);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});
