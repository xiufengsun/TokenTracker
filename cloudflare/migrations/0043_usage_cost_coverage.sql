ALTER TABLE tokentracker_hourly ADD COLUMN cost_coverage TEXT CHECK (
  cost_coverage IS NULL OR (
    (source='grok' OR (source='cursor' AND lower(model) GLOB 'grok-bot-*'))
    AND json_valid(cost_coverage) AND json_extract(cost_coverage,'$.version') IS 1
  )
);
ALTER TABLE tokentracker_leaderboard_rollup_daily_v2 ADD COLUMN cost_provenance TEXT
  CHECK(cost_provenance IS NULL OR json_valid(cost_provenance));
CREATE INDEX report_cost_pending_days ON tokentracker_leaderboard_rollup_daily_v2(day)
  WHERE cost_provenance IS NULL AND (source='grok' OR (source='cursor' AND lower(model) GLOB 'grok-bot-*'));
-- Batch/Flex and previously unknown Cursor Grok Bot models now have distinct fallback rules.
DELETE FROM report_model_rates;
