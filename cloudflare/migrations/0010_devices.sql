CREATE TABLE tokentracker_devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_name TEXT NOT NULL,
  platform TEXT, machine_id TEXT, revoked_at TEXT, name_customized INTEGER NOT NULL DEFAULT 0,
  default_device_name TEXT, created_at TEXT NOT NULL,
  UNIQUE (user_id, id)
) STRICT;
CREATE UNIQUE INDEX tokentracker_devices_machine_unique ON tokentracker_devices(user_id,machine_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX tokentracker_devices_active_unique ON tokentracker_devices(user_id,platform,device_name) WHERE revoked_at IS NULL;
CREATE TABLE tokentracker_device_machine (
  device_id TEXT PRIMARY KEY REFERENCES tokentracker_devices(id) ON DELETE CASCADE,
  machine_cluster_id TEXT NOT NULL
) STRICT;
CREATE TABLE tokentracker_device_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT, created_at TEXT NOT NULL, cloud_environment TEXT NOT NULL CHECK(cloud_environment IN ('live','sandbox')),
  FOREIGN KEY(user_id,device_id) REFERENCES tokentracker_devices(user_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tokentracker_device_tokens_active ON tokentracker_device_tokens(device_id,cloud_environment) WHERE revoked_at IS NULL;
CREATE TABLE tokentracker_device_codes (
  device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','used','expired')),
  user_id TEXT, expires_at TEXT NOT NULL, approved_at TEXT, client_info TEXT, machine_id TEXT,
  created_at TEXT NOT NULL, cloud_environment TEXT NOT NULL CHECK(cloud_environment IN ('live','sandbox'))
) STRICT;
CREATE INDEX tokentracker_device_codes_expiry ON tokentracker_device_codes(expires_at);
CREATE TABLE tokentracker_cloud_machines (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('live','sandbox')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','merged')), merged_into TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT, last_upload_at TEXT, upload_window_until TEXT,
  upload_token_id TEXT, upload_id TEXT, upload_batch_count INTEGER NOT NULL DEFAULT 0 CHECK(upload_batch_count >= 0),
  UNIQUE(user_id,environment,id),
  FOREIGN KEY(user_id,environment,merged_into) REFERENCES tokentracker_cloud_machines(user_id,environment,id),
  CHECK ((status='merged') = (merged_into IS NOT NULL))
) STRICT;
CREATE TABLE tokentracker_cloud_machine_aliases (
  user_id TEXT NOT NULL, environment TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('device','machine','cluster')),
  alias TEXT NOT NULL, machine_id TEXT NOT NULL, PRIMARY KEY(user_id,environment,kind,alias),
  FOREIGN KEY(user_id,environment,machine_id) REFERENCES tokentracker_cloud_machines(user_id,environment,id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX tokentracker_cloud_machine_aliases_slot_idx ON tokentracker_cloud_machine_aliases(user_id,environment,machine_id);
CREATE TABLE tokentracker_account_session_states (
  user_id TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL,
  bucket_start TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  reasoning_output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
  snapshot_verified_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,source,session_id),
  CHECK(total_tokens = input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens),
  CHECK(min(input_tokens,cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens)>=0)
) STRICT, WITHOUT ROWID;
CREATE INDEX tokentracker_account_session_states_bucket_idx ON tokentracker_account_session_states(user_id,source,bucket_start);
-- The guard row exists only inside one D1 batch. A stale read aborts all its writes.
CREATE TABLE device_write_guard (
  id INTEGER PRIMARY KEY CHECK(id=1),
  valid INTEGER NOT NULL CONSTRAINT device_snapshot_changed CHECK(valid=1)
) STRICT;
