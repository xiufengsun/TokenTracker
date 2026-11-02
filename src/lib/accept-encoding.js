// Pick a content encoding from an Accept-Encoding header. Keep this shared
// between the static file server and the JSON API so both agree on q-values,
// explicit identity exclusions and the "*" wildcard.
function parseAcceptEncoding(header) {
  const values = String(header || "").toLowerCase().split(",");
  const explicit = new Map();
  let wildcard = null;
  for (const raw of values) {
    const parts = raw.trim().split(";");
    const name = parts.shift()?.trim();
    if (!name) continue;
    let quality = 1;
    for (const part of parts) {
      const [key, value] = part.trim().split("=");
      if (key === "q") {
        const parsed = Number.parseFloat(value);
        quality = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    const normalized = name === "x-gzip" ? "gzip" : name;
    if (normalized !== "br" && normalized !== "gzip" && normalized !== "identity" && normalized !== "*") continue;
    if (normalized === "*") {
      wildcard = Math.max(wildcard ?? 0, quality);
      continue;
    }
    explicit.set(normalized, Math.max(explicit.get(normalized) ?? 0, quality));
  }
  return { explicit, wildcard };
}

function selectEncoding({ explicit, wildcard }) {
  let best = null;
  let bestQuality = 0;
  for (const name of ["br", "gzip"]) {
    const quality = explicit.has(name) ? explicit.get(name) : wildcard;
    if (quality !== null && quality > bestQuality) {
      best = name;
      bestQuality = quality;
    }
  }
  return best;
}

function acceptsIdentity({ explicit, wildcard }) {
  if (explicit.has("identity")) return explicit.get("identity") > 0;
  if (wildcard !== null) return wildcard > 0;
  return true;
}

function pickEncoding(header) {
  return selectEncoding(parseAcceptEncoding(header));
}

function negotiateEncoding(header) {
  const parsed = parseAcceptEncoding(header);
  return { encoding: selectEncoding(parsed), identityAllowed: acceptsIdentity(parsed) };
}

module.exports = { pickEncoding, negotiateEncoding };
