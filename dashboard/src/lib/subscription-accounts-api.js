import { clearLocalApiAuthToken, getLocalApiAuthHeaders } from "./local-api-auth";

export async function accountRequest({ id, loginId, body } = {}) {
  const query = loginId ? `?loginId=${encodeURIComponent(loginId)}` : id ? `?id=${encodeURIComponent(id)}` : "";
  const url = `/functions/tokentracker-subscription-accounts${query}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await getLocalApiAuthHeaders();
    const response = await fetch(url, {
      method: body ? "POST" : "GET", cache: "no-store",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...auth },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 && attempt === 0) { clearLocalApiAuthToken(); continue; }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error("account_request_failed");
    return data;
  }
}
