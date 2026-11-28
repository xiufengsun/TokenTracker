export const CUSTOM_CREDIT_CONFIG_CHANGED = "tokentracker:custom-credit-config-changed";
let localRevision = 0;

// Use only an opaque revision in request keys. Tabs share its persisted part;
// the counter also works in WebViews where storage is unavailable.
export function customCreditRequestRevision(): string {
  let shared = "";
  try { shared = window.localStorage.getItem(CUSTOM_CREDIT_CONFIG_CHANGED) ?? ""; } catch { /* restricted storage */ }
  return localRevision + ":" + shared;
}

export function invalidateCustomCreditUsage(): void {
  if (typeof window === "undefined") return;
  localRevision++;
  try { window.localStorage.setItem(CUSTOM_CREDIT_CONFIG_CHANGED, crypto.randomUUID()); } catch { /* restricted storage */ }
  window.dispatchEvent(new Event(CUSTOM_CREDIT_CONFIG_CHANGED));
}

export function subscribeCustomCreditChanges(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_CREDIT_CONFIG_CHANGED) onChange();
  };
  window.addEventListener(CUSTOM_CREDIT_CONFIG_CHANGED, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CUSTOM_CREDIT_CONFIG_CHANGED, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
