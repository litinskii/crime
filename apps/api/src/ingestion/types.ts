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
}
export interface SourceDefinition {
  id: string;
  name: string;
  url: string;
  verificationUrl: string;
}
export interface SourceCollector {
  source: SourceDefinition;
  collect(options?: {
    pages?: number;
    before?: number;
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
}
export interface Geocoder {
  geocode(place: Place): Promise<Place | null>;
}
export interface SummaryProvider {
  summarize(
    category: IncidentCategory,
    place: Place,
  ): Incident["title"] & {
    description: NonNullable<Incident["description"]>;
  };
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
  stage?(items: RawItem[]): Promise<RawItem[]>;
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
