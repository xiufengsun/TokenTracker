// Unified device/scope Select helpers (issue 979 follow-up).
// The Select folds This device / per-device / Account-wide into one control.
// Choosing a value only overrides the rendered data scope — cloud uploads keep
// following the persisted sync preference via AccountViewContext.scopeOverride.

export const DEVICE_FILTER_LOCAL_SCOPE = "__scope:local__";

/** Map a unified device/scope Select value to scopeOverride + deviceId. */
export function resolveUnifiedDeviceFilterChange(value) {
  if (value === DEVICE_FILTER_LOCAL_SCOPE) {
    return { scopeOverride: "local", deviceId: null };
  }
  if (!value) {
    return { scopeOverride: null, deviceId: null };
  }
  if (String(value).startsWith("local:")) {
    return { scopeOverride: "local", deviceId: value };
  }
  return { scopeOverride: null, deviceId: value };
}

/** Select value that mirrors the current scope + device filter selection. */
export function unifiedDeviceFilterValue({ accountScopeSwitchable, accountView, selectedDevice }) {
  if (!accountScopeSwitchable) return selectedDevice || "";
  if (selectedDevice) return selectedDevice;
  return accountView ? "" : DEVICE_FILTER_LOCAL_SCOPE;
}
