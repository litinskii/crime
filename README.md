# Crime Radar

Mobile-first bilingual PWA for exploring **publicly reported incidents in Ukraine**. The map is the main interface; incident density is not a measure of personal danger or crime probability.

Built from the [supplied product discussion](https://chatgpt.com/share/6ac4b304-f5c4-83eb-b575-d3658a0105d6). The first release is a working product prototype with fictional data and an independently runnable API/database foundation. **Live source collectors and real incident ingestion are not implemented or enabled.** The frontend uses Cloudflare Workers Static Assets; the API is deployed separately in the next phase.

## Quick start

Requires Node.js 22.12+ and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The frontend defaults to mock data and needs no database or credentials. Map styles/tiles come from [OpenFreeMap](https://openfreemap.org/quick_start/) and require an internet connection. If the map provider is unavailable, the incident list, filters and cards remain accessible.

```sh
npm run build
npm run preview
npm run typecheck
npm run lint
npm test
npm run format
```

The production frontend is **apps/web/dist/**. Its service worker is generated during production build, not during normal development. Preview defaults to **http://127.0.0.1:4173**. Install and offline checks should use preview or HTTPS deployment after one successful online load.

## Implemented experience

- Full-screen MapLibre map centered on Ukraine, touch pan/zoom, category pictograms and clustering.
- Cluster tap zooms in; incident selection opens a sheet with collapsed, half and expanded states. A keyboard/screen-reader incident list is also available.
- Category multi-select, keyword/legal-article search, 24h/7d/30d/1y and custom periods. Selected filters persist for the session.
- Density mode and complete statistics for visible bounds, with a previous-period comparison where a nonzero baseline exists.
- City search through a replaceable geocoding interface; demo search supports ten Ukrainian cities. A normalized address geocoder can be connected separately.
- Explicit geolocation button; no permission request on launch, no precise user-location persistence.
- Ukrainian/English UI and bilingual incident summaries. Locale changes immediately and persists locally. Detection follows saved selection → browser language (uk otherwise en) → Ukrainian fallback if unavailable.
- Light/dark/system themes, 320px layout, safe-area spacing, 44px controls, focus handling and reduced-motion styles.
- `/incident/:id` page with localised descriptions, source references, legal article, status, approximate map and share/copy-link fallback.
- Installable manifest, PNG/maskable/apple-touch icons, app-shell precache, bounded network-first incident cache and an explicit update prompt.
- Offline/no results/API error/location denial handling, request cancellation, 400ms map-query debounce, lazy map/detail chunks.

## Structure and stack

```text
apps/web/        React + TypeScript + Vite PWA
apps/api/        Fastify API + PostgreSQL/PostGIS foundation
packages/shared Types, fictional fixtures, filtering and cursor utilities
docs/           API contract, Cloudflare/AWS hosting and data-platform requirements
```

Frontend: React Router, Zustand, TanStack Query, Tailwind CSS, date-fns, i18next/react-i18next, MapLibre GL JS and vite-plugin-pwa. Icons use Lucide plus compact vector-derived map pictograms. There is no authentication, payment flow, admin UI or social functionality.

Both applications share one npm workspace to keep the public contract consistent during initial development. They are separate runtime/build units and can later be extracted to `crime-radar-web` and `crime-radar-api` repositories. The backend uses parameterized SQL with explicit PostGIS queries instead of an ORM; this keeps the small spatial schema easy to inspect. All selected versions are locked in package-lock.json.

## Mock data

270 deterministic fictional events across Kyiv, Odesa, Lviv, Dnipro, Kharkiv, Vinnytsia, Zaporizhzhia, Ivano-Frankivsk, Chernihiv and Poltava. Every category and both languages are represented. Dates cover the previous 12 months and roll daily so short-period filters remain demonstrable. Every fixture has `synthetic: true` and public approximate coordinates; there are no real people or real reports. Demo mode is labelled in the map and incident pages, including when the seeded API serves these records.

The dataset includes recent examples as well as older events. Switching to 1y and browsing the country shows the full available synthetic range. Only matching viewport records are returned to the map. Statistics use the entire matching dataset, not just the current page.

## Frontend configuration

Copy `apps/web/.env.example` to `apps/web/.env.local` only when custom configuration is needed. Restart Vite after changes. Vite values are public; never put secrets in them.

| Variable           | Purpose                                                             |
| ------------------ | ------------------------------------------------------------------- |
| VITE_DATA_SOURCE   | `mock` (default) or `api`                                           |
| VITE_API_URL       | API origin; empty for same-origin `/api/v1`                         |
| VITE_MAP_STYLE_URL | Optional MapLibre style JSON; otherwise OpenFreeMap positron/dark   |
| VITE_GEOCODING_URL | Optional normalized location-search endpoint; otherwise demo cities |

`MockIncidentsRepository` and `ApiIncidentsRepository` implement the same shared contract. Components do not scrape public source sites or call translation providers. Analytics uses an intentionally disabled `AnalyticsService` abstraction and collects nothing by default.

## API and PostGIS

To run the API without a database:

```sh
npm run dev:api
```

By default it uses in-memory fictional data. If `apps/api/.env` already exists, its configuration takes precedence. For database mode:

```sh
cp apps/api/.env.example apps/api/.env
docker compose up -d database
npm run db:migrate
npm run db:seed
```

Set `DATA_SOURCE=postgres` in `apps/api/.env`, then run `npm run dev:api`. The local API listens at **http://127.0.0.1:3000**; `/health` reports the storage mode. The database binds only to 127.0.0.1:54329. Its Compose credentials are disposable local credentials. The official PostGIS image uses linux/amd64 emulation on Apple Silicon; that setting can be removed on an amd64 machine.

To connect the frontend, set `VITE_DATA_SOURCE=api` and `VITE_API_URL=http://127.0.0.1:3000` in its environment and restart Vite. Ensure ALLOWED_ORIGINS includes the frontend origin. The database seed is idempotent and refreshes the dates of existing fictional records. No real collector is running.

API: incidents list/detail and statistics, strict spatial/date/category validation, bounded responses, opaque keyset pagination, structured logging, rate limiting and configured-origin CORS. Source/private/raw tables are excluded from public queries. See [API contract](docs/api.md) and [separate data-platform specification](docs/data-platform.md).

Optional integration test against the local migrated/seeded database:

```sh
TEST_DATABASE_URL=postgres://crime:crime_local_only@127.0.0.1:54329/crime_radar npm test
```

Without TEST_DATABASE_URL, database integration tests are skipped and the filter/API tests still run. Keep production DB credentials outside tracked files. In production use a dedicated limited read role for the public API and separate credentials for ingestion.

## PWA and deployment

Production build generates manifest.webmanifest, sw.js and hashed static assets. The service worker precaches the shell and uses network-first API caching with a five-minute expiry and bounded entries. It does not precache the base map tiles. Demo records can be generated offline; real API data may be unavailable after cache expiry. Do not describe old data as current.

An installation button appears when the browser exposes the install event; Safari uses Share → Add to Home Screen. Service worker updates prompt the user before refreshing. Share depends on browser support and a secure context; clipboard is the fallback.

See [Cloudflare Workers deployment](docs/deployment.md) for the first release, repeatable publishing, SPA routing and cache headers. The same guide preserves S3 + CloudFront as an alternative. `npm run deploy:web` builds and uploads only the frontend using your existing Wrangler login. No API/database or paid infrastructure is provisioned by that command.

## Verification and next phase

Build, typecheck and lint commands are supplied. Unit/API tests cover bilingual data, composed filters, unknown event time fallback, statistics, pagination and API validation/CORS. The optional PostGIS test traverses all seeded events without duplicate pages and checks bounded-area totals. Browser checks should cover language changes, marker/cluster selection, category/time/search filters, sheets, details, themes and 320px layout.

Lighthouse >90 Performance/Accessibility/Best Practices are product targets; they are not asserted without a measured deployment audit. Real geolocation permission, OS home-screen installation, Web Share and provider coverage should also be validated on physical target devices before release.

The next independent phase is **one verified official collector** with preserved raw data, extraction/classification, cached geocoding, privacy review, provenance, deduplication and Ukrainian/English summaries. The detailed requirements and staged completion criteria are in [docs/data-platform.md](docs/data-platform.md). The API/database foundation alone does not meet the real-data MVP definition of done.
