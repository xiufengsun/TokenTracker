# TokenTracker Cloud

TokenTracker Cloud is the optional paid service for officially hosted synchronization and usage history. [Web purchase](https://www.tokentracker.cc/cloud) is available from 2026-10-10 at USD 4.99/month or USD 39.99/year before tax, with the same base price for recurring and fixed-term purchases. Devices registered before the launch retain their 30-day transition until 2026-11-09 at 05:52:14 UTC; free accounts are not automatically charged. [Desktop and CLI version 1.3.3](https://github.com/xiufengsun/TokenTracker/releases/tag/v1.3.3) is publicly available. Historical archival/deletion jobs remain separately controlled. [简体中文](cloud-guide.zh-CN.md)

## What stays free

Local collection, every supported provider, cost estimates, usage limits, local charts, exports, and desktop features remain free and open source. You can keep using TokenTracker without signing in. Local installations are unlimited.

The shared leaderboard, achievements, and basic public profile remain available to free accounts. All accounts use the same ranking formula. Payment adds no scoring bonus and does not make a private profile public; free community uploads update less often than paid Cloud synchronization.

## What Cloud adds

Official hosted synchronization, storage, bandwidth, backups and maintenance require ongoing resources as usage grows. Cloud subscriptions support this service and its continued maintenance; the complete local app remains free and open source.

Cloud is the officially hosted cross-device analytics service. Current capabilities combine device usage in one account, analyze estimated costs by provider/model/device and period, provide web access to retained history and existing exports, and synchronize/manage devices without maintaining a VPS.

One account covers the CLI, macOS, Windows, Linux, and the web dashboard. Cloud supports cross-device synchronization with a 99-device safety cap against abuse, changed usage every 15 minutes while the client is running and online, and access to 90 days of hourly detail and 24 months of daily summaries. CLI and desktop installations sharing a registered machine identity use one slot. This identifies synchronization devices, without hardware attestation. Pausing a device frees its slot and keeps its history; resuming requires an available slot.

Free community uploads use one registered device per account with a bounded daily batch. Local installations remain unlimited. If Cloud expires with several active devices, pause the others and keep one for free community uploads. This retains existing history. The ranking formula is the same for both plans.

Cloud contains usage metrics only. Prompts, responses, code, project and session records, and AI provider credentials stay on your machine. See the [Privacy Policy](PRIVACY.md).

Cross-device monthly reports and budget views are future work, not delivered paid entitlements. Local analysis and exports remain free. Formal purchase is open at the confirmed base prices; actual payment, refund and settlement verification remain separate acceptance work.

## Free self-hosting

Self-hosted software is free under MIT. You pay for your server, domain and backups and maintain the instance yourself. Its accounts and statistics are independent of the official public leaderboard. Hosted device/history limits are service-plan terms, not software-license restrictions.

The complete self-hosted path is currently a technical preview. A clean private application installer and local official-platform authentication/sync/restore have been verified; standard Dashboard instance switching also has actual evidence. Public VPS HTTPS, native routes and a reviewed version upgrade remain pending. Read the [self-hosting guide](self-hosting.md) before attempting deployment; a complete one-command VPS installer is not available.

## Gifted Cloud access

An eligible signed-in account can redeem a privately issued 30-, 90- or 365-day Cloud code in Personal settings → Cloud. A code is claimed once; repeating the same claim does not add another term. The server shows the actual dates and a separate gift history. Gifts do not create Waffo payments or automatic renewal.

Resolve an unfinished payment or active automatic renewal before redeeming. Active or upcoming gifts prevent new paid checkout so the periods do not overlap. Disabling an unclaimed batch and revoking an already claimed gift are different operations. Gift redemption is available to eligible accounts on the official hosted service and unavailable on a free private self-hosted instance.

## Trial and transition

- Eligible accounts can start a seven-day trial without a payment card. It starts when you choose to activate it, and does not become a paid plan automatically.
- Existing users with a registered cloud device before the announced launch receive a 30-day transition from that launch date. Personal settings → Cloud shows the exact end date. We will not charge an existing account automatically.
- When a trial, transition, or paid term ends, new personal Cloud uploads stop. Existing personal Cloud history remains available to read and export for 30 days. Local tracking and the free community features continue.
- After the export window, personal Cloud access follows the disclosed policy. The 90-day hourly and 24-month daily limits describe accessible history. Compressed usage metrics can remain longer to preserve and correct public lifetime statistics. Final storage and deletion schedules will be announced separately; local data is unaffected.

## Prices and renewal

| Payment terms | Monthly base price | Yearly base price | Renewal |
|---|---|---|---|
| Waffo auto-renewal | USD 4.99 | USD 39.99, charged once for the year | Recurring subscription; cancel renewal to stop the next charge |
| Waffo fixed-term access | USD 4.99 | USD 39.99, charged once for the year | Buy another term manually; no automatic debit |

These confirmed USD base prices are the same worldwide and exclude tax. Waffo calculates applicable tax and shows the final total before payment; the final charge can differ by tax jurisdiction. Annual figures are the total annual base charge, not a monthly debit. Waffo provides Merchant of Record services under its terms. [Waffo MoR information](https://www.waffo.ai/features/mor)

Auto-renewal supports cards and Apple Pay or Google Pay where available. Fixed-term checkout supports WeChat or cards where available. The payment methods shown by Waffo are authoritative; this plan does not promise Alipay, a CNY price or a particular conversion rate.

A fixed-term renewal adds to the remaining paid term. Canceling automatic renewal preserves the already-paid term. Cancellation and refund are separate actions; canceling does not refund a payment. The published Terms of Service describe refunds; private billing support is rynnsun0509@gmail.com.

Manage a current subscription before buying another plan. A fixed paid term must end before starting a recurring subscription, to avoid overlapping charges. Historical purchases retain their original payment provider and currency.

In account billing, Waffo customers can open the [consumer portal](https://pancake.waffo.ai/consumer/portal/login) for bills and subscription management. Sign in using the email entered at checkout. This is a separate Waffo sign-in, not automatic access from the TokenTracker session.

## When payment is interrupted

Web checkout opens a separate tab and keeps the TokenTracker order page available. Native apps open the Waffo payment page in your system browser. Keep the same TokenTracker account signed in on the purchase page and in the app. Confirm payment only in Waffo's hosted interface, using one of the methods it displays.

After paying, return to the app or account page and refresh the membership status. The server verifies payment before it activates Cloud. A success screen or closed browser window does not establish whether money was received.

If the account is still awaiting confirmation, check the existing order before creating another one. A Waffo page can become unavailable after buyer details are submitted even when payment failed. Return to the TokenTracker order page and use "Close checkout and try again" only if it is still unpaid. The server checks the original payment, closes the unpaid checkout and creates its linked replacement. A successful or processing payment cannot restart. Keep the order reference and payment receipt.

If both the original and replacement orders receive payment, TokenTracker shows a duplicate-charge notice. Review the bills and contact private support before paying again. Already verified payment and membership remain visible; the notice does not mean a refund has happened. Do not post receipts, email addresses, account identifiers, or transaction details in a public GitHub issue; the private billing support route must be published before launch.

## More information

[Product specification](cloud-subscriptions.md) · [Merchant configuration and launch checks](cloud-billing-operations.md) · [Community announcement draft](cloud-announcement-draft.md)
