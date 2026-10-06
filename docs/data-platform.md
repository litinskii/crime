# Crime Radar data platform

Based on the [supplied product discussion](https://chatgpt.com/share/6ac4b304-f5c4-83eb-b575-d3658a0105d6). The first real-data MVP runs in Cloudflare Workers + D1. Fastify and PostgreSQL/PostGIS remain independently runnable for richer spatial needs; production needs no external database host.

## First verified source

The collector reads the ordinary public HTML preview of [Ukraine's National Police Telegram channel](https://t.me/s/UA_National_Police). An [official police publication](https://if.npu.gov.ua/news/natspolitsiya-zapustila-shche-odin-nomer-garyachoi-linii-z-poshuku-zniklikh-chi-zagiblikh-vnaslidok-viyskovikh-diy-rf-v-ukraini) links to this channel. Direct police-site collection returned a Cloudflare block and was not used or bypassed.

The collector checks robots.txt before each run (currently 404), respects disallows and refuses redirects, access blocks and changed layouts. Requests have a descriptive agent, 15-second timeout, bounded response and three attempts for 429/5xx with backoff. Pagination pauses between pages; production reads one page/request. Only the official channel's numeric post IDs and canonical HTTPS police news URLs are accepted. Links in source text are never executed or followed.

## Implemented pipeline

Collector → private originals/versions → durable queue → category/city extraction → offline geocoding → safe bilingual metadata → exact dedupe/review → public records → incidents/statistics API.

- Preserve source/external ID, URL, title/text, nullable publication date, retrieval time and SHA-256 hash. Undated gallery posts remain undated.
- Idempotence compares external identity, hash, publication date, canonical link and rules version. Edits reprocess and retain versions. Hashes are indexed rather than unique, so reposts retain provenance before publication dedupe.
- D1 stages pages atomically in small batches and drains three items/run. A source lease prevents overlap. Processing retries three times. Cron runs every ten minutes; queued items survive pagination.
- Classify one supported category from the headline. Advice, war/evacuation and ambiguous categories are excluded. Event time, legal article and case status are not guessed.
- Recognize ten original cities plus Lutsk and their supported name forms. A gazetteer provides cached centroids. Unknown, region-only or multi-city places stay unpublished for review. No residence/address is sent to an external geocoder.
- Summaries are Ukrainian/English templates made solely from allowlisted category/city. They explain city-centre precision, unknown event time and the source link. Raw names, contacts and addresses cannot enter them. This is limited metadata, not a full article translation or general-purpose PII redactor.
- Canonical article identity or category/city/content fingerprint merges exact reposts and preserves source links. Headline similarity ≥0.70 within seven publication days triggers review, never an automatic fuzzy merge. Confidence is fixed metadata, not calibrated accuracy or a danger score.
- Edited records that fail publication are withdrawn. Source outages alone do not erase records. Raw text/versions expire after 90 days; provenance and safe public summaries remain. Raw/review records have no public endpoint.

Production executes parameterized SQLite bounds/date/category/search queries, keyset pagination and full statistics. It is not PostGIS; advanced spatial analysis can use the retained adapter. PostgreSQL public queries explicitly separate real records from the demo seed.

## Operations and validation

Public `/api/v1/status` reports check times and published coverage. Private run history stores counts/errors; statuses/reasons and jobs support investigation without logging originals. Manual collection is bearer-secret protected and fetches a fixed source. No review UI exists yet; Cloudflare account access is required to inspect originals/review rows.

Tests use fictional HTML/records and execute D1 SQL in SQLite. They cover provenance/date parsing, robots, privacy, exact/review dedupe, edits/retraction, persistent queues, leases, retry bounds, retention, spatial/date filters, search, pagination/statistics, private-route protection and Free-plan query bounds. Optional PostGIS integration validates the other adapter. Real-source smoke runs and HTTPS/browser checks supplement these tests. See [deployment.md](deployment.md) for setup and quotas.

## Remaining work

Additional verified sources; broader maintained geography; reliable event-time/place extraction with confidence/review; fuller privacy-checked summaries/translation; validated legal mappings; authenticated review/correction UI; measured dedupe quality; outage alerts/backfill checkpoints; and larger-scale spatial/search indexes.

Coverage must remain visibly incomplete. City-centre markers and density must not imply actual incident locations or personal safety. Payments, subscriptions, social features and tracking remain outside current scope.
