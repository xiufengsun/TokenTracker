# Self-hosting implementation status

Public source inventory reviewed on 2026-10-04; actual private-backend platform verified on 2026-10-08 and gift-stage database checks recorded on 2026-10-09. This is an engineering inventory, not public VPS acceptance. The historical inventory counts below came from `17247d9d`; they are not counts of today's `origin/main`. Current source, branch integration and release blockers are recorded in the [release handoff](cloud-release-readiness.md).

## Verified now

| Item | Evidence | Limit |
| --- | --- | --- |
| Software license | Root `LICENSE`, MIT | Other dependencies retain their own licenses |
| Historical public backend source | `17247d9d` contained 23 `.ts` entry files under `dashboard/edge-patches/` | Recount the selected release commit; inventory is not deployed-source parity |
| Historical public SQL | `17247d9d` contained 33 `.sql` files under `migrations/` | Incremental history, not a fresh-install baseline |
| Frontend target configuration | `dashboard/src/lib/insforge-config.ts` reads `VITE_INSFORGE_BASE_URL` and `VITE_INSFORGE_ANON_KEY` before the official fallback | Build-time configuration; published binaries do not change |
| CLI target configuration | `src/lib/runtime-config.js`, `src/commands/init.js`, `src/commands/device-login.js` | Persistence/env resolution differs across paths |
| InsForge platform self-hosting | Official Docker Compose, setup script and README | Platform support does not bootstrap the TokenTracker application |

The core `tokentracker_devices`, `tokentracker_device_tokens`, `tokentracker_hourly`, `tokentracker_device_machine`, profile and device-code tables have no matching complete creation baseline in the public migration directory. The first migration directly alters an existing badges table. `20260821060000_ban-confirmed-leaderboard-manipulation.sql` additionally requires a precise production evidence cohort and aborts if it is absent. These are concrete reasons not to run `db migrations up --all` for a fresh install.

The branch adds a clean private-backend installer, explicit free instance policy and 14-function deployment manifest. It does not install public profile/leaderboard services or enable archival. The official v2.3.3 Linux stack passes actual auth/RLS, the earlier13 install steps, unchanged reinstall,14 HTTP flows, source parity, two-user private access, full database/storage restore and six real-browser session recovery checks. The 2026-10-09 gift update separately passed the current14-step installer, unchanged reinstall and actual billing SDK/handler checks against an isolated PostgreSQL15.18 database with synthetic auth bootstrap; self-hosted access stayed free and redemption unavailable. Public VPS HTTPS and native-client routing still need their own acceptance. [Backend installation and evidence](self-hosting-backend.md)

## Required before supported release

- [x] Produce a clean private schema/RPC/trigger/RLS baseline, free of production users, credentials, transaction records and operator-specific data repairs. Keep platform auth separate. Record installation steps and checksums; unchanged reinstall preserves data and altered steps fail explicitly. A future upgrade still requires its own reviewed manifest.
- [x] Pin and validate official InsForge v2.3.3 images, actual PostgreSQL15.18/Deno2.0.6 and SDK1.4.5. Actual signup/signin, `auth.uid()`, ownership RLS, foreign keys and anon/authenticated/project_admin privilege checks pass. CommonJS and locked dependency compatibility are verified by all14 HTTP200, not only deployment status.
- [x] Add explicit free `self_hosted` access behavior under instance-owner control. Private reads/uploads remain authenticated; client-role RPC/table access stays denied. Device quotas and hosted history windows do not apply, and no fake payment or preview entitlement is required.
- [x] Make the self-hosted device-authorize build use the selected dashboard origin and verify its grant/poll/upload flow locally.
- [x] Verify CLI persistent config, local API auth/account proxy and standard Dashboard SDK/function routing on the actual local A/C instances; current results include real authorization and private uploads. Packaged native callbacks and public VPS routes remain separate pending gates.
- [x] Verify both A→C and C→A in the actual CLI, proxy, SDK and standard Dashboard: local queue/cursors preserved at switching, previous session cleared, old-instance JWTs rejected with 409 and remote devices removed from the displayed context. See [remaining acceptance](self-hosting-remaining-acceptance.md).
- [x] Provide a deployment manifest for the private backend's 14 required functions, including device-flow authorization and rename. Bundle local imports and pin InsForge SDK 1.4.5. This is a separate manifest from `scripts/build-cloud-functions.cjs`; public-community and payment webhook deployment are excluded.
- [x] Verify private file ownership/anonymous rejection, actual browser cookie recovery, loopback foreign-origin rejection, local TLS/SPA routing and disabled official-community publication in the local official stack. This does not certify a public certificate or native callback.
- [ ] Verify public HTTPS/browser trust and packaged native callback routes. If OAuth or email is offered, configure that instance's own provider and delivery credentials and test actual code exchange/send/receive; otherwise keep those optional features disabled.
- [x] Verify unchanged reinstall and a full database/configuration/storage backup restore in the official local stack. PostgreSQL15 tools restore15.18 successfully;7 devices/4hourly/8auth/13step fields match, actual sign-in/private260/70 and40byte file match. Future upgrades and optional archive schedules remain separate reviewed changes.
- [ ] Execute fresh-install, two-device sync, account isolation, duplicate/correction, timezone, backup/restore and upgrade tests on a real isolated VPS. Test supported native clients against that instance.

Application installation and actual private functions are verified in an isolated official local Linux stack. Two fresh instances reject each other's JWT, anonymous key and refresh cookie. The second then becomes a backup replica; the complete restore preserves recorded fields and authenticates both users. Real-browser official SDK1.4.5 login/fresh-client/reload keeps the correct identity and private totals for each account. The original paid InsForge project remains unchanged by this lab. Public VPS HTTPS/OAuth, native routing and physical-device checks remain distinct.

## Reproduce the source checks

Run from the TokenTracker repository. For current inventory choose the exact reviewed commit instead of a moving remote branch; replace `REVIEWED_COMMIT` below. These commands only inspect tracked source and counts:

```sh
git rev-parse REVIEWED_COMMIT
git show REVIEWED_COMMIT:LICENSE
git ls-tree -r --name-only REVIEWED_COMMIT dashboard/edge-patches
git ls-tree -r --name-only REVIEWED_COMMIT migrations
rg -n 'VITE_INSFORGE_BASE_URL|VITE_INSFORGE_ANON_KEY' dashboard/src/lib/insforge-config.ts
rg -n 'verification_uri' dashboard/edge-patches/tokentracker-device-flow-authorize.ts
rg -n 'resolveRuntimeConfig' src/lib/local-api.js src/commands/device-login.js
```

## Official source references

- [InsForge self-hosting and supported interfaces](https://github.com/InsForge/InsForge)
- [Image-based Compose stack](https://github.com/InsForge/InsForge/blob/main/deploy/docker-compose/docker-compose.yml)
- [Setup script](https://github.com/InsForge/InsForge/blob/main/deploy/setup.sh)
- [Platform environment template](https://github.com/InsForge/InsForge/blob/main/.env.example)

Recheck these sources at implementation time. Tracking the latest upstream branch does not pin a deployable release.
