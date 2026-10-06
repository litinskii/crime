export const categories = [
  "violence",
  "theft",
  "robbery",
  "fraud",
  "drugs",
  "weapons",
  "traffic",
  "fire",
  "other",
] as const;
export type IncidentCategory = (typeof categories)[number];
export type Locale = "uk" | "en";
export type LocalizedText = { uk: string; en: string };
export type DateBasis = "event" | "publication";
export interface EventDateEvidence {
  kind: "explicit" | "relative" | "inferred-year";
  text: string;
  sourceUrl: string;
  anchorPublishedAt?: string;
  timeZone: "Europe/Kyiv";
}
export interface IncidentSource {
  name: string;
  kind?: "official" | "media" | "court";
  url?: string;
  publishedAt?: string;
}
export interface Incident {
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  category: IncidentCategory;
  keywords: string[];
  occurredAt: string | null;
  /** An extracted event date when the event's time is unknown. */
  occurredOn?: string;
  eventDateEvidence?: EventDateEvidence;
  reportedAt?: string;
  publishedAt?: string;
  location: {
    latitude: number;
    longitude: number;
    city?: string;
    cityEn?: string;
    district?: string;
    approximateAddress?: string;
    approximate: boolean;
    precision?: "street" | "district" | "city" | "region" | "unknown";
  };
  legalQualification?: { article?: string; description?: LocalizedText };
  sources: IncidentSource[];
  status?: "reported" | "investigation" | "court" | "closed";
  confidence?: number;
  synthetic?: boolean;
}
export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}
export interface IncidentQuery extends Bounds {
  from: string;
  to: string;
  /** Omitted for legacy effective-date queries. The UI always chooses a basis. */
  dateBasis?: DateBasis;
  categories?: IncidentCategory[];
  query?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}
export interface IncidentResponse {
  items: Incident[];
  total: number;
  nextCursor: string | null;
}
export interface IncidentStatistics {
  total: number;
  previousPeriodTotal: number;
  categories: Record<IncidentCategory, number>;
}
export interface IncidentsRepository {
  getIncidents(params: IncidentQuery): Promise<IncidentResponse>;
  getIncident(id: string, signal?: AbortSignal): Promise<Incident>;
  getStatistics(params: IncidentQuery): Promise<IncidentStatistics>;
}
export const cities = [
  { uk: "Київ", en: "Kyiv", lat: 50.4501, lng: 30.5234 },
  { uk: "Одеса", en: "Odesa", lat: 46.4825, lng: 30.7233 },
  { uk: "Львів", en: "Lviv", lat: 49.8397, lng: 24.0297 },
  { uk: "Дніпро", en: "Dnipro", lat: 48.4647, lng: 35.0462 },
  { uk: "Харків", en: "Kharkiv", lat: 49.9935, lng: 36.2304 },
  { uk: "Вінниця", en: "Vinnytsia", lat: 49.2331, lng: 28.4682 },
  { uk: "Запоріжжя", en: "Zaporizhzhia", lat: 47.8388, lng: 35.1396 },
  { uk: "Івано-Франківськ", en: "Ivano-Frankivsk", lat: 48.9226, lng: 24.7111 },
  { uk: "Чернігів", en: "Chernihiv", lat: 51.4982, lng: 31.2893 },
  { uk: "Полтава", en: "Poltava", lat: 49.5883, lng: 34.5514 },
];
export const locationCities = [
  ...cities,
  { uk: "Луцьк", en: "Lutsk", lat: 50.7472, lng: 25.3254 },
];
const templates: Record<
  IncidentCategory,
  {
    title: LocalizedText;
    description: LocalizedText;
    keywords: string[];
    article?: string;
  }
> = {
  violence: {
    title: { uk: "Повідомлення про бійку", en: "Altercation reported" },
    description: {
      uk: "Вигаданий приклад: повідомлено про бійку поблизу громадського простору. Обставини з’ясовуються.",
      en: "Fictional example: an altercation was reported near a public space. The circumstances are under investigation.",
    },
    keywords: ["бійка", "насильство", "fight", "violence"],
    article: "125",
  },
  theft: {
    title: { uk: "Крадіжка велосипеда", en: "Bicycle theft reported" },
    description: {
      uk: "Вигаданий приклад: повідомлено про зникнення велосипеда з громадської велопарковки.",
      en: "Fictional example: a bicycle was reported missing from a public bicycle rack.",
    },
    keywords: ["велосипед", "крадіжка", "bicycle", "theft"],
    article: "185",
  },
  robbery: {
    title: {
      uk: "Повідомлення про пограбування",
      en: "Street robbery reported",
    },
    description: {
      uk: "Вигаданий приклад: повідомлено про викрадення телефона на вулиці. Триває розслідування.",
      en: "Fictional example: a phone was reportedly taken on a street. An investigation is ongoing.",
    },
    keywords: ["телефон", "пограбування", "phone", "robbery"],
    article: "186",
  },
  fraud: {
    title: {
      uk: "Повідомлення про онлайн-шахрайство",
      en: "Online fraud reported",
    },
    description: {
      uk: "Вигаданий приклад: повідомлено про шахрайську пропозицію на онлайн-майданчику.",
      en: "Fictional example: a fraudulent offer was reported on an online marketplace.",
    },
    keywords: ["банк", "шахрайство", "bank", "fraud", "online"],
    article: "190",
  },
  drugs: {
    title: {
      uk: "Повідомлення про наркотики",
      en: "Drug-related incident reported",
    },
    description: {
      uk: "Вигаданий приклад: поліція перевіряє повідомлення про можливий незаконний обіг речовин.",
      en: "Fictional example: police are reviewing a report of possible illegal substance distribution.",
    },
    keywords: ["наркотики", "drugs"],
    article: "307",
  },
  weapons: {
    title: { uk: "Повідомлення про зброю", en: "Weapons-related report" },
    description: {
      uk: "Вигаданий приклад: у громадському місці повідомлено про предмет, схожий на зброю.",
      en: "Fictional example: an object resembling a weapon was reported in a public space.",
    },
    keywords: ["зброя", "weapon"],
    article: "263",
  },
  traffic: {
    title: {
      uk: "Дорожньо-транспортна пригода",
      en: "Traffic collision reported",
    },
    description: {
      uk: "Вигаданий приклад: повідомлено про зіткнення двох автомобілів поблизу перехрестя.",
      en: "Fictional example: a collision involving two vehicles was reported near an intersection.",
    },
    keywords: ["ДТП", "авто", "car", "collision"],
    article: "286",
  },
  fire: {
    title: { uk: "Повідомлення про пожежу", en: "Fire reported" },
    description: {
      uk: "Вигаданий приклад: рятувальники отримали повідомлення про займання у нежитловій будівлі.",
      en: "Fictional example: emergency services received a report of a fire in a non-residential building.",
    },
    keywords: ["пожежа", "fire"],
  },
  other: {
    title: {
      uk: "Пошкодження громадського майна",
      en: "Public property damage",
    },
    description: {
      uk: "Вигаданий приклад: повідомлено про пошкодження зупинки громадського транспорту.",
      en: "Fictional example: damage to a public transport shelter was reported.",
    },
    keywords: ["майно", "property", "damage"],
  },
};
/** Deterministic synthetic events. Reference date rolls once per day, never represented as live records. */
export function createMockIncidents(now = new Date()): Incident[] {
  const anchor = new Date(now);
  anchor.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: 270 }, (_, i) => {
    const city = cities[i % cities.length];
    const category = categories[Math.floor(i / 10) % 9];
    const template = templates[category];
    const days =
      i < 30
        ? 0
        : i < 100
          ? 1 + (i % 6)
          : i < 180
            ? 8 + (i % 22)
            : 31 + ((i * 37) % 333);
    const occurredAt = new Date(
      anchor.getTime() - days * 86400000 - (i % 20) * 3600000,
    ).toISOString();
    return {
      id: `demo-${String(i + 1).padStart(4, "0")}`,
      synthetic: true,
      category,
      title: template.title,
      description: template.description,
      keywords: template.keywords,
      occurredAt,
      publishedAt: occurredAt,
      reportedAt: occurredAt,
      location: {
        latitude: city.lat + Math.sin(i * 2.71) * 0.045,
        longitude: city.lng + Math.cos(i * 1.81) * 0.075,
        city: city.uk,
        cityEn: city.en,
        approximate: true,
        precision: "district",
      },
      legalQualification: template.article
        ? { article: template.article }
        : undefined,
      sources: [{ name: "Crime Radar · synthetic dataset" }],
      status: i % 3 === 0 ? "reported" : "investigation",
      confidence: 1,
    };
  });
}
export function incidentDate(
  item: Incident,
  basis?: DateBasis,
): string | undefined {
  if (basis === "publication") return item.publishedAt;
  if (basis === "event")
    return (
      item.occurredAt ??
      (item.occurredOn ? `${item.occurredOn}T00:00:00.000Z` : undefined)
    );
  return (
    item.occurredAt ??
    (item.occurredOn ? `${item.occurredOn}T00:00:00.000Z` : undefined) ??
    item.reportedAt ??
    item.publishedAt
  );
}
const calendarFormatter = new Intl.DateTimeFormat("en", {
  timeZone: "Europe/Kyiv",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const offsetFormatter = new Intl.DateTimeFormat("en", {
  timeZone: "Europe/Kyiv",
  timeZoneName: "shortOffset",
});
/** Date-only event keys are calendar dates, never assertions of midnight. */
export function queryDateBounds(q: Pick<IncidentQuery, "from" | "to">) {
  const calendarKey = (value: string) => {
    const parts = calendarFormatter.formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)!.value;
    return Date.parse(
      `${part("year")}-${part("month")}-${part("day")}T00:00:00Z`,
    );
  };
  return {
    from: Date.parse(q.from),
    to: Date.parse(q.to),
    dayFrom: calendarKey(q.from),
    dayTo: calendarKey(q.to),
  };
}
/** Start of a Ukrainian calendar day, including its actual DST offset. */
export function kyivDayStart(day: string): number {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(midnight) ||
    new Date(midnight).toISOString().slice(0, 10) !== day
  )
    throw new Error("Invalid calendar date");
  let timestamp = midnight;
  for (let i = 0; i < 3; i++) {
    const name = offsetFormatter
      .formatToParts(new Date(timestamp))
      .find((p) => p.type === "timeZoneName")!.value;
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
    if (!match) throw new Error("Unsupported Kyiv timezone offset");
    const offset =
      (Number(match[2]) * 60 + Number(match[3] ?? 0)) *
      60000 *
      (match[1] === "+" ? 1 : -1);
    const next = midnight - offset;
    if (next === timestamp) break;
    timestamp = next;
  }
  return timestamp;
}
export function kyivCalendarRange(from: string, to: string) {
  kyivDayStart(to);
  const nextDay = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    from: new Date(kyivDayStart(from)).toISOString(),
    to: new Date(kyivDayStart(nextDay) - 1).toISOString(),
  };
}
/** Compare exact times over the previous duration and date-only events over
 * the preceding, non-overlapping set of Ukrainian calendar days. */
export function previousDateBounds(q: Pick<IncidentQuery, "from" | "to">) {
  const current = queryDateBounds(q);
  const duration = current.to - current.from + 1;
  const days = current.dayTo - current.dayFrom + 86400000;
  return {
    from: current.from - duration,
    to: current.from - 1,
    dayFrom: current.dayFrom - days,
    dayTo: current.dayFrom - 86400000,
  };
}
export function filterIncidents(
  items: Incident[],
  q: IncidentQuery,
  range = queryDateBounds(q),
): Incident[] {
  const terms =
    q.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return items
    .filter((item) => {
      const l = item.location,
        date = incidentDate(item, q.dateBasis);
      const inLongitude =
        q.west <= q.east
          ? l.longitude >= q.west && l.longitude <= q.east
          : l.longitude >= q.west || l.longitude <= q.east;
      const text = [
        item.title.uk,
        item.title.en,
        item.description?.uk,
        item.description?.en,
        ...item.keywords,
        item.legalQualification?.article,
        l.city,
        l.cityEn,
        l.district,
      ]
        .join(" ")
        .toLocaleLowerCase();
      const dateValue = date ? Date.parse(date) : NaN;
      const dateOnly =
        q.dateBasis === "event" && !item.occurredAt && Boolean(item.occurredOn);
      return (
        l.latitude >= q.south &&
        l.latitude <= q.north &&
        inLongitude &&
        Boolean(date) &&
        dateValue >= (dateOnly ? range.dayFrom : range.from) &&
        dateValue <= (dateOnly ? range.dayTo : range.to) &&
        (!q.categories?.length || q.categories.includes(item.category)) &&
        terms.every((term) => text.includes(term))
      );
    })
    .sort(
      (a, b) =>
        Date.parse(incidentDate(b, q.dateBasis)!) -
          Date.parse(incidentDate(a, q.dateBasis)!) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
export function paginate(
  items: Incident[],
  query: IncidentQuery,
): IncidentResponse {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (cursor && cursor.dateBasis !== query.dateBasis)
    throw new Error("Cursor date basis does not match query");
  const limit = query.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid pagination");
  const remaining = cursor
    ? items.filter(
        (i) =>
          Date.parse(incidentDate(i, query.dateBasis)!) <
            Date.parse(cursor.date) ||
          (Date.parse(incidentDate(i, query.dateBasis)!) ===
            Date.parse(cursor.date) &&
            i.id > cursor.id),
      )
    : items;
  const page = remaining.slice(0, limit);
  return {
    items: page,
    total: items.length,
    nextCursor:
      remaining.length > limit
        ? encodeCursor(page.at(-1)!, query.dateBasis)
        : null,
  };
}
export function encodeCursor(item: Incident, dateBasis?: DateBasis): string {
  return btoa(
    JSON.stringify({
      date: new Date(incidentDate(item, dateBasis)!).toISOString(),
      id: item.id,
      dateBasis,
    }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function decodeCursor(value: string): {
  date: string;
  id: string;
  dateBasis?: DateBasis;
} {
  try {
    const cursor = JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      typeof cursor.date !== "string" ||
      !Number.isFinite(Date.parse(cursor.date)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        cursor.date,
      ) ||
      new Date(cursor.date).toISOString().slice(0, 19) !==
        cursor.date.slice(0, 19) ||
      typeof cursor.id !== "string" ||
      !cursor.id.length ||
      (cursor.dateBasis !== undefined &&
        cursor.dateBasis !== "event" &&
        cursor.dateBasis !== "publication")
    )
      throw new Error();
    return cursor;
  } catch {
    throw new Error("Invalid cursor");
  }
}
export function calculateStatistics(
  items: Incident[],
  query: IncidentQuery,
): IncidentStatistics {
  const current = filterIncidents(items, query);
  const previous = filterIncidents(items, query, previousDateBounds(query));
  const counts = Object.fromEntries(categories.map((c) => [c, 0])) as Record<
    IncidentCategory,
    number
  >;
  current.forEach((i) => counts[i.category]++);
  return {
    total: current.length,
    previousPeriodTotal: previous.length,
    categories: counts,
  };
}
