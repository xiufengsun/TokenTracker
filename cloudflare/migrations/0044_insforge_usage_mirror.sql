-- Retain revisions for deletes too. An older retry must not resurrect a row.
CREATE TABLE IF NOT EXISTS migration_usage_revisions (
  relation TEXT NOT NULL,
  row_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (relation, row_key)
) STRICT, WITHOUT ROWID;
