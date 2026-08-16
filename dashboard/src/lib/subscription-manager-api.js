import { getLocalApiAuthHeaders } from "./local-api-auth";

// Manual subscription manager API (GitHub issue 460). Local CLI only — the store
// lives next to queue.jsonl on the machine running the server; there is no
// cloud counterpart.

async function payload(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `Subscription request failed with HTTP ${response.status}`);
  }
  return data;
}

export async function listSubscriptions() {
  const response = await fetch("/functions/tokentracker-subscription-manager", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await payload(response);
  return Array.isArray(data.subscriptions) ? data.subscriptions : [];
}

async function mutate(body) {
  const auth = await getLocalApiAuthHeaders();
  return payload(await fetch("/functions/tokentracker-subscription-manager", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...auth },
    cache: "no-store",
    body: JSON.stringify(body),
  }));
}

export function createSubscription(subscription) {
  return mutate({ action: "create", subscription });
}

export function updateSubscription(id, subscription) {
  return mutate({ action: "update", id, subscription });
}

export function deleteSubscription(id) {
  return mutate({ action: "delete", id });
}
