import { describe, expect, it } from "vitest";
import { placeAfterCue, resolvePlace } from "./geography";
import { IncidentProcessor } from "./processor";
import { hash } from "./hash";
import type { RawItem } from "./types";

async function raw(title: string, content: string): Promise<RawItem> {
  return {
    sourceId: "npu-rivne-telegram",
    externalId: "NPU_Rivne/1234",
    sourceUrl: "https://t.me/NPU_Rivne/1234",
    publishedAt: "2026-10-06T07:00:00Z",
    retrievedAt: "2026-10-06T09:00:00Z",
    title,
    content,
    contentHash: await hash(content),
  };
}

describe("source region geography hints", () => {
  it.each(["Рокитне", "У Рокитному", "Rokytne"])(
    "resolves one homonymous named place from source coverage: %s",
    (text) => {
      expect(resolvePlace(text)).toBeNull();
      expect(resolvePlace(text, text, "03")).toMatchObject({
        key: "geonames-695854",
        regionCode: "03",
        uk: "Рокитне",
      });
    },
  );
  it("passes the same hint through the geographic cue parser", () => {
    expect(
      placeAfterCue(
        "Рокитному сталася пожежа",
        "Рокитному сталася пожежа",
        "03",
      ),
    ).toMatchObject({ key: "geonames-695854" });
  });
  it("gives an explicitly named other region precedence over source coverage", () => {
    expect(
      resolvePlace("Рокитне", "У Рокитному на Буковині", "19"),
    ).toMatchObject({ key: "geonames-695854", regionCode: "03" });
    expect(
      resolvePlace("Рокитне", "Рокитне на Полтавщині", "19"),
    ).toMatchObject({ key: "geonames-695851", regionCode: "18" });
  });
  it("does not use source coverage to resolve contradictory regional context", () => {
    expect(
      resolvePlace("Рокитне", "Рокитне на Рівненщині та Буковині", "19"),
    ).toBeNull();
  });
  it("keeps two different named cities ambiguous despite one matching the region", () => {
    expect(
      resolvePlace(
        "У Рівному та Києві",
        "На Рівненщині, у Рівному та Києві",
        "19",
      ),
    ).toBeNull();
    expect(
      resolvePlace("У Рокитному та Києві", "У Рокитному та Києві", "19"),
    ).toBeNull();
  });
  it("does not replace a unique known city with a regional capital", () => {
    expect(resolvePlace("У Києві", "У Києві", "19")).toMatchObject({
      uk: "Київ",
    });
    expect(resolvePlace("У селі Рокитне", "У селі Рокитне", "03")?.uk).toBe(
      "Рокитне",
    );
  });
  it.each([
    "На Рівненщині сталася пожежа",
    "У селі Невідомесело сталася пожежа",
    "У Рогитному сталася пожежа",
  ])("cannot create a settlement from source coverage: %s", (text) => {
    expect(resolvePlace(text, text, "19")).toBeNull();
  });
  it("publishes at the named settlement instead of the source's capital", async () => {
    const result = await new IncidentProcessor().process(
      await raw("У Клевані сталася пожежа", "Учора у Клевані виникла пожежа."),
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.location.city).toBe("Клевань");
    expect(result.incident.occurredOn).toBe("2026-10-05");
  });
  it("uses the explicit region in a regional-source incident", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Рокитному на Буковині сталася пожежа",
        "Учора у Рокитному на Буковині виникла пожежа.",
      ),
    );
    expect(result.status).toBe("published");
    if (result.status !== "published") throw Error("Expected publication");
    expect(result.incident.location.latitude).toBe(48.32978);
  });
  it("keeps a regional source's two-city episode in review", async () => {
    const result = await new IncidentProcessor().process(
      await raw(
        "У Рівному та Києві сталася пожежа",
        "Учора у Рівному та Києві виникла пожежа.",
      ),
    );
    expect(result).toEqual({
      status: "review",
      reason: "unknown-or-multiple-cities",
    });
  });
  it("leaves same-oblast homonyms ambiguous after adding smaller settlements", () => {
    expect(resolvePlace("У Рокитному", "У Рокитному", "19")).toBeNull();
  });
  it("does not choose the city of Zaporizhzhia from the source's oblast alone", () => {
    expect(resolvePlace("У Запоріжжі", "У Запоріжжі", "26")).toBeNull();
  });
  it.each(["У місті Запоріжжі", "місто Запоріжжя", "м. Запоріжжя"])(
    "resolves Zaporizhzhia from an explicit city label: %s",
    (text) => {
      expect(resolvePlace(text, text, "26")).toMatchObject({
        key: "geonames-687700",
        latitude: 47.85167,
        longitude: 35.11714,
      });
    },
  );
  it("uses the urban district in a representative 061 traffic report", () => {
    const title = "У Запоріжжі пʼяний водій спровокував ДТП";
    const body =
      "У Шевченківському районі Запоріжжя водій ВАЗ під час розʼїзду з автомобілем, який рухався назустріч, допустив зіткнення.";
    expect(resolvePlace(title, body, "26")).toMatchObject({
      key: "geonames-687700",
    });
    expect(placeAfterCue("Запоріжжі пʼяний водій", body, "26")).toMatchObject({
      key: "geonames-687700",
    });
  });
  it("publishes the district-located 061 report without treating the police announcement date as the event date", async () => {
    const title = "У Запоріжжі пʼяний водій спровокував ДТП";
    const content = `${title}\nУ Шевченківському районі Запоріжжя водій ВАЗ під час розʼїзду з автомобілем, який рухався назустріч, допустив зіткнення. Патрульні помітили ознаки спʼяніння, повідомили в обласній Патрульній поліції 6 жовтня.`;
    const input = await raw(title, content);
    const result = await new IncidentProcessor().process({
      ...input,
      sourceId: "zaporizhzhia-061",
      externalId:
        "https://www.061.ua/news/4163789/u-zaporizzi-panij-vodij-ziguliv-sprovokuvav-dtp",
      sourceUrl:
        "https://www.061.ua/news/4163789/u-zaporizzi-panij-vodij-ziguliv-sprovokuvav-dtp",
      publishedAt: "2026-10-06T14:36:00Z",
    });
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("Expected publication");
    expect(result.incident.location).toMatchObject({
      city: "Запоріжжя",
      latitude: 47.85167,
      longitude: 35.11714,
    });
    expect(result.incident.occurredOn).toBeUndefined();
  });
  it.each(["У селі Запоріжжя", "с. Запоріжжя", "У селищі Запоріжжя"])(
    "does not replace an explicitly named village with the city: %s",
    (title) => {
      expect(resolvePlace(title, title, "26")).toBeNull();
      expect(
        resolvePlace(title, "У місті Запоріжжі поліція провела брифінг.", "26"),
      ).toBeNull();
    },
  );
  it("keeps an unverified district and separately named settlements ambiguous", () => {
    expect(
      resolvePlace(
        "У Запоріжжі",
        "У Невідомому районі Запоріжжя сталася ДТП.",
        "26",
      ),
    ).toBeNull();
    expect(
      resolvePlace(
        "У Запоріжжі та Києві",
        "У Шевченківському районі Запоріжжя і в Києві сталися ДТП.",
        "26",
      ),
    ).toBeNull();
  });
  it("does not treat an adjectival road name as a second settlement", () => {
    const sentence =
      "Увечері 2 жовтня у Дніпрі на перетині Донецького шосе та вулиці Незламної сталася ДТП.";
    expect(resolvePlace(sentence, sentence, "04")).toMatchObject({
      key: "geonames-709930",
    });
    expect(placeAfterCue("Донецького шосе", sentence, "04")).toBeNull();
    expect(resolvePlace("На вулиці Донецького сталася ДТП.")).toBeNull();
    expect(resolvePlace("У Донецькому")).toMatchObject({
      key: "geonames-709713",
    });
    expect(resolvePlace("У Донецькому вулиці порожні.")).toMatchObject({
      key: "geonames-709713",
    });
    expect(resolvePlace("У Дніпрі та Донецькому", sentence, "04")).toBeNull();
  });
  it("publishes a Dnipro traffic report with a street homonym and its own event date", async () => {
    const title = "У Дніпрі п’яний водій спричинив ДТП";
    const content = `${title}\nУвечері 2 жовтня у Дніпрі на перетині Донецького шосе та вулиці Незламної сталася ДТП. Про це повідомляє “Дніпро Оперативний”.`;
    const result = await new IncidentProcessor().process({
      ...(await raw(title, content)),
      sourceId: "dnepr-news",
      sourceUrl: "https://dnepr.express/ua/post/dtp-u-dnipri",
      publishedAt: "2026-10-03T10:10:00Z",
    });
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("Expected publication");
    expect(result.incident.location.city).toBe("Дніпро");
    expect(result.incident.occurredOn).toBe("2026-10-02");
  });
  it("recognizes declined neuter adjectival names without choosing a same-oblast homonym", () => {
    expect(resolvePlace("У Кам’янському")).toBeNull();
    expect(
      resolvePlace("У Кам’янському", "У Кам’янському", "17"),
    ).toMatchObject({
      key: "geonames-706947",
    });
    expect(resolvePlace("У Кам’янському", "У Кам’янському", "04")).toBeNull();
  });
  it("requires regional evidence for Boratyn and distinguishes three homonyms", () => {
    expect(resolvePlace("У Боратині")).toBeNull();
    expect(resolvePlace("У Боратині", "У Боратині", "24")).toMatchObject({
      key: "geonames-711678",
      latitude: 50.70415,
      longitude: 25.35522,
    });
    expect(resolvePlace("У Боратині", "У Боратині", "19")).toMatchObject({
      key: "geonames-711679",
    });
    expect(
      resolvePlace("У Боратині", "У Боратині на Львівщині", "24"),
    ).toMatchObject({ key: "geonames-711680" });
  });
  it("does not treat a month or region as a village in an explicitly dated episode", () => {
    expect(resolvePlace("30 вересня 2026 року у Києві сталася ДТП.")?.uk).toBe(
      "Київ",
    );
    expect(
      resolvePlace(
        "Учора у Рокитному на Буковині виникла пожежа.",
        "Учора у Рокитному на Буковині виникла пожежа.",
        "19",
      )?.key,
    ).toBe("geonames-695854");
  });
  it("publishes a dated Boratyn incident with the Volyn source's geographic evidence", async () => {
    const input = await raw(
      "У Боратині сталася ДТП",
      "5 жовтня у Боратині сталася ДТП.",
    );
    const result = await new IncidentProcessor().process({
      ...input,
      sourceId: "npu-volyn-telegram",
      sourceUrl: "https://t.me/policevolyn/12696",
    });
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("Expected publication");
    expect(result.incident.location.latitude).toBe(50.70415);
    expect(result.incident.occurredOn).toBe("2026-10-05");
  });
});
