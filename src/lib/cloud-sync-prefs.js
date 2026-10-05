const fs = require("node:fs");
const path = require("node:path");

// The dashboard mirrors saved choices here. Missing or invalid preferences
// must never enable automatic uploads merely because credentials exist.
function readCloudSyncEnabled(trackerDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(trackerDir, "cloud-sync-pref.json"), "utf8"))?.enabled === true;
  } catch {
    return false;
  }
}

module.exports = { readCloudSyncEnabled };
