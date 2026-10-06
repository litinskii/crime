CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS sources (
 id text PRIMARY KEY, name text NOT NULL, base_url text, enabled boolean NOT NULL DEFAULT false,
 last_success_at timestamptz, last_failure_at timestamptz, schedule text, metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS raw_source_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id text NOT NULL REFERENCES sources(id),
 external_id text, source_url text NOT NULL, title text, content text NOT NULL, language text,
 published_at timestamptz, retrieved_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL,
 processing_status text NOT NULL DEFAULT 'collected' CHECK(processing_status IN ('collected','parsed','geocoded','normalized','duplicate','rejected','published','failed')),
 processing_error text, metadata jsonb NOT NULL DEFAULT '{}', UNIQUE(source_id,content_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_external_id ON raw_source_items(source_id,external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS incidents (
 id text PRIMARY KEY, category text NOT NULL CHECK(category IN ('violence','theft','robbery','fraud','drugs','weapons','traffic','fire','other')),
 occurred_at timestamptz, reported_at timestamptz, published_at timestamptz,
 public_location geometry(Point,4326) NOT NULL, location_precision text NOT NULL DEFAULT 'district',
 public_data jsonb NOT NULL, search_text text NOT NULL, confidence double precision NOT NULL DEFAULT 0,
 is_published boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(confidence BETWEEN 0 AND 1), CHECK(jsonb_array_length(public_data->'sources') > 0)
);
CREATE INDEX IF NOT EXISTS incidents_public_spatial ON incidents USING gist(public_location);
CREATE INDEX IF NOT EXISTS incidents_event_date ON incidents((COALESCE(occurred_at,reported_at,published_at)),id) WHERE is_published;
CREATE TABLE IF NOT EXISTS incident_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),incident_id text NOT NULL REFERENCES incidents(id),source_id text NOT NULL REFERENCES sources(id),
 source_url text, raw_source_item_id uuid REFERENCES raw_source_items(id), published_at timestamptz, UNIQUE(incident_id,source_id,source_url)
);
-- Private coordinates and original source content are never read by the public repository.
CREATE TABLE IF NOT EXISTS incident_private_locations (
 incident_id text PRIMARY KEY REFERENCES incidents(id),original_location geometry(Point,4326),original_address text
);
CREATE TABLE IF NOT EXISTS geocoding_cache (
 normalized_key text PRIMARY KEY,provider text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS processing_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id text REFERENCES sources(id),raw_source_item_id uuid REFERENCES raw_source_items(id),
 stage text NOT NULL,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
