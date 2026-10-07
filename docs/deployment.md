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
# Only when this release has unapplied, reviewed D1 migrations:
npx wrangler d1 migrations apply crime-radar-data --remote
# First queue deployment only (skip if it already exists):
npx wrangler queues create crime-radar-ingestion
npm run deploy
```

`npm run deploy` builds with `VITE_DATA_SOURCE=api` and empty `VITE_API_URL`, overriding local mock configuration, then uploads Worker code and `apps/web/dist/`. `deploy:web` is an alias. Finish local code, fixtures and checks before one final deployment; no interim production releases are needed for source-adapter work. Apply reviewed D1 migrations separately only when schema changes require them. The four media adapters and court archival need no migration or new Cloudflare resource. Deployment changes production immediately but does not change the subscription.

The D1 binding contains a public database identifier, not credentials. An independently owned clone must create its own D1 database and update the binding. Credentials stay in Wrangler configuration. GitHub Actions verifies pushes; deployments are manual from the verified branch.

## Protected manual ingestion

Cron needs no external credentials. Manual collection requires `INGESTION_SECRET` in Workers Secrets. Use a random key of at least 32 characters and set it with `npx wrangler secret put INGESTION_SECRET`. Never put it in a Vite variable or command argument. This checkout keeps its matching key in ignored `.env.ingestion`, readable only by its owner. The file contains only the key, not dotenv syntax.

```sh
npm run ingest:worker
# Resume the durable current hourly cycle, respecting each source's interval:
npm run ingest:worker -- --dispatch
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
# New media IDs (normal hourly scheduling needs no manual call):
npm run ingest:worker -- --source=dnepr-news
# Also: zaporizhzhia-061, poltava-events, lb-society
# Historical media URLs, with an ignored local resume checkpoint:
npm run ingest:news -- --months=202609,202608,202607 --limit=600
```

The CLI reads the environment or private local file. `WORKER_URL` can target another owned deployment. Outputs contain counts and public numeric cursors, never originals or secrets. Manual requests and cron share a source lease; overlapping runs are skipped.

Existing collectors stage up to 30 eligible candidates from a page. The four new media profiles scan at most 160 feed items and stage up to 12 candidates with publication dates within seven days. `dnepr-news` and `zaporizhzhia-061` use full RSS text; `poltava-events` and `lb-society` fetch candidate articles. Only individual candidate text is parsed into a DOM, avoiding the cost of a complete large-feed DOM. Full text, trusted paths and publication dates are required; a feed's publication lookback does not assign an event date.

A queue poll processes up to two items; process-only and manual jobs process up to three. Pending work persists even when posts leave the newest page. Multi-row statements and bounded source pages limit D1 queries; a test exercises the 50-query Free limit. Missing required article text or changed source layouts stop collection. Failed items retry at most three times; edits reset attempts. Daily indexed maintenance expires original text/versions older than 90 days, up to 500 rows per table per run. A large backlog can take additional days to clear. The same bounded maintenance removes old job/run history.

## Archived court source

`court-decisions` has `enabled:false`. Historical cards and source links remain readable; no new court uploads, manual processing or queued reprocessing are accepted. After normal authentication the court endpoint and source-selected private routes return HTTP 410 before D1 access. Legacy queued deliveries retire their task without changing public or raw records or creating successors. Disabled tasks are excluded from hourly dispatch and outbox recovery. Private retention continues normally.

`scripts/harvest-courts.py` exits before fetching archives or accessing a checkpoint. `.github/workflows/harvest-courts.yml` has no schedule or push trigger, and its retained manual job is disabled. These workflow changes apply remotely when pushed to the default branch. An older remote scheduled workflow may still start until then, but the released Worker rejects its uploads with HTTP 410. GitHub was the runner for official court data; no GitHub dataset was imported. The former OIDC verifier remains scoped to the exact workflow/repository identity and provides no access to other ingestion endpoints.

## Hourly active-source collection

Cloudflare web-source retries back off from one hour to six hours, retaining historical public records. Every hour the coordinator dispatches all due work from the 16 active sources into `crime-radar-ingestion`, including the four new media profiles. The consumer receives one message per invocation with concurrency 3, keeping each invocation within D1 Free's 50-query bound. Source leases and the durable D1 outbox protect against overlapping jobs and at-least-once Queue delivery. A poll waits until its actual 60-minute interval has elapsed; stale hourly poll tasks become process-only work. Fresh collected originals run before older rule versions. Continuation messages drain persisted originals without extra HTTP polling, up to 256 jobs per source/cycle and a global 640 processing jobs per UTC day (at most 1,920 process-only originals, plus bounded poll processing). This leaves capacity for hourly polls and retries on the free account. Unsent active-source jobs and expired deliveries are recovered by the next hourly coordinator. Queue delivery failures do not delete originals; reaching a daily budget leaves them for a later cycle. Queue messages carry only a task ID; text stays private in D1.

Process/backfill runs have separate clocks and do not update live polling success. Retention runs at 02:15 UTC, including old outbox tasks. The open map refreshes its period every five minutes and source status hourly; reopening/focusing source information can trigger a stale-data refresh. Check `/api/v1/status` for actual timestamps and queue ages. The regional pilot covers Vinnytsia, Rivne, Volyn, Chernivtsi and Zhytomyr through verified public Telegram channels; the new regional media profiles add Dnipropetrovsk, Zaporizhzhia and Poltava, with LB.ua as a national supplementary feed. Settlement lookup remains partial, so additional sources do not establish complete oblast coverage.

## Quotas

Static assets have a [free/unlimited request allowance](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). Dynamic Worker/API code has [separate quotas](https://developers.cloudflare.com/workers/platform/pricing/). D1 Free includes 5 million rows read/day, 100,000 written/day and 5 GB total account storage; each database is limited to 500 MB. Exhausted daily quotas block queries until reset rather than upgrading the account. Indexes reduce reads but count towards writes. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). [Queues Free](https://developers.cloudflare.com/queues/platform/pricing/) includes 10,000 read/write/delete operations per day and 24-hour message retention. Durable originals and task recovery remain in D1. No paid-plan change is part of this deployment.

Normal maximum ingestion traffic is 384 poll messages/day (16 × 24) plus 640 process messages/day. At one write, one read and one delete each, this is **3,072 Queue operations/day** before retries and recovery, leaving headroom under the 10,000-operation allowance. Feed scans, candidate counts and the global process cap stay bounded; manual imports or abnormal repeated deliveries add usage. The calculation is an ingestion budget, not a guarantee for all API traffic or actual D1 row usage.

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

After publishing check health/status, filtered incidents, statistics, detail and direct incident links. Unauthorized collection must return 401, authenticated archived-source ingestion 410, unknown private/API routes 404 and invalid queries 400. Check both languages and 320px layout. The archived court source should show history rather than an outage/retry. Existing installations may need to accept the service-worker update prompt. Source failure retains published records and separate last success/failure times.

Physical installation, geolocation permission, Web Share, offline map tiles and Lighthouse require separate device/audit checks. No unmeasured score is claimed.
