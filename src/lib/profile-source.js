"use strict";

// A split profile is filed under "<provider>@<profile>" (see scan-roots.js).
// The provider part still selects parser behaviour, pricing and backend
// attribution, so code that asks "is this Claude?" must compare baseSource(),
// not the full source name. "@" cannot appear in an existing source name and is
// not the "|" that bucket keys are split on.

const PROFILE_SOURCE_SEPARATOR = "@";

function isProfileSource(source) {
  return typeof source === "string" && source.includes(PROFILE_SOURCE_SEPARATOR);
}

// "claude@work" -> "claude"; any other value is returned unchanged.
function baseSource(source) {
  if (typeof source !== "string") return source;
  const at = source.indexOf(PROFILE_SOURCE_SEPARATOR);
  return at === -1 ? source : source.slice(0, at);
}

// The profile part of "claude@work" ("work"), or null for a plain source.
function profileOfSource(source) {
  if (!isProfileSource(source)) return null;
  return source.slice(source.indexOf(PROFILE_SOURCE_SEPARATOR) + 1) || null;
}

module.exports = {
  PROFILE_SOURCE_SEPARATOR,
  baseSource,
  isProfileSource,
  profileOfSource,
};
