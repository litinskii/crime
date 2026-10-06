import type { Incident, IncidentCategory } from "@crime-radar/shared";

export interface RawItem {
  sourceId: string;
  externalId: string;
  sourceUrl: string;
  title: string;
  content: string;
  publishedAt: string | null;
  retrievedAt: string;
  contentHash: string;
  canonicalUrl?: string;
  /** Telegram's forwarding header, not merely a link to another article. */
  isRepost?: boolean;
  /** Only supplied when the source proves the original publication timestamp. */
  originalPublishedAt?: string;
}
export interface SourceDefinition {
  id: string;
  name: string;
  url: string;
  verificationUrl: string;
  kind?: "official" | "media" | "court";
  transport?: "telegram" | "rss" | "police-web" | "court";
  archiveUrl?: string;
  telegramChannel?: string;
  /** GeoNames admin1 code; source coverage is not an incident location. */
  regionCode?: string;
  /** Exact hosts allowed for canonical article provenance; links are not fetched. */
  canonicalHosts?: readonly string[];
  cadenceMinutes?: number;
}
export interface SourceCollector {
  source: SourceDefinition;
  collect(options?: {
    pages?: number;
    before?: number;
    page?: number;
    signal?: AbortSignal;
  }): Promise<RawItem[]>;
}
export interface Place {
  key: string;
  uk: string;
  en: string;
  latitude: number;
  longitude: number;
  precision: "city";
  aliases?: string[];
  regionCode?: string;
}
export interface Geocoder {
  geocode(place: Place): Promise<Place | null>;
}
export interface SummaryProvider {
  summarize(
    category: IncidentCategory,
    place: Place,
    facts?: ExtractedFacts,
  ): Incident["title"] & {
    description: NonNullable<Incident["description"]>;
  };
}
export interface ExtractedFacts {
  subtype?: { uk: string; en: string };
  article?: string;
  status?: Incident["status"];
  occurredOn?: string;
  eventDateEvidence?: import("./event-date").EventDateEvidence;
  dateReviewReason?: string;
  details: { uk: string; en: string }[];
}
export type Processed =
  | { status: "rejected" | "review"; reason: string }
  | {
      status: "published";
      incident: Incident;
      canonicalKey: string;
      fingerprint: string;
    };
export interface RunResult {
  discovered: number;
  changed: number;
  published: number;
  duplicates: number;
  review: number;
  rejected: number;
  failed: number;
}
export interface IngestionStore {
  begin(source: SourceDefinition): Promise<string | null>;
  /** Stage a page and drain a bounded, durable work queue. */
  stage?(items: RawItem[], sourceId?: string): Promise<RawItem[]>;
  saveRaw(item: RawItem): Promise<{ id: string; changed: boolean }>;
  record(
    id: string,
    result: Processed,
    raw: RawItem,
  ): Promise<"published" | "duplicate" | "review" | "rejected">;
  failItem(id: string, reason: string): Promise<void>;
  finish(
    runId: string,
    source: SourceDefinition,
    result: RunResult,
    error?: string,
  ): Promise<void>;
}
