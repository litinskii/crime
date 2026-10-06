import { describe, expect, it } from "vitest";
import {
  extractEventDate,
  kyivCalendarDay,
  eventPublicationIssue,
} from "./event-date";
import type { EventDateContext } from "./event-date";
import { IncidentProcessor, ruleVersion } from "./processor";
import { hash } from "./hash";
import type { RawItem } from "./types";

const context: EventDateContext = {
  publishedAt: "2026-10-06T07:00:00Z",
  sourceUrl: "https://t.me/UA_National_Police/1234",
};
function date(text: string, extra: Partial<EventDateContext> = {}) {
  return extractEventDate(text, { ...context, ...extra });
}
async function raw(
  title: string,
  content: string,
  extra: Partial<RawItem> = {},
): Promise<RawItem> {
  return {
    sourceId: "npu-telegram",
    externalId: "UA_National_Police/1234",
    sourceUrl: context.sourceUrl,
    publishedAt: context.publishedAt,
    retrievedAt: "2026-10-06T09:00:00Z",
    title,
    content,
    contentHash: await hash(content),
    ...extra,
  };
}

describe("event calendar dates", () => {
  it.each([
    [
      "2 жовтня 2026 року у Києві чоловік викрав велосипед.",
      "2026-10-02",
      "explicit",
    ],
    ["02.10.2026 у Києві чоловік викрав велосипед.", "2026-10-02", "explicit"],
    ["2026-10-02 у Києві чоловік викрав велосипед.", "2026-10-02", "explicit"],
    [
      "2 жовтня у Києві чоловік викрав велосипед.",
      "2026-10-02",
      "inferred-year",
    ],
    [
      "Інцидент трапився 5 жовтня. Близько 21:00 у Луцьку чоловік завдав потерпілому удару.",
      "2026-10-05",
      "inferred-year",
    ],
    ["Учора у Києві чоловік викрав велосипед.", "2026-10-05", "relative"],
    ["Вчора у Києві чоловік викрав велосипед.", "2026-10-05", "relative"],
    ["Сьогодні у Києві чоловік викрав велосипед.", "2026-10-06", "relative"],
    ["ДТП сталася вчора у Львові.", "2026-10-05", "relative"],
    ["Вчора у Львові виникла пожежа.", "2026-10-05", "relative"],
    ["Сьогодні у Львові загорівся будинок.", "2026-10-06", "relative"],
  ])("dates the episode in %s", (text, occurredOn, kind) => {
    expect(date(text)).toMatchObject({
      status: "known",
      occurredOn,
      evidence: { kind, sourceUrl: context.sourceUrl, timeZone: "Europe/Kyiv" },
    });
  });
  it("uses the Kyiv calendar across UTC midnight and a year boundary", () => {
    const publishedAt = "2025-12-31T22:30:00Z";
    expect(kyivCalendarDay(publishedAt)).toBe("2026-01-01");
    expect(
      date("Сьогодні у Києві чоловік викрав велосипед.", { publishedAt }),
    ).toMatchObject({ occurredOn: "2026-01-01" });
    expect(
      date("Вчора у Києві чоловік викрав велосипед.", { publishedAt }),
    ).toMatchObject({ occurredOn: "2025-12-31" });
    expect(
      date("31 грудня у Києві чоловік викрав велосипед.", { publishedAt }),
    ).toMatchObject({
      occurredOn: "2025-12-31",
      evidence: { anchorPublishedAt: publishedAt },
    });
  });
  it.each([
    ["2026-03-28T22:30:00Z", "2026-03-29", "2026-03-28"],
    ["2026-03-29T21:15:00Z", "2026-03-30", "2026-03-29"],
    ["2026-10-25T22:30:00Z", "2026-10-26", "2026-10-25"],
  ])(
    "shifts calendar days across DST (%s)",
    (publishedAt, today, yesterday) => {
      expect(
        date("Сьогодні у Києві чоловік викрав велосипед.", { publishedAt }),
      ).toMatchObject({ occurredOn: today });
      expect(
        date("Вчора у Києві чоловік викрав велосипед.", { publishedAt }),
      ).toMatchObject({ occurredOn: yesterday });
    },
  );
  it("uses the publication date rather than the day the collector runs", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві сталася крадіжка",
        "Вчора у Києві чоловік викрав велосипед.",
        {
          publishedAt: "2026-10-01T08:00:00Z",
          retrievedAt: "2026-10-06T09:00:00Z",
        },
      ),
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.occurredOn).toBe("2026-09-30");
    expect(result.incident.occurredAt).toBeNull();
    expect(result.incident.eventDateEvidence).toEqual({
      kind: "relative",
      text: "Вчора",
      sourceUrl: context.sourceUrl,
      anchorPublishedAt: "2026-10-01T08:00:00Z",
      timeZone: "Europe/Kyiv",
    });
    expect(ruleVersion).toContain("v4");
  });
  it.each([
    "5 жовтня 2026 року затримали чоловіка, який викрав велосипед.",
    "Вчора поліцейські повідомили про крадіжку, яку вчинив чоловік.",
    "5 жовтня суд засудив чоловіка, який викрав велосипед.",
    "5 жовтня надійшло повідомлення про пожежу, яка сталася у Львові.",
    "5 жовтня 2026 року вбивство розкрили поліцейські.",
    "Сьогодні у Києві поліцейські викрили чоловіка, який викрав велосипед.",
    "5 жовтня у Києві суд обрав запобіжний захід чоловіку, який викрав велосипед.",
    "5 жовтня у Києві чоловіку вручили підозру, бо він викрав велосипед.",
    "5 жовтня у Києві прокурори передали до суду справу чоловіка, який викрав велосипед.",
    "5 жовтня у Києві поліцейські перевірили повідомлення про чоловіка, який викрав велосипед.",
  ])("does not date an arrest, report or judgment: %s", (text) => {
    expect(date(text).status).toBe("unknown");
  });
  it("can separate the report date from an explicitly dated episode", () => {
    expect(
      date(
        "5 жовтня поліцейські повідомили про ДТП, яка сталася 2 жовтня 2026 року у Києві.",
      ),
    ).toMatchObject({
      status: "known",
      occurredOn: "2026-10-02",
      evidence: { kind: "explicit" },
    });
  });
  it("keeps a separately dated act when the next clause describes a procedural action", () => {
    expect(
      date(
        "Учора у Києві чоловік викрав велосипед та сьогодні поліцейські вручили йому підозру.",
      ),
    ).toMatchObject({
      status: "known",
      occurredOn: "2026-10-05",
      evidence: { text: "Учора" },
    });
    expect(
      date(
        "Сьогодні поліцейські викрили чоловіка, який 2 жовтня 2026 року у Києві викрав велосипед.",
      ),
    ).toMatchObject({
      status: "known",
      occurredOn: "2026-10-02",
      evidence: { kind: "explicit" },
    });
  });
  it.each([
    "5 жовтня минулого року у Києві чоловік викрав велосипед.",
    "5 жовтня торік у Києві чоловік викрав велосипед.",
    "У 2024 році у Києві 5 жовтня чоловік викрав велосипед.",
    "Учора у Києві чоловік викрав велосипед у 2020 році.",
    "5 жовтня цього року у Києві чоловік викрав велосипед.",
  ])(
    "reviews contextual years rather than assuming a fresh rolling date: %s",
    (text) => {
      expect(date(text)).toEqual({
        status: "review",
        reason: "event-year-context-requires-review",
      });
    },
  );
  it("does not publish an old year-modified event as a fresh episode", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві розкрили крадіжку",
        "5 жовтня минулого року у Києві чоловік викрав велосипед.",
      ),
    );
    expect(result).toEqual({
      status: "review",
      reason: "event-year-context-requires-review",
    });
  });
  it("does not anchor a late forward without verified original metadata", () => {
    expect(
      date("Вчора у Києві чоловік викрав велосипед.", { isRepost: true }),
    ).toEqual({
      status: "unknown",
      reason: "repost-date-without-original-anchor",
    });
    expect(
      date("2 жовтня у Києві чоловік викрав велосипед.", { isRepost: true })
        .status,
    ).toBe("unknown");
    expect(
      date("Forwarded from Police\nВчора у Києві чоловік викрав велосипед.")
        .status,
    ).toBe("unknown");
    expect(
      date("2 жовтня 2026 року у Києві чоловік викрав велосипед.", {
        isRepost: true,
      }),
    ).toMatchObject({ occurredOn: "2026-10-02" });
  });
  it("dates a forward using its verified original publication", () => {
    expect(
      date("Вчора у Києві чоловік викрав велосипед.", {
        isRepost: true,
        originalPublishedAt: "2026-10-01T08:00:00Z",
      }),
    ).toMatchObject({
      occurredOn: "2026-09-30",
      evidence: { anchorPublishedAt: "2026-10-01T08:00:00Z" },
    });
    expect(
      date("Вчора у Києві чоловік викрав велосипед.", {
        isRepost: true,
        originalPublishedAt: "2026-10-07T08:00:00Z",
      }).status,
    ).toBe("unknown");
  });
  it("does not mistake a canonical article link for a forward", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві сталася крадіжка",
        "Вчора у Києві чоловік викрав велосипед.",
        { canonicalUrl: "https://npu.gov.ua/news/theft" },
      ),
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.occurredOn).toBe("2026-10-05");
  });
  it("reviews conflicting episode days and invalid or future explicit dates", () => {
    expect(
      date(
        "2 жовтня у Києві чоловік викрав велосипед. 3 жовтня у Києві чоловік викрав телефон.",
      ),
    ).toEqual({ status: "review", reason: "multiple-event-dates" });
    expect(
      date("31 вересня 2026 року у Києві чоловік викрав велосипед."),
    ).toEqual({ status: "review", reason: "invalid-event-date" });
    expect(
      date("7 жовтня 2026 року у Києві чоловік викрав велосипед."),
    ).toEqual({ status: "review", reason: "future-event-date" });
    expect(
      date("29 лютого 2024 року у Києві чоловік викрав велосипед."),
    ).toMatchObject({ occurredOn: "2024-02-29" });
  });
  it("sends conflicting event dates to review in the processor", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві сталися крадіжки",
        "2 жовтня у Києві чоловік викрав велосипед. 3 жовтня у Києві чоловік викрав телефон.",
      ),
    );
    expect(result).toEqual({
      status: "review",
      reason: "multiple-event-dates",
    });
  });
  it.each([
    "У період з 5 до 6 жовтня у Києві чоловік викрав велосипед.",
    "Уночі з 5 на 6 жовтня у Львові виникла пожежа.",
    "5–6 жовтня у Києві чоловік викрав велосипед.",
  ])("reviews a date range instead of selecting its last day: %s", (text) => {
    expect(date(text)).toEqual({
      status: "review",
      reason: "event-date-range",
    });
  });
  it("reviews a title location that conflicts with a dated episode", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві розкрили крадіжку",
        "2 жовтня у Одесі чоловік викрав велосипед.",
      ),
    );
    expect(result).toEqual({
      status: "review",
      reason: "unknown-or-multiple-cities",
    });
  });
  it("reviews same-day episodes in different cities", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві розкрили крадіжку",
        "2 жовтня у Києві чоловік викрав велосипед. 2 жовтня у Одесі чоловік викрав телефон.",
      ),
    );
    expect(result).toEqual({
      status: "review",
      reason: "unknown-or-multiple-cities",
    });
  });
  it("publishes only the date phrase as evidence, without names or addresses", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві сталася крадіжка",
        "2 жовтня 2026 року у Києві Петренко Іван викрав велосипед за адресою Вулиця Тестова 12.",
      ),
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.eventDateEvidence?.text).toBe("2 жовтня 2026 року");
    expect(JSON.stringify(result.incident)).not.toMatch(/Петренко|Тестова/);
  });
  it("keeps court documents in the same case as distinct identities", async () => {
    const content =
      "Справа №123/456/26\nВИРОК м. Київ\nВСТАНОВИВ:\n01.09.2026 у м. Тернополі обвинувачений викрав велосипед.\nУ судовому засіданні досліджено докази.";
    const processor = new IncidentProcessor();
    const first = await processor.process(
      await raw("Вирок: Крадіжка", content, {
        sourceId: "court-decisions",
        externalId: "123",
        sourceUrl: "https://reyestr.court.gov.ua/Review/123",
      }),
    );
    const second = await processor.process(
      await raw("Вирок: Крадіжка", content, {
        sourceId: "court-decisions",
        externalId: "124",
        sourceUrl: "https://reyestr.court.gov.ua/Review/124",
      }),
    );
    expect(first.status).toBe("published");
    expect(second.status).toBe("published");
    if (first.status !== "published" || second.status !== "published")
      throw Error("Expected publication");
    expect(first.canonicalKey).toBe("court-document:123");
    expect(second.canonicalKey).toBe("court-document:124");
    expect(first.incident.id).not.toBe(second.incident.id);
    expect(first.incident.eventDateEvidence).toEqual({
      kind: "explicit",
      text: "01.09.2026",
      sourceUrl: "https://reyestr.court.gov.ua/Review/123",
      timeZone: "Europe/Kyiv",
    });
  });
});

describe("confirmed episode publication gate", () => {
  it.each([
    [
      "5 жовтня у Києві чоловік не викрав велосипед, повідомлення було хибним.",
      "negated-event",
    ],
    ["5 жовтня у Києві не було пожежі.", "negated-event"],
    [
      "Учора у Києві нібито сталася пожежа, інформація не підтвердилася.",
      "unconfirmed-event",
    ],
    [
      "Учора у Києві сталася пожежа. Інформацію спростовано.",
      "unconfirmed-event",
    ],
    [
      "Поліція перевірила хибне повідомлення про пожежу у Києві.",
      "unconfirmed-event",
    ],
    ["За сценарієм сьогодні у Києві виникла пожежа.", "simulated-event"],
    [
      "Під час тактичних навчань сьогодні у Києві виникла пожежа.",
      "simulated-event",
    ],
    ["Сьогодні рятувальники у Києві гасили умовну пожежу.", "simulated-event"],
  ])("withholds a denied or simulated episode: %s", (text, reason) => {
    expect(eventPublicationIssue(text)).toBe(reason);
  });
  it.each([
    "Учора у Києві чоловік викрав велосипед. Свідки надали докази. На допиті він сказав, що не викрав велосипед.",
    "Учора у Києві виникла пожежа. Інформація про загибель людини не підтвердилася.",
    "Учора у Києві виникла пожежа. Рятувальники після цього провели навчання.",
    "Учора у Києві виникла пожежа у навчальному центрі.",
  ])(
    "preserves a real episode despite separate comments or unrelated qualifiers: %s",
    (text) => {
      expect(eventPublicationIssue(text)).toBeNull();
    },
  );
  it("checks the body instead of accepting the copied headline of a correction", async () => {
    const title = "У Києві сталася пожежа";
    const result = await new IncidentProcessor().process(
      await raw(
        title,
        `${title}\nУчора у Києві не було пожежі, виклик був хибним.`,
      ),
    );
    expect(result).toEqual({ status: "rejected", reason: "negated-event" });
  });
  it("rejects a training post even when its headline looks like a real event", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Києві сталася пожежа",
        "За сценарієм сьогодні у Києві виникла пожежа.",
      ),
    );
    expect(result).toEqual({ status: "rejected", reason: "simulated-event" });
  });
  it("does not mistake a defendant's earlier denial for the court's event narrative", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "Вирок: Крадіжка",
        "Справа №123/456/26\nОбвинувачений заявив, що не викрав велосипед.\nВСТАНОВИВ:\n01.09.2026 у м. Тернополі обвинувачений викрав велосипед.\nУ судовому засіданні досліджено докази.",
        { sourceId: "court-decisions" },
      ),
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.occurredOn).toBe("2026-09-01");
  });
});
