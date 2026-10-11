# Cloud subscriptions

This document tracks the Cloud subscription work. Production web purchase was activated on 2026-10-10 at USD4.99/month or USD39.99/year before tax, equal for recurring and fixed-term purchases. One genuine fixed-month payment and its full refund have been verified; recurring/yearly financial flows, actual settlement and native-device acceptance retain their separate evidence requirements. User-facing terms are in the [Cloud guide](cloud-guide.md) ([简体中文](cloud-guide.zh-CN.md)); operational gates are in the [billing runbook](cloud-billing-operations.md), and the [community announcement](cloud-announcement-draft.md) remains a review draft. The unified desktop and CLI release v1.3.3 is now public; remaining physical-native and financial acceptance stays separate.

The user-facing service is named TokenTracker Cloud (云服务). Legacy internal `pro` identifiers remain compatible with existing entitlements and receipts. Current evidence and release blockers are in the [release handoff](cloud-release-readiness.md). The [gift specification](pro-gift-codes.md) adds 30/90/365-day account grants with no provider payment or renewal, single-claim protection and checkout exclusion for active/upcoming gifts.

## Product boundaries

Local tracking, provider integrations, cost estimates, limits, desktop features, and local exports remain free and open source. Cloud is the officially managed cross-device analytics service. A membership belongs to one account and works across the CLI, macOS, Windows, Linux, and web dashboard.

There are three ways to use the product. Local is ready and free. Managed Cloud hosts account aggregation and history. Self-hosted software is free under MIT, with the owner paying for their VPS and maintaining it; the complete self-hosted installation remains a technical preview until its bootstrap, routing and real deployment checks pass. See the [self-hosting guide](self-hosting.md) ([简体中文](self-hosting.zh-CN.md)).

| | Free | Cloud |
|---|---|---|
| Local features | Complete | Complete |
| Local installations | Unlimited | Unlimited |
| Community | Shared leaderboard, achievements, and basic public profile | Same ranking rules |
| Personal cloud dashboard | Seven-day trial | Included |
| Cross-device aggregation | Seven-day trial | Cross-device sync; 99-device safety cap against abuse |
| Cloud synchronization | Daily community batches | Changed data every 15 minutes |
| Cloud history | Basic public summaries | 90 days of hourly detail and 24 months of daily summaries |
| Cross-device analysis | Per-device local charts | Combined usage, cost estimates, provider/model breakdowns and device filters |
| Hosted operations | No server needed for local use | Managed API and web access, without maintaining a personal VPS |
| Global base pricing | Free | USD 4.99/month or USD 39.99/year, before tax |
| Payment terms | No payment required | Same base price for recurring or fixed-term access |

The server determines membership and limits. A successful checkout redirect cannot grant access. Cloud synchronization contains usage metrics, not prompts, provider credentials, code, or local session and project records.

Free community uploads use one registered synchronization device per account and a daily bounded batch. Local installations remain unlimited. After Cloud expires, users with several active cloud devices choose one for free community uploads by pausing the others; their existing history remains intact. Ranking uses the same formula for free and Cloud accounts.

## Payment flows

- New purchases use Waffo Pancake hosted checkout through the server-only `@waffo/pancake-ts@0.25.0` SDK. The same USD base prices apply worldwide; Waffo calculates applicable taxes and displays the final charge before payment. These prices are active production prices confirmed by the Owner.
- Recurring monthly/yearly plans support cards and, where available, Apple Pay or Google Pay. Canceling renewal preserves the already-paid term.
- Fixed monthly/yearly passes use one-time checkout, supporting WeChat or cards where available. Another purchase extends the remaining paid term without automatic debits. The hosted checkout determines the methods actually offered; no Alipay or CNY exchange-rate commitment is made.
- Historical Paddle, direct WeChat and Alipay records remain readable and processable under their original provider. They are not new-purchase options and must not be relabeled Waffo.
- Verified provider callbacks bind to a server-created order. Fulfillment validates merchant identity, currency, amount or price, payment state, account ownership, and provider environment.
- Duplicate callbacks must not extend access twice. Late events must not resurrect canceled or refunded access. Failed processing must remain retryable.
- Checkout-session consumption does not prove payment. After decline, explicit safe retry closes a verified unpaid order and creates one linked replacement, reusing a persisted retry request after network failure. Successful or processing payments cannot silently start another subscription.
- A successful late payment on the predecessor can create a real duplicate-charge conflict. Keep both financial records, show the conflict, block further checkout and require private support reconciliation. Multiple provider attempts are individually bound and verified; actual test Back/replacement and cancellation-before-retry have passed. Unverified or processing payments remain blocked.
- Web checkout opens a new tab with `noopener,noreferrer`; native clients use the system browser. The owned purchase page stays available for status checks. Membership refreshes after returning or regaining focus. Users can recover a paid order when the return link is lost.
- Waffo billing uses its consumer portal. Users sign in with the email used at checkout; TokenTracker does not issue a portal session or promise automatic login.

## Experience requirements

Use the existing TokenTracker typography, controls and light/dark themes. At the owner's request, Cloud plans, checkout, membership and self-hosting use a scoped graphite/monochrome palette, including their shell selections. Existing unrelated product screens keep their current styling.

Present Cloud value in three groups: cross-device analysis, hosted history/export, and ongoing synchronization/device management. Show free self-hosting as an explicit alternative with its technical-preview status and operating responsibilities. Do not sell the self-hosted software license or apply hosted device safety caps to the eventual self-hosted license.

- Pricing explains the Cloud benefit before listing features. Free remains a clearly available choice.
- Monthly/yearly and auto-renewal/fixed-term selectors show the USD base price and term. Annual prices show the total annual base charge; the monthly equivalent is secondary. Explain that taxes and the final amount are shown at checkout.
- Trial requires no payment card. Explain the trial end date, retained local functionality, and Cloud history limits before starting.
- Checkout states distinguish creating an order, awaiting payment, payment received, and activating membership. Closing a payment window does not imply failure.
- Personal settings → Cloud shows status, expiration or renewal date, device allowance, payment history, and the relevant cancellation or renewal action.
- Devices can be paused and explicitly resumed without deleting their local or cloud history. Errors preserve context and offer a specific recovery action. The allowance counts registered synchronization identities; it is not hardware attestation.
- Existing cloud accounts with a device registered before launch receive 30 days of transition from the announced launch date. Trial, transition, and paid-term expiration stop personal Cloud uploads and preserve 30 days of read-only/export access. Retention and historical deletion require their own verified rollout and prior notice.
- Show membership explanations only after deliberate personal Cloud actions. Never open a startup sales modal or place payment gates on the free leaderboard. Reuse existing responses instead of extra polling, show sales CTAs only for verified live availability, and remember dismissals per account for at least seven days. Paid users receive date/device notices, not sales prompts.
- Verify keyboard focus, accessible labels, reduced motion, narrow screens, desktop webviews, and both themes. Do not use false urgency, hidden renewal terms, or forced subscription consent.

### Reference decisions

- [Bitwarden's personal plans](https://bitwarden.com/pricing/) distinguish the billed annual amount from a monthly equivalent. TokenTracker will give the actual annual charge greater emphasis and keep the free local option visible alongside Cloud.
- [PostHog's pricing](https://posthog.com/pricing) explains the free allowance and when payment is needed. TokenTracker will state what stays local and free before requesting sign-in, and explain Cloud limits before trial activation.
- [Plausible's hosting model](https://plausible.io/self-hosted-web-analytics) separates open-source self-hosting from managed service value. TokenTracker will charge for hosted aggregation and history while keeping the software's local functionality complete.

## Delivery and verification

1. Add the order/event/membership schema and transactional RPCs with restricted privileges and ownership RLS.
2. Integrate Waffo checkout, verified callbacks, refunds, cancellation, reconciliation, and operational configuration while preserving historical provider records.
3. Connect pricing, trial, checkout recovery, billing settings, and native return flows to the server's membership state.
4. Enforce device, read, upload, and retention rules; reduce shared leaderboard refresh and repetitive account reads.
5. Update privacy, user documentation, community announcement drafts, and deployment/rollback instructions.
6. Validate financial invariants using a real PostgreSQL runtime, then verify provider sandbox transactions against an isolated backend and the actual UI.
7. Merchant approval, signed production credential/Store checks, four published live products, formal webhook and payout binding are complete. The Owner explicitly authorized formal-price activation on 2026-10-10; the production website/catalog and a real SDK-created unpaid checkout URL were verified. Actual payment/refund, paid billing periods and bank settlement remain separate acceptance work; the launch flag is not financial proof. See [current evidence](cloud-release-readiness.md).

An unavailable merchant account is a remaining launch requirement, not evidence that the payment integration works. Production charging, historical deletion, and publication of the community announcement remain separate launch actions.

## Pricing and future benefits

The Owner confirmed global USD4.99/month and USD39.99/year base prices on 2026-10-09, with tax added by checkout. Recurring and fixed-term modes have the same base price. Formal web purchase was activated under explicit authorization on 2026-10-10, with launch_at=2026-10-10T05:52:14.603712+00:00 and existing-device transition ending 30 days later. No free account is automatically charged. Production transaction/settlement evidence, desktop release, archival/deletion and announcement remain separate. Track measured per-account cost and Waffo fees; update the server catalog, provider products and UI together if prices change later.

The next low-cost benefit to evaluate is a cross-device monthly report with period comparisons and a downloadable summary, calculated from the existing aggregates in the client. A cross-device budget view can follow. These are planned work, not current paid entitlements. Local charts, local reports/exports and local alerts must remain available without a hosted subscription. AI-generated advice, emailed reports, team seats and priority response guarantees are not implemented or promised.
