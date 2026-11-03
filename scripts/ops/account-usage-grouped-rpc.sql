-- Server-side aggregation for the cross-device account view.
--
-- Motivation: each tokentracker-account-* edge function used to fetch raw
-- tokentracker_hourly rows in 1000-row PostgREST pages and aggregate them in
-- the edge. Measured cost is ~300-600ms PER 1000-row page (PostgREST round-trip
-- + JSON serialization of 1000 rows), NOT the DB scan (which is ~7ms, indexed).
-- A heavy user's 52-week heatmap spanned ~7 pages (~3.2s) and every other
-- account-* function re-paginated its own range on top of that.
--
-- This function does the GROUP BY in Postgres and returns a SINGLE jsonb row
-- (jsonb_agg), which sidesteps PostgREST's 1000-row response cap entirely: one
-- round-trip, no pagination. The heaviest real user's 52-week heatmap dropped
-- from ~3.2s to ~137ms server-side. tz-local bucketing uses `AT TIME ZONE`
-- (same IANA tz database as the old JS Intl.DateTimeFormat path, including DST
-- — verified against the old functions across Asia/Shanghai, America/New_York
-- spanning a spring-forward, and a fixed UTC offset).
--
-- CROSS-DEVICE SEMANTIC (GitHub Discussion #101) — two source classes:
--   * MACHINE-LEVEL sources (claude/codex/gemini/...) come from each machine's
--     LOCAL logs. Pick ONE canonical row per (hour, source, model) across the
--     user's ACTIVE devices (largest total_tokens wins) rather than summing.
--     One physical machine drifts across multiple device_ids (unstable
--     fingerprint, name-family splits, replay), and summing those double-counts
--     (issue #187). Whole-row dedup on the cumulative per-(hour,model) snapshot
--     is immune to that. The cost: two genuinely distinct machines running the
--     SAME model in the SAME half-hour count once, not summed — rare, and far
--     better than the systemic ~2x that fold-then-SUM produced.
--   * ACCOUNT-LEVEL sources (cursor, trae-cn) come from a per-ACCOUNT cloud
--     API, NOT machine logs, so SUMming across devices multiplies one
--     account's usage by its device count (the v0.42.0 double-count bug).
--     Dedup, do not add. HOW to dedup depends on the source's identity:
--       - cursor rows are identical across devices (no session identity):
--         the legacy whole-row per-(hour, model) MAX pick below.
--       - trae-cn is a CORRECTABLE snapshot: totals can be revised down, a
--         session can move to another model or another half-hour. Hour-level
--         dedup cannot express that (a fresh device's first data bucket
--         cannot safely displace earlier hours), so trae-cn aggregates from
--         tokentracker_account_session_states - ONE canonical row per
--         (user, source, session_id), whole-row-replaced on every change by
--         the LWW upsert (tokentracker_upsert_account_session_states).
--         Downward / model / bucket corrections all collapse into that one
--         replace; cross-device duplication collapses because device_id is
--         NOT part of the identity. Absence never deletes (contract NOT
--         PROVEN). Mirrored by src/lib/account-usage-dedup.js (executable
--         spec; semantics pinned by test/account-usage-dedup.test.js).
-- DEPLOYMENT: this function reads tokentracker_account_session_states —
-- apply the account-session-states migration BEFORE this updated RPC.
-- The account-level source list MUST stay in sync with ACCOUNT_LEVEL_SOURCES in
-- src/lib/source-metadata.js (parity asserted by test/account-source-parity.test.js).
--
-- Whole-row (not per-column MAX) canonical pick: a per-column MAX would synth a
-- row that never existed and inflate cost, which is derived from the individual
-- token columns (src/lib/pricing computeRowCost), not total_tokens. DISTINCT ON
-- keeps the columns of one real row internally consistent.
--
-- Hour-grain dedup BEFORE tz bucketing: account-level data is per-hour, so the
-- canonical pick happens at the raw hour_start grain; only then is it truncated
-- to the tz-local hour/day/month. Deduping at a coarser (e.g. daily) bucket
-- would collapse many real hours into one and under-count.
--
-- SECURITY INVOKER (the default): runs with the caller's privileges, so it
-- never exposes more than a direct SELECT on tokentracker_hourly would. The
-- edge functions call it with the service-role token AFTER verifying the user's
-- JWT and resolving p_user_id / p_device_ids server-side.
--
-- Determinism (Codex review): jsonb_agg is ordered by (bucket, source, model)
-- so the array — and therefore the model-breakdown `sources` ordering and the
-- per-bucket `models` object key order built in the edge — is stable across
-- query plans, mirroring the old `.order("hour_start")` behavior.
--
-- Invalid timezone (Codex review): an unrecognized p_tz would make
-- `AT TIME ZONE p_tz` raise and 500 the endpoint. The old JS caught the
-- Intl.DateTimeFormat throw and fell back to the offset. The tzr CTE validates
-- p_tz against pg_timezone_names once; an unknown zone falls back to
-- p_offset_min, then UTC — matching the old precedence.
--
-- p_trunc: 'hour' | 'day' | 'month' | 'none' (none = group by source+model only)
-- p_tz:    IANA zone (e.g. 'Asia/Shanghai') or NULL
-- p_offset_min: fallback minutes east of UTC when p_tz is NULL/invalid (monthly
--               passes both NULL to bucket by UTC, matching the old slice).
--
-- Idempotent (CREATE OR REPLACE). Rollback: DROP FUNCTION account_usage_grouped.

CREATE OR REPLACE FUNCTION account_usage_grouped(
  p_user_id uuid,
  p_device_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min int
) RETURNS jsonb
LANGUAGE sql STABLE
AS $func$
  WITH tzr AS (
    -- Validate p_tz once; fall back to offset/UTC on an unknown zone instead of
    -- raising (mirrors the old JS Intl.DateTimeFormat try/catch fallback).
    SELECT CASE
             WHEN p_tz IS NOT NULL AND p_tz <> ''
                  AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz)
             THEN p_tz
             ELSE NULL
           END AS tz
  ),
  -- Account-level source list — keep in sync with src/lib/source-metadata.js.
  cfg AS (
    SELECT ARRAY['cursor', 'trae-cn']::text[] AS account_sources
  ),
  -- Read the large per-user hourly slice once. Machine-level and Cursor
  -- canonicalization below rescan only this bounded materialized result.
  base AS MATERIALIZED (
    SELECT
      h.device_id, h.hour_start, h.source, h.model,
      h.total_tokens::bigint                AS total_tokens,
      h.input_tokens::bigint                AS input_tokens,
      h.output_tokens::bigint               AS output_tokens,
      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens,
      h.conversations::bigint               AS conversations,
      h.updated_at
    FROM tokentracker_hourly h CROSS JOIN cfg
    WHERE h.user_id = p_user_id
      AND h.hour_start >= p_from
      AND h.hour_start < p_to
      AND (
        h.source = 'cursor'
        OR (
          NOT (h.source = ANY(cfg.account_sources))
          AND h.device_id = ANY(p_device_ids)
        )
      )
  ),
  -- Stage 1: canonicalize to the raw hour grain.
  hourly AS (
    -- Machine-level: ONE canonical whole row per (hour, source, model) across
    -- the user's ACTIVE devices, taking the row with the largest total_tokens
    -- (newest-wins on ties) -- the SAME dedup as the account-level branch below,
    -- only the source/device filters differ.
    --
    -- One physical machine accumulates several device_ids over time: identity
    -- drift (no-suffix name -> "#suffix" -> machine_id anchor), an UNSTABLE
    -- hardware fingerprint minting a fresh id (sandbox vs CLI username, or
    -- ioreg/reg failure -> randomUUID), the CLI vs dashboard name families that
    -- never adopt each other, plus PR #184's full-history replay. The previous
    -- fold-then-SUM only collapsed rows BYTE-IDENTICAL across all six token
    -- columns, so a machine whose duplicate devices diverged by even one
    -- boundary hour (different sync offsets) double-counted -- the 2026-06 "2x
    -- token" reports (issue #187). Keying the canonical pick on the cumulative
    -- per-(hour,model) snapshot instead of device identity is immune to every
    -- split mode and needs no historical backfill.
    --
    -- Trade-off vs Discussion #101's "two real machines sum": genuinely distinct
    -- machines that ran the SAME model in the SAME half-hour bucket now count
    -- once (the larger snapshot) instead of summing. That collision is rare
    -- (distinct machines rarely hit an identical model+half-hour), and measured
    -- against real heavy multi-machine users it lands far closer to truth than
    -- the systemic ~2x the fold-then-SUM produced.
    -- WITHIN each machine CLUSTER pick ONE canonical whole row per
    -- (hour, source, model) [largest total_tokens], THEN SUM across clusters.
    -- A physical machine's device-id splits (identity drift / replay / a CLI +
    -- dashboard reading the same logs out of sync) share a cluster -> deduped to
    -- the max (no inflation). Two GENUINELY distinct machines fall in separate
    -- clusters -> summed (issue #187 fix that doesn't lose real multi-machine
    -- usage). Cluster membership is precomputed in tokentracker_device_machine by
    -- VALUE consistency (equal/covered overlap = same machine; concurrent
    -- independent values = distinct). Devices absent from that table cluster as
    -- themselves (device_id), so a lone device sums as one cluster.
    -- Emit ONE canonical whole row per (machine_cluster, hour, source, model).
    -- The cluster is in DISTINCT ON / ORDER BY but NOT selected, so same-machine
    -- device-id splits collapse to one row (max) while distinct machines emit one
    -- row each on the same (hour,source,model). Stage-2 `grouped` SUMs them by
    -- (bucket,source,model) -> within-cluster max, cross-cluster sum, in one pass
    -- (no extra GROUP BY here -- the whole-history leaderboard variant 502s with
    -- a second aggregation pass).
    SELECT mac.hour_start, mac.source, mac.model,
      mac.total_tokens, mac.input_tokens, mac.output_tokens,
      mac.cached_input_tokens, mac.cache_creation_input_tokens,
      mac.reasoning_output_tokens, mac.conversations
    FROM (
      SELECT DISTINCT ON (COALESCE(dm.machine_cluster_id, h.device_id::text), h.hour_start, h.source, h.model)
        h.hour_start, h.source, h.model,
        h.total_tokens::bigint                AS total_tokens,
        h.input_tokens::bigint                AS input_tokens,
        h.output_tokens::bigint               AS output_tokens,
        h.cached_input_tokens::bigint         AS cached_input_tokens,
        h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
        h.reasoning_output_tokens::bigint     AS reasoning_output_tokens,
        h.conversations::bigint               AS conversations
      FROM base h
      LEFT JOIN tokentracker_device_machine dm ON dm.device_id = h.device_id
      WHERE h.source NOT IN ('cursor', 'trae-cn')
        AND h.device_id = ANY(p_device_ids)
      ORDER BY COALESCE(dm.machine_cluster_id, h.device_id::text),
               h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) mac

    UNION ALL

    -- 'cursor' (account-level, no session identity): rows are identical
    -- across devices, so the legacy whole-row MAX pick per
    -- (hour, source, model) dedups them. NOT active-device-filtered:
    -- account truth follows the account, not which device last synced.
    SELECT d.hour_start, d.source, d.model,
      d.total_tokens, d.input_tokens, d.output_tokens,
      d.cached_input_tokens, d.cache_creation_input_tokens,
      d.reasoning_output_tokens, d.conversations
    FROM (
      SELECT DISTINCT ON (h.hour_start, h.source, h.model)
        h.hour_start, h.source, h.model,
        h.total_tokens::bigint                AS total_tokens,
        h.input_tokens::bigint                AS input_tokens,
        h.output_tokens::bigint               AS output_tokens,
        h.cached_input_tokens::bigint         AS cached_input_tokens,
        h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
        h.reasoning_output_tokens::bigint     AS reasoning_output_tokens,
        h.conversations::bigint               AS conversations
      FROM base h
      WHERE h.source = 'cursor'
      ORDER BY h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) d

    UNION ALL

    -- trae-cn: canonical account truth from session states (one row per
    -- session after the LWW upsert). NOT active-device-filtered.
    SELECT s.bucket_start AS hour_start, s.source, s.model,
      SUM(s.total_tokens)::bigint                AS total_tokens,
      SUM(s.input_tokens)::bigint                AS input_tokens,
      SUM(s.output_tokens)::bigint               AS output_tokens,
      SUM(s.cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(s.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(s.reasoning_output_tokens)::bigint     AS reasoning_output_tokens,
      COUNT(*)::bigint                           AS conversations
    FROM tokentracker_account_session_states s
    WHERE s.user_id = p_user_id
      AND s.bucket_start >= p_from
      AND s.bucket_start <  p_to
      AND s.source = 'trae-cn'
    GROUP BY s.bucket_start, s.source, s.model
  ),
  -- Stage 2: bucket the canonical hour rows to tz-local trunc, then aggregate.
  loc AS (
    SELECT
      CASE p_trunc
        WHEN 'hour'  THEN to_char(date_trunc('hour',  lt.local_ts), 'YYYY-MM-DD"T"HH24:00:00')
        WHEN 'day'   THEN to_char(date_trunc('day',   lt.local_ts), 'YYYY-MM-DD')
        WHEN 'month' THEN to_char(date_trunc('month', lt.local_ts), 'YYYY-MM')
        ELSE ''
      END AS bucket,
      hourly.source, hourly.model,
      CASE
        -- '%deepseek-v4-flash%' does not match deepseek-v4.1-flash (the ".1"
        -- breaks the substring run). deepseek-v4.1-flash is the OpenRouter /
        -- Command Code / WorkBuddy id and bare deepseek-flash its app-facing
        -- alias; both ride the same peak/off-peak calendar (#1010).
        WHEN lower(hourly.model) LIKE '%deepseek-v4-flash%'
          OR lower(hourly.model) LIKE '%deepseek-v4.1-flash%'
          OR lower(hourly.model) LIKE '%deepseek-flash%'
          OR lower(hourly.model) LIKE '%deepseek-v4-pro%'
        THEN CASE
          WHEN extract(hour FROM hourly.hour_start AT TIME ZONE 'UTC') >= 1
               AND extract(hour FROM hourly.hour_start AT TIME ZONE 'UTC') < 4
            OR extract(hour FROM hourly.hour_start AT TIME ZONE 'UTC') >= 6
               AND extract(hour FROM hourly.hour_start AT TIME ZONE 'UTC') < 10
          THEN 'peak' ELSE 'off_peak'
        END
        ELSE 'peak'
      END AS pricing_tier,
      hourly.total_tokens, hourly.input_tokens, hourly.output_tokens,
      hourly.cached_input_tokens, hourly.cache_creation_input_tokens,
      hourly.reasoning_output_tokens, hourly.conversations
    FROM hourly CROSS JOIN tzr
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN tzr.tz IS NOT NULL THEN (hourly.hour_start AT TIME ZONE tzr.tz)
               WHEN p_offset_min IS NOT NULL THEN ((hourly.hour_start AT TIME ZONE 'UTC') + make_interval(mins => p_offset_min))
               ELSE (hourly.hour_start AT TIME ZONE 'UTC')
             END AS local_ts
    ) lt
  ),
  grouped AS (
    SELECT
      bucket, source, model, pricing_tier,
      SUM(total_tokens)::bigint                AS total_tokens,
      SUM(input_tokens)::bigint                AS input_tokens,
      SUM(output_tokens)::bigint               AS output_tokens,
      SUM(cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint     AS reasoning_output_tokens,
      SUM(conversations)::bigint               AS conversations
    FROM loc
    GROUP BY bucket, source, model, pricing_tier
  )
  SELECT COALESCE(
           jsonb_agg(to_jsonb(grouped.*) ORDER BY grouped.bucket, grouped.source, grouped.model, grouped.pricing_tier),
           '[]'::jsonb
         )
  FROM grouped
$func$;
