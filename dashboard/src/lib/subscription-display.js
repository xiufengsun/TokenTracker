import { copy } from "./copy";

// Shared billing-cycle helpers for the subscription rows: the settings popover
// and the inline subscription bars on the Limits page render identical
// progress/remaining values from these functions.
//
// All calendar math runs in UTC on purpose: nextBillingAt is stored as a UTC
// ISO string, so deriving cycle bounds with local-time getters would make the
// same record render different progress depending on the viewer's time zone
// (and flip across DST transitions).

const DAY_MS = 86400000;

// Calendar months in UTC with day-of-month clamping, so Jan 31 + 1 month is
// Feb 28/29 (not Mar 2/3) and the anchor day never drifts across cycles.
export function addMonthsUtc(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()),
  );
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.getTime();
}

function cycleStartMs(endMs, cycle) {
  if (cycle === "weekly") return endMs - 7 * DAY_MS;
  if (cycle === "yearly") return addMonthsUtc(endMs, -12);
  // Monthly: the calendar month ending at endMs, day clamped so Mar 31 maps
  // back to Feb 28/29 instead of rolling into March.
  const end = new Date(endMs);
  const daysInPrevMonth = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0),
  ).getUTCDate();
  const start = new Date(
    Date.UTC(
      end.getUTCFullYear(),
      end.getUTCMonth() - 1,
      1,
      end.getUTCHours(),
      end.getUTCMinutes(),
    ),
  );
  start.setUTCDate(Math.min(end.getUTCDate(), daysInPrevMonth));
  return start.getTime();
}

// The cycle a subscription is currently in. Auto-renew records roll forward
// past recorded renewals (the plan keeps renewing until cancelled), so an
// expired date shows the current cycle instead of a permanently red 100% bar
// contradicting its own "Auto-renew" badge. Non-renewing records stop at the
// recorded expiry — `expired` is true only there.
export function cycleView(subscription, now) {
  const recordedEndMs = new Date(subscription.nextBillingAt).getTime();
  if (!Number.isFinite(recordedEndMs)) return null;
  const cycle = ["weekly", "monthly", "yearly"].includes(subscription.cycle)
    ? subscription.cycle
    : "monthly";

  let endMs = recordedEndMs;
  if (subscription.autoRenew && endMs <= now) {
    if (cycle === "weekly") {
      const span = 7 * DAY_MS;
      // At least one week: when now lands exactly on endMs, ceil() alone
      // adds zero weeks and the record would render as a stuck 100% bar.
      endMs += Math.max(1, Math.ceil((now - endMs) / span)) * span;
    } else {
      const step = cycle === "yearly" ? 12 : 1;
      // Bounded for safety; a record millennia in the past still terminates.
      for (let i = 0; i < 12000 && endMs <= now; i += 1) {
        endMs = addMonthsUtc(endMs, step);
      }
    }
  }

  const startMs = cycleStartMs(endMs, cycle);
  const span = Math.max(1, endMs - startMs);
  const progress = Math.max(0, Math.min(1, (now - startMs) / span));
  return {
    endMs,
    startMs,
    progress,
    cycleDays: Math.max(1, Math.round(span / DAY_MS)),
    expired: !subscription.autoRenew && recordedEndMs <= now,
  };
}

// Compact right-hand label, same vocabulary as the limits bar ("6d", "17h").
// Deliberately locale-independent: the shared time keys translate to verbose
// past-tense strings ("X天前"), which is wrong for a remaining duration.
// Takes the effective end (already rolled for auto-renew) from cycleView.
export function remainingLabel(endMs, now) {
  const diff = endMs - now;
  if (diff <= 0) return copy("subscriptions.expired");
  const totalMinutes = Math.ceil(diff / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

export function countdownText(endMs, now) {
  const diff = endMs - now;
  if (diff <= 0) return copy("subscriptions.expired");
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return copy("subscriptions.countdown", { days, hours, minutes });
}
