const ZCODE_RESET_STATUS_URL = "https://zcode.z.ai/api/v1/coding-plan/reset/status";

function normalizeZcodeResetCredits(body, { nowMs = Date.now() } = {}) {
  if (body?.code !== 0 || !body.data) {
    throw new Error("Could not parse ZCode reset credits: invalid response");
  }
  const result = {};
  for (const [key, field] of [
    ["five_hour", "available_five_hour_resets"],
    ["weekly", "available_week_resets"],
  ]) {
    if (!Array.isArray(body.data[field])) {
      throw new Error("Could not parse ZCode reset credits: missing card list");
    }
    result[key] = body.data[field].map((card) => {
      const expiresMs = card?.expire_at;
      if (typeof expiresMs !== "number" || !Number.isFinite(expiresMs) || expiresMs <= 0
        || !Number.isFinite(new Date(expiresMs).getTime())) {
        throw new Error("Could not parse ZCode reset credits: invalid expiry");
      }
      return { expires_at: new Date(expiresMs).toISOString() };
    }).filter((card) => Date.parse(card.expires_at) > nowMs)
      .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  }
  return result;
}

/** Read inventory only; send the two login tokens exclusively to ZCode's fixed status endpoint. */
async function fetchZcodeResetCredits({
  zcodeToken, codingPlanToken, teamContext, fetchImpl = fetch, nowMs = Date.now(), timeoutMs = 2000,
}) {
  const headers = {
    Authorization: /^Bearer\s/i.test(zcodeToken) ? zcodeToken : `Bearer ${zcodeToken}`,
    "X-Bigmodel-Authorization": codingPlanToken,
    "Bigmodel-Target-Type": teamContext ? "TEAM" : "PERSONAL",
    Accept: "application/json",
  };
  if (teamContext) {
    headers["Bigmodel-Organization"] = teamContext.organizationId;
    headers["Bigmodel-Project"] = teamContext.projectId;
  }
  const controller = new AbortController();
  let timer;
  try {
    const request = Promise.resolve().then(async () => {
      const response = await fetchImpl(ZCODE_RESET_STATUS_URL, {
        // Custom auth headers survive cross-origin redirects; never forward them.
        method: "GET", headers, signal: controller.signal, redirect: "error",
      });
      if (!response.ok) throw new Error(`ZCode reset credits API returned HTTP ${response.status}`);
      const body = await response.json();
      if (body?.code !== 0) throw new Error(`ZCode reset credits API error: code=${body?.code ?? "unknown"}`);
      return normalizeZcodeResetCredits(body, { nowMs });
    });
    return await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("ZCode reset credits request timed out"));
      }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchZcodeResetCredits, normalizeZcodeResetCredits };
