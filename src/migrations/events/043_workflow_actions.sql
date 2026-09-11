CREATE TABLE event_workflow_operations (
  operation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edit', 'cancel')),
  input_digest TEXT NOT NULL,
  input_json TEXT NOT NULL,
  guard_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX event_workflow_operations_event ON event_workflow_operations(scope_id, event_id);
