# TokenTracker — Design System

Derived from `dashboard/src/styles.css` + `dashboard/tailwind.config.cjs`. Tailwind utility classes use the `oai-*` token names.

## Color (OKLCH, green-tinted neutrals, hue 145)

- **Neutrals** `oai-gray-50…950`: every neutral is tinted toward green (chroma ~0.005–0.03, hue 145). Surfaces, borders, text. Dark mode inverts the ramp; dashboard defaults dark.
- **Brand accent**: emerald — `--oai-blue: #059669` (token name is legacy; the brand is green), light `#10b981`, dark `#047857`. Exposed as `oai-brand` utilities. Used for primary action, current selection, cost figure, and "you/me" highlight only. Restrained: accent ≤10% of surface.
- **Semantic**: success `#10b981`, warning `#f59e0b`, error `#ef4444`, info `#059669`.
- Never `#000`/`#fff`: base black `#0a0a0a`, white `#fafafa`.
- Per-provider category colors come from `getProviderColor()` (data-viz only, in distribution bars/charts).

### Cloud surfaces

Cloud plans, checkout, self-host guidance, and the membership card use a scoped
`.tt-cloud-theme` graphite palette. Primary actions remain black in light mode
and off-white in dark mode. Borders, savings badges, links, hover states, and
avatar fallbacks use neutral grays. Focus uses a visible two-pixel outline in
both themes. Existing dashboard and provider colors remain unchanged.

Cloud benefits describe implemented account-wide analysis, hosted history, and
managed synchronization. Self-host is a separate free software option with
server costs and operations handled by the user; its complete deployment flow
is labeled as a technical preview until it has been verified on a fresh VPS.

Cloud management lives in Personal settings → Cloud. The page title, membership
status, and expiry share a compact unbordered row that wraps on narrow screens.
One plain secondary sentence combines the membership state and its date;
avoid status capsules and explanatory icons in this header. Transition, trial,
gifted, active, and expired access retain accurate distinct wording, while
renewal controls and device help remain in their own sections.
Devices have a separate card. Subscription, billing, export, code redemption, and Cloud
synchronization share one settings card: subscription is its first navigation row;
three consistent task rows open
mutually exclusive dialogs, followed by the synchronization switch. Billing
uses a wider dialog; export and redemption stay compact. Each dialog has one
title, keyboard dismissal and focus restoration, with content retained during
its close animation. Closing export cancels pending work; redemption cannot
close during a request and retains its receipt on reopening.
Card contents use the same horizontal padding as Account settings. Function rows
use 44px targets with 8px vertical card padding; device cards use 12px vertical
padding and compact two-line rows with 6px above and below each device.
Users without a recurring subscription go directly to plans; subscribers get one
management entry that opens their provider portal. Avoid duplicate plan or dashboard links.
The page heading uses spacing rather than a divider above the first card.
Device rows align the icon with the device name; platform and recent sync time
share a compact second line. Pending orders and verified payments share the
billing ledger's date, amount, and status columns. Manual order lookup appears
on demand at the bottom of that ledger; gift history belongs to the redemption
dialog. Keep provider and membership state authoritative when presenting actions.
Export reuses the Dashboard range calendar, with two months on desktop and one
on narrow screens. Draft dates apply together or cancel together. The download
buttons use the same compact 32px height as the calendar's footer actions.

The `.tt-cloud-settings` scope uses the existing system sans for headings,
labels, controls, and IDs: 13px metadata, 14px body, 18px section headings, and
24px page headings, expressed in rem. Numerals use tabular figures. The settings
navigation is 11rem wide on desktop; mobile keeps horizontal scrolling tabs.

## Typography

- **Sans**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …` (system stack, `font-oai`). One family carries everything.
- **Mono**: `"SF Mono", SFMono-Regular, ui-monospace, Menlo, …` (`font-mono`) for token counts, terminal-style copy, IDs.
- Numbers use `tabular-nums`.
- Fixed rem-ish scale (Tailwind `text-xs … text-7xl`); product UI uses fixed steps, NOT fluid clamp headings. The one giant metric is the exception and must be width-bounded.

## Layout & components

- Card primitive: `Card` (single border + subtle elevation). No nested cards.
- Responsive shell: desktop sidebar `hidden lg:flex`; mobile drawer + `MobileTopBar` (hamburger) `lg:hidden`. Content scrolls inside `div.flex-1.overflow-y-auto`.
- Breakpoints: Tailwind defaults (`sm`=640, `md`=768, `lg`=1024). Phone target 360–430px.
- Motion: `motion/react`, ease-out, 150–250ms, state-conveying only. Respect `prefers-reduced-motion`.

## Mobile structural rules (this project)

- Tab/segment groups: single horizontal-scroll row, never `flex-wrap` into stacks.
- Big metric: cap with `clamp()`/responsive font so it never clips at 360px.
- Data tables: collapse secondary columns below `sm`; keep the key metric on-screen (no horizontal scroll for core data). Detail goes to the profile/expand view.
- Touch targets ≥40px; tap feedback via `active:` states.
