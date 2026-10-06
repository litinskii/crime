CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, metadata TEXT NOT NULL,
 last_success_at TEXT, last_failure_at TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ingestion_runs (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), status TEXT NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT, counts TEXT NOT NULL DEFAULT '{}', error TEXT
);
CREATE TABLE IF NOT EXISTS raw_source_items (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), external_id TEXT NOT NULL,
 source_url TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, published_at TEXT,
 retrieved_at TEXT NOT NULL, content_hash TEXT NOT NULL, rules TEXT NOT NULL,
 canonical_url TEXT, status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(source_id,external_id)
);
CREATE INDEX IF NOT EXISTS raw_source_hash ON raw_source_items(source_id,content_hash);
CREATE INDEX IF NOT EXISTS raw_retention ON raw_source_items(retrieved_at);
CREATE INDEX IF NOT EXISTS raw_queue ON raw_source_items(source_id,status,retrieved_at);
CREATE TABLE IF NOT EXISTS raw_source_item_versions (
 raw_id TEXT NOT NULL REFERENCES raw_source_items(id), content_hash TEXT NOT NULL,
 title TEXT NOT NULL, content TEXT NOT NULL, published_at TEXT, retrieved_at TEXT NOT NULL,
 PRIMARY KEY(raw_id,content_hash)
);
CREATE TABLE IF NOT EXISTS incidents (
 id TEXT PRIMARY KEY, category TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
 effective_date INTEGER NOT NULL, published_at TEXT NOT NULL, city TEXT NOT NULL,
 public_data TEXT NOT NULL CHECK(json_valid(public_data)), search_text TEXT NOT NULL,
 canonical_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, is_published INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS public_date ON incidents(is_published,effective_date DESC,id);
CREATE INDEX IF NOT EXISTS public_bounds ON incidents(is_published,latitude,longitude);
CREATE INDEX IF NOT EXISTS public_category ON incidents(is_published,category,effective_date);
CREATE INDEX IF NOT EXISTS incident_fingerprint ON incidents(fingerprint);
CREATE TABLE IF NOT EXISTS incident_sources (
 incident_id TEXT NOT NULL REFERENCES incidents(id), raw_id TEXT NOT NULL REFERENCES raw_source_items(id),
 source_url TEXT NOT NULL, PRIMARY KEY(incident_id,source_url)
);
CREATE TABLE IF NOT EXISTS geocoding_cache (
 place_key TEXT PRIMARY KEY, provider TEXT NOT NULL, result TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_jobs (
 id TEXT PRIMARY KEY, raw_id TEXT NOT NULL REFERENCES raw_source_items(id), stage TEXT NOT NULL,
 status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, reason TEXT, created_at TEXT NOT NULL
);
