# Native sandbox gateway acceptance

This runbook prepares a separate native QA build against the existing InsForge project. It does not enable production billing, replace reviewed functions, or make a normal installed app a sandbox client. Root coordinates Windows permissions and all remote deployments. Credentials remain in the existing server or a native-local RAM broker.

Use the [release handoff](cloud-release-readiness.md) for the current checkout and platform evidence. The remote gateway and GUI results below are historical acceptance records, not a remote re-verification by the current Windows documentation pass. The ordinary Windows build has no dedicated NativeQA target or broker wiring; its unit tests and DLL build cannot certify this Mac QA route.

The fixed realm is `tokentracker-native-sandbox-v1`. The real authentication issuer remains `https://srctyff5.us-east.insforge.app`. The new gateway is `https://srctyff5.function2.insforge.app/tokentracker-native-sandbox-gateway`. Its single function endpoint uses query selectors. Do not assume the platform supports nested `/gateway/api/auth/*` paths.

## Route contract

| Original request | Gateway destination | Identity |
| --- | --- | --- |
| Auth login, refresh, current session, OAuth exchange | Real issuer via the native-local broker; outside gateway | Actual InsForge session |
| Account summary/daily/hourly/monthly/heatmap/model-breakdown/devices GET | Corresponding `tokentracker-account-*-sandbox` | Signed authenticated JWT, gateway and access rosters |
| Device issue POST, rename PATCH | Existing issue/rename sandbox | Same signed JWT |
| Ingest POST | Existing `tokentracker-ingest-sandbox` | QA token hash, owner, sandbox and revocation checks |
| Device-flow authorize/grant/poll POST | Existing access sandbox | A signed-in QA JWT on **every** request |
| Billing account/devices/remove-device/resume-device | `tokentracker-billing-access-sandbox` | Signed QA JWT |
| Billing catalog/order/checkout/restart-checkout/reconcile/cancel/trial | `tokentracker-billing-sandbox` | Signed QA JWT also on finance roster |
| Billing portal | Rejected | Existing shared portal URL has no test binding |
| Webhooks, direct DB/admin/storage, telemetry, publishing, unknown aliases | Rejected | No fallback to a live endpoint |

Business requests use `?fn=<original slug>` plus their existing query parameters. The gateway requires `X-TokenTracker-Sandbox-Realm: tokentracker-native-sandbox-v1`. It forwards only the validated original bearer and JSON content type. No cookie, CSRF, anon/admin API key, merchant key or environment override goes upstream. It never signs a substitute user JWT.

Device flow here deliberately requires prior broker login. The ordinary anonymous CLI authorize/poll sequence is not supported by these reviewed QA handlers. The public transport only supplies a missing bearer for catalog. A native-local broker may explicitly attach its current **actual** QA access token to authorize/poll; otherwise they return an authentication error. Do not call the flow usable until real authorization/grant/poll results and a resulting QA-issued token lookup have been checked.

`GET ?mode=profile` returns only the public route/realm/return-site contract. `GET ?mode=identity` requires the realm header and a real JWT, and returns its verified user UUID and finance eligibility. `GET ?mode=device-identity` accepts an actual QA-issued device bearer, checks its hash in the QA table through the original SDK, and returns only owner/sandbox/QA upload-scope proof without uploading. A live-table token cannot satisfy this lookup. The native run-ID/directory/nonce challenge is a separate local-server ownership check. None of these checks grants membership.

## Authentication and local isolation

The standard SDK 1.4.5 web login returns `user`, `accessToken`, and `csrfToken`, with an HTTPOnly `insforge_refresh_token` cookie. Web refresh sends that cookie and `x-csrf-token` to `/api/auth/refresh`. Do not strip those headers and claim reload recovery works.

A same-origin QA broker can retain an actual refresh token in RAM and use `/api/auth/refresh?client_type=mobile` with `{ "refresh_token": actualRamValue }`. It updates RAM with the rotated real token and returns the standard SDK user/access-token response. It must not return a refresh token or password to the page, tool output, logs or files. Preserve real issuer validation and local CSRF/run/nonce checks. The business gateway does not implement auth.

The QA target uses a separate WebView profile, owned temporary data directory, machine identity and local origin. It must neither read a normal user's token/config/queue nor restore an official-app session into this run. Check the signed gateway identity against the broker's actual actor and fixed realm before any business request. Scope all in-memory token/cache/purchase state to realm, issuer, actor and local run. Reset on a mismatch. Ordinary Release is unchanged.

The gateway transport is `scripts/cloud-sandbox/native-client-transport.mjs`. Inject it before the Dashboard entry or apply it in the native-local proxy to both WebView and Node calls. The original backend/anon descriptor remains valid under the existing product validation. If bootstrap, profile verification or proxy guard is missing, stop the QA app; do not load the ordinary transport. This module delegates auth to the broker, captures only approved business paths, and never implements session recovery itself.

OAuth paths are listed for a future real-issuer acceptance, not evidence of working OAuth in this QA target. The current external-open guard permits only Waffo test checkout. The unchanged Dashboard callback page uses the ordinary `tokentracker://auth/callback` scheme. A future QA OAuth test needs a dedicated local callback served by the native owner, the real exchange/PKCE flow and `tokentracker-qa` dispatch. Never send it to the normal app or log its full code URL. This round covers password/broker recovery and an existing owned paid-order return.

## Build and deploy after Root review

Generate independent outputs. None of these commands deploys or modifies the normal 18, financial 2 or access 14 builders.

```sh
node scripts/cloud-sandbox/build-native-gateway.cjs /absolute/private/gateway-artifact
node scripts/cloud-sandbox/build-native-return-site.cjs /absolute/private/return-site-source
node --test test/cloud-native-sandbox-gateway.test.js
deno check --node-modules-dir=none scripts/cloud-sandbox/native-gateway.ts
```

Root first records the existing project/deployment metadata and original function source hashes. Before this acceptance, the project had no frontend deployment. The new standalone QA return site is now ready at `https://srctyff5.insforge.site`. Its source directory contains only the package, build script, static page and route/header configuration. It is separate from the full Dashboard and contains no env or credentials. Do not deploy the full Dashboard or enable production billing as part of this test.

Root configures only sandbox settings: `TOKENTRACKER_SANDBOX_GATEWAY_USER_IDS`, `TOKENTRACKER_SANDBOX_GATEWAY_ORIGINS` (exact approved HTTPS or HTTP loopback origins), and `TOKENTRACKER_SANDBOX_BILLING_SITE_URL` (the new bare HTTPS origin). Ensure each actor is on the existing access roster, eligible actors on the finance roster, and on the actual QA DB allowed-user list. Those changes are server-side. Never add production merchant credentials or change the global billing environment.

Deploy the one new independent gateway slug. Read its remote source hash and profile/identity over HTTPS. Re-read the original function sources/metadata and policy. Only the approved test subject may invoke business routes. Missing or malformed rosters/site configuration, bad signature, wrong role, foreign origin or realm, and unapproved subject must fail before a forwarded business call. Keep production policy in preview and production orders unchanged.

## Payment return

The old billing helper takes a site URL's **origin** and appends `/billing/checkout`. A gateway URL containing a path is therefore not a valid return-site configuration. Root deploys the standalone site on its own stable HTTPS origin in the existing project and verifies `/billing/checkout?order=<owned UUID>` resolves to its static page.

The page is generic, has no auth/backend SDK, user data or payment confirmation, and opens only:

```text
tokentracker-qa://billing/return?order=<UUID>&realm=tokentracker-native-sandbox-v1
```

The native owner checks scheme/host/path, exactly one UUID order, fixed realm, and the order's binding to the current real actor/run. It then focuses its own QA window at `/billing/checkout?order=<UUID>`. The original page's focus/visibility polling reads the original sandbox ledger. An unowned ID, another realm/account, duplicate order parameter or stale run cannot route to an ordinary app or report success.

For the first test, Root supplies an existing actual owned paid order through the current RAM broker. Use its public UUID/status/membership summary; do not share the full checkout URL/csId in chat or logs. Do not create another payment or refund for this return test. An existing Waffo session's old success URL does not change when the site secret changes. Manually opening the generic return page verifies native continuation, not a new provider return transaction.

If a later separately authorized checkout test opens a provider URL, require exact `https://pancake.waffo.ai`, no userinfo/port/hash, canonical `/store/<store segment>/checkout/cs_<session>` path and exactly one `test=true`. The actual SDK session ID lives in the path, not a `csId` query parameter. Reject obsolete query-only checkout URLs and extra `csId`/`cs_id` selectors. The native broker also compares the full URL with the current actor's actual owned order response. Never append `csId` or `test=true` to an unverified URL to claim it is a test checkout. Portal remains unavailable because its current shared login URL does not carry that proof.

## Evidence and remaining checks

2026-10-09 acceptance has these actual results:

- The gateway source hash is `4c4de1062e43840d634a3fdb78ec235b27bc21c4d31c60181d6fcc45b5b7f679`. Thirteen real HTTPS checks cover identity, actual paid order/account/devices and unsigned/tampered JWT, origin, realm, API-key and environment rejection. One real QA-issued device token resolves to its sandbox owner and is rejected by original live ingest. No new transactions were created.
- The return HTML, JavaScript and CSS each return HTTP200 and match built sources, with CSP and no-store headers. This proves hosting, not OS dispatch.
- The isolated Mac QA window displays the actual sandbox actor, paid term, cancellation and refunds. The normal account UI recovers the existing order by ID; after logout and WebView recreation it stays signed out. Its source/binary record is kept separate from later builds.
- Original23 function metadata and52 RPC definitions remain unchanged; live policy is preview with no launch date and0 orders.

Browser Use explicitly refused the external-protocol click. Do not attempt the same navigation through another browser, CLI or GUI surface. Browser→OS→App remains a manual-device acceptance step; the internal order recovery does not prove it. A human should click the QA page's return button while the owned QA run is signed in. The engineer then checks the actor/realm/order and the unchanged real ledger. This requires no repeat purchase or refund.

The ordinary app has a separate order-only `tokentracker://billing/return?order=<UUID>` parser on Mac and Windows. It opens the current local order page and has no sandbox realm or entitlement logic. Windows parser tests have now also run on Windows; see the release handoff for their source and result. The older Windows window evidence still does not prove the new OS return path or installer. Keep those device steps pending until actually observed.
