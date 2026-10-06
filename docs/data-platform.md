# Crime Radar Data Platform — implementation specification

Source: [the supplied planning discussion](https://chatgpt.com/share/6ac4b304-f5c4-83eb-b575-d3658a0105d6). This document records the independent second project and its remaining work. **The current implementation is the API/database foundation, not a live ingestion platform.**

## Implemented foundation

- Fastify API, request validation, bounded results, opaque keyset pagination and allowed-origin CORS.
- PostgreSQL/PostGIS tables for sources, raw items, incidents, provenance, private locations, geocoding cache and processing jobs.
- Public spatial GiST index and event/report/publication date index.
- Synthetic seed compatible with the bilingual frontend contract.
- Visible-area statistics over the full matching dataset, independent of page size.
- Unit/API tests plus optional integration tests against a migrated, seeded PostGIS database.

The two applications live in one npm workspace to share types and filters while the product is being developed. They remain independently runnable/buildable and can be extracted into separate repositories later. The database currently uses explicit parameterized SQL instead of an ORM: the schema is small, and the PostGIS query behavior stays visible and testable.

## Pipeline to implement

Public sources → collectors → raw storage → extraction → classification → location extraction → geocoding → privacy processing → deduplication → normalization → PostgreSQL/PostGIS → API.

Implement one verified official source before adding more. Start with National Police or one regional police publication source. Government open datasets, emergency services and court documents are later adapters. Verify each source's availability, robots rules, terms, update frequency and publication structure before implementation. No frontend component reads source sites.

Each `SourceCollector.collect(context)` returns raw records containing source ID, external ID where available, source URL, original title/content, language, publication timestamp, raw location and metadata. Preserve retrieval timestamp and content hash. The raw table has uniqueness constraints on `(source_id, external_id)` and `(source_id, content_hash)` to support idempotent runs. Source updates must update/version raw content and trigger deliberate reprocessing rather than being silently discarded. Use stored HTML/JSON fixtures for tests; never hit government sites during unit tests.

Job stages: collected, parsed, geocoded, normalized, duplicate, rejected, published, failed. Record failures and attempts. Keep collectors separate from classification and normalization. Apply concurrency limits, delays, timeouts and exponential backoff. Store per-source last successful/failed run, discovered counts and processed counts. Scheduling belongs to the job runner, not to collectors; cron is enough initially.

## Data and quality rules

Canonical categories: violence, theft, robbery, fraud, drugs, weapons, traffic, fire, other. IDs stay language-independent. Allow future subcategories. Prefer structured source metadata and legal articles before inference; maintain legal mappings in their own module and validate them before live use.

Distinguish occurredAt, reportedAt and publishedAt. Unknown event times stay null; never invent them from a publication timestamp. The frontend/API interval filtering currently falls back to reportedAt then publishedAt and labels the date type. A future API should expose explicit date precision and date basis.

Store region, city, district, street/intersection and extracted address when known. Location precision is exact/street/district/city/region/unknown; do not plot a region centroid as a precise street event. No identifiable private residence should be published with exact coordinates. Original coordinates belong to the private location table; the API queries only public coordinates. Privacy-safe output can use a deterministic displacement of 100–300m or a coarse centroid, based on precision and event context. Displacement must remain stable between requests.

Publish summarized information without victims' or suspects' names, phone numbers, emails, apartment numbers, documents or other private identifiers. Raw source text needs restricted access and a retention policy. A generic regex is insufficient to establish privacy of real Ukrainian records; validate extraction on fixtures and review uncertain records before publication. No raw document endpoint is public.

Every published incident must have provenance. Preserve source URLs, type, publication date, retrieval timestamp and relation to raw documents. Multiple sources may describe one incident. Source unavailability is tracked separately and must not automatically erase an incident.

Deduplication should combine date/time proximity, public/internal location precision, category/legal article, text similarity and source relationships. Store match confidence and make thresholds configurable. Use a high-confidence merge tier, a review tier and a separate-record tier. The example 0.90/0.70 thresholds in the discussion require validation on real source fixtures; they are not proof of accuracy. Do not merge low-confidence records automatically.

Keep geocoding behind `Geocoder.geocode(parsedLocation)`. Cache normalized queries, respect provider limits, and return null on insufficient location data. Keep optional AI extraction/translation behind provider interfaces. Validate structured responses with Zod and treat source text as data. Only normalized, privacy-processed titles and summaries should be translated; never send raw personal records to an AI provider by default. Store Ukrainian and English text and support reprocessing from preserved raw material.

## API

The implemented contract is documented in [api.md](./api.md). Keep this stable across ingestion implementations. Query by visible bounds and dates; server-side totals must include all matching incidents. Use spatial indexes, bounded response sizes and keyset pagination. Support bilingual keyword search, legal articles, cities and districts; for larger datasets replace substring matching with tested full-text/trigram indexes.

In production use HTTPS, secret management, a restricted DB role for public reads, request validation/rate limiting, configured frontend origins and private ingestion/admin operations. The local Compose credentials are disposable development credentials, not production defaults.

## Delivery phases

1. **Foundation:** schema, PostGIS, seed, incidents/detail/statistics API (implemented).
2. **First source:** verified collector + fixtures + raw persistence + job runner + extraction.
3. **Location/category:** classification rules, event time confidence, location parsing and cached geocoding.
4. **Publication gate:** privacy processing, source provenance, duplicate matching and English summaries.
5. **Coverage:** additional sources, quality metrics, corrections and resilient scheduling.

Expose internal metrics for missing event dates, coarse/unknown locations, failed geocoding, uncertain classification, possible duplicates and failed jobs. Structured logs should include job/source/raw item/incident IDs, stage, duration and errors without leaking personal content.

First real-data MVP completion requires at least one real source, idempotent repeated ingestion, tested extraction/classification/geocoding/privacy/deduplication, Ukrainian and English summaries, provenance on every public incident, spatial/API integration tests and documented local deployment. Authentication, admin UI, subscriptions, payments, push notifications and social features remain out of scope.
