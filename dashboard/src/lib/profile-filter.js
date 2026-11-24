import { copy } from "./copy";
import { formatProviderDisplayName } from "./provider-display";

// A provider that was split into profiles reports one source per profile
// ("claude@work"), next to the plain "claude" for its native directory. These
// helpers turn the sources the breakdown reports into the options of the
// dashboard's Profile selector. See src/lib/profile-source.js for the naming.

const SEPARATOR = "@";

function providerOf(sourceId) {
  const at = sourceId.indexOf(SEPARATOR);
  return at === -1 ? sourceId : sourceId.slice(0, at);
}

function normalizeIds(sources) {
  const list = Array.isArray(sources) ? sources : [];
  return list.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
}

// The source ids that belong to a provider that has at least one profile
// source, sorted so a provider's native entry comes before its profiles.
export function profileSourceIds(sources) {
  const ids = [...new Set(normalizeIds(sources))];
  const split = new Set(ids.filter((id) => id.includes(SEPARATOR)).map(providerOf));
  return ids.filter((id) => split.has(providerOf(id))).sort();
}

// Remembers every profile seen so far. A period with no usage for a profile
// must not make the selector (or the chosen profile) disappear.
export function mergeKnownProfiles(known, seen) {
  const merged = new Set([...normalizeIds(known), ...normalizeIds(seen)]);
  const next = [...merged].sort();
  const same = Array.isArray(known) && known.length === next.length && known.every((id, i) => id === next[i]);
  return same ? known : next;
}

// Select options, or [] when there is nothing to choose between (fewer than two
// sources), so the selector stays hidden for everyone who did not split.
export function buildProfileOptions(ids) {
  const list = normalizeIds(ids);
  if (list.length < 2) return [];
  return [
    { value: "", label: copy("dashboard.profile_filter.all") },
    ...list.map((id) => ({
      value: id,
      label: id.includes(SEPARATOR)
        ? formatProviderDisplayName(id)
        : copy("dashboard.profile_filter.default", { provider: formatProviderDisplayName(id) }),
    })),
  ];
}
