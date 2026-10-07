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
