// Copy the public aggregate response byte-for-byte, including large token counts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const cli = ["--yes", "cf@1.0.0-rc.4"];
const database = process.argv[2];
assert.match(database ?? "", /^[a-f\d-]{36}$/i, "Pass the staging D1 database UUID");
const source = "https://srctyff5.function2.insforge.app/tokentracker-community-models";
const response = await fetch(source, { redirect: "error" });
assert.equal(response.status, 200);
const payload = await response.text();
const snapshot = JSON.parse(payload);
assert.equal(snapshot.period, "total");
assert.ok(Number.isFinite(Date.parse(snapshot.generated_at)));
assert.ok(Array.isArray(snapshot.top_models));
const schema = readFileSync(new URL("../migrations/0001_community_snapshot.sql", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "tt-community-"));

function query(statements) {
  const file = join(dir, "query.json");
  writeFileSync(file, JSON.stringify(statements), { mode: 0o600 });
  const output = execFileSync("npx", [...cli, "d1", "query", database, "--batch", "@" + file],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(output);
  assert.ok(result.length > 0 && result.every(entry => entry.success));
  return result;
}

try {
  query([{ sql: schema }, {
    sql: `INSERT INTO community_snapshot (id, generated_at, payload) VALUES ('total', ?, ?)
          ON CONFLICT(id) DO UPDATE SET generated_at = excluded.generated_at, payload = excluded.payload
          WHERE julianday(excluded.generated_at) >= julianday(community_snapshot.generated_at)`,
    params: [snapshot.generated_at, payload],
  }]);
  const [readback] = query([{ sql: "SELECT payload FROM community_snapshot WHERE id = 'total'" }]);
  assert.equal(readback.results[0]?.payload, payload, "Target snapshot differs from the fetched source");
  console.log(JSON.stringify({ generated_at: snapshot.generated_at, bytes: Buffer.byteLength(payload),
    sha256: createHash("sha256").update(payload).digest("hex") }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
