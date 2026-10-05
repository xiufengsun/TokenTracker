const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function validBinding(binding) {
  return ["userId", "baseUrl", "machineId"].every(
    (key) => typeof binding?.[key] === "string" && binding[key].length > 0,
  );
}

// A successful auth refresh supplies the binding. This file never imports a
// CLI config token, whose owner may belong to another signed-in account.
function createCloudDeviceTokenStore(filePath) {
  let loaded = false;
  let entry = null;

  function load() {
    if (loaded) return entry;
    loaded = true;
    let fd;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!fs.fstatSync(fd).isFile()) return null;
      fs.fchmodSync(fd, 0o600);
      const data = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (data?.version === 1 && validBinding(data) && typeof data.token === "string" && data.token) entry = data;
    } catch { /* missing or invalid cache requires ordinary issuance */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return entry;
  }

  function clear(binding) {
    if (binding && (!validBinding(binding) || ["userId", "baseUrl", "machineId"].some((key) => load()?.[key] !== binding[key]))) return;
    loaded = true;
    entry = null;
    try { fs.unlinkSync(filePath); } catch { /* cache may not exist */ }
  }

  return {
    get(binding) {
      if (!validBinding(binding)) return null;
      const value = load();
      if (!value) return null;
      if (value.userId !== binding.userId) {
        clear();
        return null;
      }
      return value.baseUrl === binding.baseUrl && value.machineId === binding.machineId ? value.token : null;
    },
    set(binding, token) {
      if (!validBinding(binding) || typeof token !== "string" || !token) return false;
      const value = { version: 1, userId: binding.userId, baseUrl: binding.baseUrl, machineId: binding.machineId, token };
      if (JSON.stringify(load()) === JSON.stringify(value)) return true;
      loaded = true;
      entry = value;
      const tmp = `${filePath}.tmp.${crypto.randomUUID()}`;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, filePath);
        return true;
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* no temporary file to remove */ }
        return false;
      }
    },
    invalidate(token) {
      if (typeof token === "string" && token && load()?.token === token) clear();
    },
    clear,
  };
}

module.exports = { createCloudDeviceTokenStore };
