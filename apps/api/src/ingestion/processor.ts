import { locationCities, type IncidentCategory } from "@crime-radar/shared";
import { hash } from "./hash";
import type {
  Geocoder,
  Place,
  Processed,
  RawItem,
  SummaryProvider,
} from "./types";

const forms: Record<string, string> = {
  Київ: "Ки(?:їв|єв(?:і|а|ом))",
  Одеса: "Одес(?:а|і|у|ою)",
  Львів: "Льв(?:ів|ові|ова)",
  Дніпро: "Дніпр(?:о|і|а)",
  Харків: "Харков(?:і|а)|Харків",
  Вінниця: "Вінниц(?:я|і|ю)",
  Запоріжжя: "Запоріжж(?:я|і)",
  "Івано-Франківськ": "Івано-Франківськ(?:у|а)?",
  Чернігів: "Чернігов(?:і|а)|Чернігів",
  Полтава: "Полтав(?:а|і|у)",
  Луцьк: "Луцьк(?:у|а)?",
};
export const gazetteer: Place[] = [
  ...locationCities.map((city) => ({
    key: city.en.toLowerCase(),
    uk: city.uk,
    en: city.en,
    latitude: city.lat,
    longitude: city.lng,
    precision: "city" as const,
  })),
];
const ruleVersion = "rules-v2-city-only";
/** Offline city lookup; never geocodes raw names/addresses through an external service. */
export class CityGeocoder implements Geocoder {
  async geocode(place: Place) {
    return gazetteer.find((city) => city.key === place.key) ?? null;
  }
}
export function extractPlace(title: string): Place | null {
  const found = gazetteer.filter((place) => {
    const form = forms[place.uk];
    return new RegExp(`(?<![\\p{L}])(?:${form})(?![\\p{L}])`, "iu").test(title);
  });
  return found.length === 1 ? found[0] : null;
}
const rules: [IncidentCategory, RegExp][] = [
  ["violence", /вбивств|вбив(?:ця|ці|цю)|побит|побив|зґвалт|ножов|насильств/iu],
  ["theft", /крадіж|викрав|крадія|крадіїв|викрадач/iu],
  ["robbery", /пограб|розбій|грабіж|грабував/iu],
  ["fraud", /шахрай|ошук|фіктивн.*зарплат/iu],
  ["drugs", /наркот|нарколаб|наркоділ|амфетамін|метадон|психотроп/iu],
  ["weapons", /незаконн.*збро|збут.*збро|боєприпас|гранат|вибухівк/iu],
  ["traffic", /ДТП|дорожньо-транспортн|зіткнен.*авто/iu],
  ["fire", /пожеж|підпал/iu],
];
export function classify(title: string): IncidentCategory | null {
  if (
    /обстріл|ракет|росіян|дрон|безпілот|ворож|евакуац|навчан|вітаємо|запрош|нагадуємо|поради|як не стати|нагород|ваканс/iu.test(
      title,
    )
  )
    return null;
  const matches = rules.filter(([, pattern]) => pattern.test(title));
  // Robbery often also says "theft"; do not guess ambiguous multi-incident reports.
  return matches.length === 1 ? matches[0][0] : null;
}
const names: Record<IncidentCategory, { uk: string; en: string }> = {
  violence: { uk: "насильство", en: "violence" },
  theft: { uk: "крадіжку", en: "theft" },
  robbery: { uk: "пограбування", en: "robbery" },
  fraud: { uk: "шахрайство", en: "fraud" },
  drugs: { uk: "наркотики", en: "drugs" },
  weapons: { uk: "незаконний обіг зброї", en: "weapons" },
  traffic: { uk: "ДТП", en: "a traffic collision" },
  fire: { uk: "пожежу", en: "fire" },
  other: { uk: "подію", en: "an incident" },
};
/** Deterministic bilingual summaries use only allowlisted category/city, never the raw report. */
export class SafeSummaryProvider implements SummaryProvider {
  summarize(category: IncidentCategory, place: Place) {
    const name = names[category];
    return {
      uk: `Повідомлення поліції про ${name.uk} · ${place.uk}`,
      en: `Police report about ${name.en} · ${place.en}`,
      description: {
        uk: `Національна поліція опублікувала повідомлення про ${name.uk}. Згадане місто: ${place.uk}. Позначка показує центр міста, а не місце події. Час події не встановлено; показано дату публікації. Подробиці доступні за посиланням на джерело.`,
        en: `The National Police published a report about ${name.en}. The city mentioned is ${place.en}. The marker represents the city centre, not the incident site. The incident time is unknown; the publication date is shown. Follow the source for details.`,
      },
    };
  }
}
export class IncidentProcessor {
  constructor(
    readonly geocoder: Geocoder = new CityGeocoder(),
    readonly summaries: SummaryProvider = new SafeSummaryProvider(),
  ) {}
  async process(raw: RawItem): Promise<Processed> {
    const category = classify(raw.title);
    if (!category)
      return { status: "rejected", reason: "not-single-supported-incident" };
    if (
      !raw.publishedAt ||
      !Number.isFinite(Date.parse(raw.publishedAt)) ||
      Date.parse(raw.publishedAt) > Date.now() + 300000
    )
      return { status: "review", reason: "invalid-publication-time" };
    const place = extractPlace(raw.title);
    if (!place)
      return { status: "review", reason: "unknown-or-multiple-cities" };
    const located = await this.geocoder.geocode(place);
    if (!located) return { status: "review", reason: "geocoding-unavailable" };
    const canonicalKey = raw.canonicalUrl ?? raw.sourceUrl;
    const identity = await hash(canonicalKey);
    const summary = this.summaries.summarize(category, located);
    const title = { uk: summary.uk, en: summary.en };
    return {
      status: "published",
      canonicalKey,
      fingerprint: await hash(`${category}:${located.key}:${raw.contentHash}`),
      incident: {
        id: `npu-${identity.slice(0, 24)}`,
        title,
        description: summary.description,
        category,
        keywords: [
          names[category].uk,
          names[category].en,
          located.uk,
          located.en,
        ],
        occurredAt: null,
        publishedAt: raw.publishedAt,
        location: {
          latitude: located.latitude,
          longitude: located.longitude,
          city: located.uk,
          cityEn: located.en,
          approximate: true,
          precision: "city",
        },
        sources: [
          {
            name: "Національна поліція України",
            url: raw.sourceUrl,
            publishedAt: raw.publishedAt,
          },
        ],
        confidence: 0.75,
        synthetic: false,
      },
    };
  }
}
/** Similarity is a review signal only. Unknown event times prohibit automatic fuzzy merges. */
export function similarity(a: string, b: string): number {
  const tokens = (text: string) =>
    new Set(text.toLocaleLowerCase("uk").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const left = tokens(a),
    right = tokens(b);
  const union = new Set([...left, ...right]).size;
  return union
    ? [...left].filter((token) => right.has(token)).length / union
    : 0;
}
export { ruleVersion };
