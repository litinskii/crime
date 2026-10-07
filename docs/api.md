# Public API v1

`GET /health` reports database readiness. Production returns `storage: d1` and `ingestion: multi-source`; local PostgreSQL returns `ingestion: manual-cli`.

`GET /api/v1/status` returns the configured source registry with kind, check/retry times, last error, pending age, latest source publication, last newly received item, per-status counts and rejection reasons, plus a deduplicated global total. No raw text/review items are public. `POST /internal/ingest?source=<allowlisted-id>` requires a server-side bearer secret; optional positive `before` (Telegram) or `page` (Ukrinform archive) backfills a bounded page. `/internal/articles` accepts up to three allowlisted publisher URLs and fetches originals itself. `/internal/court` accepts up to three validated official RTF metadata entries and 100 withdrawn IDs; the exact main-branch GitHub harvest workflow can authenticate with verified short-lived OIDC. `POST /internal/process?source=<allowlisted-id>` drains persisted work without fetching; `drain=1` is a compatibility alias on `/internal/ingest`. Processing and historical backfills do not postpone live polling. Each hour, cron dispatches every due web source through Cloudflare Queues. Individual jobs process up to two originals on a poll and three on a continuation; process-only jobs include court records and never refetch feeds. `POST /internal/dispatch` uses the same bearer secret and durable hourly outbox to resume the current cycle. Duplicate delivery cannot repeat a completed poll. Polling uses per-source cadence and persistent failure backoff; retention runs separately once daily.

## List / statistics

`GET /api/v1/incidents` and `GET /api/v1/statistics` require:

| Parameter    | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| north, south | Latitude, -85 to 85; north must exceed south                            |
| east, west   | Longitude, -180 to 180; non-crossing bounds                             |
| from, to     | ISO 8601 timestamps with timezone; interval <= 366 days                 |
| categories   | Optional comma-separated canonical category IDs                         |
| query        | Optional search terms (all must match), up to 200 characters / 32 terms |
| dateBasis    | Optional `event` or `publication`; the UI explicitly selects a basis    |
| limit        | Page size: default 500; D1 caps at 500, PostgreSQL at 2000              |
| cursor       | Opaque cursor returned by the preceding list response                   |

Do not interpret or invent cursor values. Ordering follows the selected date basis descending, then ID ascending. A cursor is bound to its date basis; a mismatch returns 400. Repeat the same filters with the next cursor. Statistics ignore pagination and match the same query and keyword filters.

```json
{ "items": [], "total": 270, "nextCursor": null }
```

Statistics returns `total`, `previousPeriodTotal`, and a count for each category. Exact timestamps use the preceding equal-duration interval. Date-only events use the preceding equal number of Ukrainian calendar days, without overlapping the current calendar days. A percent change is displayed only if its previous total is greater than zero.

`GET /api/v1/incidents/:id` returns one public `Incident`. Missing ID returns 404; invalid parameters return 400; failures return generic 503 in production (500 locally). Responses carry `Cache-Control: no-store`; the PWA has a bounded five-minute offline cache. Production API requests are limited to 120 per minute per Cloudflare client IP.

## Shared public record

Types live in `packages/shared/src/index.ts`. Fields include bilingual title/description, canonical category, keywords, nullable occurredAt, optional date-only occurredOn and eventDateEvidence (kind, date phrase, source URL and publication anchor), reportedAt/publishedAt, public latitude/longitude, city/district and approximation/precision, legal qualification, sources, status and confidence. Synthetic fixtures include `synthetic: true`; the frontend displays a demo badge even when they come from the API.

`dateBasis=event` includes only established occurredAt/occurredOn; unknown event dates are excluded. Exact event times use timestamp bounds; date-only events use the Ukrainian calendar dates touched by those bounds (Europe/Kyiv). Custom UI dates cover full Ukrainian days, including daylight-saving transitions. `dateBasis=publication` uses the latest publication among active supporting originals and may include historical or undated events. Omitting dateBasis preserves the legacy occurredAt → occurredOn → reportedAt → publishedAt fallback for older clients. A date-only value never asserts a midnight event time. An edited or withdrawn original removes only its own support; remaining originals retain publication and their independently established date evidence. Coordinates are public/approximate coordinates only; exact internal locations and raw documents have separate storage and are never queried by the public repository.

The offline city search covers eleven cities. An optional `VITE_GEOCODING_URL` provider must return `LocationResult[]` with id, bilingual name, latitude, longitude and optional zoom. No browser translation or source scraping is implemented.
