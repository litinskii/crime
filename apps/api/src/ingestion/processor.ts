import type { IncidentCategory, LocalizedText } from "@crime-radar/shared";
import { hash } from "./hash";
import { gazetteer, placeAfterCue, resolvePlace } from "./geography";
import { sourceById } from "./sources";
import {
  explicitDates,
  extractEventDate,
  kyivCalendarDay,
  eventPublicationIssue,
} from "./event-date";
import type { EventDateEvidence } from "./event-date";
import type {
  ExtractedFacts,
  Geocoder,
  Place,
  Processed,
  RawItem,
  SummaryProvider,
} from "./types";
export { gazetteer } from "./geography";
export const ruleVersion = "rules-v5-regional-small-settlements-1";
export class CityGeocoder implements Geocoder {
  async geocode(place: Place) {
    return gazetteer.find((city) => city.key === place.key) ?? null;
  }
}
export const extractPlace = resolvePlace;
const eventVerb =
  /викрав|таємн.{0,30}викрад|заволоді[вл]|наніс|нанесл|вдарив|ударив|вчинив|скоїв|зіткнув|наїхав|підпалив|збував|продав|придбав|зберігав/iu;
export function courtEvent(raw: RawItem): {
  place: Place;
  occurredOn: string;
  content: string;
  eventDateEvidence: EventDateEvidence;
} | null {
  const text = raw.content.replace(
    /в\s+с\s+т\s+а\s+н\s+о\s+в\s+и\s+в/giu,
    "ВСТАНОВИВ",
  );
  const start = text.search(/ВСТАНОВИВ\s*[:-]?/iu);
  if (start < 0) return null;
  const narrative = text
    .slice(start + 9)
    .split(
      /Допитаний|У судовому засіданні|Дослідивши|Досліджені судом|Суд вважає/iu,
    )[0]
    .slice(0, 12000);
  const candidates: {
    place: Place;
    occurredOn: string;
    content: string;
    eventDateEvidence: EventDateEvidence;
  }[] = [];
  for (const paragraph of narrative.split(/\n/)) {
    if (
      !eventVerb.test(paragraph) ||
      /уроджен|народив|зареєстрован|місце служби|бойов|диверсі/iu.test(
        paragraph,
      )
    )
      continue;
    // The leading event date is distinct from dates of martial-law decrees quoted later.
    const date = explicitDates(paragraph.slice(0, 120)).slice(0, 1);
    if (
      date.length !== 1 ||
      /Указ|Закону|постанови/iu.test(paragraph.slice(0, 50)) ||
      date[0] > (kyivCalendarDay(raw.publishedAt) ?? "")
    )
      continue;
    // Require a named settlement within the event paragraph, never the court heading.
    const mentions = [
      ...paragraph.matchAll(
        /(?:(?<!\p{L})[ув]\s+|території\s+|адресою:\s*)(?:міста|місті|м\.|села|селі|с\.|селищі)\s+([\p{L}'’ʼ-]+(?:\s+[\p{L}'’ʼ-]+){0,2})/giu,
      ),
    ]
      .map((m) => placeAfterCue(m[1], paragraph))
      .filter((p): p is Place => Boolean(p));
    const places = [...new Map(mentions.map((p) => [p.key, p])).values()];
    if (places.length === 1)
      candidates.push({
        place: places[0],
        occurredOn: date[0],
        content: paragraph,
        eventDateEvidence: {
          kind: "explicit",
          text:
            paragraph
              .slice(0, 120)
              .match(
                /(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]20\d{2}|\d{1,2}\s+\p{L}+\s+20\d{2})/u,
              )?.[0] ?? date[0],
          sourceUrl: raw.sourceUrl,
          timeZone: "Europe/Kyiv",
        },
      });
  }
  if (
    !candidates.length ||
    new Set(candidates.map((c) => `${c.place.key}:${c.occurredOn}`)).size !== 1
  )
    return null;
  return candidates[0];
}
const rules: [IncidentCategory, RegExp][] = [
  [
    "violence",
    /вбивств|вбив(?:ця|ці|цю)|побит|побив|зґвалт|ножов|насильств|тяжк.*тілесн|погроз.*(?:вбив|житт)|розбещ|сексуальн.*(?:насильств|домаган)|інтим.*дитин|дитин.*інтим/iu,
  ],
  ["theft", /крадіж|викрав|крадія|крадіїв|викрадач|таємн.{0,30}викрад/iu],
  ["robbery", /пограб|розбій|грабіж|грабував/iu],
  ["fraud", /шахрай|ошук|фіктивн.*зарплат/iu],
  ["drugs", /наркот|нарколаб|наркоділ|амфетамін|метадон|психотроп/iu],
  ["weapons", /незаконн.*збро|збут.*збро|боєприпас|гранат|вибухівк/iu],
  [
    "traffic",
    /ДТП|дорожньо-транспортн|зіткнен.*авто|наїхав.*пішох|правил.*дорожнього руху/iu,
  ],
  ["fire", /пожеж|підпал/iu],
  [
    "other",
    /хабар|неправомірн.*вигод|корупц|розтрат|привласн.*(?:бюджет|державн)|незаконн.*переправ|переправлення.*ухилян|ухилення.*подат|несплат.*подат|контрабанд/iu,
  ],
];
const excluded =
  /обстріл|ракет|росіян|дрон|безпілот|ворож|евакуац|навчан|вітаємо|запрош|нагадуємо|поради|як не стати|нагород|ваканс|вшанув|роковин|Голокост|день пам['’ʼ]ят|профілакт|інформаційн.*кампан|гаряч.*ліні|центр.{0,60}протидії/iu;
export function classify(text: string): IncidentCategory | null {
  if (excluded.test(text)) return null;
  const matches = rules.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][0] : null;
}
export const isCandidate = (title: string) =>
  classify(title) !== null ||
  (!excluded.test(title) &&
    /кримінальн|підозр|затрим|правопоруш|конфлікт|інтим|переплат|відшкодував.*подат/iu.test(
      title,
    ));
const names: Record<IncidentCategory, LocalizedText> = {
  violence: { uk: "Насильство", en: "Violence" },
  theft: { uk: "Крадіжка", en: "Theft" },
  robbery: { uk: "Пограбування", en: "Robbery" },
  fraud: { uk: "Шахрайство", en: "Fraud" },
  drugs: { uk: "Наркотики", en: "Drugs" },
  weapons: { uk: "Незаконний обіг зброї", en: "Illegal weapons" },
  traffic: { uk: "ДТП", en: "Traffic collision" },
  fire: { uk: "Пожежа", en: "Fire" },
  other: { uk: "Інше правопорушення", en: "Other offence" },
};
const subtypes: [IncidentCategory, RegExp, LocalizedText][] = [
  [
    "violence",
    /замах.{0,30}вбивств/iu,
    { uk: "Замах на вбивство", en: "Attempted homicide" },
  ],
  ["violence", /вбивств/iu, { uk: "Вбивство", en: "Homicide" }],
  [
    "violence",
    /зґвалт/iu,
    { uk: "Сексуальне насильство", en: "Sexual violence" },
  ],
  [
    "violence",
    /погроз/iu,
    { uk: "Погрози насильством", en: "Threats of violence" },
  ],
  [
    "violence",
    /побит|побив|тілесн/iu,
    { uk: "Напад і тілесні ушкодження", en: "Assault and injuries" },
  ],
  ["theft", /велосипед/iu, { uk: "Крадіжка велосипеда", en: "Bicycle theft" }],
  [
    "theft",
    /автомобіл|авто\b/iu,
    { uk: "Крадіжка автомобіля", en: "Vehicle theft" },
  ],
  [
    "fraud",
    /фіктивн.*зарплат/iu,
    { uk: "Шахрайство з виплатою зарплати", en: "Payroll fraud" },
  ],
  [
    "fraud",
    /телефонн.{0,40}шахрай|зателефон|представив.{0,50}банку|банківськ.{0,30}шахрай/iu,
    { uk: "Телефонне або банківське шахрайство", en: "Phone or banking fraud" },
  ],
  [
    "fraud",
    /інтернет|онлайн/iu,
    { uk: "Інтернет-шахрайство", en: "Online fraud" },
  ],
  [
    "drugs",
    /нарколаб|лаборатор/iu,
    { uk: "Виробництво наркотиків", en: "Drug production" },
  ],
  ["drugs", /збут|продаж/iu, { uk: "Збут наркотиків", en: "Drug dealing" }],
  [
    "traffic",
    /пішох/iu,
    { uk: "ДТП за участю пішохода", en: "Collision involving a pedestrian" },
  ],
  ["fire", /підпал/iu, { uk: "Підпал", en: "Arson" }],
  [
    "other",
    /хабар|неправомірн.*вигод/iu,
    { uk: "Підозра в хабарництві", en: "Bribery allegation" },
  ],
];
export function extractFacts(
  raw: RawItem,
  category: IncidentCategory,
): ExtractedFacts {
  const text = raw.content;
  const date =
    raw.sourceId === "court-decisions"
      ? { status: "unknown" as const }
      : extractEventDate(text, raw);
  const subtype = subtypes.find(
    ([cat, re]) => cat === category && re.test(text),
  )?.[2];
  // Only an explicit reference to the Criminal Code; never infer an article from category or use the procedural code.
  const article = text.match(
    /(?:ст\.?|статт(?:я|і|ею))\s*(\d{3}(?:-\d)?)\s*(?:\([^)]{0,200}\)\s*)?(?:КК(?:\s+України)?|Кримінального кодексу)/iu,
  )?.[1];
  const details: LocalizedText[] = [];
  if (
    /повідомили?\s+про\s+підозру|повідомлено\s+про\s+підозру|оголосили.*підозру/iu.test(
      text,
    )
  )
    details.push({
      uk: "Джерело повідомляє про вручення підозри.",
      en: "The source reports that a notice of suspicion was issued.",
    });
  if (/затримал|затримано/iu.test(text))
    details.push({
      uk: "Джерело повідомляє про затримання.",
      en: "The source reports a detention.",
    });
  if (/передали.*суд|скерували.*суд|направили.*суд/iu.test(text))
    details.push({
      uk: "За повідомленням джерела, справу передано до суду.",
      en: "According to the source, the case was referred to court.",
    });
  if (/загин(?:ув|ула|ули)|смертельн|летальн/iu.test(text))
    details.push({
      uk: "У повідомленні зазначено загибель людини або людей.",
      en: "The report mentions a fatality or fatalities.",
    });
  else if (/травмован|постраждал|поранен|госпіталізован/iu.test(text))
    details.push({
      uk: "Джерело повідомляє про постраждалих.",
      en: "The source reports injuries.",
    });
  const status =
    raw.sourceId === "court-decisions"
      ? "court"
      : /розсліду|підозру|кримінальн.*проваджен/iu.test(text)
        ? "investigation"
        : "reported";
  return {
    subtype,
    article,
    status,
    details,
    occurredOn: date.status === "known" ? date.occurredOn : undefined,
    eventDateEvidence: date.status === "known" ? date.evidence : undefined,
    dateReviewReason: date.status === "review" ? date.reason : undefined,
  };
}
function incidentPlace(raw: RawItem, sourceRegionCode?: string): Place | null {
  if (raw.sourceId === "court-decisions") {
    return courtEvent(raw)?.place ?? null;
  }
  const context = `${raw.title}\n${raw.content}`;
  const cues = (text: string) => [
    ...text.matchAll(
      /(?<!\p{L})[уУвВ]\s+(?:(?:місті|міста|м\.|селі|села|с\.|селищі)\s+)?([\p{Lu}][\p{L}'’ʼ-]*(?:\s+[\p{L}'’ʼ-]+){0,2})/gu,
    ),
  ];
  const titleCues = cues(raw.title);
  if (titleCues.length) {
    const places = titleCues.map((m) =>
      placeAfterCue(m[1], context, sourceRegionCode),
    );
    if (places.some((p) => !p)) return null;
    const unique = [...new Map(places.map((p) => [p!.key, p!])).values()];
    const whole = resolvePlace(raw.title, context, sourceRegionCode);
    if (unique.length !== 1 || whole?.key !== unique[0].key) return null;
    // A title may name the reporting police office. An explicitly located,
    // dated episode must agree; a single category does not imply one city.
    for (const sentence of raw.content.split(/\n|(?<=[.!?])\s+/u)) {
      if (extractEventDate(sentence, raw).status !== "known") continue;
      const episodeCues = cues(sentence);
      if (!episodeCues.length) continue;
      if (
        resolvePlace(sentence, context, sourceRegionCode)?.key !== unique[0].key
      )
        return null;
    }
    return unique[0];
  }
  const candidates = new Map<string, Place>();
  for (const sentence of raw.content.split(/\n|(?<=[.!?])\s+/u)) {
    if (/народив|мешка|прожива|суд.*розташ|уроджен/iu.test(sentence)) continue;
    if (!/(?:(?<!\p{L})[уУвВ]\s|місті|м\.|селі|с\.|селищі)/u.test(sentence))
      continue;
    if (
      !/сталося|сталась|трапил|ско[їє]|вчини|затрим|викри|підпал|заволод|ДТП|крадіж|шахрай|поліцей|слідч|правоохорон/iu.test(
        sentence,
      )
    )
      continue;
    for (const match of cues(sentence)) {
      const place = placeAfterCue(match[1], context, sourceRegionCode);
      if (place) candidates.set(place.key, place);
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}
export class SafeSummaryProvider implements SummaryProvider {
  summarize(category: IncidentCategory, place: Place, facts?: ExtractedFacts) {
    const name = facts?.subtype ?? names[category];
    const details = facts?.details ?? [];
    return {
      uk: `${name.uk} · ${place.uk}`,
      en: `${name.en} · ${place.en}`,
      description: {
        uk: [
          `${facts?.status === "court" ? "Судове рішення описує подію" : "Публічне джерело повідомило про подію"}: ${name.uk.toLocaleLowerCase("uk")}. Населений пункт, зазначений у повідомленні: ${place.uk}.`,
          ...details.map((d) => d.uk),
          `Позначка показує центр населеного пункту, а не місце події. ${facts?.occurredOn ? "Дату події наведено без точного часу." : "Час події не встановлено; показано дату публікації."} Подробиці та контекст — у джерелі.`,
        ].join(" "),
        en: [
          `${facts?.status === "court" ? "A court judgment describes" : "A public source reported"} ${name.en.toLowerCase()}. The settlement identified in the report is ${place.en}.`,
          ...details.map((d) => d.en),
          `The marker represents the settlement centre, not the incident site. ${facts?.occurredOn ? "The event date is given without an exact time." : "The incident time is unknown; the publication date is shown."} Follow the source for details and context.`,
        ].join(" "),
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
    const source = sourceById(raw.sourceId);
    if (!source) return { status: "rejected", reason: "unknown-source" };
    if (
      /внаслідок.{0,80}(?:обстріл|ракет|атаки дрон)|(?:обстріл|ракет|російськ).{0,60}(?:спричин|влуч|атак|удар)/iu.test(
        raw.content.slice(0, 1500),
      )
    )
      return { status: "rejected", reason: "war-related-harm" };
    const category =
      classify(raw.title) ??
      (isCandidate(raw.title) && !rules.some(([, re]) => re.test(raw.title))
        ? classify(raw.content.slice(0, 3000))
        : null);
    if (!category)
      return { status: "rejected", reason: "not-single-supported-incident" };
    if (
      !raw.publishedAt ||
      !Number.isFinite(Date.parse(raw.publishedAt)) ||
      Date.parse(raw.publishedAt) > Date.now() + 300000
    )
      return { status: "review", reason: "invalid-publication-time" };
    const place = incidentPlace(raw, source.regionCode);
    if (!place)
      return { status: "review", reason: "unknown-or-multiple-cities" };
    const located = await this.geocoder.geocode(place);
    if (!located) return { status: "review", reason: "geocoding-unavailable" };
    const canonicalKey =
      source.kind === "court"
        ? `court-document:${raw.externalId}`
        : (raw.canonicalUrl ?? raw.sourceUrl);
    const identity = await hash(raw.canonicalUrl ?? raw.sourceUrl);
    const event = source.kind === "court" ? courtEvent(raw) : null;
    if (event && classify(event.content) !== category)
      return {
        status: "review",
        reason: "court-category-not-confirmed-in-event",
      };
    const body = raw.content.startsWith(raw.title)
      ? raw.content.slice(raw.title.length)
      : raw.content;
    const eventIssue = eventPublicationIssue(event?.content ?? body);
    if (eventIssue) return { status: "rejected", reason: eventIssue };
    const facts = extractFacts(
      event ? { ...raw, content: event.content } : raw,
      category,
    );
    if (event) {
      facts.occurredOn = event.occurredOn;
      facts.eventDateEvidence = event.eventDateEvidence;
    }
    if (facts.dateReviewReason)
      return { status: "review", reason: facts.dateReviewReason };
    const summary = this.summaries.summarize(category, located, facts);
    return {
      status: "published",
      canonicalKey,
      fingerprint: await hash(`${category}:${located.key}:${raw.contentHash}`),
      incident: {
        id: `${raw.sourceId.startsWith("npu") ? "npu" : raw.sourceId}-${identity.slice(0, 24)}`,
        title: { uk: summary.uk, en: summary.en },
        description: summary.description,
        category,
        keywords: [
          names[category].uk,
          names[category].en,
          located.uk,
          located.en,
          ...(facts.article ? [facts.article] : []),
        ],
        occurredAt: null,
        occurredOn: facts.occurredOn,
        eventDateEvidence: facts.eventDateEvidence,
        publishedAt: raw.publishedAt,
        status: facts.status,
        legalQualification: facts.article
          ? { article: facts.article }
          : undefined,
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
            name: source.name,
            url: raw.sourceUrl,
            publishedAt: raw.publishedAt,
            kind: source.kind,
          },
        ],
        confidence: source.kind === "official" ? 0.8 : 0.7,
        synthetic: false,
      },
    };
  }
}
export function similarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(s.toLocaleLowerCase("uk").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const left = tokens(a),
    right = tokens(b),
    union = new Set([...left, ...right]).size;
  return union ? [...left].filter((t) => right.has(t)).length / union : 0;
}
