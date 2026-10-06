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
export interface IncidentSource {
  name: string;
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
export function incidentDate(item: Incident): string | undefined {
  return item.occurredAt ?? item.reportedAt ?? item.publishedAt;
}
export function filterIncidents(
  items: Incident[],
  q: IncidentQuery,
): Incident[] {
  const terms =
    q.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return items
    .filter((item) => {
      const l = item.location,
        date = incidentDate(item);
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
      return (
        l.latitude >= q.south &&
        l.latitude <= q.north &&
        inLongitude &&
        Boolean(date) &&
        Date.parse(date!) >= Date.parse(q.from) &&
        Date.parse(date!) <= Date.parse(q.to) &&
        (!q.categories?.length || q.categories.includes(item.category)) &&
        terms.every((term) => text.includes(term))
      );
    })
    .sort(
      (a, b) =>
        Date.parse(incidentDate(b)!) - Date.parse(incidentDate(a)!) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
export function paginate(
  items: Incident[],
  query: IncidentQuery,
): IncidentResponse {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const limit = query.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid pagination");
  const remaining = cursor
    ? items.filter(
        (i) =>
          Date.parse(incidentDate(i)!) < Date.parse(cursor.date) ||
          (Date.parse(incidentDate(i)!) === Date.parse(cursor.date) &&
            i.id > cursor.id),
      )
    : items;
  const page = remaining.slice(0, limit);
  return {
    items: page,
    total: items.length,
    nextCursor: remaining.length > limit ? encodeCursor(page.at(-1)!) : null,
  };
}
export function encodeCursor(item: Incident): string {
  return btoa(JSON.stringify({ date: incidentDate(item), id: item.id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function decodeCursor(value: string): { date: string; id: string } {
  try {
    const cursor = JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      typeof cursor.date !== "string" ||
      !Number.isFinite(Date.parse(cursor.date)) ||
      typeof cursor.id !== "string" ||
      !cursor.id.length
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
  const current = filterIncidents(items, query),
    duration = Date.parse(query.to) - Date.parse(query.from);
  const previous = filterIncidents(items, {
    ...query,
    from: new Date(Date.parse(query.from) - duration - 1).toISOString(),
    to: new Date(Date.parse(query.from) - 1).toISOString(),
  });
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
