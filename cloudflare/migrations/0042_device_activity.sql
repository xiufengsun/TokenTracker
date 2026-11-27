ALTER TABLE tokentracker_devices ADD COLUMN last_seen_at TEXT;
ALTER TABLE tokentracker_device_tokens ADD COLUMN last_sync_at TEXT;
ALTER TABLE tokentracker_device_tokens ADD COLUMN last_used_at TEXT;
