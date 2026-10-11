function parseBearerToken(authorization) {
  // Match only the prefix so an all-whitespace header cannot make two
  // overlapping quantifiers repeatedly backtrack over the same characters.
  const value = String(authorization || "");
  const prefix = /^Bearer[ \t]+/i.exec(value);
  if (!prefix) return null;
  const token = value.slice(prefix[0].length);
  return token && !/[\r\n]/.test(token) ? token : null;
}

module.exports = { parseBearerToken };
