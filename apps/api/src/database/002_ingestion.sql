ALTER TABLE raw_source_items DROP CONSTRAINT IF EXISTS raw_source_items_processing_status_check;
ALTER TABLE raw_source_items DROP CONSTRAINT IF EXISTS raw_source_items_source_id_content_hash_key;
CREATE INDEX IF NOT EXISTS raw_source_hash ON raw_source_items(source_id,content_hash);
ALTER TABLE raw_source_items ADD CONSTRAINT raw_source_items_processing_status_check
 CHECK(processing_status IN ('collected','parsed','geocoded','normalized','duplicate','review','rejected','published','failed'));
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS canonical_key text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_canonical ON incidents(canonical_key) WHERE canonical_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS incidents_fingerprint ON incidents(fingerprint);
CREATE TABLE IF NOT EXISTS raw_source_item_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), raw_source_item_id uuid NOT NULL REFERENCES raw_source_items(id) ON DELETE CASCADE,
 content_hash text NOT NULL, title text NOT NULL, content text NOT NULL, published_at timestamptz,
 retrieved_at timestamptz NOT NULL, UNIQUE(raw_source_item_id,content_hash)
);
CREATE INDEX IF NOT EXISTS raw_retention ON raw_source_items(retrieved_at);
CREATE TABLE IF NOT EXISTS ingestion_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id text NOT NULL REFERENCES sources(id),
 status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 counts jsonb NOT NULL DEFAULT '{}', error text
);
CREATE TABLE IF NOT EXISTS geocoding_city_cache (
 normalized_key text PRIMARY KEY, provider text NOT NULL, result jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
