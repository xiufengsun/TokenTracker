# Lifetime leaderboard repair across sparse history (#827)

The repair scheduler rebuilt seven calendar days on each invocation, starting
at the oldest raw `hour_start`. A single epoch-dated upload made a full repair
cycle traverse approximately 56 years. Even at the ten-minute cadence described
in [#472](https://github.com/xiufengsun/TokenTracker/issues/472), that is roughly
three weeks, rather than the promised half-day recovery window.

## Read-only production findings

Investigation for [#827](https://github.com/xiufengsun/TokenTracker/issues/827)
on 2026-11-04 UTC, from repository commit `d6542abf`:

- The deployed advance function matches the calendar-based repair in
  `20260817120000_account-session-states.sql`.
- At `rebuilt_at = 2026-11-04T16:50:00.057Z`, `through` was November 4 but
  `repair_from` was January 29, **1970**. A current closed-day watermark does
  not establish that historical corrections have been repaired.
- Four raw `omp` buckets dated January 1, 1970 exist. Their `updated_at`
  values range from September 18 to October 13, 2026, predating the report.
  The next raw timestamp is June 6, 2008.
- Robin's live account grouping and daily rollup disagree over the **same**
  closed UTC window, `[2025-11-05, 2026-11-04)`:

  | Source | Live minus daily rollup | Differing days |
  | --- | ---: | ---: |
  | Codex | +439,126,609 | 40 |
  | Grok | -212,479,273 | 4 |
  | Zcode | -343,762,883 | 8 |
  | Claude / OpenCode / Ollama | 0 | 0 |

- The current public profile headline already uses the lifetime snapshot
  (`totals.source = leaderboard_snapshot`), so comparing its headline to the
  board no longer independently tests rollup parity. Its provider breakdown
  still uses the activity window. The original 4.17B headline gap is not a
  claim about current values.
- Both profile and leaderboard machine usage select active devices. The
  account RPC's `p_device_ids` is populated by `account_usage_grouped_v2`,
  which filters `revoked_at IS NULL`. The later weekly report's SQL snippet
  alone does not demonstrate a different revocation policy.
- The project-admin connection cannot read `cron.job` (`permission denied
  for schema cron`), so scheduler configuration and execution history were
  not independently verified. No production rows or functions were changed.

## Change and deployment

`20261104165655_skip-empty-leaderboard-repair-spans.sql` seeks the next occupied
closed UTC day before each bounded rebuild. Candidates include raw hourly
usage, TRAE session states, archive manifests (when enabled), and existing daily
rollups. Including the last set ensures that deleted or moved source data still
has its old materialized totals removed. The migration preserves first-seed priority, device deduplication,
old usage, and the seven-calendar-day bound on each rebuild. It also skips
empty spans during bootstrap/catch-up and adds a partial session-bucket index;
production already has the hourly timestamp and daily-rollup day indexes.
The archive manifest's day index supports the cold-day probe without unpacking
archived payloads. The advance function retains the archive scheduler's
`cloud_repair_usage_days(7)` call before any catch-up early return. Its separate
dirty-day work remains bounded to seven days, in addition to the existing
seven-calendar-day catch-up/cyclic rebuild.

Both archive-first and archive-last installation are supported. The sparse
scheduler checks for archive objects at execution time, so it also works before
archiving is enabled. The archive migration's SQL-shape guard recognizes this
archive-aware scheduler and retains its occupied-day seeks; unknown scheduler
shapes still fail migration validation.

Apply this migration through an owner-capable database migration runner.
The existing advance function is owned by `postgres` in production; an ordinary
`project_admin` CLI migration cannot replace that function. The migration does
not change its ownership, recreate the scheduler, or force a full rebuild.
Schedule the index creation with normal database migration care: it is a
transactional, non-concurrent index build on session states.

After deployment, let the existing repair job advance and verify its cursor
jumps across the empty decades. Compare live grouping with daily rollups over
identical closed UTC dates, and daily-rollup sums with the trigger-maintained
total rollup. Allow a complete occupied-history cycle and the subsequent total
snapshot refresh before checking the public board. Remaining discrepancies
need per-day investigation; this fix removes the demonstrated empty-span delay
without asserting that every reported mismatch has the same cause.

## Regression coverage

`test/leaderboard-rollup-sparse-repair.test.js` executes the old and new advance
functions in PGlite with the repository's actual deduplication, daily replacement,
and total-rollup triggers. It reproduces the stale recent total while the old
cursor walks 1970, then verifies recovery, wraparound, idempotency, rollup-only
deletions, revocations, model/bucket moves, per-user seed priority, session-only
bootstrap, UTC boundaries, and the seven-day work limit.
Composition tests apply the full archive and sparse-repair migrations in both
orders, then verify cold-only bootstrap and cyclic recovery without dirty-day
hints, repeated-advance idempotency, and downward cold corrections through the
dirty-day hook even when catch-up returns early. The archive-last case also
executes the sparse scheduler before archive installation on the same connection.
