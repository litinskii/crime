-- Durable outbox: hourly retries and at-least-once delivery cannot lose work.
CREATE TABLE ingestion_tasks (
 id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL REFERENCES sources(id),
 cycle INTEGER NOT NULL,
 step INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('poll','process')),
 created_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done')),
 lease_until INTEGER NOT NULL DEFAULT 0,
 dispatched_at INTEGER,
 UNIQUE(source_id,cycle,step)
);
CREATE INDEX ingestion_task_outbox ON ingestion_tasks(status,dispatched_at,lease_until);
CREATE INDEX ingestion_task_budget ON ingestion_tasks(kind,created_at);
