-- Migration 038 froze only album-eligible structured events. Force every
-- published calendar to create a new generation whose structured projection
-- covers the same authoritative event set as its ICS body.
UPDATE event_calendar_publication_generations
SET requested_generation = requested_generation + 1,
    lease_token = NULL,
    lease_generation = NULL,
    lease_expires_at = NULL,
    failure_count = 0,
    next_attempt_at = NULL,
    document_generation = NULL,
    document_body = NULL,
    document_sha256 = NULL,
    document_config_fingerprint = NULL,
    document_calendar_json = NULL,
    document_generated_at = NULL,
    document_event_count = NULL,
    document_events_json = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
