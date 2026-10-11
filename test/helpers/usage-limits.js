const limits = require("../../src/lib/usage-limits");

/**
 * A temporary home does not isolate the desktop keyring. Default to a keyring
 * miss; individual tests can supply secretToolRunner with fixture credentials.
 */
function withoutHostKeyring(fn) {
  return (options = {}) => fn({
    secretToolRunner: () => ({ status: 1, stdout: "" }),
    ...options,
  });
}

module.exports = {
  ...limits,
  getUsageLimits: withoutHostKeyring(limits.getUsageLimits),
  fetchAntigravityLimits: withoutHostKeyring(limits.fetchAntigravityLimits),
  loadAntigravityCredentials: withoutHostKeyring(limits.loadAntigravityCredentials),
};
