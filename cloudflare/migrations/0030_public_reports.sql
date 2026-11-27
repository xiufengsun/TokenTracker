CREATE TABLE IF NOT EXISTS tokentracker_leaderboard_snapshots (
 user_id TEXT NOT NULL, period TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL,
 rank INTEGER NOT NULL, gpt_tokens INTEGER, claude_tokens INTEGER, other_tokens INTEGER,
 total_tokens INTEGER, display_name TEXT, avatar_url TEXT, is_public INTEGER CHECK(is_public IN(0,1)),
 generated_at TEXT NOT NULL, gemini_tokens INTEGER,cursor_tokens INTEGER,opencode_tokens INTEGER,
 openclaw_tokens INTEGER,estimated_cost_usd TEXT,hermes_tokens INTEGER,kiro_tokens INTEGER,
 copilot_tokens INTEGER,kimi_tokens INTEGER,github_url TEXT,
 PRIMARY KEY(period, from_day, to_day, user_id)
) STRICT;
CREATE INDEX IF NOT EXISTS snapshot_rank ON tokentracker_leaderboard_snapshots(period,from_day,to_day,rank);
CREATE INDEX IF NOT EXISTS snapshot_recent ON tokentracker_leaderboard_snapshots(period,to_day DESC);
CREATE INDEX IF NOT EXISTS snapshot_user ON tokentracker_leaderboard_snapshots(user_id,generated_at DESC);

CREATE TABLE IF NOT EXISTS tokentracker_user_settings (
 user_id TEXT PRIMARY KEY, leaderboard_public INTEGER NOT NULL DEFAULT 0, leaderboard_anonymous INTEGER NOT NULL DEFAULT 0,
 display_name TEXT,avatar_url TEXT,github_url TEXT,show_github_url INTEGER NOT NULL DEFAULT 0,profile_likes INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
) STRICT;

CREATE VIEW IF NOT EXISTS tokentracker_user_profiles AS
  SELECT a.id AS user_id,
    COALESCE(s.display_name,json_extract(a.profile,'$.name'),substr(a.email,1,instr(a.email,'@')-1)) AS display_name,
    COALESCE(s.avatar_url,json_extract(a.profile,'$.avatar_url')) AS avatar_url
  FROM tt_auth_accounts a LEFT JOIN tokentracker_user_settings s ON s.user_id=a.id;
CREATE TABLE IF NOT EXISTS tokentracker_badge_catalog (
 badge_id TEXT PRIMARY KEY,sort_order INTEGER NOT NULL,lower_is_better INTEGER NOT NULL,
 bronze REAL NOT NULL,silver REAL NOT NULL,gold REAL NOT NULL,diamond REAL NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tokentracker_user_badges (
 user_id TEXT NOT NULL,badge_id TEXT NOT NULL,tier INTEGER NOT NULL,metric_value REAL,meta TEXT,
 bronze_at TEXT,silver_at TEXT,gold_at TEXT,diamond_at TEXT,updated_at TEXT,
 bronze_no INTEGER,silver_no INTEGER,gold_no INTEGER,diamond_no INTEGER,
 PRIMARY KEY(user_id,badge_id)
) STRICT;
CREATE TABLE IF NOT EXISTS tokentracker_device_skill_inventories (
 user_id TEXT NOT NULL,device_id TEXT NOT NULL,skills TEXT NOT NULL CHECK(json_valid(skills)),
 scanned_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,device_id)
) STRICT;
