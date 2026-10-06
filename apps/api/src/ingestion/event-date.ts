export interface EventDateEvidence {
  kind: "explicit" | "relative" | "inferred-year";
  /** Only the date expression is public; the source sentence may contain personal data. */
  text: string;
  sourceUrl: string;
  anchorPublishedAt?: string;
  timeZone: "Europe/Kyiv";
}

export interface EventDateContext {
  publishedAt: string | null;
  sourceUrl: string;
  isRepost?: boolean;
  /** Verified publication metadata from the original message, never retrieval time. */
  originalPublishedAt?: string;
}

export type EventDateResult =
  | { status: "known"; occurredOn: string; evidence: EventDateEvidence }
  | { status: "unknown"; reason?: string }
  | { status: "review"; reason: string };

const months: Record<string, number> = {
  січня: 1,
  лютого: 2,
  березня: 3,
  квітня: 4,
  травня: 5,
  червня: 6,
  липня: 7,
  серпня: 8,
  вересня: 9,
  жовтня: 10,
  листопада: 11,
  грудня: 12,
};
const monthNames = Object.keys(months).join("|");
interface DateExpression {
  index: number;
  text: string;
  day?: number;
  month?: number;
  year?: number;
  relative?: number;
}

function expressions(text: string): DateExpression[] {
  const result: DateExpression[] = [];
  const occupied: [number, number][] = [];
  function add(
    pattern: RegExp,
    parse: (m: RegExpMatchArray) => DateExpression,
  ) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      if (occupied.some(([a, b]) => start >= a && start < b)) continue;
      occupied.push([start, start + match[0].length]);
      result.push(parse(match));
    }
  }
  add(/(?<![\p{L}\d])(20\d{2})-(\d{2})-(\d{2})(?!\d)/gu, (m) => ({
    index: m.index!,
    text: m[0],
    year: +m[1],
    month: +m[2],
    day: +m[3],
  }));
  add(/(?<![\p{L}\d])(\d{1,2})[./](\d{1,2})[./](20\d{2})(?!\d)/gu, (m) => ({
    index: m.index!,
    text: m[0],
    day: +m[1],
    month: +m[2],
    year: +m[3],
  }));
  add(
    new RegExp(
      `(?<![\\p{L}\\d])(\\d{1,2})\\s+(${monthNames})\\s+(20\\d{2})(?:\\s+року)?(?!\\d)`,
      "giu",
    ),
    (m) => ({
      index: m.index!,
      text: m[0],
      day: +m[1],
      month: months[m[2].toLocaleLowerCase("uk")],
      year: +m[3],
    }),
  );
  add(
    new RegExp(
      `(?<![\\p{L}\\d])(\\d{1,2})\\s+(${monthNames})(?!\\p{L})`,
      "giu",
    ),
    (m) => ({
      index: m.index!,
      text: m[0],
      day: +m[1],
      month: months[m[2].toLocaleLowerCase("uk")],
    }),
  );
  add(/(?<!\p{L})(сьогодні|вчора|учора)(?!\p{L})/giu, (m) => ({
    index: m.index!,
    text: m[0],
    relative: /^сьогодні$/iu.test(m[0]) ? 0 : -1,
  }));
  return result.sort((a, b) => a.index - b.index);
}

function calendarDate(year: number, month: number, day: number): string | null {
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}

export function kyivCalendarDay(
  timestamp: string | null | undefined,
): string | null {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDay(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** Explicit dates are also used by the separately gated court narrative parser. */
export function explicitDates(text: string): string[] {
  return [
    ...new Set(
      expressions(text)
        .filter((date) => date.year !== undefined)
        .map((date) => calendarDate(date.year!, date.month!, date.day!))
        .filter((date): date is string => date !== null),
    ),
  ];
}

// Past event predicates, rather than category words in an announcement or headline.
const predicates =
  /(?<!\p{L})(?:викра(?:в|ла|ли)|заволоді(?:в|ла|ли)|поби(?:в|ла|ли)|вбив|вдарив|ударив|наніс|нанес(?:ла|ли)|завдав|завдала|скої(?:в|ла|ли)|вчини(?:в|ла|ли)|зіткну(?:вся|лися|лася)|здійсни(?:в|ла)\s+наїзд|наїха(?:в|ла)|зби(?:в|ла)|підпали(?:в|ла|ли)|збу(?:вав|вала|вали)|прода(?:в|ла|ли)|придба(?:в|ла|ли)|зберіга(?:в|ла|ли)|(?:одержав|отримав)\s+(?:хабар|неправомірну\s+вигоду)|виникла\s+пожежа|спалахнула\s+пожежа|загорі(?:вся|лася)|зайня(?:лася|лося)|(?:ДТП|аварія|пожежа|подія|інцидент|пригода|автопригода|крадіжка|напад|бійка|займання)(?:,?\s+(?:яка|який|яке|що))?\s+(?:стал(?:ася|ась|ося)|стався|трапил(?:ася|ась|ося)|трапився|відбул(?:ася|ась|ося)|відбувся)|(?:стал(?:ася|ась|ося)|стався|трапил(?:ася|ась|ося)|трапився)\s+(?:ДТП|аварія|пожежа|подія|інцидент|пригода|автопригода|крадіжка|напад|бійка|займання))(?!\p{L})/giu;
const administrativePredicates =
  /затрим(?:а|у)|викри(?:в|ла|ли|то)|розкри(?:в|ла|ли|то)|обра(?:в|ла|ли|но)\s+(?:запобіжн|міру)|вручи(?:в|ла|ли)|вручено|переда(?:в|ла|ли|но)|прове(?:ли|дено)\s+обшук|арештува|задокументува|встанови(?:в|ла|ли)|встановлено|розгляну(?:в|ла|ли|то)|надійш|отримал.{0,40}повідомлен|зверну(?:в|ла)|повідом(?:ив|ила|или|лено)|оголоси(?:в|ла|ли)|засуди(?:в|ла|ли)|ухвали(?:в|ла|ли)|вирок|судове\s+засідання|скерува(?:в|ла|ли)|направи(?:в|ла|ли)|розслідува(?:в|ла|ли)|відкри(?:в|ла|ли)\s+(?:кримінальне\s+)?провадження|народив|народила|зареєстрован|Указ|постанов[аи]|набрав.*чинності/giu;
const yearModifier =
  /(?<!\p{L})(?:торік|позаторік|минулоріч|минул(?:ого|ому)\s+ро(?:ку|ці)|позаминул(?:ого|ому)\s+ро(?:ку|ці)|цього\s+року|поточного\s+року|20\d{2}\s+(?:року|році|рік|р\.))(?!\p{L})/iu;
const relativeClause =
  /,\s*(?:який|яка|яке|які|що|котрий|котра|котре|котрі)(?!\p{L})/iu;

const eventNoun =
  /ДТП|аварі[яїю]|пожеж[аіу]|займання|крадіжк[аиу]|викрадення|пограбування|напад|інцидент|поді[яїю]/iu;
const negatedEvent =
  /(?:ДТП|аварія|пожежа|крадіжка|подія|інцидент|напад)\s+не\s+(?:стал(?:ася|ась|ося)|стався|відбул(?:ася|ась|ося)|відбувся)|не\s+(?:було|стал(?:ося|ася)|відбулося)\s+(?:ДТП|аварії|пожежі|займання|крадіжки|пограбування|нападу|події|інциденту)/iu;
const unconfirmedReference =
  /(?:інформація|повідомлення|відомості|факт|виклик)(?:\s+(?:про\s+це|щодо\s+цього))?\s+(?:не\s+підтверд(?:илася|илась|илися|илися|ився|илось|илося)|виявил(?:ася|ось|ося)\s+(?:хибн|неправдив))|(?:інформацію|повідомлення|відомості|факт)\s+(?:спростовано|не\s+підтверджено)/iu;
const unconfirmedNamedEvent =
  /(?:хибн[аеиу]|неправдив[аеиу])\s+(?:інформаці[яїю]|повідомлення|виклик)\s+(?:про|щодо)\s+(?:ДТП|аварі[юї]|пожеж[уії]|крадіжк[уи]|напад)|(?:інформація|повідомлення|факт)\s+(?:про|щодо)\s+(?:ДТП|аварі[юї]|пожеж[уії]|крадіжк[уи]|напад)[^,;.!?\n]{0,60}\s+не\s+підтверд|(?:ДТП|пожежа|крадіжка|подія|інцидент)\s+не\s+підтверд/iu;
const simulation =
  /за\s+сценарієм|умовн(?:о|а|ої|у|ий|ого|е)\s+(?:сталася|сталося|виникла|ДТП|пожеж|займан|напад|поді|інцидент)|(?:імітували|зімітували|імітація|змоделювали|моделювали)\s+(?:ДТП|пожеж|займан|напад)|під\s+час\s+(?:(?:тактичних|тактико-спеціальних|пожежно-тактичних|спеціальних)\s+)?навчань|навчальна\s+(?:пожежа|тривога)/iu;

/** Check the main episode and its immediate correction, not later suspect comments. */
export function eventPublicationIssue(text: string): string | null {
  const sentences = text
    .split(/\n|(?<=[.!?])\s+/u)
    .filter((sentence) => sentence.trim());
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    const actions = [...sentence.matchAll(predicates)];
    const negative = negatedEvent.test(sentence);
    const namedCorrection = unconfirmedNamedEvent.test(sentence);
    const training = eventNoun.test(sentence) && simulation.test(sentence);
    if (!actions.length && !negative && !namedCorrection && !training) continue;
    if (
      negative ||
      actions.some((action) =>
        /(?<!\p{L})не\s*$/iu.test(
          sentence.slice(Math.max(0, action.index! - 12), action.index!),
        ),
      )
    )
      return "negated-event";
    if (namedCorrection || unconfirmedReference.test(sentence))
      return "unconfirmed-event";
    if (training) {
      const trainingIndex = sentence.search(simulation);
      if (
        !actions.length ||
        actions.some((action) => Math.abs(action.index! - trainingIndex) <= 100)
      )
        return "simulated-event";
    }
    // “A fire was reported. The information was disproved.” is a direct correction.
    // “Information about casualties was unconfirmed” does not deny the fire itself.
    const next = sentences[index + 1];
    if (
      next &&
      ![...next.matchAll(predicates)].length &&
      unconfirmedReference.test(next)
    )
      return "unconfirmed-event";
    return null;
  }
  return null;
}

function eventAssociated(sentence: string, date: DateExpression): boolean {
  const markers = [
    ...[...sentence.matchAll(predicates)].map((m) => ({
      index: m.index!,
      end: m.index! + m[0].length,
      event: true,
    })),
    ...[...sentence.matchAll(administrativePredicates)].map((m) => ({
      index: m.index!,
      end: m.index! + m[0].length,
      event: false,
    })),
  ].sort((a, b) => a.index - b.index);
  const end = date.index + date.text.length;
  const before = markers.filter((m) => m.end <= date.index).at(-1);
  const after = markers.find((m) => m.index >= end);
  // A preceding predicate in the same clause binds trailing dates: “ДТП сталася вчора”.
  if (
    before &&
    date.index - before.end <= 100 &&
    !/[,;:]/u.test(sentence.slice(before.end, date.index))
  ) {
    if (
      before.event &&
      after &&
      !after.event &&
      !/[,;:]/u.test(sentence.slice(end, after.index))
    )
      return false;
    return before.event;
  }
  // For leading dates, the first predicate wins: “вчора затримали чоловіка, який викрав…”.
  // A relative clause describes the suspect's earlier act, not the date of the main clause.
  return Boolean(
    after?.event &&
    after.index - end <= 180 &&
    !relativeClause.test(sentence.slice(end, after.end)),
  );
}

export function extractEventDate(
  text: string,
  context: EventDateContext,
): EventDateResult {
  const publicationDay = kyivCalendarDay(context.publishedAt);
  if (!publicationDay)
    return { status: "unknown", reason: "invalid-publication-anchor" };
  const originalDay = kyivCalendarDay(context.originalPublishedAt);
  const verifiedOriginal =
    originalDay &&
    context.originalPublishedAt &&
    Date.parse(context.originalPublishedAt) <= Date.parse(context.publishedAt!);
  const isRepost =
    context.isRepost ||
    /(?:Forwarded from|переслано\s+(?:від|з)|репост|передрук)/iu.test(text);
  const anchor = verifiedOriginal
    ? context.originalPublishedAt!
    : isRepost
      ? undefined
      : context.publishedAt!;
  const anchorDay = kyivCalendarDay(anchor);
  const results: { occurredOn: string; evidence: EventDateEvidence }[] = [];
  let unanchored = false;
  for (const sentence of text.split(/\n|(?<=[.!?])\s+/u)) {
    for (const expression of expressions(sentence)) {
      if (!eventAssociated(sentence, expression)) continue;
      if (expression.year === undefined && yearModifier.test(sentence))
        return {
          status: "review",
          reason: "event-year-context-requires-review",
        };
      // “З 5 до 6 жовтня” has only one named month, but still describes a range.
      const prefix = sentence.slice(
        Math.max(0, expression.index - 55),
        expression.index,
      );
      if (
        new RegExp(
          `(?:з|від)\\s+\\d{1,2}(?:\\s+(?:${monthNames}))?\\s+(?:до|по|на)\\s*$`,
          "iu",
        ).test(prefix) ||
        /\d{1,2}\s*(?:[-–—]|та|і)\s*$/u.test(prefix)
      )
        return { status: "review", reason: "event-date-range" };
      let occurredOn: string | null;
      let kind: EventDateEvidence["kind"];
      if (expression.year !== undefined) {
        occurredOn = calendarDate(
          expression.year,
          expression.month!,
          expression.day!,
        );
        kind = "explicit";
      } else {
        if (!anchorDay) {
          unanchored = true;
          continue;
        }
        if (expression.relative !== undefined) {
          occurredOn = shiftDay(anchorDay, expression.relative);
          kind = "relative";
        } else {
          const year = +anchorDay.slice(0, 4);
          occurredOn = calendarDate(year, expression.month!, expression.day!);
          if (!occurredOn || occurredOn > anchorDay)
            occurredOn = calendarDate(
              year - 1,
              expression.month!,
              expression.day!,
            );
          kind = "inferred-year";
        }
      }
      if (!occurredOn)
        return { status: "review", reason: "invalid-event-date" };
      if (occurredOn > publicationDay || (anchorDay && occurredOn > anchorDay))
        return { status: "review", reason: "future-event-date" };
      results.push({
        occurredOn,
        evidence: {
          kind,
          text: expression.text,
          sourceUrl: context.sourceUrl,
          ...(kind !== "explicit" ? { anchorPublishedAt: anchor! } : {}),
          timeZone: "Europe/Kyiv",
        },
      });
    }
  }
  if (new Set(results.map((r) => r.occurredOn)).size > 1)
    return { status: "review", reason: "multiple-event-dates" };
  if (results.length) {
    const best =
      results.find((r) => r.evidence.kind === "explicit") ?? results[0];
    return { status: "known", ...best };
  }
  return {
    status: "unknown",
    ...(unanchored ? { reason: "repost-date-without-original-anchor" } : {}),
  };
}
