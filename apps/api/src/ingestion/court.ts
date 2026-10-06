import { fetchText, robotsAllows, SourceAccessError } from "./collector";
import { hash } from "./hash";
import { sourceById } from "./sources";
import type { RawItem, SourceCollector } from "./types";
export interface CourtDocument {
  id: string;
  url: string;
  publishedAt: string;
  caseNumber: string;
  category: string;
}
export function validCourtDocument(value: unknown): value is CourtDocument {
  if (!value || typeof value !== "object") return false;
  const v = value as CourtDocument;
  return (
    typeof v.id === "string" &&
    /^\d{1,12}$/.test(v.id) &&
    typeof v.url === "string" &&
    /^https:\/\/od\.reyestr\.court\.gov\.ua\/files\/\d{1,3}\/[a-f0-9]{32}\.rtf$/.test(
      v.url,
    ) &&
    typeof v.publishedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(v.publishedAt) &&
    Number.isFinite(Date.parse(v.publishedAt)) &&
    typeof v.caseNumber === "string" &&
    /^[\dА-ЯІЇЄҐа-яіїєґ/\- ]{1,60}$/u.test(v.caseNumber) &&
    typeof v.category === "string" &&
    v.category.length < 300
  );
}
/** Decode the open registry's ANSI/Unicode RTF without evaluating embedded objects. */
export function rtfToText(rtf: string): string {
  if (!rtf.startsWith("{\\rtf"))
    throw new SourceAccessError("Source court document is not RTF");
  const decoder = new TextDecoder("windows-1251"),
    stack: boolean[] = [];
  let skip = false,
    out = "";
  for (let i = 0; i < rtf.length;) {
    const c = rtf[i++];
    if (c === "{") {
      stack.push(skip);
      continue;
    }
    if (c === "}") {
      skip = stack.pop() ?? false;
      continue;
    }
    if (c !== "\\") {
      if (!skip && c !== "\r" && c !== "\n") out += c;
      continue;
    }
    const rest = rtf.slice(i);
    if (rest.startsWith("'")) {
      const bytes: number[] = [];
      let hex = rtf.slice(i).match(/^'([a-f0-9]{2})/i);
      while (hex) {
        bytes.push(parseInt(hex[1], 16));
        i += 3;
        if (rtf[i] === "\\" && rtf[i + 1] === "'") {
          i++;
          hex = rtf.slice(i).match(/^'([a-f0-9]{2})/i);
        } else break;
      }
      if (!skip) out += decoder.decode(new Uint8Array(bytes));
      continue;
    }
    if (/[{}\\]/.test(rtf[i] ?? "")) {
      if (!skip) out += rtf[i];
      i++;
      continue;
    }
    const word = rest.match(/^([a-z]+)(-?\d+)? ?/i);
    if (!word) {
      if (rtf[i] === "*") skip = true;
      i++;
      continue;
    }
    i += word[0].length;
    const key = word[1],
      num = Number(word[2]);
    if (
      [
        "fonttbl",
        "colortbl",
        "stylesheet",
        "info",
        "pict",
        "object",
        "header",
        "footer",
      ].includes(key)
    ) {
      skip = true;
      continue;
    }
    if (skip) continue;
    if (key === "u") {
      out += String.fromCharCode(num < 0 ? num + 65536 : num);
      if (rtf[i] === "?") i++;
    } else if (key === "par" || key === "line") out += "\n";
    else if (key === "tab") out += " ";
  }
  return out
    .normalize("NFC")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}
export class CourtCollector implements SourceCollector {
  source = sourceById("court-decisions")!;
  constructor(readonly documents: CourtDocument[]) {}
  async collect(): Promise<RawItem[]> {
    if (!this.documents.length) return [];
    const policy = await fetchText(
      "https://od.reyestr.court.gov.ua/robots.txt",
    );
    const items: RawItem[] = [];
    for (const doc of this.documents) {
      if (!validCourtDocument(doc))
        throw new SourceAccessError("Source court metadata invalid");
      if (
        policy.status !== 404 &&
        (policy.status !== 200 ||
          !robotsAllows(policy.text, new URL(doc.url).pathname))
      )
        throw new SourceAccessError(
          "Source court robots policy does not permit collection",
        );
      const response = await fetchText(doc.url);
      if (response.status !== 200)
        throw new SourceAccessError(
          `Source court access failed: HTTP ${response.status}`,
        );
      const content = rtfToText(response.text);
      if (content.length < 100)
        throw new SourceAccessError("Source court text missing");
      items.push({
        sourceId: this.source.id,
        externalId: doc.id,
        sourceUrl: `https://reyestr.court.gov.ua/Review/${doc.id}`,
        canonicalUrl: `https://reyestr.court.gov.ua/Review/${doc.id}`,
        title: `Вирок: ${doc.category}`,
        content: content.slice(0, 120000),
        publishedAt: doc.publishedAt,
        retrievedAt: new Date().toISOString(),
        contentHash: await hash(content),
      });
    }
    return items;
  }
}
