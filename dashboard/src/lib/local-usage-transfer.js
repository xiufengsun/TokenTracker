import { clearLocalApiAuthToken, getLocalApiAuthHeaders } from "./local-api-auth";

export const LOCAL_USAGE_CHANGED_EVENT = "tokentracker:local-usage-changed";
export const LOCAL_USAGE_MAX_BYTES = 5 * 1024 * 1024;

// Pick one metric for the displayed scope, matching resolveDisplayTokens.
// Choosing separately for each device would inflate mixed zero-billable views.
export function localDeviceUsage(devices, accountSources, selectedDevice = "") {
  const scope = selectedDevice ? devices.filter((device) => device.id === selectedDevice) : [...devices, ...accountSources];
  const billable = scope.some((row) => Number(row.billable_total_tokens) > 0);
  const display = (row) => ({ ...row, total_tokens: billable ? row.billable_total_tokens ?? row.total_tokens : row.total_tokens });
  return { devices: devices.map(display), accountSources: accountSources.map(display) };
}

async function request({ action, ...values } = {}, retry = true) {
  const query = new URLSearchParams();
  if (!action) for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== "") query.set(key, String(value));
  }
  const response = await fetch(`/api/local-usage${query.size ? `?${query}` : ""}`, {
    method: action ? "POST" : "GET", cache: "no-store",
    headers: { ...await getLocalApiAuthHeaders(), "Content-Type": "application/json" },
    ...(action ? { body: JSON.stringify({ action, ...values }) } : {}),
  });
  if (response.status === 401 && retry) {
    clearLocalApiAuthToken();
    return request({ action, ...values }, false);
  }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.code || "transfer_failed"), { code: data.code });
  return data;
}

export function localUsageAction(action, values = {}) { return request({ action, ...values }); }
export function readLocalUsageDevices({ from, to, timeZone, tzOffsetMinutes } = {}) {
  return request({ from, to, tz: timeZone, tz_offset_minutes: tzOffsetMinutes });
}
