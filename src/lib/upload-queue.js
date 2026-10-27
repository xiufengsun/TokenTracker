const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { isUtf8 } = require("node:buffer");

const BACKLOG_BYTES = 1_000_000;
const CHUNK_BYTES = 64 * 1024;
const { TOKEN_COLUMNS } = require("./account-usage-dedup");

function sessionSnapshotMs(row) {
  const verifiedMs = Date.parse(row?.snapshot_verified_at);
  if (typeof row?.source !== "string" || row.source.trim().toLowerCase() !== "trae-cn" ||
      typeof row.session_id !== "string" || !row.session_id.trim() || row.session_id.trim().length > 256 ||
      typeof row.model !== "string" || !row.model.trim() || row.model.trim().length > 200 ||
      !Number.isFinite(Date.parse(row.bucket_start)) || !Number.isFinite(verifiedMs) ||
      TOKEN_COLUMNS.some((column) => !Number.isSafeInteger(Number(row[column])) || Number(row[column]) < 0) ||
      !Number.isSafeInteger(Number(row.unclassified_input_tokens ?? 0)) || Number(row.unclassified_input_tokens ?? 0) < 0 ||
      Number(row.total_tokens) !== Number(row.input_tokens) + Number(row.output_tokens) + Number(row.cached_input_tokens) + Number(row.cache_creation_input_tokens) + Number(row.unclassified_input_tokens ?? 0)) return null;
  return verifiedMs;
}

// Keep raw bytes, including CRLF and incomplete tails. Upload offsets are
// byte positions, not JavaScript string lengths.
async function* iterateQueueLines(handle, start, end) {
  let position = start;
  let lineStart = start;
  let carry = Buffer.alloc(0);
  while (position < end) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (!bytesRead) throw new Error("Queue changed while reading");
    position += bytesRead;
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let consumed = 0;
    let newline;
    while ((newline = data.indexOf(10, consumed)) !== -1) {
      const bytes = data.subarray(consumed, newline + 1);
      yield { bytes, start: lineStart, complete: true };
      lineStart += bytes.length;
      consumed = newline + 1;
    }
    carry = Buffer.from(data.subarray(consumed));
  }
  if (carry.length) yield { bytes: carry, start: lineStart, complete: false };
}

function snapshotKey(bytes) {
  if (!isUtf8(bytes)) return null;
  let row;
  try { row = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (row.kind === "account_session_state") {
    const verifiedMs = sessionSnapshotMs(row);
    if (verifiedMs === null) return null;
    return { key: JSON.stringify(["session", row.source.trim().toLowerCase(), row.session_id.trim()]), verifiedMs };
  }
  // Preserve unknown control records even when they happen to carry a bucket.
  if (Object.hasOwn(row, "kind") || typeof row.hour_start !== "string" || !Number.isFinite(Date.parse(row.hour_start))) return null;
  const source = (typeof row.source === "string" ? row.source.trim().toLowerCase() : "") || "codex";
  const model = (typeof row.model === "string" ? row.model.trim() : "") || "unknown";
  return { key: JSON.stringify(["hourly", source, model, row.hour_start]), verifiedMs: null };
}

// Caller holds sync.lock. Only rewrite pending snapshots; uploaded history and
// queue.state.json stay byte-for-byte unchanged across an atomic replacement.
async function compactPendingQueue({ queuePath, offset = 0, minPendingBytes = BACKLOG_BYTES }) {
  let input;
  let output;
  let temporary;
  try {
    input = await fs.open(queuePath, "r");
    const before = await input.stat();
    const pendingBytesBefore = Math.max(0, before.size - offset);
    const unchanged = { compacted: false, removedRecords: 0, pendingBytesBefore, pendingBytesAfter: pendingBytesBefore };
    if (!before.isFile() || !Number.isSafeInteger(offset) || offset < 0 || offset >= before.size || pendingBytesBefore < minPendingBytes) return unchanged;
    if (offset > 0) {
      const boundary = Buffer.alloc(1);
      await input.read(boundary, 0, 1, offset - 1);
      if (boundary[0] !== 10) return unchanged;
    }
    const latest = new Map();
    let removedRecords = 0;
    for await (const line of iterateQueueLines(input, offset, before.size)) {
      const snapshot = line.complete ? snapshotKey(line.bytes) : null;
      if (snapshot == null) continue;
      const previous = latest.get(snapshot.key);
      if (previous) removedRecords += 1;
      // Account truth uses a strictly newer fetch stamp; equal stamps retain
      // the first observation, even after a replay or local clock rollback.
      if (!previous || snapshot.verifiedMs === null || snapshot.verifiedMs > previous.verifiedMs) {
        latest.set(snapshot.key, { start: line.start, verifiedMs: snapshot.verifiedMs });
      }
    }
    if (!removedRecords) return unchanged;

    temporary = `${queuePath}.compact.${crypto.randomUUID()}`;
    output = await fs.open(temporary, "wx", before.mode & 0o777);
    await output.chmod(before.mode & 0o777);
    for (let position = 0; position < offset;) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, offset - position));
      const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error("Queue changed while copying uploaded history");
      await output.writeFile(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    let pendingBytesAfter = 0;
    for await (const line of iterateQueueLines(input, offset, before.size)) {
      const snapshot = line.complete ? snapshotKey(line.bytes) : null;
      if (snapshot != null && latest.get(snapshot.key).start !== line.start) continue;
      await output.writeFile(line.bytes);
      pendingBytesAfter += line.bytes.length;
    }
    await output.sync();
    await output.close();
    output = null;
    // Windows cannot replace the destination while our read handle is open.
    await input.close();
    input = null;
    const current = await fs.stat(queuePath);
    if (current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
      throw new Error("Queue changed during pending compaction");
    }
    await fs.rename(temporary, queuePath);
    temporary = null;
    return { compacted: true, removedRecords, pendingBytesBefore, pendingBytesAfter };
  } catch (error) {
    if (error.code === "ENOENT" && !input && !temporary) return { compacted: false, removedRecords: 0, pendingBytesBefore: 0, pendingBytesAfter: 0 };
    throw error;
  } finally {
    await input?.close();
    await output?.close();
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { BACKLOG_BYTES, compactPendingQueue, iterateQueueLines, sessionSnapshotMs };
