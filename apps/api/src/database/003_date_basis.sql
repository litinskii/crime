-- Separate indexed event and publication queries; occurred_at also stores
-- date-only events at UTC midnight without asserting a known event time.
CREATE INDEX IF NOT EXISTS incidents_actual_date ON incidents(occurred_at DESC,id) WHERE is_published;
CREATE INDEX IF NOT EXISTS incidents_publication_date ON incidents(published_at DESC,id) WHERE is_published;
ALTER TABLE incident_sources ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE incident_sources ADD COLUMN IF NOT EXISTS event_date timestamptz;
ALTER TABLE incident_sources ADD COLUMN IF NOT EXISTS event_data jsonb;
UPDATE incident_sources s SET active=false WHERE EXISTS(SELECT 1 FROM incidents i WHERE i.id=s.incident_id AND NOT i.is_published)
 OR EXISTS(SELECT 1 FROM raw_source_items r WHERE r.id=s.raw_source_item_id AND r.processing_status IN ('review','rejected'));
UPDATE incident_sources s SET event_date=i.occurred_at,
 event_data=jsonb_build_object('occurredAt',i.public_data->'occurredAt','occurredOn',i.public_data->'occurredOn','eventDateEvidence',i.public_data->'eventDateEvidence')
 FROM incidents i WHERE i.id=s.incident_id AND s.active AND s.event_data IS NULL AND i.occurred_at IS NOT NULL
 AND (i.public_data->'eventDateEvidence'->>'sourceUrl'=s.source_url OR (i.public_data->'eventDateEvidence'->>'sourceUrl' IS NULL AND (SELECT COUNT(*) FROM incident_sources x WHERE x.incident_id=i.id AND x.active)=1));
CREATE INDEX IF NOT EXISTS incident_source_support ON incident_sources(incident_id,active,source_url);
