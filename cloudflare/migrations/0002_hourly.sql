CREATE TABLE IF NOT EXISTS tokentracker_hourly (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'unknown',
  hour_start TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  billable_total_tokens INTEGER,
  conversations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  total_cost_usd TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (user_id, device_id, source, model, hour_start)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tokentracker_hourly_updated ON tokentracker_hourly(updated_at);
CREATE INDEX IF NOT EXISTS tokentracker_hourly_user_hour ON tokentracker_hourly(user_id, hour_start);
CREATE INDEX IF NOT EXISTS tokentracker_hourly_total ON tokentracker_hourly(total_tokens);
CREATE INDEX IF NOT EXISTS tokentracker_hourly_hour ON tokentracker_hourly(hour_start);
CREATE INDEX IF NOT EXISTS tokentracker_hourly_deepseek_hour ON tokentracker_hourly(hour_start,user_id,device_id,source,model)
  WHERE instr(lower(model),'deepseek-v4-flash') > 0 OR instr(lower(model),'deepseek-v4-pro') > 0;
