import places from "./ukraine-places.json";
import ruralRows from "./ukraine-rural-places.json";
import { locationCities } from "@crime-radar/shared";
import type { Place } from "./types";

// GeoNames CC BY 4.0. Small-settlement matches additionally require regional
// evidence: their national homonym coverage is incomplete in this bounded file.
const rural: Place[] = (
  ruralRows as [string, string, string, number, number, string, string[]][]
).map(([id, uk, en, latitude, longitude, regionCode, aliases]) => ({
  key: `geonames-${id}`,
  uk,
  en,
  latitude,
  longitude,
  regionCode,
  aliases,
  precision: "city",
}));
const ruralKeys = new Set(rural.map((place) => place.key));
export const gazetteer: Place[] = [...places, ...rural].map((place) => {
  const familiar = locationCities.find((city) => city.uk === place.uk);
  return {
    ...place,
    precision: "city",
    ...(familiar ? { en: familiar.en } : {}),
  };
});
const normalize = (s: string) =>
  s.normalize("NFC").toLocaleLowerCase("uk").replace(/[’ʼ`]/g, "'");
const forms = new Map<string, Place[]>();
const exceptions: Record<string, string[]> = {
  Київ: ["Києві", "Києва", "Києвом"],
  Львів: ["Львові", "Львова"],
  Харків: ["Харкові", "Харкова"],
  Чернігів: ["Чернігові", "Чернігова"],
  "Біла Церква": ["Білій Церкві", "Білої Церкви", "Білу Церкву"],
  "Кривий Ріг": ["Кривому Розі", "Кривого Рогу", "Кривий Ріг"],
  "Кам'янець-Подільський": ["Кам'янці-Подільському", "Кам'янця-Подільського"],
  "Кам'янське": ["Кам'янському", "Кам'янського", "Кам'янським"],
  "Кам’янське": ["Кам’янському", "Кам’янського", "Кам’янським"],
  Тернопіль: ["Тернополі", "Тернополя"],
  Рівне: ["Рівному", "Рівного"],
  Рокитне: ["Рокитному", "Рокитного", "Рокитним"],
  Миколаїв: ["Миколаєві", "Миколаєва"],
  Хмельницький: ["Хмельницькому", "Хмельницького"],
  Запоріжжя: ["Запоріжжі"],
  Вінниця: ["Вінниці", "Вінницю"],
  Чернівці: ["Чернівцях", "Чернівців"],
  Суми: ["Сумах", "Сум"],
};
function variants(name: string) {
  const result = [name, ...(exceptions[name] ?? [])];
  if (/ий$/.test(name))
    result.push(...["ому", "ого", "им"].map((s) => name.slice(0, -2) + s));
  else if (/а$/.test(name))
    result.push(...["і", "и", "у", "ою"].map((s) => name.slice(0, -1) + s));
  else if (/о$/.test(name))
    result.push(...["і", "а", "ом"].map((s) => name.slice(0, -1) + s));
  else if (/і$/.test(name))
    result.push(...["ях", "ів", "ям"].map((s) => name.slice(0, -1) + s));
  else if (/и$/.test(name))
    result.push(...["ах", "ів", "ам"].map((s) => name.slice(0, -1) + s));
  else if (/я$/.test(name))
    result.push(...["і", "ю"].map((s) => name.slice(0, -1) + s));
  else if (/ь$/.test(name))
    result.push(...["і", "я", "ю"].map((s) => name.slice(0, -1) + s));
  else if (/[бвгджзклмнпрстфхцчшщ]$/.test(name))
    result.push(...["і", "у", "а", "ом"].map((s) => name + s));
  return result;
}
for (const place of gazetteer) {
  for (const alias of new Set([place.uk, place.en, ...(place.aliases ?? [])]))
    for (const form of variants(alias)) {
      const key = normalize(form),
        old = forms.get(key) ?? [];
      if (!old.some((p) => p.key === place.key))
        forms.set(key, [...old, place]);
    }
}
function streetName(tokens: string[], index: number, length: number): boolean {
  if (
    /^(?:вулиці|вулицю|вулиця|вул|проспекті|проспекту|проспект|просп|провулку|провулок|пров|бульварі|бульвару|бульвар|бульв|узвозі|узвіз|площі|площа|шосе|автошляху|автодороги)$/iu.test(
      tokens[index - 1] ?? "",
    )
  )
    return true;
  // The genitive adjective in “Донецького шосе” is a road name, while
  // “У Донецькому вулиці...” still names a separately located settlement.
  return (
    /(?:ого|ої)$/iu.test(tokens[index + length - 1] ?? "") &&
    /^(?:шосе|тракту|тракт|провулку|провулок|проспекту|проспект|бульвару|бульвар)$/iu.test(
      tokens[index + length] ?? "",
    )
  );
}
function placeMentions(text: string): Place[][] {
  const tokens = normalize(text).match(/[\p{L}]+(?:['-][\p{L}]+)*/gu) ?? [];
  const found: Place[][] = [];
  for (let i = 0; i < tokens.length; i++)
    for (let n = 3; n >= 1; n--) {
      const matches = forms.get(tokens.slice(i, i + n).join(" "));
      if (!matches) continue;
      if (streetName(tokens, i, n)) continue;
      // Small villages also share names with months and regions (Вересня,
      // Буковина). Count them only after a settlement cue or as a bare lookup.
      if (
        matches.every((place) => ruralKeys.has(place.key)) &&
        !(i === 0 && tokens.length === n) &&
        !/^(?:у|в|с|селі|села|село|селищі|селище|м|місті|міста)$/u.test(
          tokens[i - 1] ?? "",
        )
      )
        continue;
      found.push(matches);
      i += n - 1;
      break;
    }
  return found;
}
export function mentionedPlaces(text: string): Place[] {
  return [
    ...new Map(
      placeMentions(text)
        .flat()
        .map((place) => [place.key, place]),
    ).values(),
  ];
}
const regions: Record<string, RegExp> = {
  "01": /Черкащ|Черкаськ/iu,
  "02": /Чернігівщ|Чернігівськ/iu,
  "03": /Буковин|Чернівецьк/iu,
  "04": /Дніпропетровщ|Дніпропетровськ/iu,
  "05": /Донеччин|Донецьк/iu,
  "06": /Івано-Франківщ|Івано-Франківськ/iu,
  "07": /Харківщ|Харківськ/iu,
  "08": /Херсонщ|Херсонськ/iu,
  "09": /Хмельниччин|Хмельницьк/iu,
  "10": /Кіровоградщ|Кіровоградськ/iu,
  "11": /Крим/iu,
  "13": /Київщ|Київськ/iu,
  "14": /Луганщ|Луганськ/iu,
  "15": /Львівщ|Львівськ/iu,
  "16": /Миколаївщ|Миколаївськ/iu,
  "17": /Одещ|Одеськ/iu,
  "18": /Полтавщ|Полтавськ/iu,
  "19": /Рівненщ|Рівненськ/iu,
  "21": /Сумщ|Сумськ/iu,
  "22": /Тернопільщ|Тернопільськ/iu,
  "23": /Вінниччин|Вінницьк/iu,
  "24": /Волин/iu,
  "25": /Закарпат/iu,
  "26": /Запоріжж|Запорізьк/iu,
  "27": /Житомирщ|Житомирськ/iu,
};
// Запоріжжя is both a city and a village in the same oblast. The source's
// coverage cannot distinguish them; require a city label or a named urban
// district. Districts verified at https://zp.gov.ua/pages/318556-struktura-miskoyi-vladi.
const zaporizhzhiaName = "Запоріжж(?:я|і|ю|ям)(?!\\p{L})";
const zaporizhzhiaVillage = new RegExp(
  `(?<!\\p{L})(?:селі|село|села|с\\.|селищі|селище|селища)\\s*${zaporizhzhiaName}`,
  "iu",
);
const zaporizhzhiaCity = new RegExp(
  `(?<!\\p{L})(?:місті|місто|міста|м\\.)\\s*${zaporizhzhiaName}`,
  "iu",
);
const zaporizhzhiaDistrict = new RegExp(
  `(?<!\\p{L})(?:Вознесенівськ|Дніпровськ|Заводськ|Космічн|Олександрівськ|Хортицьк|Шевченківськ)(?:ому|ого|ий)\\s+район(?:і|у)?\\s+(?:(?:міста|м\\.)\\s*)?${zaporizhzhiaName}`,
  "iu",
);
function explicitCity(matches: Place[], text: string): Place[] {
  const city = matches.find((place) => place.key === "geonames-687700");
  if (!city || matches.length < 2 || zaporizhzhiaVillage.test(text))
    return matches;
  return zaporizhzhiaCity.test(text) || zaporizhzhiaDistrict.test(text)
    ? [city]
    : matches;
}
export function resolvePlace(
  text: string,
  context = text,
  sourceRegionCode?: string,
): Place | null {
  const mentions = placeMentions(text);
  if (!mentions.length) return null;
  const codes = Object.entries(regions)
    .filter(([, re]) => re.test(context))
    .map(([code]) => code);
  // Region evidence resolves homonyms only. It cannot remove a separately named city.
  const region =
    codes.length === 1
      ? codes[0]
      : codes.length === 0
        ? sourceRegionCode
        : undefined;
  const resolved: Place[] = [];
  const evidence = `${text}\n${context}`;
  for (const matches of mentions) {
    let candidates =
      region &&
      (matches.length > 1 || matches.some((place) => ruralKeys.has(place.key)))
        ? matches.filter((place) => place.regionCode === region)
        : matches;
    candidates = explicitCity(candidates, evidence);
    if (candidates.length !== 1) return null;
    if (ruralKeys.has(candidates[0].key) && !region) return null;
    resolved.push(candidates[0]);
  }
  const unique = [
    ...new Map(resolved.map((place) => [place.key, place])).values(),
  ];
  return unique.length === 1 ? unique[0] : null;
}
/** A geographic cue must precede the name; compound landmarks cannot become village names. */
export function placeAfterCue(
  text: string,
  context = text,
  sourceRegionCode?: string,
): Place | null {
  const tokens = text.match(/[\p{L}]+(?:['’ʼ-][\p{L}]+)*/gu) ?? [];
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    if (!forms.has(normalize(tokens.slice(0, n).join(" ")))) continue;
    if (streetName(tokens, 0, n)) return null;
    if (
      tokens[n] &&
      /^\p{Lu}\p{Ll}/u.test(tokens[n] ?? "") &&
      /^\p{Lu}/u.test(tokens[0] ?? "")
    )
      return null;
    return resolvePlace(
      tokens.slice(0, n).join(" "),
      context,
      sourceRegionCode,
    );
  }
  return null;
}
