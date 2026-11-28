CREATE UNIQUE INDEX report_public_view_user ON tokentracker_public_views(user_id);
CREATE TABLE tokentracker_anticheat_config (key TEXT PRIMARY KEY,value REAL NOT NULL,note TEXT) STRICT;
CREATE TABLE tokentracker_anticheat_run_state (id INTEGER PRIMARY KEY CHECK(id=1),last_completed_at TEXT,
 last_queue_changed_at TEXT,last_response_completed_at TEXT) STRICT;
INSERT INTO tokentracker_anticheat_run_state (id) VALUES (1);
INSERT INTO tokentracker_anticheat_config(key,value) VALUES
 ('circuit_breaker_users',3),('exclude_cohort_ratio',10),('exclude_peak_hard',12000000000),
 ('exclude_peak_soft',5000000000),('exclude_ratio',50),('exclude_split_bucket_count',6),('lookback_days',1),
 ('review_day_total',20000000000),('review_peak',3000000000),('review_peak_share',0.5),('review_ratio',10);
CREATE TRIGGER report_flags_new AFTER INSERT ON tokentracker_leaderboard_anomaly_flags BEGIN
 UPDATE tokentracker_anticheat_run_state SET last_queue_changed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1;
END;
CREATE TRIGGER report_flags_updated AFTER UPDATE OF status ON tokentracker_leaderboard_anomaly_flags BEGIN
 UPDATE tokentracker_anticheat_run_state SET last_queue_changed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1;
END;
CREATE TRIGGER report_flags_deleted AFTER DELETE ON tokentracker_leaderboard_anomaly_flags BEGIN
 UPDATE tokentracker_anticheat_run_state SET last_queue_changed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1;
END;
CREATE TABLE tokentracker_hourly_quarantine (
 user_id TEXT, device_id TEXT, source TEXT, model TEXT, hour_start TEXT, input_tokens INTEGER,cached_input_tokens INTEGER,
 cache_creation_input_tokens INTEGER,output_tokens INTEGER,reasoning_output_tokens INTEGER,total_tokens INTEGER,billable_total_tokens INTEGER,
 conversations INTEGER,created_at TEXT,updated_at TEXT,total_cost_usd TEXT,quarantined_at TEXT,quarantine_reason TEXT
) STRICT;
CREATE TABLE tokentracker_model_aliases (id INTEGER PRIMARY KEY,usage_model TEXT,canonical_model TEXT,effective_from TEXT,created_at TEXT) STRICT;
