import {
  createMockIncidents,
  filterIncidents,
  paginate,
  calculateStatistics,
  type Incident,
  type IncidentQuery,
  type IncidentResponse,
  type IncidentsRepository,
  type IncidentStatistics,
} from "@crime-radar/shared";
export class MockIncidentsRepository implements IncidentsRepository {
  private data = createMockIncidents();
  async getIncidents(q: IncidentQuery): Promise<IncidentResponse> {
    q.signal?.throwIfAborted();
    return paginate(filterIncidents(this.data, q), q);
  }
  async getIncident(id: string, signal?: AbortSignal): Promise<Incident> {
    signal?.throwIfAborted();
    const item = this.data.find((i) => i.id === id);
    if (!item) throw new Error("Incident not found");
    return item;
  }
  async getStatistics(q: IncidentQuery): Promise<IncidentStatistics> {
    q.signal?.throwIfAborted();
    return calculateStatistics(this.data, q);
  }
}
export class ApiIncidentsRepository implements IncidentsRepository {
  private base = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.base}/api/v1/${path}`, { signal });
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json();
  }
  private params(q: IncidentQuery): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (k === "signal" || v === undefined) continue;
      params.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return params.toString();
  }
  getIncidents(q: IncidentQuery) {
    return this.request<IncidentResponse>(
      `incidents?${this.params(q)}`,
      q.signal,
    );
  }
  getIncident(id: string, signal?: AbortSignal) {
    return this.request<Incident>(
      `incidents/${encodeURIComponent(id)}`,
      signal,
    );
  }
  getStatistics(q: IncidentQuery) {
    return this.request<IncidentStatistics>(
      `statistics?${this.params(q)}`,
      q.signal,
    );
  }
}
export interface SourceStatus {
  mode: "live";
  sources: {
    id: string;
    name: string;
    url: string;
    kind: "official" | "media" | "court";
    enabled?: boolean;
    published?: number;
    pending?: number;
    latestPublicationAt?: string | null;
    lastNewItemAt?: string | null;
    oldestPendingAt?: string | null;
    lastProcessedAt?: string | null;
    counts?: Record<string, number>;
    rejectionReasons?: Record<string, number>;
    next_attempt_at?: number;
    last_error?: string | null;
    last_success_at: string | null;
    last_failure_at: string | null;
  }[];
  total: number;
}
export async function getSourceStatus(
  signal?: AbortSignal,
): Promise<SourceStatus> {
  const origin = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
  const response = await fetch(`${origin}/api/v1/status`, { signal });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}
export const isDemo = import.meta.env.VITE_DATA_SOURCE !== "api";
export const incidentsRepository: IncidentsRepository = isDemo
  ? new MockIncidentsRepository()
  : new ApiIncidentsRepository();
