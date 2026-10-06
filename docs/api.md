# Public API v1

`GET /health` reports database readiness. Production returns `storage: d1` and `ingestion: npu-telegram`; local PostgreSQL returns `ingestion: manual-cli`.

`GET /api/v1/status` returns source name/URL, last successful/failed check, published total and city-level coverage. No raw text/review items are public. `POST /internal/ingest` requires a server-side bearer secret and fetches a fixed official source; optional positive numeric `before` backfills one page. It is not an upload endpoint. Cron runs the same pipeline every ten minutes.

## List / statistics

`GET /api/v1/incidents` and `GET /api/v1/statistics` require:

| Parameter    | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| north, south | Latitude, -85 to 85; north must exceed south                 |
| east, west   | Longitude, -180 to 180; non-crossing bounds                  |
| from, to     | ISO 8601 timestamps with timezone; interval <= 366 days      |
| categories   | Optional comma-separated canonical category IDs              |
| query        | Optional search terms (all must match), up to 200 characters |
| limit        | Page size: default 500; D1 caps at 500, PostgreSQL at 2000   |
| cursor       | Opaque cursor returned by the preceding list response        |

Do not interpret or invent cursor values. Ordering is effective date descending then ID ascending. Repeat the same filters with the next cursor. Statistics ignore pagination and match the same query and keyword filters.

```json
{ "items": [], "total": 270, "nextCursor": null }
```

Statistics returns `total`, `previousPeriodTotal`, and a count for each category. Previous period has equal duration and excludes the current interval's boundary. A percent change is displayed only if its previous total is greater than zero.

`GET /api/v1/incidents/:id` returns one public `Incident`. Missing ID returns 404; invalid parameters return 400; failures return generic 503 in production (500 locally). Responses carry `Cache-Control: no-store`; the PWA has a bounded five-minute offline cache. Production API requests are limited to 120 per minute per Cloudflare client IP.

## Shared public record

Types live in `packages/shared/src/index.ts`. Fields include bilingual title/description, canonical category, keywords, nullable occurredAt, reportedAt/publishedAt, public latitude/longitude, city/district and approximation/precision, legal qualification, sources, status and confidence. Synthetic fixtures include `synthetic: true`; the frontend displays a demo badge even when they come from the API.

Date filters use occurredAt when available, then reportedAt, then publishedAt. Undated records do not belong to a dated result set. The interface labels the fallback date explicitly. Coordinates are public/approximate coordinates only; exact internal locations and raw documents have separate storage and are never queried by the public repository.

The offline city search covers eleven cities. An optional `VITE_GEOCODING_URL` provider must return `LocationResult[]` with id, bilingual name, latitude, longitude and optional zoom. No browser translation or source scraping is implemented.
