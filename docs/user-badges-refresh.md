# Badge refresh operations

`tokentracker-user-badges-refresh` accepts POST with either
`x-refresh-secret: $LEADERBOARD_REFRESH_SECRET` or a bearer matching the
server's `INSFORGE_SERVICE_ROLE_KEY`. It executes exactly
`SELECT public.user_badges_refresh_v2() AS result`; request bodies and query
parameters cannot supply SQL. Anonymous and ordinary signed-in callers are
rejected before database access.

## Why both changes are required

The `timeout of 10000ms exceeded` error comes from the backend's Axios
PostgREST proxy. Increasing `createClient.timeout`, or using native fetch
against `/api/database/rpc/user_badges_refresh`, still reaches that proxy.
The edge instead uses native fetch to `/api/database/advance/rawsql`, the
ordinary **project_admin** SQL endpoint. The existing service-role credential
works there; neither unrestricted/root SQL nor a new secret is required.
See InsForge's [proxy timeout](https://github.com/InsForge/InsForge/blob/1dd0a1235673d05f0c6f78dcac73f6d862f197f2/backend/src/services/database/postgrest-proxy.service.ts#L45)
and [admin SQL execution](https://github.com/InsForge/InsForge/blob/1dd0a1235673d05f0c6f78dcac73f6d862f197f2/backend/src/services/database/database-advance.service.ts#L87).

The old refresh also used the abandoned v1 rollup: production's watermark was
2026-08-15, while v2 was current at 2026-11-04. Recomputing the growing raw tail
exceeded even the admin endpoint's 30-second database limit. The migration
uses the same maintained daily v2 rollup and dedup v2 tail as
`leaderboard_usage_grouped`, with a non-overlapping UTC watermark boundary.
An absent watermark fails explicitly. It preserves all badge calculations,
global model-debut checks, monotonic tiers, first-achieved timestamps, serial
triggers, the single `badges` claim, and production's memory settings.

Production's original `user_badges_refresh()` is owned by a higher-privilege
role, so the migration creates a separate `user_badges_refresh_v2()` entry
point owned by `project_admin`. It leaves the legacy function and its grants
intact. Both functions use the same claim key; the edge and HTTP schedule use
the new function.

The transport deadline is 110 seconds, including response-body consumption.
The effective SQL limit on this route is **30 seconds**, despite the function's
historical `statement_timeout = 120s`; the outer statement's timer controls
execution. A full production-data rollback rehearsal completed in **16.4s**
and would have refreshed **35,936** badge rows. No sharding is needed at that
workload. If it approaches 30 seconds later, inspect the v2 watermark first;
if current, shard the work rather than raising only the fetch timeout.

There is one database attempt per invocation. Transport failures can have an
unknown commit outcome, so the edge does not automatically retry. HTTP,
transport and malformed-result failures return `ok: false` without exposing
backend error bodies or credentials. `result: 0` can mean the shared five-minute
claim was already taken; it is not evidence that badge timestamps advanced.

## Deploy and verify

Run from the repository root with the CLI linked to `tokentracker`
(`srctyff5.us-east.insforge.app`). Apply only this migration before deploying:

```bash
npx -y @insforge/cli db migrations up 20261012120001_refresh-badges-from-maintained-rollup.sql
npx -y @insforge/cli functions deploy tokentracker-user-badges-refresh \
  --file dashboard/edge-patches/tokentracker-user-badges-refresh.ts
```

The migration version is deliberately the next slot after the deployed
`20261012120000` head, ahead of the unrelated pending device-reset and
model-wire migrations. It does not apply those migrations or move the remote
head past them. Skip the migration command if it is already applied.

Invoke with the existing service role. The pipeline keeps the credential out
of terminal output and curl's command-line arguments:

```bash
set +x
set -o pipefail
npx -y @insforge/cli secrets get INSFORGE_SERVICE_ROLE_KEY --json |
  node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { const {value} = JSON.parse(s); if (!value || /[\r\n]/.test(value)) process.exit(1); process.stdout.write("Authorization: Bearer " + value + "\n"); });' |
  curl --fail-with-body --silent --show-error --max-time 120 \
    --request POST --header @- --header 'Content-Type: application/json' --data '{}' \
    https://srctyff5.us-east.insforge.app/functions/tokentracker-user-badges-refresh
```

Expect HTTP 200, `ok: true`, and a positive `result` (number of upserted badge
rows). Verify freshness separately:

```bash
npx -y @insforge/cli db query \
  'SELECT MAX(updated_at) AS badges_updated_at FROM public.tokentracker_user_badges' --json
```

The existing active schedule `user-badges-refresh-6h`
(`b55a4848-b0e5-4d25-a98f-c42990994431`) uses `32 */6 * * *`, POST, and the
refresh-secret header. Keep that schedule; do not create a duplicate.

```bash
npx -y @insforge/cli schedules logs b55a4848-b0e5-4d25-a98f-c42990994431 --limit 5
```

To stop automated writes, deactivate this schedule with
`npx -y @insforge/cli schedules update b55a4848-b0e5-4d25-a98f-c42990994431 --active false`.
The migration adds only the new refresh function; it neither deletes badge
data nor changes read RPCs. Redeploying the old edge reintroduces the 10-second
proxy failure and is not a working fallback.

## Checks

```bash
node --test test/user-badges-refresh-edge-guardrails.test.js \
  test/user-badges-refresh-sql.test.js test/user-badges-schema-guardrails.test.js \
  test/user-badges-edge-guardrails.test.js test/user-badges-thresholds-single-source.test.js
npm run validate:guardrails
```

The edge tests include a real HTTP response delayed beyond ten seconds. The
SQL tests execute the bootstrap and migration with PGlite, checking the
base/tail boundary, privileges, claim skipping/rollback, and preservation of
earned tiers, timestamps and serial numbers.
