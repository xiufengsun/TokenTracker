# Cloud subscriptions

This document tracks the Cloud subscription work. The plans below are proposed; payment availability and a launch date will be announced after checkout, fulfillment, and merchant onboarding are verified.

## Product boundaries

Local tracking, provider integrations, cost estimates, limits, desktop features, and local exports remain free and open source. A Cloud membership belongs to one TokenTracker account and works across the CLI, macOS, Windows, Linux, and web dashboard.

| | Free | Cloud |
|---|---|---|
| Local features | Complete | Complete |
| Local installations | Unlimited | Unlimited |
| Community | Shared leaderboard, achievements, and basic public profile | Same ranking rules |
| Personal cloud dashboard | Seven-day trial | Included |
| Cross-device aggregation | Seven-day trial | Up to five physical machines |
| Cloud synchronization | Daily community batches | Changed data every 15 minutes |
| Cloud history | Basic public summaries | 90 days of hourly detail and 24 months of daily summaries |
| China pricing | Free | CNY 29/month or CNY 249/year |
| International pricing | Free | USD 5.99/month or USD 49/year |

The server determines membership and limits. A successful checkout redirect cannot grant access. Cloud synchronization contains usage metrics, not prompts, provider credentials, code, or local session and project records.

## Payment flows

- Mainland China: WeChat Native and Alipay web checkout purchase a fixed membership term. Renewals extend the existing paid term and do not enable automatic debits.
- International: Paddle hosted checkout supports monthly and yearly subscriptions. Canceling renewal preserves the already-paid term.
- Verified provider callbacks bind to a server-created order. Fulfillment validates merchant identity, currency, amount or price, payment state, account ownership, and provider environment.
- Duplicate callbacks must not extend access twice. Late events must not resurrect canceled or refunded access. Failed processing must remain retryable.
- Checkout uses the system browser in native clients. Membership refreshes after returning, and also when the purchase page regains focus. Users can recover a paid order when the return link is lost.

## Experience requirements

Use the existing TokenTracker typography, emerald accent, controls, and light/dark themes. Reference established open-source product pricing and account-management flows for clarity and interaction patterns, without replacing the product's visual identity.

- Pricing explains the Cloud benefit before listing features. Free remains a clearly available choice.
- Monthly/yearly and CNY/USD selectors show the actual charge and term. Annual prices show the total billed amount; discounts are calculated from the displayed prices.
- Trial requires no payment card. Explain the trial end date, retained local functionality, and Cloud history limits before starting.
- Checkout states distinguish creating an order, awaiting payment, payment received, and activating membership. Closing a payment window does not imply failure.
- Account settings show status, expiration or renewal date, device allowance, payment history, and the relevant cancellation or renewal action.
- Over-limit devices can be reviewed and removed without affecting local tracking. Errors preserve context and offer a specific recovery action.
- Existing cloud accounts receive 30 days of transition. Expiration preserves a disclosed read-only/export window before Cloud retention takes effect.
- Verify keyboard focus, accessible labels, reduced motion, narrow screens, desktop webviews, and both themes. Do not use false urgency, hidden renewal terms, or forced subscription consent.

## Delivery and verification

1. Add the order/event/membership schema and transactional RPCs with restricted privileges and ownership RLS.
2. Implement Paddle, WeChat, and Alipay checkout, callbacks, refunds, cancellation, reconciliation, and operational configuration.
3. Connect pricing, trial, checkout recovery, billing settings, and native return flows to the server's membership state.
4. Enforce device, read, upload, and retention rules; reduce shared leaderboard refresh and repetitive account reads.
5. Update privacy, user documentation, community announcement drafts, and deployment/rollback instructions.
6. Validate financial invariants using a real PostgreSQL runtime, then verify provider sandbox transactions against an isolated backend and the actual UI.
7. Finish merchant registrations, configure approved live credentials, and verify a real checkout and settlement with the owner before activating production charging.

An unavailable merchant account is a remaining launch requirement, not evidence that the payment integration works. Production charging, historical deletion, and publication of the community announcement remain separate launch actions.
