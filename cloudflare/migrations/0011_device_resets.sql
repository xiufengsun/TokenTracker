CREATE TABLE tokentracker_cloud_usage_resets (
  operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('live','sandbox')),
  device_id TEXT NOT NULL, machine_id TEXT NOT NULL,
  device_ids TEXT NOT NULL CHECK(json_valid(device_ids)),
  affected_days TEXT NOT NULL CHECK(json_valid(affected_days)),
  removed_rows INTEGER NOT NULL CHECK(removed_rows>=0),
  status TEXT NOT NULL CHECK(status IN ('reset','complete')),
  reset_at TEXT NOT NULL, completed_at TEXT,
  FOREIGN KEY(user_id,device_id) REFERENCES tokentracker_devices(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,environment,machine_id) REFERENCES tokentracker_cloud_machines(user_id,environment,id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX tt_reset_pending ON tokentracker_cloud_usage_resets(user_id,environment,machine_id) WHERE status='reset';
CREATE INDEX tt_reset_owner ON tokentracker_cloud_usage_resets(user_id);
