const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const initSqlJs = require("sql.js");
const { resolveTraeDbPaths, readTraeUsageRows } = require("../src/lib/trae-db");

const KEY = "a1".repeat(32); // Synthetic test key.
const ENV = { TOKENTRACKER_TRAE_SQLCIPHER_KEY: KEY };
let sql;

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trae-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(contexts, { reserve = false } = {}) {
  sql ||= initSqlJs();
  const SQL = await sql;
  const db = new SQL.Database();
  try {
    db.run(`PRAGMA page_size = 4096;
      CREATE TABLE chat_turn (id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT,
        created_at INTEGER, updated_at INTEGER, context TEXT);
      CREATE TABLE history_v2 (token_usage INTEGER);`);
    db.run("INSERT INTO history_v2 VALUES (987654321)");
    for (const [i, context] of contexts.entries()) {
      db.run("INSERT INTO chat_turn VALUES (?, ?, ?, ?, ?, ?)", [
        i + 1, "synthetic-session", `synthetic-turn-${i + 1}`, 1770000000000 + i,
        1770000000100 + i, typeof context === "string" ? context : JSON.stringify(context),
      ]);
    }
    const bytes = Buffer.from(db.export());
    if (reserve) {
      // Allocate SQLCipher's reserved trailer in this small synthetic SQLite
      // fixture. All fixture pages are leaf b-trees without overflow/freeblocks.
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        const header = offset + (offset === 0 ? 100 : 0);
        assert.equal(bytes[header], 13);
        assert.equal(bytes.readUInt16BE(header + 1), 0);
        const count = bytes.readUInt16BE(header + 3);
        const content = bytes.readUInt16BE(header + 5);
        assert.ok(content - 80 > header - offset + 8 + count * 2);
        bytes.copy(bytes, offset + content - 80, offset + content, offset + 4096);
        bytes.fill(0, offset + 4016, offset + 4096);
        bytes.writeUInt16BE(content - 80, header + 5);
        for (let i = 0; i < count; i++) {
          const pointer = header + 8 + 2 * i;
          bytes.writeUInt16BE(bytes.readUInt16BE(pointer) - 80, pointer);
        }
      }
      bytes[20] = 80;
    }
    return bytes;
  } finally { db.close(); }
}

function encrypt(plaintext, hexKey = KEY) {
  const key = Buffer.from(hexKey, "hex");
  const salt = Buffer.alloc(16, 0x35);
  const hmacKey = crypto.pbkdf2Sync(key, Buffer.from(salt.map((byte) => byte ^ 0x3a)), 2, 32, "sha512");
  const encrypted = Buffer.alloc(plaintext.length);
  for (let offset = 0; offset < plaintext.length; offset += 4096) {
    const number = offset / 4096 + 1;
    const start = number === 1 ? 16 : 0;
    const iv = Buffer.alloc(16, number);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    if (number === 1) salt.copy(encrypted);
    cipher.update(plaintext.subarray(offset + start, offset + 4016)).copy(encrypted, offset + start);
    cipher.final();
    iv.copy(encrypted, offset + 4016);
    const pageId = Buffer.alloc(4);
    pageId.writeUInt32LE(number);
    crypto.createHmac("sha512", hmacKey).update(encrypted.subarray(offset + start, offset + 4032))
      .update(pageId).digest().copy(encrypted, offset + 4032);
  }
  return encrypted;
}

function makeWal(frames, { bigEndian = false } = {}) {
  const bytes = Buffer.alloc(32 + frames.length * 4120);
  bytes.writeUInt32BE(bigEndian ? 0x377f0683 : 0x377f0682, 0);
  bytes.writeUInt32BE(3007000, 4);
  bytes.writeUInt32BE(4096, 8);
  bytes.writeUInt32BE(33, 16);
  bytes.writeUInt32BE(71, 20);
  let a = 0, b = 0;
  const update = (buffer) => {
    for (let i = 0; i < buffer.length; i += 8) {
      a = (a + (bigEndian ? buffer.readUInt32BE(i) : buffer.readUInt32LE(i)) + b) >>> 0;
      b = (b + (bigEndian ? buffer.readUInt32BE(i + 4) : buffer.readUInt32LE(i + 4)) + a) >>> 0;
    }
  };
  update(bytes.subarray(0, 24));
  bytes.writeUInt32BE(a, 24);
  bytes.writeUInt32BE(b, 28);
  frames.forEach(({ page, number, commit = 0 }, i) => {
    const offset = 32 + i * 4120;
    bytes.writeUInt32BE(number, offset);
    bytes.writeUInt32BE(commit, offset + 4);
    bytes.subarray(16, 24).copy(bytes, offset + 8);
    page.copy(bytes, offset + 24);
    update(bytes.subarray(offset, offset + 8));
    update(page);
    bytes.writeUInt32BE(a, offset + 16);
    bytes.writeUInt32BE(b, offset + 20);
  });
  return bytes;
}

function allPages(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    result.push({ number: offset / 4096 + 1, page: bytes.subarray(offset, offset + 4096) });
  }
  result.at(-1).commit = result.length;
  return result;
}

function context(input = 100) {
  return {
    model_name: "gpt-5.2",
    token_usage: { prompt_tokens: input, completion_tokens: 20, cache_read_input_tokens: 80, total_tokens: input + 20 },
  };
}

test("TRAE discovery uses only international live databases on each platform", (t) => {
  const dir = temp(t);
  for (const platform of ["win32", "darwin", "linux"]) {
    const parent = platform === "win32" ? path.join(dir, "AppData", "Roaming")
      : platform === "darwin" ? path.join(dir, "Library", "Application Support") : path.join(dir, ".config");
    for (const name of ["Trae", "TRAE SOLO", "Trae CN", "TRAE SOLO CN"]) {
      const root = path.join(parent, name, "ModularData", "ai-agent");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "database.db"), "live");
      fs.writeFileSync(path.join(root, "database_decrypted.db"), "stale");
    }
    assert.deepEqual(resolveTraeDbPaths({}, { platform, home: dir }), ["Trae", "TRAE SOLO"].map((name) =>
      path.join(parent, name, "ModularData", "ai-agent", "database.db")));
  }
  const custom = path.join(dir, "custom", "ModularData", "ai-agent");
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, "database_decrypted.db"), "stale");
  assert.deepEqual(resolveTraeDbPaths({ TOKENTRACKER_TRAE_HOME: path.join(dir, "custom") }), []);
  const explicit = path.join(custom, "database_decrypted.db");
  assert.deepEqual(resolveTraeDbPaths({ TOKENTRACKER_TRAE_DB: explicit }), [explicit]);
});

test("TRAE reader projects structured usage without message bodies or scalar history snapshots", async (t) => {
  const dir = temp(t), file = path.join(dir, "database.db");
  const first = context();
  first.prompt = "PRIVATE PROMPT MUST NEVER APPEAR";
  first.token_usage.private_data = first.prompt;
  first.persist_user_message_context = { model_info: { display_model_name: "GPT-5.2", model_name: "internal" }, user_message: first.prompt };
  const second = context(200);
  second.persist_user_message_context = { model_info: { display_model_name: "-", model_name: "gpt-5.3" } };
  fs.writeFileSync(file, await fixture([first, second, "bad json", { token_usage: 9000 }, { token_usage: { prompt_tokens: -1 } }]));
  const original = fs.readFileSync(file);
  const result = await readTraeUsageRows(file, { env: {} });
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {
    id: "1", session_id: "synthetic-session", turn_id: "synthetic-turn-1", created_at: 1770000000000,
    updated_at: 1770000000100,
    model: "GPT-5.2", usage: context().token_usage,
  });
  assert.equal(result[1].model, "gpt-5.3");
  assert.equal(result[2].usage, null);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(dir), ["database.db"]);
});

test("TRAE reader preserves structured zero usage for corrections and rejects invalid token fields", async (t) => {
  const file = path.join(temp(t), "database.db");
  const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const invalidValues = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "PRIVATE TOKEN TEXT", true,
    { message: "PRIVATE TOKEN OBJECT" }, ["PRIVATE TOKEN ARRAY"]];
  fs.writeFileSync(file, await fixture([
    { token_usage: zero },
    ...invalidValues.map((value) => ({ token_usage: { ...zero, prompt_tokens: value, completion_tokens: 10 } })),
  ]));
  const result = await readTraeUsageRows(file, { env: {} });
  assert.equal(result.length, invalidValues.length + 1);
  assert.deepEqual(result[0].usage, zero);
  assert.equal(result[0].model, "trae-unknown");
  assert.ok(result.slice(1).every((row) => row.usage === null));
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("TRAE reader accepts explicit null optional counters without discarding the turn", async (t) => {
  const file = path.join(temp(t), "database.db");
  fs.writeFileSync(file, await fixture([{ token_usage: {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    cache_read_input_tokens: null, cache_creation_input_tokens: null, reasoning_tokens: null,
  } }]));
  assert.deepEqual((await readTraeUsageRows(file, { env: {} }))[0].usage,
    { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
});

test("TRAE reader reports unsupported schemas but accepts an empty chat_turn table", async (t) => {
  const file = path.join(temp(t), "database.db");
  fs.writeFileSync(file, await fixture([]));
  assert.deepEqual(await readTraeUsageRows(file, { env: {} }), []);
  const SQL = await sql;
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    db.run("DROP TABLE chat_turn");
    fs.writeFileSync(file, db.export());
  } finally { db.close(); }
  await assert.rejects(readTraeUsageRows(file, { env: {} }), /chat_turn table is missing/);
});

test("TRAE reader decrypts authenticated SQLCipher pages entirely in memory", async (t) => {
  const dir = temp(t), file = path.join(dir, "database.db");
  fs.writeFileSync(file, encrypt(await fixture([context()], { reserve: true })));
  const before = fs.readFileSync(file);
  const result = await readTraeUsageRows(file, { env: ENV });
  assert.equal(result.length, 1);
  assert.equal(result[0].usage.prompt_tokens, 100);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(dir), ["database.db"]);
});

test("TRAE reader uses the shared application key and honors an explicit override", async (t) => {
  const file = path.join(temp(t), "database.db");
  const applicationKey = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";
  fs.writeFileSync(file, encrypt(await fixture([context()], { reserve: true }), applicationKey));
  assert.equal((await readTraeUsageRows(file, { env: {} }))[0].usage.prompt_tokens, 100);
  assert.equal((await readTraeUsageRows(file, { env: { TOKENTRACKER_TRAE_SQLCIPHER_KEY: "  " } }))[0].usage.prompt_tokens, 100);
  await assert.rejects(readTraeUsageRows(file, { env: ENV }), /authentication failed/);
  // The explicit key takes precedence for custom installations.
  fs.writeFileSync(file, encrypt(await fixture([context(200)], { reserve: true })));
  assert.equal((await readTraeUsageRows(file, { env: ENV }))[0].usage.prompt_tokens, 200);
});

test("TRAE reader rejects malformed and incorrect keys without exposing them", async (t) => {
  const file = path.join(temp(t), "database.db");
  fs.writeFileSync(file, encrypt(await fixture([context()], { reserve: true })));
  await assert.rejects(readTraeUsageRows(file, { env: {} }), /TOKENTRACKER_TRAE_SQLCIPHER_KEY/);
  await assert.rejects(readTraeUsageRows(file, { env: { TOKENTRACKER_TRAE_SQLCIPHER_KEY: "z".repeat(64) } }), /64 hex/);
  const wrongKey = "b2".repeat(32);
  await assert.rejects(readTraeUsageRows(file, { env: { TOKENTRACKER_TRAE_SQLCIPHER_KEY: wrongKey } }), (err) => {
    assert.match(err.message, /authentication failed/);
    assert.ok(!err.message.includes(wrongKey));
    return true;
  });
});

test("TRAE reader authenticates later pages and rejects truncated encrypted files", async (t) => {
  const file = path.join(temp(t), "database.db");
  const bytes = encrypt(await fixture([context()], { reserve: true }));
  bytes[4200] ^= 1;
  fs.writeFileSync(file, bytes);
  await assert.rejects(readTraeUsageRows(file, { env: ENV }), /authentication failed/);
  fs.writeFileSync(file, bytes.subarray(0, bytes.length - 1));
  await assert.rejects(readTraeUsageRows(file, { env: ENV }), /truncated/);
});

for (const encrypted of [false, true]) {
  for (const bigEndian of [false, true]) {
    test(`TRAE WAL replay uses latest committed usage (encrypted=${encrypted}, bigEndian=${bigEndian})`, async (t) => {
      const dir = temp(t), file = path.join(dir, "database.db");
      const make = async (input) => {
        const bytes = await fixture([context(input)], { reserve: encrypted });
        return encrypted ? encrypt(bytes) : bytes;
      };
      const initial = await make(100), committed = await make(200), pending = await make(300);
      fs.writeFileSync(file, initial);
      const wal = makeWal([...allPages(committed), ...allPages(pending).map((frame) => ({ ...frame, commit: 0 }))], { bigEndian });
      fs.writeFileSync(`${file}-wal`, wal);
      const result = await readTraeUsageRows(file, { env: ENV });
      assert.equal(result[0].usage.prompt_tokens, 200);
      assert.deepEqual(fs.readFileSync(file), initial);
      assert.deepEqual(fs.readFileSync(`${file}-wal`), wal);
      assert.equal(fs.readdirSync(dir).length, 2);
    });
  }
}

test("TRAE WAL rejects corrupted complete frames and ignores incomplete uncommitted tails", async (t) => {
  const file = path.join(temp(t), "database.db");
  const initial = await fixture([context()]), committed = await fixture([context(200)]);
  fs.writeFileSync(file, initial);
  const wal = makeWal(allPages(committed));
  fs.writeFileSync(`${file}-wal`, Buffer.concat([wal, Buffer.alloc(19, 1)]));
  assert.equal((await readTraeUsageRows(file, { env: {} }))[0].usage.prompt_tokens, 200);
  wal[80] ^= 1;
  fs.writeFileSync(`${file}-wal`, wal);
  await assert.rejects(readTraeUsageRows(file, { env: {} }), /WAL frame checksum failed/);
});

test("TRAE encrypted WAL page authentication is independent of its frame checksum", async (t) => {
  const file = path.join(temp(t), "database.db");
  const initial = encrypt(await fixture([context()], { reserve: true }));
  const modified = encrypt(await fixture([context(200)], { reserve: true }));
  modified[4200] ^= 1;
  fs.writeFileSync(file, initial);
  // Rebuild valid WAL checksums around invalid authenticated ciphertext.
  fs.writeFileSync(`${file}-wal`, makeWal(allPages(modified)));
  await assert.rejects(readTraeUsageRows(file, { env: ENV }), /authentication failed/);
});

test("TRAE WAL ignores old frames after a salt reset", async (t) => {
  const file = path.join(temp(t), "database.db");
  const initial = await fixture([context()]), committed = await fixture([context(200)]);
  fs.writeFileSync(file, initial);
  const wal = makeWal([...allPages(committed), ...allPages(initial)]);
  const oldFrame = 32 + committed.length / 4096 * 4120;
  wal.writeUInt32BE(999, oldFrame + 8);
  fs.writeFileSync(`${file}-wal`, wal);
  assert.equal((await readTraeUsageRows(file, { env: {} }))[0].usage.prompt_tokens, 200);
});

test("TRAE reader rejects an active rollback journal instead of reading uncommitted changes", async (t) => {
  const file = path.join(temp(t), "database.db");
  fs.writeFileSync(file, await fixture([context()]));
  fs.writeFileSync(`${file}-journal`, Buffer.from("d9d505f920a163d7", "hex"));
  await assert.rejects(readTraeUsageRows(file, { env: {} }), /rollback transaction/);
});
