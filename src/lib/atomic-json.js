const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function writeJsonAtomicSync(filePath, value) {
  const contents = JSON.stringify(value, null, 2) + "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${crypto.randomUUID()}`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, contents, "utf8");
    fs.closeSync(fd);
    fd = undefined;
    // Replace the final directory entry rather than following a link that
    // appeared after the caller read or checked the previous configuration.
    fs.renameSync(tmp, filePath);
    created = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.unlinkSync(tmp);
  }
}

module.exports = { writeJsonAtomicSync };
