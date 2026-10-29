# WorkBuddy subscription quota

WorkBuddy China and WorkBuddy AI use separate local authenticated proxies:
`~/.workbuddy/wbipc/endpoint.json` and `~/.workbuddy-ai/wbipc/endpoint.json`.
`WORKBUDDY_HOME` and `WORKBUDDY_AI_HOME` override the respective directories.
The UI exposes each edition as its own **WorkBuddy** / **WorkBuddy AI** row with
its own visibility switch; balances from different accounts are never added or
compared. The pre-split era folded both editions into one `workbuddy` switch:
stored preferences without an explicit `workbuddyAi` value inherit that unified
switch, so nobody's rows silently appear or disappear across the upgrade.

The desktop app must be running and signed in. TokenTracker authenticates the
local peer with the discovery ticket and the broker's HMAC challenge, then calls
`wb.request` / `http.fetch`. WorkBuddy supplies its own backend credentials;
encrypted desktop access tokens do not need to be decrypted or exported.

Only three read-only billing operations are exposed by this integration:

- `POST /billing/meter/get-user-resource-summary`
- `POST /billing/meter/get-user-resource-paid-packages`
- `POST /billing/meter/get-user-resource-free-packages`

Each edition renders two windows, mirroring the desktop app's own split. The
plan window is the subscription's base credits (套餐基础积分) with that
package's `CycleEndTime` as the reset. The resource-package window pools every
non-plan credit group from the summary's `CreditGroups` — 套餐赠送积分, 购买积分
and 平台奖励积分 — and carries no reset, because those grants have no shared
cycle. Both windows carry `used_credits`, `limit_credits` and
`remaining_credits` for hover details, displayed to at most two decimal
places; a group that omits its remaining count contributes `total - used` to
the pool, and a group that omits its usage count is derived as `total - remain`
in the same spirit. An exhausted plan (total > 0) stays visible at 100% used; an empty
0/0 pool yields no window at all, so the UI drops it like a missing window.
Summaries that predate `CreditGroups` fall back to pooling every summary
package row that cannot be the subscription plan. Requests and sockets
are cancelled when the usage-limits provider budget expires. Tickets, backend
credentials and full API responses are never persisted or logged. Legacy
plaintext sessions and manually configured `WORKBUDDY_ACCESS_TOKEN` /
`WORKBUDDY_AI_ACCESS_TOKEN` remain available when no desktop proxy is discovered.

## English plan names and provenance

An English `SubscriptionPackageName` or `PackageName` returned by the API is
preserved verbatim. The real China API response checked on 2026-10-21 returned
`SubscriptionPackageName: "体验版"`, `PackageName: "CodeBuddy个人体验版"`, and no
English-name field. Do not describe an English fallback as an API-returned name.

For localized responses, the fallback labels are copied from the official
WorkBuddy Desktop 5.8.3 bundle:

- `renderer/assets/edition-config-BLwrE-d8.js`: `getEditionConfigMap`, including
  its China/international and English-language branches.
- `renderer/assets/common-DRZ6FwkK.js`: `resolveEditionFromResources` and its
  package-code mapping.

| Edition | China English UI | International UI branch |
| --- | --- | --- |
| `free` | `Free` | `Free` |
| `pro` | `STANDARD` | `Pro` |
| `pro_trial` | `STANDARD TRIAL` | `Pro-Trial` |
| `youth` | `Youth` | `Youth` |
| `advanced` | `Advanced` | `Advanced` |
| `flagship` | `Ultimate` | `Ultimate` |

This means China's `TCACA_code_008_cfWoLwvjU4` is shown as `Free`, not an invented
`Trial` label. Unknown localized packages stay unnamed until an official English
name is available. English casing and punctuation survive limits aggregation and
render the same way in the dashboard and macOS menu bar, regardless of UI locale.

China Desktop 5.8.3 was verified against the live signed-in billing proxy. The
international transport and edition isolation are covered by a local broker
fixture; a live international account has not been tested.
