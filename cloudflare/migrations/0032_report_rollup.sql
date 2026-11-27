CREATE TABLE tokentracker_leaderboard_anomaly_flags (
 user_id TEXT NOT NULL, day TEXT NOT NULL, peak_tokens INTEGER,day_tokens INTEGER,baseline_median REAL,ratio REAL,peak_share REAL,
 cohort_ratio REAL,peak_source TEXT,peak_model TEXT,status TEXT NOT NULL,detected_at TEXT,reviewed_at TEXT,note TEXT,PRIMARY KEY(user_id,day)
) STRICT;
CREATE INDEX report_flags_status ON tokentracker_leaderboard_anomaly_flags(status,user_id);
CREATE TABLE tokentracker_leaderboard_rollup_daily_v2 (
 user_id TEXT NOT NULL,source TEXT NOT NULL,model TEXT NOT NULL,day TEXT NOT NULL,pricing_tier TEXT NOT NULL,
 total_tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_input_tokens INTEGER NOT NULL,
 cache_creation_input_tokens INTEGER NOT NULL,reasoning_output_tokens INTEGER NOT NULL,
 PRIMARY KEY(day,user_id,source,model,pricing_tier)
) STRICT, WITHOUT ROWID;
CREATE INDEX report_rollup_user ON tokentracker_leaderboard_rollup_daily_v2(user_id,day);
CREATE TABLE report_dirty_days(day TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
CREATE TABLE report_refresh_claim(kind TEXT PRIMARY KEY, started_at TEXT NOT NULL) STRICT;
CREATE TABLE report_model_rates (
 source TEXT NOT NULL, model TEXT NOT NULL, pricing_tier TEXT NOT NULL,
 input REAL NOT NULL,output REAL NOT NULL,cached REAL NOT NULL,creation REAL NOT NULL,reasoning REAL NOT NULL,
 PRIMARY KEY(source,model,pricing_tier)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER report_hourly_new AFTER INSERT ON tokentracker_hourly BEGIN
 INSERT INTO report_dirty_days VALUES(substr(NEW.hour_start,1,10)) ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_hourly_changed AFTER UPDATE ON tokentracker_hourly BEGIN
 INSERT INTO report_dirty_days VALUES(substr(OLD.hour_start,1,10)),(substr(NEW.hour_start,1,10)) ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_hourly_deleted AFTER DELETE ON tokentracker_hourly BEGIN
 INSERT INTO report_dirty_days VALUES(substr(OLD.hour_start,1,10)) ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_session_new AFTER INSERT ON tokentracker_account_session_states BEGIN
 INSERT INTO report_dirty_days VALUES(substr(NEW.bucket_start,1,10)) ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_session_changed AFTER UPDATE ON tokentracker_account_session_states BEGIN
 INSERT INTO report_dirty_days VALUES(substr(OLD.bucket_start,1,10)),(substr(NEW.bucket_start,1,10)) ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_session_deleted AFTER DELETE ON tokentracker_account_session_states BEGIN
 INSERT INTO report_dirty_days VALUES(substr(OLD.bucket_start,1,10)) ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_device_revoke AFTER UPDATE OF revoked_at ON tokentracker_devices
WHEN OLD.revoked_at IS NOT NEW.revoked_at BEGIN
 INSERT INTO report_dirty_days SELECT DISTINCT substr(hour_start,1,10) FROM tokentracker_hourly WHERE user_id=NEW.user_id AND device_id=NEW.id ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_device_delete BEFORE DELETE ON tokentracker_devices BEGIN
 INSERT INTO report_dirty_days SELECT DISTINCT substr(hour_start,1,10) FROM tokentracker_hourly WHERE user_id=OLD.user_id AND device_id=OLD.id ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_cluster_new AFTER INSERT ON tokentracker_device_machine BEGIN
 INSERT INTO report_dirty_days SELECT DISTINCT substr(hour_start,1,10) FROM tokentracker_hourly
 WHERE user_id=(SELECT user_id FROM tokentracker_devices WHERE id=NEW.device_id) AND device_id=NEW.device_id ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_cluster_changed AFTER UPDATE OF machine_cluster_id ON tokentracker_device_machine WHEN OLD.machine_cluster_id IS NOT NEW.machine_cluster_id BEGIN
 INSERT INTO report_dirty_days SELECT DISTINCT substr(hour_start,1,10) FROM tokentracker_hourly
 WHERE user_id=(SELECT user_id FROM tokentracker_devices WHERE id=NEW.device_id) AND device_id=NEW.device_id ON CONFLICT(day) DO NOTHING;
END;
CREATE TRIGGER report_cluster_deleted BEFORE DELETE ON tokentracker_device_machine BEGIN
 INSERT INTO report_dirty_days SELECT DISTINCT substr(hour_start,1,10) FROM tokentracker_hourly
 WHERE user_id=(SELECT user_id FROM tokentracker_devices WHERE id=OLD.device_id) AND device_id=OLD.device_id ON CONFLICT(day) DO NOTHING;
END;
INSERT INTO report_dirty_days SELECT DISTINCT substr(hour_start,1,10) FROM tokentracker_hourly WHERE true ON CONFLICT(day) DO NOTHING;
INSERT INTO report_dirty_days SELECT DISTINCT substr(bucket_start,1,10) FROM tokentracker_account_session_states WHERE true ON CONFLICT(day) DO NOTHING;
