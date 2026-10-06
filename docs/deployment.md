# Cloudflare Workers deployment

The only production site is [crime-radar.w-siteee.workers.dev](https://crime-radar.w-siteee.workers.dev). `wrangler.jsonc` targets Worker **crime-radar** and D1 **crime-radar-data**. No Pages project is used. The Worker serves the PWA, same-origin API and hourly scheduler. The frontend never scrapes sources.

## Publish

Requires Node.js 22.16+, npm and an existing Wrangler login:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npx wrangler d1 migrations apply crime-radar-data --remote
npm run deploy
```

`npm run deploy` builds with `VITE_DATA_SOURCE=api` and empty `VITE_API_URL`, overriding local mock configuration, then uploads Worker code and `apps/web/dist/`. `deploy:web` is an alias. Apply reviewed D1 migrations separately. Deployment changes production immediately but does not change the subscription.

The D1 binding contains a public database identifier, not credentials. An independently owned clone must create its own D1 database and update the binding. Credentials stay in Wrangler configuration. GitHub Actions verifies pushes; deployments are manual from the verified branch.

## Protected manual ingestion

Cron needs no external credentials. Manual collection requires `INGESTION_SECRET` in Workers Secrets. Use a random key of at least 32 characters and set it with `npx wrangler secret put INGESTION_SECRET`. Never put it in a Vite variable or command argument. This checkout keeps its matching key in ignored `.env.ingestion`, readable only by its owner. The file contains only the key, not dotenv syntax.

```sh
npm run ingest:worker
# Initial backfill, one page per request with pauses:
npm run ingest:worker -- --pages=5
# Drain persisted work, stopping when no pending work remains:
npm run ingest:worker -- --source=npu-telegram --drain --runs=20
# One specific older page:
npm run ingest:worker -- --before=78627
# Other current sources and the paginated media archive:
npm run ingest:worker -- --source=zaxid-news
npm run ingest:worker -- --source=zaxid-news --drain --runs=20
# Regional pilot (repeat with the five registered source IDs):
npm run ingest:worker -- --source=npu-vinnytsia-telegram --pages=3
npm run ingest:worker -- --source=npu-vinnytsia-telegram --drain --runs=20
npm run ingest:worker -- --source=ukrinform-regions --page=2
# Historical media URLs, with an ignored local resume checkpoint:
npm run ingest:news -- --months=202609,202608,202607 --limit=600
# Court metadata archive (Python 3), with an ignored local resume checkpoint:
npm run ingest:courts -- --limit=1000
```

The CLI reads the environment or private local file. `WORKER_URL` can target another owned deployment. Outputs contain counts and public numeric cursors, never originals or secrets. Manual requests and cron share a source lease; overlapping runs are skipped.

Each run stages up to 30 eligible candidates from a page and processes at most three items. Pending work persists even when posts leave the newest page. Multi-row statements and a maximum 30-item source page bound D1 queries; a test exercises the 50-query Free limit. Missing required article text or changed source layouts stop collection. Failed items retry at most three times; edits reset attempts. Daily indexed maintenance expires original text/versions older than 90 days, up to 500 rows per table per run. A large backlog can take additional days to clear. The same bounded maintenance removes old job/run history.

## Daily court collection

`.github/workflows/harvest-courts.yml` downloads the official daily ZIP at 05:40 UTC, streams criminal verdict metadata, and submits bounded RTF references. It also runs on its own workflow/script changes and can be dispatched manually. An Actions cache holds only public IDs/metadata signatures. Authentication uses GitHub-signed, short-lived OIDC tokens, refreshed during long runs; no repository secret is required. The Worker verifies issuer, audience, signature, time bounds, immutable repository/owner IDs, main branch and exact workflow path. Forks, PR workflows and unrelated jobs cannot ingest. The OIDC token is accepted only by the court endpoint. Explicit status=0 records are withdrawn. A failed harvest is visible in Actions; the next daily run resumes from the last checkpoint.

Cloudflare web-source retries back off from one hour to six hours, retaining historical public records. Every hour the scheduler polls one due source, or uses a free slot to process a pending source. The minimum poll interval is 60 minutes. A single source is selected each hourly tick, so an individual source can be checked less often when other sources are due. Process/backfill runs have separate clocks and do not update live polling success. Retention runs at 02:15 UTC. The open map refreshes its period every five minutes and source status hourly; reopening/focusing source information can trigger a stale-data refresh. Check `/api/v1/status` for actual timestamps and queue ages. The regional pilot covers Vinnytsia, Rivne, Volyn, Chernivtsi and Zhytomyr through verified public Telegram channels; other oblasts remain a later rollout.

## Quotas

Static assets have a [free/unlimited request allowance](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). Dynamic Worker/API code has [separate quotas](https://developers.cloudflare.com/workers/platform/pricing/). D1 Free includes 5 million rows read/day, 100,000 written/day and 5 GB total account storage; each database is limited to 500 MB. Exhausted daily quotas block queries until reset rather than upgrading the account. Indexes reduce reads but count towards writes. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). No paid-plan change is part of this deployment.

## Local Worker

```sh
npm run build:production
npx wrangler d1 migrations apply crime-radar-data --local
npx wrangler dev --port 8787
```

Local D1 is separate and empty by default. Use the PostGIS collector/API in the README for the alternative adapter. SQLite integration tests use fictional records in memory and need no Cloudflare account.

## Routing, cache and verification

Only `/api/*`, `/internal/*` and `/health` run code before asset routing. `_redirects` rewrites `/incident/*` to the app shell; missing assets keep real 404 responses. Hashed assets are immutable; HTML/SW/manifest revalidate. API JSON is `no-store`; the PWA has a bounded five-minute network-first cache. Camera/microphone are disabled; geolocation is requested after a tap.

[Cron changes may take up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Confirm a scheduled ingestion log or updated source polling timestamp after that window; manual ingestion alone does not verify cron.

After publishing check health/status, filtered incidents, statistics, detail and direct incident links. Unauthorized collection must return 401, unknown private/API routes 404 and invalid queries 400. Check both languages and 320px layout. Existing installations may need to accept the service-worker update prompt. Source failure retains published records and separate last success/failure times.

Physical installation, geolocation permission, Web Share, offline map tiles and Lighthouse require separate device/audit checks. No unmeasured score is claimed.
