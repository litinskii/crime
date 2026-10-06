CREATE INDEX IF NOT EXISTS raw_versions_retention ON raw_source_item_versions(retrieved_at);
CREATE INDEX IF NOT EXISTS jobs_retention ON processing_jobs(created_at);
CREATE INDEX IF NOT EXISTS runs_retention ON ingestion_runs(finished_at);
