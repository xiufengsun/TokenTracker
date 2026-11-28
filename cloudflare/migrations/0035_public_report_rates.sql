-- The first staging build priced public snapshots with account-report rates.
-- Public rates now match the separately deployed leaderboard version and remain cached until the next pricing migration.
DELETE FROM report_model_rates;
