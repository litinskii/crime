ALTER TABLE sources ADD COLUMN last_attempt_at TEXT;
ALTER TABLE sources ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_error TEXT;
CREATE INDEX IF NOT EXISTS sources_due ON sources(next_attempt_at,lease_until);
CREATE INDEX IF NOT EXISTS raw_queue ON raw_source_items(source_id,status,retrieved_at);
