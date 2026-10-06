ALTER TABLE sources ADD COLUMN last_processed_at TEXT;
ALTER TABLE sources ADD COLUMN processing_error TEXT;
ALTER TABLE sources ADD COLUMN next_process_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'poll';
ALTER TABLE raw_source_items ADD COLUMN first_seen_at TEXT;
ALTER TABLE raw_source_items ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
UPDATE raw_source_items SET first_seen_at=retrieved_at;
CREATE INDEX raw_pending_age ON raw_source_items(source_id,status,first_seen_at);
ALTER TABLE incident_sources ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
UPDATE incident_sources SET active=0
 WHERE incident_id IN (SELECT id FROM incidents WHERE is_published=0)
 OR raw_id IN (SELECT id FROM raw_source_items WHERE status IN ('review','rejected'));
CREATE INDEX incident_source_support ON incident_sources(incident_id,active,source_url);
CREATE INDEX incident_source_raw ON incident_sources(raw_id,incident_id);
ALTER TABLE incidents ADD COLUMN event_date INTEGER;
ALTER TABLE incidents ADD COLUMN publication_date INTEGER;
UPDATE incidents SET
 event_date=CAST(strftime('%s',COALESCE(json_extract(public_data,'$.occurredAt'),json_extract(public_data,'$.occurredOn'))) AS INTEGER)*1000 + CAST(substr(strftime('%f',COALESCE(json_extract(public_data,'$.occurredAt'),json_extract(public_data,'$.occurredOn'))),4,3) AS INTEGER),
 publication_date=CAST(strftime('%s',published_at) AS INTEGER)*1000 + CAST(substr(strftime('%f',published_at),4,3) AS INTEGER);
ALTER TABLE incident_sources ADD COLUMN event_date INTEGER;
ALTER TABLE incident_sources ADD COLUMN event_data TEXT;
ALTER TABLE incident_sources ADD COLUMN publication_date INTEGER;
ALTER TABLE incident_sources ADD COLUMN published_at TEXT;
UPDATE incident_sources SET published_at=(SELECT published_at FROM raw_source_items WHERE id=raw_id);
UPDATE incident_sources SET publication_date=CAST(strftime('%s',published_at) AS INTEGER)*1000 + CAST(substr(strftime('%f',published_at),4,3) AS INTEGER);
-- Older rows can only attribute proof when its source URL is known, or when
-- there is exactly one supporting original. Do not assign it to every repost.
UPDATE incident_sources SET
 event_date=(SELECT event_date FROM incidents WHERE id=incident_id),
 event_data=(SELECT json_object('occurredAt',json_extract(public_data,'$.occurredAt'),'occurredOn',json_extract(public_data,'$.occurredOn'),'eventDateEvidence',json(json_extract(public_data,'$.eventDateEvidence'))) FROM incidents WHERE id=incident_id)
 WHERE active=1 AND EXISTS(SELECT 1 FROM incidents i WHERE i.id=incident_id AND i.event_date IS NOT NULL AND (json_extract(i.public_data,'$.eventDateEvidence.sourceUrl')=source_url OR (json_extract(i.public_data,'$.eventDateEvidence.sourceUrl') IS NULL AND (SELECT COUNT(*) FROM incident_sources x WHERE x.incident_id=i.id AND x.active=1)=1)));
CREATE INDEX incident_event_support ON incident_sources(incident_id,active,event_date);
CREATE INDEX incident_publication_support ON incident_sources(incident_id,active,publication_date);
UPDATE incidents SET
 publication_date=(SELECT MAX(publication_date) FROM incident_sources s WHERE s.incident_id=incidents.id AND s.active=1),
 published_at=(SELECT published_at FROM incident_sources s WHERE s.incident_id=incidents.id AND s.active=1 AND s.publication_date IS NOT NULL ORDER BY s.publication_date DESC,s.source_url LIMIT 1),
 effective_date=COALESCE(event_date,(SELECT MAX(publication_date) FROM incident_sources s WHERE s.incident_id=incidents.id AND s.active=1),effective_date),
 public_data=json_set(public_data,'$.publishedAt',(SELECT published_at FROM incident_sources s WHERE s.incident_id=incidents.id AND s.active=1 AND s.publication_date IS NOT NULL ORDER BY s.publication_date DESC,s.source_url LIMIT 1),'$.reportedAt',(SELECT published_at FROM incident_sources s WHERE s.incident_id=incidents.id AND s.active=1 AND s.publication_date IS NOT NULL ORDER BY s.publication_date DESC,s.source_url LIMIT 1))
 WHERE EXISTS(SELECT 1 FROM incident_sources s WHERE s.incident_id=incidents.id AND s.active=1 AND s.publication_date IS NOT NULL);
CREATE INDEX public_event_date ON incidents(is_published,event_date DESC,id);
CREATE INDEX public_publication_date ON incidents(is_published,publication_date DESC,id);
CREATE INDEX incident_event_candidates ON incidents(category,city,event_date);
CREATE INDEX incident_publication_candidates ON incidents(category,city,publication_date);

-- A forwarding header or corrected publication timestamp is also a new version,
-- even when its text has not changed. Keep the actual content hash separately.
CREATE TABLE raw_source_item_versions_next (
 raw_id TEXT NOT NULL REFERENCES raw_source_items(id), content_hash TEXT NOT NULL,
 version_key TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
 published_at TEXT, retrieved_at TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(raw_id,version_key)
);
INSERT INTO raw_source_item_versions_next(raw_id,content_hash,version_key,title,content,published_at,retrieved_at,metadata)
 SELECT raw_id,content_hash,content_hash || char(31) || COALESCE(published_at,'') || char(31) || title || char(31) || '{}' ,title,content,published_at,retrieved_at,'{}'
 FROM raw_source_item_versions;
DROP TABLE raw_source_item_versions;
ALTER TABLE raw_source_item_versions_next RENAME TO raw_source_item_versions;
CREATE INDEX raw_version_retention ON raw_source_item_versions(retrieved_at);
