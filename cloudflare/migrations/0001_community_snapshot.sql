CREATE TABLE IF NOT EXISTS community_snapshot (
  id TEXT PRIMARY KEY CHECK (id = 'total'),
  generated_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (
    json_valid(payload)
    AND json_type(payload, '$.generated_at') IS 'text'
    AND json_extract(payload, '$.generated_at') = generated_at
    AND json_extract(payload, '$.period') IS 'total'
  )
) STRICT;
