# Cloud billing operations

TokenTracker Cloud v1.3.3 is publicly released at source cc934784. Current product display names, prices and existing IDs were reverified; no new payment was created. The Owner confirmed the settlement/withdrawal account as verified and available. Actual refund receipt and the first eligible merchant payout remain separate acceptance. See the [current release handoff](cloud-release-readiness.md); earlier API/account snapshots below retain their historical scope.

2026-10-10 live fixed-month acceptance is complete: the Owner paid USD4.99 with zero tax and authorized a full refund. Genuine payment/refund callbacks each delivered once with HTTP200; the ledger records 499 paid and 499 refunded, with the original term retained and paid access revoked. Independent before10/10 and after11/11 checks passed; the actual account page returned to its existing-device transition and displays Refunded US$4.99. See [the exact evidence and boundaries](cloud-live-payment-acceptance.md). Earlier zero-payment preparation snapshots below are historical. No new charge/refund is needed to repeat this case.

This runbook records the authorized production launch and the remaining acceptance gates. Owner-confirmed pre-tax base prices are USD 4.99/month and USD 39.99/year, equal for recurring and fixed-term purchases. Mark each check with its commit, environment, date, result, and private evidence location; leave untested items unchecked.

2026-10-10 production activation: the Owner explicitly requested enabling the formal prices. The guarded live-policy update affected exactly one row, with phase=active and launch_at=2026-10-10T05:52:14.603712+00:00. Existing devices created before launch retain their 30-day transition until 2026-11-09T05:52:14.603712+00:00. Local/free community use remains available; no existing account is automatically charged. Archive/deletion jobs remain off. Do not move launch_at when retrying or rolling back.

Signed production queries reverified merchant/Store, key pin and all four published prices. Catalog HTTP200 reports live/hosted/active, Waffo=true and checkout_verified=true. TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED=true was set under the Owner's explicit launch authorization; despite its historical name, the flag is an operator gate, not evidence of an actual paid/refunded/settled transaction. The complete production Dashboard and public pricing/terms/privacy are READY at www.tokentracker.cc, exact source f51520eed4cf1238638e1d335bd0934db87638db; five routes return HTTP200 and the three public files match source bytes. A genuine SDK-authenticated live fixed-month checkout returned HTTP200 and a production Waffo URL, creating one QA unpaid draft only. No card, wallet, refund or payout was used. Never report zero live orders after this probe.

Fourteen formal handlers were deployed and read back; the existing paid InsForge project remains in use. The supplier database backup was restored and independently compared in isolated PG15.18; this does not prove public-VPS/platform-storage recovery. Payout binding is correct, but the earlier signed API reported channelStatus=unverified and no verification timestamp. The fixed-month payment and full refund are complete as recorded above; actual payer/merchant settlement, other live charging modes and physical native-device acceptance remain open. See the [current release handoff](cloud-release-readiness.md) for exact evidence and dates; preparation-stage instructions below preserve the required order for future deployments.

The code and configuration references are [runtime.ts](../dashboard/edge-patches/cloud/runtime.ts), [Waffo adapter](../dashboard/edge-patches/cloud/waffo.ts), [billing handler](../dashboard/edge-patches/tokentracker-billing.ts), [financial migration](../migrations/20261003120000_cloud-subscriptions.sql), [device/access migration](../migrations/20261004120000_cloud-machine-access.sql), [Waffo migration](../migrations/20261007120000_cloud-waffo.sql), [safe-retry migration](../migrations/20261007130000_cloud-waffo-retry.sql), [attempt bindings](../migrations/20261007140000_cloud-waffo-attempts.sql), [authorization audit](../migrations/20261007150000_cloud-waffo-authorizations.sql), [sandbox periods](../migrations/20261007160000_cloud-waffo-sandbox-periods.sql), [instance policy](../migrations/20261008120000_self-hosted-access.sql), [token environment validation](../migrations/20261008120001_validate-cloud-token-environment.sql), and [usage archive](cloud-usage-archive.md). Recheck them against the reviewed commit at deployment.

## Environment and secrets

Sandbox and live provider credentials, notification destinations, price IDs, orders, payments, and subscriptions must stay separate. Use a dedicated checkout/return origin, without changing the production account UI. The default billing environment is `live` so historical production device tokens remain compatible; both policy rows start in `preview`. A separate sandbox backend can explicitly set `TOKENTRACKER_BILLING_ENVIRONMENT=sandbox`. For acceptance on the existing paid backend, use the fixed sandbox builds below and leave that global setting unchanged. The default does not enable charging.

Store server credentials in the target backend's secret store. Do not commit `.insforge/project.json`, local secret files, private keys, screenshots containing credentials, or customer payment payloads. Never use `VITE_` for server API keys or service-role credentials. `@waffo/pancake-ts@0.25.0` runs only on the server; the frontend receives the owned order and hosted checkout URL, without a client SDK or private key.

TokenTracker `sandbox` maps to Waffo `test`; TokenTracker `live` maps to Waffo `prod`. Product setup uses the separate `WAFFO_ENVIRONMENT=test` script variable. Keep these names distinct and never infer production approval from a successful test request.

| Configuration key | Value to prepare |
|---|---|
| `TOKENTRACKER_BILLING_ENVIRONMENT` | `sandbox` or `live`, mapped to Waffo `test` or `prod` |
| `TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED` | Defaults false; the guarded operator gate was enabled under the Owner's explicit production-launch authorization. Independently record actual payment/refund/membership acceptance; this flag does not prove it |
| `TOKENTRACKER_BILLING_SITE_URL` | HTTPS origin hosting `/billing/checkout`; Waffo return URLs require HTTPS |
| `INSFORGE_BASE_URL` | Target backend origin |
| `INSFORGE_SERVICE_ROLE_KEY` | Server-only edge database credential |
| `INSFORGE_ANON_KEY` or `ANON_KEY` | Backend anonymous client key |
| `JWT_SECRET` / `JWT_PUBLIC_KEY` | Backend JWT verifier material matching its actual signing algorithm |
| `WAFFO_MERCHANT_ID` | Merchant identity for the approved environment |
| `WAFFO_STORE_ID` | The selected store, verified by API read-back |
| `WAFFO_PRIVATE_KEY` | Server-only RSA key. The SDK accepts PEM or raw Base64, but TokenTracker's live pin guard requires standard PEM; normalize a raw Base64 download privately before deployment |
| `WAFFO_LIVE_PRIVATE_KEY_SHA256` | SHA256 of the decoded DER in that PEM, after independently verifying the production key's provider environment and ownership; a fingerprint alone does not prove either |
| `WAFFO_CLOUD_MONTHLY_PRODUCT_ID` | Monthly recurring USD product |
| `WAFFO_CLOUD_YEARLY_PRODUCT_ID` | Yearly recurring USD product |
| `WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID` | One-month fixed-term USD product |
| `WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID` | One-year fixed-term USD product |

| SKU | Billing mode | USD base amount | SDK product type |
|---|---|---|---|
| `cloud_usd_monthly` | `recurring` | 4.99 | Subscription, monthly |
| `cloud_usd_yearly` | `recurring` | 39.99 | Subscription, yearly |
| `cloud_usd_monthly_fixed` | `fixed` | 4.99 | One-time |
| `cloud_usd_yearly_fixed` | `fixed` | 39.99 | One-time |

These are the Owner-confirmed global production base prices before tax (confirmed 2026-10-09); sandbox uses the same amounts. Store integer cents in TokenTracker (499/3999), but pass display amount strings (`"4.99"`/`"39.99"`) to the SDK. Waffo products use the `saas` tax category. Product and order validation checks ownership, environment, price, billing period and absence of a provider trial. The seven-day no-card trial belongs to TokenTracker. Waffo checkout calculates tax and displays the final charge; do not promise identical tax-inclusive totals or a CNY conversion rate. Read back `providers.waffo` from the catalog; that flag is not proof of merchant approval or payment.

## Existing project hosted sandbox

The owner authorized acceptance on the existing paid TokenTracker backend at `https://srctyff5.us-east.insforge.app`. No new developer account or backend is required. Sandbox and live billing records share PostgreSQL but use separate `environment` values; authentication remains the existing project's authentication.

1. Check the linked project and save private schema/function recovery evidence. Apply only the nine financial/device migrations listed below, skipping `20261005120000_cloud-usage-archive.sql`. The token environment column defaults existing tokens to `live`. Its named FK starts `NOT VALID`, still enforcing new writes, then the final migration validates historical rows in a separate transaction. On this hosted project, `statement_timeout` overrides are forbidden; preserve the platform timeout and use the allowed three-second `lock_timeout`. Read back migration history and `convalidated=true` rather than relying on the CLI success message.
2. Create dedicated application test users through the existing auth service. Configure the nine dedicated settings: `TOKENTRACKER_SANDBOX_USER_IDS`, `TOKENTRACKER_SANDBOX_BILLING_SITE_URL`, and the `TOKENTRACKER_SANDBOX_` versions of merchant ID, store ID, private key and four Waffo product IDs. The allowlist contains actual test-user UUIDs. Keep passwords, JWTs and private keys outside the repository and logs. Do not replace reserved JWT/backend secrets or global billing environment/site settings.
3. Build and deploy only the two new sandbox slugs. The build fixes billing to `sandbox`/Waffo `test`, disables live checkout verification, reads only dedicated Waffo/site settings, and checks a valid signed JWT plus the UUID allowlist before billing or catalog database access. The original function slugs and production frontend remain unchanged.

```bash
node scripts/build-cloud-functions.cjs --sandbox
npx @insforge/cli functions deploy tokentracker-billing-sandbox --file .tmp/cloud-functions-sandbox/tokentracker-billing-sandbox.js
npx @insforge/cli functions deploy tokentracker-waffo-webhook-sandbox --file .tmp/cloud-functions-sandbox/tokentracker-waffo-webhook-sandbox.js
```

4. Independently compare each remote source with its artifact and confirm active status. Verify allowlisted JWT requests return 200, other valid users return 403, and missing/tampered JWTs return 401. Anonymous/authenticated REST reads of the catalog base table are denied. Read back all four merchant test products, then set only the sandbox policy to `active` for acceptance. During initial prelaunch acceptance the live row remains preview/null; after the authorized launch, sandbox acceptance must preserve the existing live phase and launch_at without resetting them.
5. Register the merchant test webhook at `https://srctyff5.us-east.insforge.app/functions/tokentracker-waffo-webhook-sandbox` and read back its URL, events and test flag. It retains raw RSA signature verification and checks test mode/store before SQL. Verify genuine checkout, callback, ledger, membership, return UI, cancellation and refunds with the dedicated users. Preserve private receipts and compare original service behavior after testing. This does not enable paid restrictions on the existing sync/leaderboard functions.

On 2026-10-08, the initial nine migrations and both sandbox functions were deployed and independently read back. The FK was validated; metadata for the original 23 active functions and MD5s for 52 existing business RPCs were unchanged. Two forbidden timeout attempts were checked to have created no new tables before the successful deployment. Subsequent hosted sandbox acceptance verified payment, cancellation, partial/full refunds, device access and UI recovery; the 2026-10-09 gift stage added its migration and a separate gift-only sandbox. See [delivery evidence](cloud-delivery.md). These results do not prove a production charge, bank settlement or every native-client flow.

## Merchant preparation

### Waffo test setup and production approval

- Verify the selected merchant/store through the SDK and dashboard before configuring products. Do not replace unrelated existing products or publish test products as part of a test run.
- [Test product setup](../scripts/setup-waffo-cloud.cjs) requires `WAFFO_ENVIRONMENT=test` and secure merchant/store/key configuration. Its default run is read-only; `--apply` creates missing products with stable idempotency keys and performs an independent API read-back. On 2026-10-07, all four test products were created and read back. Keep their IDs and private evidence outside tracked documents.
- The 2026-10-07 store read-back reported `prodEnabled=false`; the later 2026-10-08 acceptance verified merchant production approval and Store production/receipt permissions. This is historical API evidence, not a fresh remote check. The Owner has now created the production key, supplied its local file and confirmed payout association. Independently bind the file to the provider environment/merchant and re-read payout binding and the four live product versions before launch. See [production preparation](waffo-production-readiness.md).
- Configure an HTTP webhook for the matching store/environment at `BACKEND_ORIGIN/functions/tokentracker-waffo-webhook`. Include one-time completion, subscription activation/payment/cancellation/past-due, and refund lifecycle events needed by the handler. Re-read the stored URL, event list and test-mode flag after configuration.
- Use the SDK's RSA-SHA256 verification over the raw request body and `X-Waffo-Signature`. Verify event mode and store, then reconcile with the signed provider API before transactional fulfillment. Do not grant membership from checkout redirects or unsigned metadata.
- Confirm recurring card/Apple Pay/Google Pay and fixed-term WeChat/card availability in the actual hosted checkout. Web opens a new tab with `noopener,noreferrer`; native clients use the system browser. The [consumer portal](https://pancake.waffo.ai/consumer/portal/login) requires the purchase email and a separate Waffo login; it is not a TokenTracker-authenticated portal session.

Record the merchant contract's fees, payout account/currency, schedule and any threshold privately. Waffo's MoR service handles applicable consumer sales taxes under its terms. It does not establish exemption from the operator's own income/business taxes, invoicing or foreign-exchange accounting. Review those obligations for the real operating entity and settlement contract. [MoR service](https://www.waffo.ai/features/mor), [developer terms](https://www.waffo.ai/developer-terms)

A verified checkout receipt is different from payout settlement. The sandbox receipts described below are verified separately. Production pilot payments and bank settlement remain unverified; do not infer them from product setup or local tests.

### Contextual membership reminders

Reminders reuse existing catalog, membership and denied-access responses without new API requests, polling or telemetry. Nothing appears on initial dashboard opening or the free leaderboard. A user's sync toggle, private history selection or device action can show a dismissible explanation in that panel. Free local use and daily community uploads remain available.

Sales and trial CTAs require a fresh catalog with `environment=live`, reached active launch policy, configured Waffo and `checkout_verified=true`, plus a matching active/live membership response. The server's gate also requires explicit `TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED=true`. Merchant approval, product setup or sandbox success alone does not justify that switch. It was enabled with the Owner's explicit launch request on 2026-10-10; if policy returns to preview or verification is disabled, reminders cannot promote a live purchase.

Dismissal records are local, per account and scene, with at least seven days of shared cooldown across promotional scenes. Account switches clear active reminder intent. Unwritable storage suppresses sales CTAs and automatic expiry nudges; explicit action explanations can still be closed in memory. Existing paid access never triggers a sales prompt. Device/history issues lead to management, while date notices use the trial's final 48 hours or a transition/fixed paid term's final seven days. Cancellation does not shorten the paid term.

### Declined checkout and safe retry

Waffo consumes a checkout session when the buyer is submitted, before payment has necessarily succeeded. A consumed session can show expired even before its configured TTL. Do not refresh the old session or treat that screen as proof of an unpaid order. See the [official checkout guide](https://docs.waffo.ai/checkout/checkout-flow).

The explicit `POST billing?action=restart-checkout` takes `{id: old_order_uuid, request_id: retry_uuid}`. The server validates the retry UUID before side effects, verifies every strongly bound attempt has no real successful or processing payment, closes each pending Waffo order with its own idempotency key and re-reads the complete terminal set, then creates one linked replacement under database locks. Verified zero-amount period0 authorizations are durable audit evidence, never membership payments. The client persists the retry request against its predecessor and reuses it after a timeout. Only the successful response changes the visible order URL. Returning from payment never grants membership.

The isolated test on 2026-10-07 confirmed a declined provider payment as failed with its order closed, without Cloud access. An explicit restart returned HTTP 200 with a new TokenTracker order UUID. A separate sandbox Visa payment was read back as succeeded for USD 4.99; a genuine provider-signed payment callback returned HTTP 200, and PostgreSQL recorded the order paid with Cloud access enabled. Actual merchant sandbox receipts cover monthly/annual recurring Visa, monthly fixed WeChat and annual fixed Visa. A USD2.00 partial monthly refund retained its paid term; full refunds of the monthly WeChat pass and both annual products reversed only their corresponding rights. Canceling both recurring modes retained their original paid dates. The annual fixed Back/replacement path succeeded with two provider attempts under one application UUID. Two other pending fixed attempts were canceled, then one successor was created; replay returned that same successor. These use an isolated application auth/SQL backend, not hosted production InsForge or real funds.

A late successful payment on the original order can conflict with the replacement. The ledger retains the true payment records and marks `retry_payment_conflict_at`; the UI requests bill review and private support and blocks further payment/retry controls. Account responses expose conflict orders separately from pending unpaid orders, including paid and closed conflicts. Reconcile both provider order/payment references and any subscriptions manually. Never hide a charge, assume there was only one payment, grant a second term to make totals look right, or record a refund that has not been verified.

The provider's Back recovery can create several Waffo order IDs for one merchant order reference. Each attempt is registered only after full merchant ownership/product/environment verification. Only the first real payment selects the canonical order; all genuine charges remain in the ledger. Fixed cancellation uses the actual merchant-provided buyer identity, followed by exact customer-visible order/store/product verification. The customer GraphQL schema does not expose merchant metadata; do not request it or replace merchant ownership checks with a guessed email.

Actual annual test renewal failure exposed a short collection-grace window. Unpaid grace is not cached as a purchased term. The subsequent successful test simulation also returned a precise13-minute paid window. Sandbox accounting preserves those provider-confirmed dates, never invents a year or grants access before a future period starts. Live requires a full purchased month/year, and its lower bound remains unchanged. The simulator differs from the documented full-period advance; verify a genuine live renewal cycle with the vendor before launch. See [Waffo Test Mode](https://docs.waffo.ai/features/test-mode).

### Historical payment providers

New purchases use Waffo. Existing Paddle, direct WeChat and Alipay orders, events, payments and subscriptions retain their original provider and currency. Keep the legacy verification credentials and handlers only where historical transactions require reconciliation, refunds or cancellation. Do not rewrite those records as Waffo, redirect an unresolved legacy purchase into a new Waffo charge, or require new direct merchant registrations for this Waffo rollout.

## Deployment sequence

These commands describe the initial reviewed rollout. It has now completed the formal function replacements and isolated database restore documented above. Do not replay deployments, migrations, policy changes or financial probes merely because an old step is written in this checklist. For subsequent work, preserve the current active launch timestamp and deploy only reviewed source changes. Check `current` before any mutation; record the project privately. Do not apply unrelated pending migrations.

```bash
npx @insforge/cli current
npx @insforge/cli db migrations list
node --test test/cloud-billing-*.test.js
node scripts/build-cloud-functions.cjs
```

1. Save the target database backup, current policy values, deployed function sources, relevant schedule states, and frontend version to a private recovery location. The latest 2026-10-10 read-only plan for reviewed head 6abe2701 records 19 candidates and 16 existing source/metadata snapshots, including the separately reviewed leaderboard-refresh bundle; the original 18 candidate hashes are unchanged. Both deployed Waffo handlers match, 14 replacements remain pending, and three historical provider handlers are absent. Metadata is unchanged and no replacement was performed. Snapshot-directory/file NTFS ACL checks permit only Owner, System and Administrators. Verify the backup is readable and test restoration on the isolated backend; source snapshots alone do not prove database recovery.
2. Apply the reviewed financial and device/access migrations, then the Waffo and safe-retry migrations, rechecking remote history, RLS, grants, indexes and both policy rows. Apply the archive migration only under its separate schema/parity/backup gate. These are incremental migrations for an existing TokenTracker backend, not a blank self-hosted schema bootstrap. They do not activate charging or install a historical deletion schedule.

```bash
npx @insforge/cli db migrations up 20261003120000_cloud-subscriptions.sql
npx @insforge/cli db migrations up 20261004120000_cloud-machine-access.sql
npx @insforge/cli db migrations up 20261007120000_cloud-waffo.sql
npx @insforge/cli db migrations up 20261007130000_cloud-waffo-retry.sql
npx @insforge/cli db migrations up 20261007140000_cloud-waffo-attempts.sql
npx @insforge/cli db migrations up 20261007150000_cloud-waffo-authorizations.sql
npx @insforge/cli db migrations up 20261007160000_cloud-waffo-sandbox-periods.sql
npx @insforge/cli db migrations up 20261008120000_self-hosted-access.sql
npx @insforge/cli db migrations up 20261008120001_validate-cloud-token-environment.sql
npx @insforge/cli db migrations up 20261008150000_cloud-pro-badges.sql
npx @insforge/cli db migrations up 20261009120000_cloud-gifts.sql
```

The gift migration adds private batch/code/grant/redemption state and RPCs. Preserve its applied checksum and privilege read-back; do not rerun an already applied migration or issue production codes as part of schema deployment. The hosted project already has the gift migration from sandbox acceptance. A fresh private instance instead uses the reviewed 14-step `scripts/self-host/manifest.cjs`, never this incremental hosted list.

3. Set target secrets through secure backend configuration. Verify names and active status without printing values. The standard builder enumerates 18 artifacts; the independently built and tested leaderboard-refresh bundle is the nineteenth candidate in the latest plan. The two Waffo billing/webhook handlers are already deployed and source-matched; private snapshots preserve 16 existing relevant function sources and metadata, including the original 13 sync/account/leaderboard replacements and this separate leaderboard-refresh repair. The three legacy non-Waffo webhook slugs are absent in the current backend; deploy them only if verified historical transactions require them, preserving the original provider. An isolated recovery rehearsal and preview regressions still precede replacement of these 14 production handlers. Use built artifacts containing the reviewed SDK runtime and resolved relative modules; do not deploy shared modules separately. Live Waffo also requires the DER SHA256 pin of the independently verified production private key in `WAFFO_LIVE_PRIVATE_KEY_SHA256`; a matching pin alone does not prove provider environment. See the [current handoff](cloud-release-readiness.md) for precise source, bundle hash and acceptance boundaries.

```bash
npx @insforge/cli functions deploy tokentracker-billing --file .tmp/cloud-functions/tokentracker-billing.js
npx @insforge/cli functions deploy tokentracker-waffo-webhook --file .tmp/cloud-functions/tokentracker-waffo-webhook.js
npx @insforge/cli functions list --json
```

4. Read back each function with `functions code <slug>` and compare it with its built artifact. Confirm status `active`. Independently request the catalog and an authenticated account. Check HTTP status and body; an unavailable secret or authentication failure is not a passing smoke test.
5. Deploy the tested UI and any upload/read/device enforcement changes in preview. Preview must preserve existing Cloud access and block paid checkout/trial activation. Verify the migration and frontend do not start historical deletion. Client changes also require the CLI and all desktop releases described in [CLAUDE.md](../CLAUDE.md).
6. Activate only the sandbox policy after authentication and environment isolation are verified, then complete the financial and UI gates against it. Keep production `live` in preview. Record real callback, ledger, membership, and provider receipt evidence.
7. After owner approval, choose and announce one launch time. Read back final production secrets/provider flags/catalog, and set the `live` policy to `active` with that `launch_at`. Preserve the exact launch timestamp; existing-device transition eligibility and end dates depend on it. Independently verify checkout remains closed before launch and opens at the intended time.
8. Keep history archival/deletion off until its separate gate passes. Record every live change and recheck free/community behavior, checkout, account expiration, and private support links. Publish the reviewed announcement only within its own authorization.

## Launch gates

| Gate | Evidence required | Result |
|---|---|---|
| Financial state in PostgreSQL | Real PostgreSQL concurrency/transaction tests, grants/RLS, one fulfillment per payment, cumulative refunds, stale events, environment isolation | SQL/HTTP and real gift multi-connection tests passed; hosted checkout idempotency returned 200/202/202 for one order. Broader live race/transaction acceptance remains pending |
| Signed provider events | Genuine Waffo test notifications; mode/store/amount/signature mismatch rejected; API-bound order and period verified | Four test SKUs, failure/recovery and four refunds verified; production events pending |
| Checkout and recovery UI | New-tab/system-browser checkout and return on every offered platform; stable retry, no hidden second subscription, cancellation and supported portal flow | Hosted browser and Mac QA internal order recovery passed. Current Windows normal email login, account switch, reload/logout and packaged WebView2 passed; Browser→OS→App payment return, installer lifecycle and Linux native checkout need separate evidence |
| Retry collisions and provider back flow | Real late-payment reconciliation; both charges remain visible; conflict blocks new checkout; multiple provider attempts verified independently, safely canceled/recovered without hiding real payments | Actual two-pending cancel/restart verified; SQL/HTTP race and replay tests passed; hosted concurrency pending |
| Entitlements and free use | Server gates personal cloud upload/read and registered synchronization devices; 5 slots; shared CLI/app identity; unchanged ranking formula; local/free community intact | Hosted sandbox access, device slots and isolation passed; preview regressions passed. After activation, both existing QA accounts retain transition read/upload without paid badges and public leaderboard HTTP200. Private local self-host sync passed separately |
| Gifts | One-time claim, same-account retry, account isolation, expiry, batch disable, independent revoke, no Waffo charge/renewal; active/upcoming gifts block new checkout | Two real sandbox accounts and database concurrency passed; formal handler deployed/source-matched. One live QA gift was redeemed for sidebar/UX acceptance, then its grant revoked and batch disabled with UI/database read-back; That gift recipient QA B still has zero orders/payments; QA A retains its earlier unpaid draft. Windows gift GUI still requires its own evidence |
| Trial and transition | Explicit no-card 7-day start, existing-device 30-day transition, no implicit renewal, accurate dates and 30-day read-only export | Sandbox trial passed; live launch timestamp and two real existing-device transition states verified; genuine web CSV/JSON downloads passed before activation. Future expiry behavior and native export retain their source/device evidence requirements |
| Retention | Validated hot/cold truth, history boundaries, complete export, dry-run impact list, backup restore; no early data deletion | Local SQL and isolated hosted cold-correction/restore evidence exist. Production migration, query budget, erasure/recovery and scheduled activation gates remain pending; no schedule enabled |
| Live payment/refund | Genuine provider transaction matches immutable order, ledger, account and full term; refunds independently checked | Fixed-month USD4.99 payment/full refund passed 2026-10-10, genuine callbacks HTTP200 once each. Other live modes and partial-refund cases retain their own evidence boundaries; earlier sandbox cases remain separately valid |
| Settlement and terms | Approved payout account; provider statement and bank receipt; fees/revenue reconciliation; final renewal/refund/privacy/support terms | Pending |
| Formal pricing and website activation | Owner explicitly approves live pricing/publication; preserve launch_at and verify production catalog, source and checkout URL | Completed 2026-10-10 under explicit Owner authorization; announcement, desktop release and retention/deletion activation remain separate |

Historical Mac gift-stage evidence records 3,846 Node tests passing with three skipped, four architecture checks and 1,169 Dashboard tests. Earlier 3,743/3,818 counts belong to older stages. Current post-integration checks and full CI gaps are listed in [the release handoff](cloud-release-readiness.md); no historical count proves the current merged release candidate.

Local tests do not complete genuine provider, UI, or settlement gates. Every offered route needs its own evidence. A failed or unavailable route must remain unavailable in checkout.

## Historical backup security migration

The production audit on 2026-10-10 found default anonymous/authenticated grants on two legacy device/token backup tables. Migration 20261010000000_secure-legacy-device-backups.sql enables RLS and revokes all client/PUBLIC grants on these exact optional tables. The migration runner owns the transaction. Before/after row counts and administrator SELECT match; four real client HTTP reads are denied and the advisor rescan has zero rls-disabled findings. This is not a data-deletion or archival activation migration. Do not restore the exposed grants during a billing rollback. Remaining server-only RLS/no-policy and cache-performance findings remain separately recorded in the release handoff.

## Rollback and incident handling

1. Read and preserve the live policy and incident timeline, then set its `phase` back to `preview` while retaining `launch_at`. Read back the catalog and confirm new checkout and trial requests are refused. In the current policy, preview restores legacy free personal Cloud access; it does not erase paid terms.
2. Stop only deployed archival/deletion jobs recorded in release evidence. Verify their active flags and subsequent execution logs. Do not delete usage, orders, events, payments, or subscriptions as a rollback step.
3. Keep valid webhook handlers and their verification secrets available so completed payments, refunds, and cancellations can still arrive. If a handler is faulty, restore its reviewed predecessor only if it understands the current schema and preserves payment verification; otherwise fix it forward and reconcile undelivered events. Never grant access from a success-page screenshot or weaken signature/amount checks.
4. Restore the frontend/account gate behavior tested in preview. Preserve local operation, exports and access to already-paid terms. Verify HTTP responses and account state independently after restoration.
5. Compare provider transaction/refund/subscription statements with the ledger. Use provider redelivery or authenticated provider reconciliation with stable IDs; retain duplicate protection. Do not manually duplicate payments or extend terms to compensate for a delayed webhook.
   `POST billing?action=reconcile` accepts the owner's order UUID as `{id}` and queries the provider, with a 30-second per-order cooldown. A new recurring checkout is refused while an earlier created checkout remains unresolved. A provider-confirmed canceled transaction can close an unpaid order. Use the explicit restart endpoint for its unique successor; do not create unrelated replacement orders manually. Any `retry_payment_conflict_at` requires reviewing both payment paths and resolving refunds/subscriptions privately before new checkout is allowed. Full refunds are separate from membership and renewal status; a refund does not itself cancel recurring billing. Account removal must handle recurring subscriptions and retained financial records first; financial FKs prevent silent cascading deletion. The usage erasure runner leaves auth and billing records intact.
6. Decide with the owner how to handle current recurring subscriptions, including any historical provider subscriptions. Setting TokenTracker to preview does not stop provider renewals or refund payments. Any provider cancellation/refund must have its own authorization and independently verified result.
7. Before reactivation, close the incident cause, repeat affected gates, and review transition impact. Do not silently move `launch_at`, shorten export windows, or replay an announcement with obsolete dates.

## Owner actions to collect at the end

- [x] Waffo merchant approval and Store production/receipt permissions were independently verified on 2026-10-08. Reconfirm the selected merchant/store before launch; approval is separate from live products, private keys and payout-account verification.
- [x] Owner confirmed the payout account is added and available; the 2026-10-09 UI check independently shows an existing account. Do not ask for another account or bank details.
- [x] Owner confirmed the existing payout account is associated. The signed production API confirms the correct merchant binding and payoutEnable=true; the authenticated dashboard displays one saved account. The API still reports channelStatus=unverified and channelVerifiedAt=NULL. [Waffo's payout-account guide](https://docs.waffo.ai/merchant/payout-accounts) says a new account becomes Verified after the holder-name check on its first real payout. The current state may therefore reflect the absence of that payout; it alone does not establish a configuration failure. Do not add the account again.
- [x] Owner created the production key and supplied its local file. Production list presence and local RSA 2048 sign/verify passed; the Base64 PKCS#8 download has a normalized PEM and DER pin prepared outside the repository with restricted NTFS ACL. Signed production queries verified key/environment/merchant/Store ownership. Eight Waffo server secrets have been configured and independently read back; no client or reserved backend credentials were changed.
- [x] Engineering read back merchant/Store, production key ownership, four active production products, the formal webhook and payout binding/status. These checks do not verify a live transaction or settlement.
- [ ] Owner confirms contract fees/currency/settlement conditions, then completes and verifies the first real payout once eligible funds are available. Reconcile the channel state if that payout fails or remains abnormal; API credentials stay server-side.
- [x] Owner confirmed USD4.99/month and USD39.99/year before tax, identical for recurring and fixed terms.
- [ ] Confirm actual live checkout tax/payment methods and final renewal/cancellation/refund/privacy/support terms. Retention/deletion still requires its separate reviewed announcement.
- [x] Owner completed the fixed-month live pilot and explicitly authorized full refund; actual provider, ledger, membership and UI results were independently verified. Other live modes and bank/merchant payout are not proved by this case.
- [x] Owner explicitly approved formal prices and production activation on 2026-10-10; production policy, website and a live checkout URL were independently read back. The launch-time zero-payment snapshot is historical; fixed-month payment/full refund later passed. Bank/merchant settlement remains unverified.
- [ ] Publish an announcement or unified desktop release only under its own scope and evidence; no announcement or desktop release was made by the price activation.

Waffo SDK 0.25.0, its integration skill, official MoR information, developer terms and privacy links were checked in the earlier acceptance. Merchant approval and genuine sandbox payment/refund evidence are recorded separately. Live launch and fixed-month payment/full refund have been verified. Other live billing modes, future renewals and bank/merchant settlement retain their own acceptance boundaries; recheck applicable contract fees when reconciling actual revenue.
