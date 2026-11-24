"use strict";
const fs = require("node:fs");
const path = require("node:path");
// Run the actual shared Edge implementation in the existing import-free VM harnesses.
function inlineCostProvenance(source) {
  return source.replace(/^import .* from "\.\/cloud\/cost-provenance\.ts";$/m, () =>
    fs.readFileSync(path.join(__dirname, "../../dashboard/edge-patches/cloud/cost-provenance.ts"), "utf8")
      .replace(/^import type .*;$/m, "").replace(/\bexport /g, ""));
}
module.exports = { inlineCostProvenance };
