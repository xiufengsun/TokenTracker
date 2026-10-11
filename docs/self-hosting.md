# Self-host TokenTracker

Self-hosting is the free software option for people who want to operate their own synchronization backend. You pay your infrastructure provider for the VPS, domain and backups, and maintain the service yourself. Managed Cloud pays for operating the hosted service; it does not change TokenTracker's MIT license.

**Status: technical preview.** InsForge supports Docker Compose self-hosting, but this repository does not yet contain a complete, verified TokenTracker installation for an empty VPS. This guide explains the preparation, existing configuration and remaining release gates. It is not a one-command installer. [InsForge self-hosting](https://github.com/InsForge/InsForge#self-hosted-docker-compose)

[中文版](self-hosting.zh-CN.md) · [Implementation status](self-hosting-status.md)

## Choose how to use it

| Option | What you operate | TokenTracker software fee | Data scope |
| --- | --- | --- | --- |
| Local | The app on each device | Free | Each device's local usage |
| Managed Cloud | Nothing on a server | Hosted subscription | Your official Cloud account |
| Self-host | Your own backend and web dashboard | Free | Accounts and devices on your instance |

A self-hosted instance is independent of the official account system and public leaderboard. Its users and history are not automatically copied to the official service. Local parsers, cost calculations and local export remain available without a server.

## What is open source

The public repository includes the application and backend TypeScript/SQL source. The historical `17247d9d` inventory contained 23 backend entry files and 33 migration files; recount the chosen release commit rather than treating those as current counts. The [MIT license](../LICENSE) permits using and modifying this code. A source inventory does not prove deployed-source parity.

The historical migrations are incremental changes to an existing database. Some files are operator-specific moderation or repair operations. **Do not apply every historical migration to a fresh database.** Use the [clean private-backend installer](self-hosting-backend.md). Its `--sql` mode owns a PostgreSQL transaction; `--migration` uses the linked InsForge migration API's transaction.

Subscription, device-access, gift and archive work is tracked on `feat/cloud-subscriptions`; it has not been released as paid Pro. The clean private baseline, official local Linux platform and standard Dashboard A→C→A switching have recorded acceptance. Public VPS HTTPS and supported native routes remain pending. [Current inventory and gaps](self-hosting-status.md) · [Release handoff](cloud-release-readiness.md)

## Prepare the VPS

Use a supported Linux host with Docker Engine and Compose v2, persistent SSD storage, a domain and HTTPS. There is no validated TokenTracker minimum VPS size yet; benchmark your account/device volume before choosing production capacity.

InsForge's current image-based stack has PostgreSQL, PostgREST, the InsForge API/admin application and a Deno function runtime. The platform creates its own authentication schema; TokenTracker still needs its application baseline and functions. [Official Compose source](https://github.com/InsForge/InsForge/blob/main/deploy/docker-compose/docker-compose.yml)

For the **InsForge platform only**, follow the official setup instructions. Download and review its setup script before executing it in a separate directory. Select a reviewed release and pin image versions/digests for repeatable upgrades. The script generates secrets and does not start the service. Set InsForge's `API_BASE_URL` and `VITE_API_BASE_URL` to your public API origin, then use the official Compose startup. [Official setup source](https://github.com/InsForge/InsForge/blob/main/deploy/setup.sh)

Keep the admin/API ingress behind the chosen HTTPS proxy and access controls. Do not expose PostgreSQL, PostgREST or the Deno runtime directly. Keep the generated admin password, database password, JWT signing key, encryption key and admin API key on the server. Only the public anonymous key belongs in a browser build. Changing a database password in `.env` after first initialization is not a database password rotation.

After the platform is installed, the current InsForge CLI supports linking directly to its API URL and server-only admin key with `link --api-base-url` and `--api-key`. This does not create a cloud account or install the VPS. CLI 0.2.8's executable help confirms this path; the v2.3.3 README still contains older cloud-only wording. The self-hosted dashboard, MCP and documented APIs are also available for administration. Keep admin keys out of shell history, browser builds and screenshots. [CLI connection guide](https://docs.insforge.dev/cli-reference/connection).

## Install the application

The local branch provides a clean private-backend installer and a 14-function manifest under `scripts/self-host/`. Follow the [backend installation guide](self-hosting-backend.md). Actual platform and VPS acceptance remain separate from the local SQL tests.

1. Install the reviewed application schema, RPCs, indexes, triggers, RLS policies and grants. Verify the server role and authenticated/anonymous roles against the selected InsForge release. Do not reuse production users, tokens, orders or moderation records as seed data.
2. Build the private backend with `node scripts/self-host/build-functions.cjs` and deploy its 14 reviewed functions through the self-hosted management interface. The manifest includes device authorization, issuance, ingestion, rename, account reads and free instance settings. It excludes public-community and payment webhooks. Relative imports are bundled and the SDK is pinned.
3. Supply server-only `INSFORGE_BASE_URL`, `INSFORGE_SERVICE_ROLE_KEY`, and the appropriate `INSFORGE_ANON_KEY`/`ANON_KEY`, `JWT_SECRET` or `JWT_PUBLIC_KEY` to functions. Verify actual user JWTs and server-role database access. Do not assume the self-hosted `ACCESS_API_KEY` can be substituted into every existing edge-token flow without testing.
4. Configure sign-in, session cookies, allowed origins and redirect URLs on your instance. An OAuth provider needs your own application registration and callback URL. Test browser, local CLI and native callbacks separately. Configure an email delivery service if your chosen authentication flow sends verification or reset emails.
5. Build and serve the web dashboard against your own API and anonymous key. Keep frontend history routing, `/device` and native callback routes reachable on your own web origin. Check every auth/usage request's actual destination.
6. The clean installer activates the explicit free `self_hosted` policy. Private usage remains authenticated, without the hosted device or history allowance. It does not mint paid orders or use `preview` to grant access. Verify this policy on the actual instance before inviting users.

Private usage and the proposed archive use PostgreSQL. File uploads, such as avatars, additionally need persistent InsForge storage and bucket policies. Storage can use its default filesystem or an appropriate S3-compatible backend; include it in backups. [InsForge storage configuration](https://github.com/InsForge/InsForge#5-storage-backends-optional)

Personal installations do not need a payment-provider merchant account. A deployment that resells hosted access would need its own payment setup and verification.

## Client configuration

A static web build uses the existing variables:

```dotenv
VITE_INSFORGE_BASE_URL=https://api.your-domain.example
VITE_INSFORGE_ANON_KEY=your-instance-public-anon-key
```

Use your instance's public anonymous key. InsForge v2.3.3 creates an opaque `anon_` key with 40 or 64 lowercase hex characters; older instances may use a JWT whose role is `anon`. The backend verifies the actual key, not merely its prefix. A custom URL without its own key fails closed and never falls back to the official key. Admin, service-role, user JWTs and private keys are rejected; the Vite build stops without logging the supplied value. The official default remains available when no custom endpoint is configured. The legacy `VITE_TOKENTRACKER_BACKEND_BASE_URL`/`VITE_TOKENTRACKER_BACKEND_ANON_KEY` pair is also supported. [Official key verification](https://github.com/InsForge/InsForge/blob/v2.3.3/backend/src/services/secrets/secret.service.ts#L637-L718).

Local CLI-served HTML loads `/api/runtime-config.js` synchronously before the app module. Its public descriptor supplies the selected `baseUrl`, `anonKey`, `dashboardUrl` and any `configurationError`; it takes precedence over compiled defaults. It contains no device JWT or server credential. Custom sign-in displays the destination host, so users can distinguish their own server from the official service.

The CLI runtime supports `TOKENTRACKER_INSFORGE_BASE_URL`, `TOKENTRACKER_INSFORGE_ANON_KEY` and `TOKENTRACKER_DASHBOARD_URL`, as well as persisted configuration. Verify the actual descriptor and request destinations after configuration. Source references are [runtime config](../src/lib/runtime-config.js), [local API](../src/lib/local-api.js) and [frontend configuration](../dashboard/src/lib/insforge-config.ts).

The frontend binds its SDK singleton to the selected endpoint/key pair. `resetInsforgeClientForInstanceChange()` clears its in-memory SDK session and SDK auth/PKCE namespace, and emits `tt.insforgeInstanceChanged` so account caches and cloud-sync capability are cleared. It preserves provider preferences and local usage. Purchases and reminder dismissals are namespaced by instance/account. A new instance requires its own sign-in; an old client cannot provide a bearer token for the new instance.

Only same-origin localhost SDK proxy requests use `x-tokentracker-instance`; direct remote requests retain the original protocol. HTTP-only refresh cookies require the local proxy's instance binding and stale-response protection; JavaScript cleanup alone cannot isolate those cookies. Do not copy a device token or official account session to the new backend.

With the server's explicit `self_hosted` policy, the UI shows a free private instance without official pricing, trials or payment portals. Server operators manage capacity, backups and history retention. Public Profile features are disabled by default on the private path and do not publish to the official service.

The released desktop bundles still need the matching CLI/dashboard release. Verify the actual device-authorization URL against your own dashboard; the existing edge source's official URL must not send self-hosted authorization to the official account system. Browser/native authorization, two-instance credential isolation and a fresh VPS remain release gates. A frontend build alone does not complete them.

## Verify before calling the installation ready

Test the real VPS through its public HTTPS URL:

- A new account signs in, signs out and refreshes its session. Another account cannot read its data.
- Device authorization links to your own dashboard; two clients upload to the same private account without replacing each other's identity.
- Re-uploading the same batch does not increase totals. Corrections, device filters, timezone/DST and model costs match local data.
- Session expiry, suspended devices and an offline backend produce recoverable UI states without discarding the local queue.
- Browser and native traffic uses the chosen instance. Self-hosted traffic is not uploaded to the official backend or leaderboard.
- A backup restores authentication, usage, device identities, storage and required secrets into a separate instance. Restore and upgrade drills preserve totals.

Unit tests do not satisfy these public VPS checks. A later official v2.3.3 local Linux lab verified actual authentication, private sync, storage and database restore; see [the backend evidence](self-hosting-backend.md). That lab is separate from this Windows checkout and does not prove a public VPS deployment or a packaged native route.

## Maintain the service

Back up the database, persistent file storage, deployment configuration and encryption/signing keys to a private recovery location. Use a separate destination from the VPS and test recovery. Keep database and storage backups consistent with the chosen schema and application version.

Install only reviewed schedules, with bounded work and observable failures. Usage archival must pass its separate parity, concurrency and recovery gates before a retention job can move data. A running container is not proof that rollups, repair jobs or backups are executing. [Archive activation checks](cloud-usage-archive.md)

Before upgrades, record the application commit, InsForge version/image digests, schema version and function sources. Back up first, apply the explicit upgrade manifest, verify the client/API contract, and keep a compatible rollback path. Review authentication, storage and function-runtime changes when upgrading InsForge.

Self-hosting offers control over data and operating costs. It also makes uptime, upgrades and recovery your responsibility. The supported deployment package will be marked ready only after the [remaining implementation gates](self-hosting-status.md) pass.
