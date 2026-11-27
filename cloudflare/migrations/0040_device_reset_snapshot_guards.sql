-- A refresh may have started reading the old usage before a device reset.
CREATE TRIGGER tt_device_reset_guard_insert BEFORE INSERT ON tokentracker_leaderboard_snapshots
WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_usage_resets r WHERE r.user_id=NEW.user_id AND
  (r.status='reset' OR julianday(NEW.generated_at) < julianday(COALESCE(r.completed_at,r.reset_at))))
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER tt_device_reset_guard_update BEFORE UPDATE ON tokentracker_leaderboard_snapshots
WHEN EXISTS(SELECT 1 FROM tokentracker_cloud_usage_resets r WHERE r.user_id=NEW.user_id AND
  (r.status='reset' OR julianday(NEW.generated_at) < julianday(COALESCE(r.completed_at,r.reset_at))))
BEGIN SELECT RAISE(IGNORE); END;
