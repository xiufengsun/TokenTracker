# Privacy Policy

_Last updated: 2026-10-04 · Applies to the `tokentracker-cli` npm package, the macOS app, the Windows app, the Linux app, and [www.tokentracker.cc](https://www.tokentracker.cc)._

TokenTracker reads the local logs that AI coding tools already write to your disk, and turns them into token counts and cost estimates. It is local-first: the dashboard, the parsers and the database all run on your machine.

Cloud billing is being developed. The billing entries below describe the planned flow and do not mean paid checkout or Cloud history retention is already active in production. See the [Cloud guide](cloud-guide.md) for the proposed limits and transition rules.

This document lists **every** network request the software can make, what each one sends, and how to switch it off. If you find a request that is not listed here, that is a bug — please [open an issue](https://github.com/xiufengsun/TokenTracker/issues).

---

## 1. What never leaves your machine

TokenTracker's parsers extract numbers and timestamps only. TRAE Work CN is a narrow exception to the local-only source model, and it is off by default: only when you explicitly set `TOKENTRACKER_TRAE_CN_USAGE=1`, during an eligible non-background sync, when local TRAE Work CN auth exists, does TokenTracker transmit the existing sign-in authorization from the locally signed-in app to TRAE's internal API for a read-only usage request. Without that variable nothing is ever sent. It is not an unconditional or default generic network request. That authorization is never persisted or logged.

**Never retained as usage data or uploaded to TokenTracker:**

- **Prompts, responses, and conversation bodies** — TokenTracker may parse local tool files containing conversation records to extract usage metrics, but prompt and response texts are never persisted, collected, or transmitted
- **File contents** from your projects
- **Commit messages and diffs** — Git attribution runs `git log` locally, uses the subject line only to detect reverts, and keeps nothing
- **API keys, cookies, and session tokens** belonging to your AI providers are never persisted or logged by TokenTracker

**Recorded locally, never uploaded:**

- **File paths, project names, and repository names.** The Projects view needs to know which repo a session belonged to, so `project.queue.jsonl` stores a project key and git remote URL, and `session.queue.jsonl` stores each session's working directory. Both files stay on your machine — they are excluded from cloud sync (see §4) and the Projects view is computed entirely locally. Set `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` to stop deriving them at all.

You can verify this in [`src/lib/rollout.js`](../src/lib/rollout.js): every `parse*Incremental` function emits only the queue row shapes described below.

---

## 2. What is stored locally

Everything lives under `~/.tokentracker/` (`%USERPROFILE%\.tokentracker\` on Windows):

| Path | Contents |
|---|---|
| `tracker/queue.jsonl` | Append-only hourly buckets: source, model, token counts, timestamp |
| `tracker/project.queue.jsonl` | The same hourly buckets, split per project: git remote URL and `owner/repo` key. Never uploaded |
| `tracker/session.queue.jsonl` | Per-session token totals and timing for the Sessions view, plus each session's working directory. Never uploaded |
| `tracker/cursors.json` | Read offsets so parsing stays incremental |
| `tracker/config.json` | Your preferences |
| `tracker/*-usage-limits-cache.json` | Last successful quota reading per provider, so a timeout shows stale bars instead of an error |
| `pets/`, `skills/`, `cache/` | Desktop pet assets, skill index, misc caches |

To erase everything TokenTracker knows about you, delete that directory. `tokentracker uninstall` additionally removes the hooks it installed into your AI tools.

---

## 3. Network requests

### 3.1 Enabled by default

| Request | Destination | What is sent | Frequency |
|---|---|---|---|
| **Anonymous heartbeat** | `srctyff5.us-east.insforge.app` | A one-way hash of the machine id, plus the app version, OS platform, and app shell (`cli` / `macos` / `windows` / `linux`) as separate plain fields. Nothing else. | At most once per day |
| **Dashboard analytics** | `us.i.posthog.com` (PostHog) | Pageviews and explicitly instrumented feature events, plus which shell you use. Autocapture and session recording are **off**; browser Do-Not-Track is respected. | While the dashboard is open |
| **Provider quota reads** | The provider's own API (`api.anthropic.com`, `chatgpt.com`, `cursor.com`, `api.github.com`, `api.kimi.com`, `api.z.ai`, `qoder.com`, `qoder.com.cn`, `openapi.qoder.sh`, `openapi.qoder.com.cn`, `cloudcode-pa.googleapis.com`, …) | Whatever that provider's own endpoint requires, authenticated with the credentials **that provider already stored on your machine**. These requests go directly from your machine to the provider — they never pass through our servers, and we never see the response. | While quota bars are visible |
| **TRAE Work CN usage read** | TRAE's internal API | Transmits the existing sign-in authorization from the locally signed-in TRAE Work CN app to TRAE; reads usage metadata only. TokenTracker never persists or logs the auth token or prompt/response content. | Off unless you set `TOKENTRACKER_TRAE_CN_USAGE=1`; then during eligible non-background sync when local TRAE Work CN auth exists |
| **GitHub star count** | `api.github.com` | Nothing but the request itself (public repo metadata) | On dashboard load |
| **Update check** | `api.github.com` | Nothing but the request itself | Windows: once at launch. macOS: only when you click "Check for Updates" |
| **Pricing data refresh** | `raw.githubusercontent.com` | Nothing but the request itself (public model pricing JSON from BerriAI/litellm) | At most once every 24 hours when the local pricing cache is missing or stale |

Both telemetry items are disabled together by a single switch:

```bash
export TOKENTRACKER_NO_TELEMETRY=1     # or DO_NOT_TRACK=1
```

You can also set `"telemetry": false` in `~/.tokentracker/tracker/config.json`. On localhost and inside the desktop apps, the dashboard asks the local server for this preference before initialising analytics — and if the answer cannot be confirmed, analytics stays **off** (fail-closed).

Audit: [`src/lib/telemetry.js`](../src/lib/telemetry.js), [`dashboard/src/lib/analytics.js`](../dashboard/src/lib/analytics.js), [`src/lib/pricing/litellm-fetcher.js`](../src/lib/pricing/litellm-fetcher.js).

### 3.2 Only after you opt in or click something

| Request | Destination | What is sent | Trigger |
|---|---|---|---|
| **Devin quota read** | `server.codeium.com` (Devin's official `GetPlanStatus` RPC) | An empty JSON body, authenticated with the Devin CLI session token already stored on your machine. The token is never persisted or logged by TokenTracker. | Off by default — only while the Devin provider switch in Settings → Usage & Limits → Providers is on, and only on a locally authenticated request |
| **Cloud sync / leaderboard** | `srctyff5.us-east.insforge.app` | Hourly buckets only — see §4 | Signing in to a TokenTracker account |
| **Cloud billing (planned)** | TokenTracker backend | Signed-in account, plan, provider, order reference, and requests to read membership or payment history | Choosing trial, checkout, or account billing after launch |
| **Payment checkout (planned)** | Waffo Pancake hosted checkout | Order and opaque account references, environment, plan and amount/currency to bind payment to membership. You enter your purchase email and payment/billing details in Waffo's interface. No usage buckets or AI provider credentials are sent | Explicitly choosing paid Cloud checkout after launch |
| **Exchange rates** | `open.er-api.com` | Nothing but the request itself | Selecting a non-USD display currency |
| **Desktop pet download** | `codex-pets.net` | The pet id you chose | Importing a pet from a link |
| **IP check page** | `ip.net.coffee`, `claude.ai`, `1.1.1.1` | Your IP address is, by design, what these endpoints observe — that page exists to tell you how providers see your network | Opening the IP Check page |
| **Service status page** | Provider status pages (`status.claude.com`, `status.openai.com`, `status.cursor.com`, …) | Nothing but the request itself | Opening the Service Status page |
| **Share card fonts** | `fonts.googleapis.com` | Standard web-font request; Google can see your IP address | Generating a share image |

### 3.3 Never

- No request contains prompt text, responses, file contents, paths, or project names.
- We operate no ad network, no data broker integration, and no cross-site tracking.
- We do not sell or rent your data. The service providers listed below process the information needed for the features you use, as described in this policy.

---

## 4. Cloud account and leaderboard

Signing in is **entirely optional**. TokenTracker is fully functional without an account; the leaderboard, cross-device aggregation, badges and public profiles are the only features that require one.

**Sent when signed in:**

- Hourly usage buckets, each containing exactly: `hour_start`, `source`, `model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_creation_input_tokens`, `reasoning_output_tokens`, `total_tokens`, `conversation_count`
- A machine id at device-registration time, so usage from several computers can be merged into one account without double-counting
- The email address and display name from your OAuth provider (GitHub or Google)

**Not sent, ever:**

- Prompts, responses, file contents, project or repository names, file paths
- Local session records — `session.queue.jsonl` stays on your machine
- Per-project breakdowns — `project.queue.jsonl` is never uploaded
- Any provider credential

**Public visibility:** your profile appears on the public leaderboard only while `Settings → Account → Public profile` is on. Turning it off removes you from the leaderboard and turns badges into a "private" placeholder.

**Deleting cloud data:** contact us via [GitHub issues](https://github.com/xiufengsun/TokenTracker/issues) and we will remove the account and its usage rows. Deleting `~/.tokentracker/` removes the local copy immediately. Do not include receipts or other billing information in a public issue.

### 4.1 Cloud billing and retention (planned)

Billing will keep a minimal ledger linked to the TokenTracker account: plan/provider/environment, order and provider transaction/subscription references, amount/currency, payment and refund status, membership dates, linked original/retry order references, payment-conflict flags, and normalized event IDs/times used to prevent duplicate fulfillment. TokenTracker does not receive or store card numbers, security codes, payment passwords, or AI provider credentials. Contextual Cloud explanations reuse existing account responses. Their per-account/scenario dismissal dates implement a local seven-day cooldown and remain until browser storage is cleared or updated; this adds no analytics events or periodic network requests. Waffo processes checkout, payer, billing and fraud-prevention information under its [privacy policy](https://www.waffo.ai/privacy). Its consumer portal uses the email entered at purchase and requires separate sign-in; TokenTracker does not issue a portal login session. A verified callback and provider reconciliation update our ledger, not the checkout success page. Historical payment records retain their original provider and currency.

Planned personal Cloud access covers 90 days of hourly usage and 24 months of daily summaries. After a trial, transition or paid term expires, new personal Cloud uploads stop and existing history remains readable/exportable for 30 days. Compressed usage metrics can remain longer to preserve and correct public lifetime statistics. These limits do not imply deletion of the underlying metrics or local files. Final storage and deletion schedules will be disclosed before archival/deletion is activated.

Usage deletion and billing-record retention are different requests. Any transaction records required for accounting, refunds or disputes will follow the applicable retention requirements disclosed at launch. Payment providers may retain records they are legally required to keep; deleting TokenTracker usage cannot promise deletion of those provider records. Deleting usage or signing out does not cancel a recurring Waffo subscription or any historical subscription with another provider. Cancel renewal separately through the billing flow. Final retention terms and a private billing support route must be available before paid checkout launches.

---

## 5. Third parties

| Service | Role | Their policy |
|---|---|---|
| InsForge | Backend for accounts, cloud sync, leaderboard, heartbeat | [github.com/InsForge](https://github.com/InsForge) |
| PostHog | Anonymous product analytics | [posthog.com/privacy](https://posthog.com/privacy) |
| Vercel | Hosting for www.tokentracker.cc | [vercel.com/legal/privacy-policy](https://vercel.com/legal/privacy-policy) |
| GitHub | Source hosting, releases, OAuth, star counts, upstream pricing data (`raw.githubusercontent.com`) | [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement) |
| Google | OAuth sign-in, fonts on share cards | [policies.google.com/privacy](https://policies.google.com/privacy) |
| Waffo Pancake (planned) | New Cloud checkout, recurring/fixed-term purchases, MoR, consumer bills, payment/refund callbacks | [Waffo Privacy Policy](https://www.waffo.ai/privacy) |
| Paddle (historical compatibility only) | Existing subscription, payment/refund records and notifications; no new purchase route | [Paddle Privacy Policy](https://www.paddle.com/legal/privacy) |
| Direct WeChat Pay (historical compatibility only) | Existing Native payment/refund records and notifications | [WeChat Pay service agreement](https://posts.tenpay.com/posts/cbddf0af6088c4080432b952163ea238.html) |
| Direct Alipay (historical compatibility only) | Existing web/WAP payment/refund records and notifications | [Alipay agreements and privacy policy](https://render.alipay.com/p/c/17qjvbnlkcw0) |

AI providers whose quota endpoints TokenTracker reads (Anthropic, OpenAI, Cursor, GitHub Copilot, Google, Moonshot, Z.ai, Qoder, Devin, …) are governed by their own policies. TokenTracker acts on your behalf with credentials already on your machine; it does not create any new relationship with them.

---

## 6. Turning things off

| Variable | Effect |
|---|---|
| `TOKENTRACKER_NO_TELEMETRY=1` | Disables the daily heartbeat **and** dashboard analytics |
| `DO_NOT_TRACK=1` | Same as above (respects the standard) |
| `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` | Stops TokenTracker running `git log` inside your project directories |

Signing out removes cloud sync. Not signing in means it never starts.

---

## 7. Children

TokenTracker is a developer tool and is not directed at children under 13. We do not knowingly collect personal information from children.

## 8. Changes

Material changes to this policy will be noted in the release notes and in the `Last updated` date above. The full history is in [this file's Git log](https://github.com/xiufengsun/TokenTracker/commits/main/docs/PRIVACY.md).

## 9. Contact

Questions, corrections, or deletion requests: [github.com/xiufengsun/TokenTracker/issues](https://github.com/xiufengsun/TokenTracker/issues)
