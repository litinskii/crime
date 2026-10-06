import { cities, type LocalizedText, type Locale } from "@crime-radar/shared";
export const localized = (
  value: Partial<LocalizedText> | undefined,
  locale: string,
  sourceText = "",
) => value?.[locale as Locale] || value?.uk || sourceText;
export interface LocationResult {
  id: string;
  name: LocalizedText;
  latitude: number;
  longitude: number;
  zoom?: number;
}
export interface GeocodingService {
  search(query: string, signal?: AbortSignal): Promise<LocationResult[]>;
}
class LocalGeocodingService implements GeocodingService {
  async search(query: string): Promise<LocationResult[]> {
    const term = query.trim().toLocaleLowerCase();
    return cities
      .filter(
        (c) => !term || `${c.uk} ${c.en}`.toLocaleLowerCase().includes(term),
      )
      .map((c) => ({
        id: c.en,
        name: { uk: c.uk, en: c.en },
        latitude: c.lat,
        longitude: c.lng,
        zoom: 12,
      }));
  }
}
class ApiGeocodingService implements GeocodingService {
  async search(query: string, signal?: AbortSignal): Promise<LocationResult[]> {
    const url = new URL(import.meta.env.VITE_GEOCODING_URL);
    url.searchParams.set("query", query);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Geocoding unavailable");
    return response.json();
  }
}
export const geocoding: GeocodingService = import.meta.env.VITE_GEOCODING_URL
  ? new ApiGeocodingService()
  : new LocalGeocodingService();
export interface AnalyticsService {
  track(event: string, properties?: Record<string, unknown>): void;
}
// Intentionally disabled. No precise coordinates or user information is collected.
export const analytics: AnalyticsService = { track(_event, _properties) {} };
export function safeSourceUrl(url?: string): string | undefined {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
