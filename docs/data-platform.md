# Crime Radar data platform

Production is a multi-source Cloudflare Worker/D1 pipeline. See the [source audit](public-sources.md) for verified feeds, registries, archive formats, access failures and attribution.

## Collection and publication

- A registry distinguishes official police reports, media and court decisions. Public cards cite the original publisher and identify its kind.
- Collectors respect robots policies, use a descriptive agent, bounded responses/timeouts, refuse arbitrary hosts/paths/redirects and retry 429/5xx. Blocked police websites remain registered and retry later.
- Private originals retain source/external ID, URL, title/text, publication/retrieval dates and content hash. Versions allow edits to be traced. No raw/review endpoint is public.
- D1 stages at most 30 items and processes at most three per run. Small multi-row statements fit the Free request query budget. Leases prevent source overlap; queue state survives pagination. Empty archive pages can still drain pending work.
- Category extraction prefers an unambiguous headline; supported text evidence is used when the title has no category. Advice, war harm and unsupported/multiple categories are excluded.
- Settlement lookup uses a maintained offline GeoNames gazetteer with 3,266 populated places and current Ukrainian aliases/declensions. Shared names require regional context. Marks use settlement centres. The frontend's separate quick city search still supports eleven cities.
- Media/Telegram locations come from the headline or incident-related sentences. Court locations require a dated event narrative; court addresses, residence and birthplaces cannot supply event coordinates. Unknown/ambiguous records stay private for review.
- Safe bilingual summaries contain constrained incident subtype, place and explicitly detected facts (e.g. reported detention/injuries). Legal articles require an explicit Criminal Code reference; procedural-code articles and category-based guesses are not published. Names, contacts and exact addresses are not copied into cards. This is factual summarisation, not unrestricted translation or general-purpose PII redaction.
- `occurredOn` records an explicit event day without inventing a time. Date filters use event date when available, otherwise publication date. Cards distinguish these dates. Court publication is never substituted for a known historical event date.
- Canonical article identity or category/place/content hash merges exact reposts. Court cases share a canonical case key. Similar headlines trigger review, never automatic fuzzy merging. Confidence is source metadata, not calibrated accuracy or a danger score.
- Edits failing the gate and officially withdrawn court documents retract publication. Access failures alone preserve old reports. Private text/versions expire after 90 days; safe public metadata/provenance remain.

## Scheduling, history and operations

Cloudflare cron selects one due web source at the start of each hour, favouring sources not checked recently. Sources rotate across hourly runs to keep collection within the Free plan's per-invocation query limit. Failed checks back off from one hour to six hours; successful checks reset the delay to one hour. Status reports last attempt/success/failure, next retry, pending items and each source's published count. Settings displays this information without private originals.

`/internal/ingest` selects an allowlisted source and optional archive cursor/page. `/internal/articles` accepts at most three allowlisted article URLs, which the server fetches itself. `/internal/court` accepts at most three official RTF metadata entries or 100 withdrawn IDs. Local imports require the existing bearer secret; court harvesting additionally accepts a cryptographically verified GitHub Actions OIDC token for this exact repository, owner, workflow and main branch.

Daily court metadata is too large for a small Worker request: the current ZIP is about 303 MB compressed. A GitHub Actions Python job downloads/streams it, filters active criminal verdicts, posts bounded batches and remembers metadata signatures. It refreshes its short-lived OIDC token during long runs. Checkpoints contain public document metadata only; raw decisions never enter Git/cache. Explicit official status=0 triggers withdrawal. Archive disappearance alone does not imply withdrawal.

Historical media import reads verified monthly sitemaps and resumes from a private local URL checkpoint. Telegram supports numeric `before` pagination; Ukrinform's public news archive supports numbered pages. These imports use the same publication gates and source leases as regular collection.

Tests cover XML namespaces/full article metadata, robots/allowlists, privacy, expanded/ambiguous geography, court heading exclusion, explicit event dates, withdrawal, outage preservation/backoff, queues/leases, exact/review duplicates, retention, pagination/statistics, private-route protection, signed CI authentication and D1 query bounds. Optional PostGIS integration validates the local adapter. Real-source smoke checks supplement fixtures.

## Remaining quality work

Authenticated review/corrections; independently verified regional sources; broader settlement morphology; measured duplicate detection across media/police/courts; richer privacy-checked bilingual facts; calibrated confidence and larger-scale spatial/search indexes. Aggregated crime statistics need a separate view and must not become invented map events.
