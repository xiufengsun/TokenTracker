CREATE TABLE IF NOT EXISTS tokentracker_public_views (
 user_id TEXT NOT NULL, token_hash TEXT PRIMARY KEY, revoked_at TEXT, created_at TEXT NOT NULL,updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS public_view_owner ON tokentracker_public_views(user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS tokentracker_profile_likes (
 id TEXT PRIMARY KEY, target_user_id TEXT NOT NULL,liker_id TEXT NOT NULL,is_authenticated INTEGER NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(target_user_id,liker_id)
) STRICT;
CREATE TABLE IF NOT EXISTS tokentracker_telemetry_daily (
 machine_hash TEXT NOT NULL,day TEXT NOT NULL,app_version TEXT NOT NULL,platform TEXT NOT NULL,shell TEXT NOT NULL,
 first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,PRIMARY KEY(machine_hash,day)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS telemetry_day ON tokentracker_telemetry_daily(day);
