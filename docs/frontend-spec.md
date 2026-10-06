# PWA requirements and completion boundary

Based on the final bilingual PWA specification in the [planning chat](https://chatgpt.com/share/6ac4b304-f5c4-83eb-b575-d3658a0105d6). The preceding single-language specification is superseded by this bilingual version.

## Product scope

Ukraine, mobile-first 320–480px, map as the primary interface, larger screen support. Ukrainian and English from the first release; localized UI and incident content; saved locale before browser detection. Publicly reported incidents only, with source attribution and approximate locations. Never present incident density as risk or safety probability.

## Required functions

- MapLibre, Ukraine initial view at 31.2/48.4/zoom 5, pan/pinch/double-tap, markers, category icons, clustering and heatmap.
- Viewport-based queries, 300–500ms debounce, cancellation and query caching; never request a whole live country dataset.
- Categories: violence/theft/robbery/fraud/drugs/weapons/traffic/fire/other.
- Periods: 24h/7d/30d/1y plus custom dates, default 7d; multi-category and bilingual keyword/legal search.
- Incident count and category totals for the whole matching visible area; previous-period comparison when valid.
- Three-state mobile incident sheet, separate details route `/incident/:id`, source list, legal qualification, status, keywords, approximate map and share fallback.
- Place search through an abstraction, explicit user location action, no automatic location request or precise-coordinate persistence.
- Light/dark/system appearance, touch controls >=44px, safe areas, keyboard labels/navigation, focus management and reduced motion.
- Mock/API repositories behind VITE_DATA_SOURCE, localized records, multiple sources and nullable event dates.
- Installable PWA, manifest/icons/worker, offline shell, bounded incident-data caching, and update prompt.
- Offline, no results, API/map failure and location denial states.
- Static build deployed with Cloudflare Workers, as selected by the owner. No ingestion in the browser.

## Shared model clarification

The data-platform spec correctly permits unknown occurredAt, although the initial PWA model declared it mandatory. The shared model uses `string | null`, labels reported/publication dates explicitly and uses them as a documented filter fallback. Locations carry approximation/precision. Source labels are original names; generated title/summary translations belong to data providers, not browser AI calls.

## Delivery boundary

The current frontend implements the core prototype and works on 270 fictional bilingual events. It is deployed on Cloudflare Workers Static Assets. Address search defaults to city-only fixtures until a normalized geocoding provider is configured. Custom date range is capped to the API's 366-day window. Live incident providers, real ingestion and tracking providers are outside this phase.

Type/lint/build/tests and browser checks are part of verification. Production PWA shell and offline loading can be tested on localhost preview; physical phone installation, permission prompts, sharing and measured Lighthouse scores remain release verification tasks. See README for current commands and constraints.
