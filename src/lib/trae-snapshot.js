"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const PAGE_SIZE = 4096;
const RESERVED = 80;
// TRAE's shared application key
const DEFAULT_SQLCIPHER_KEY = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";
const CACHE_PAGES = 64;
const MAX_WAL_INDEX_PAGES = 1024 * 1024;

function error(message) { return new Error(`Cannot read TRAE usage: ${message}`); }
// A writer race rather than a bad store: the caller may retry immediately.
function transientError(message) { return Object.assign(error(message), { transient: true }); }

function statOptional(file) {
  try { return fs.statSync(file, { bigint: true }); }
  catch (err) { if (err.code === "ENOENT" || err.code === "ENOTDIR") return null; throw err; }
}

function sameStat(a, b) {
  if (!a || !b) return a === b;
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino;
}

function readExact(fd, target, offset) {
  let read = 0;
  while (read < target.length) {
    const count = fs.readSync(fd, target, read, target.length - read, offset + read);
    if (!count) throw transientError("database or WAL was truncated during the read; retry when TRAE is idle.");
    read += count;
  }
  return target;
}

function pageDecryptor(firstPage, env) {
  const hex = String(env.TOKENTRACKER_TRAE_SQLCIPHER_KEY || "").trim() || DEFAULT_SQLCIPHER_KEY;
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw error("TOKENTRACKER_TRAE_SQLCIPHER_KEY must contain 64 hex characters.");
  const key = Buffer.from(hex, "hex");
  const salt = Buffer.from(firstPage.subarray(0, 16).map((byte) => byte ^ 0x3a));
  // SQLCipher 4 raw-key format: AES-256-CBC, 4096-byte pages, SHA-512 HMAC.
  // https://github.com/sqlcipher/sqlcipher/blob/master/src/sqlcipher.c
  const hmacKey = crypto.pbkdf2Sync(key, salt, 2, 32, "sha512");
  salt.fill(0);
  return {
    decrypt(page, number) {
      const start = number === 1 ? 16 : 0;
      const ivOffset = PAGE_SIZE - RESERVED;
      const pageId = Buffer.alloc(4);
      pageId.writeUInt32LE(number);
      const expected = crypto.createHmac("sha512", hmacKey)
        .update(page.subarray(start, ivOffset + 16)).update(pageId).digest();
      if (!crypto.timingSafeEqual(expected, page.subarray(ivOffset + 16))) {
        throw error("SQLCipher authentication failed (incorrect key, unsupported format, or damaged database); set TOKENTRACKER_TRAE_SQLCIPHER_KEY to override the shared application key.");
      }
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, page.subarray(ivOffset, ivOffset + 16));
      decipher.setAutoPadding(false);
      const decoded = decipher.update(page.subarray(start, ivOffset));
      decipher.final();
      page.fill(0);
      if (number === 1) SQLITE_HEADER.copy(page);
      decoded.copy(page, start);
      decoded.fill(0);
      if (number === 1 && (page.readUInt16BE(16) !== PAGE_SIZE || page[20] !== RESERVED)) {
        throw error("unsupported SQLCipher page format.");
      }
      return page;
    },
    dispose() { key.fill(0); hmacKey.fill(0); },
  };
}

function checksum(data, bigEndian, state = [0, 0]) {
  let [a, b] = state;
  for (let i = 0; i < data.length; i += 8) {
    const x = bigEndian ? data.readUInt32BE(i) : data.readUInt32LE(i);
    const y = bigEndian ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4);
    a = (a + x + b) >>> 0;
    b = (b + y + a) >>> 0;
  }
  return [a, b];
}

function indexWal(fd, size, pageSize) {
  const pages = new Map();
  if (fd == null || size === 0) return { pages, pageCount: null };
  if (size < 32) throw transientError("incomplete WAL header; retry when TRAE is idle.");
  const header = readExact(fd, Buffer.alloc(32), 0);
  const magic = header.readUInt32BE(0);
  if ((magic !== 0x377f0682 && magic !== 0x377f0683) ||
      header.readUInt32BE(4) !== 3007000 || header.readUInt32BE(8) !== pageSize) {
    throw error("unsupported WAL format.");
  }
  const bigEndian = magic === 0x377f0683;
  let sum = checksum(header.subarray(0, 24), bigEndian);
  if (sum[0] !== header.readUInt32BE(24) || sum[1] !== header.readUInt32BE(28)) throw error("WAL header checksum failed.");
  let pageCount = null;
  let pending = new Map();
  const frame = Buffer.alloc(24 + pageSize);
  // Index offsets instead of buffering/decrypting an entire WAL. Uncommitted
  // frames never enter the visible page map. SQLite checksums cover ciphertext.
  // https://www.sqlite.org/fileformat2.html#walformat
  for (let offset = 32; offset + frame.length <= size; offset += frame.length) {
    readExact(fd, frame, offset);
    if (!frame.subarray(8, 16).equals(header.subarray(16, 24))) break;
    // Like a salt mismatch, the first checksum mismatch ends the valid log (a
    // torn append or crash leftover); only committed frames before it count.
    sum = checksum(frame.subarray(24), bigEndian, checksum(frame.subarray(0, 8), bigEndian, sum));
    if (sum[0] !== frame.readUInt32BE(16) || sum[1] !== frame.readUInt32BE(20)) break;
    const number = frame.readUInt32BE(0);
    const commit = frame.readUInt32BE(4);
    if (!number || number === 0xffffffff || commit === 0xffffffff) throw error("invalid WAL page number or database size.");
    pending.set(number, offset + 24);
    if (pending.size + pages.size > MAX_WAL_INDEX_PAGES) throw error("WAL index exceeds the bounded-memory limit; let TRAE checkpoint its WAL and retry.");
    if (commit) {
      for (const [page, position] of pending) pages.set(page, position);
      pending = new Map();
      pageCount = commit;
      for (const page of pages.keys()) if (page > commit) pages.delete(page);
    }
  }
  frame.fill(0);
  return { pages, pageCount };
}

// A read-only, optimistic snapshot. SQLite reads authenticated pages on demand;
// no decrypted database is ever written to disk or materialized in memory.
// The caller must discard results if isStable() fails after the SQL query.
function openTraeSnapshot(dbPath, env = process.env) {
  const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-journal`];
  const before = paths.map(statOptional);
  if (!before[0]) throw error("database no longer exists.");
  if (before.some((stat) => stat && (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)))) {
    throw error("unsupported database file or size.");
  }
  const handles = [];
  const cache = new Map();
  let decryptor;
  const close = () => {
    for (const page of cache.values()) page.fill(0);
    cache.clear();
    if (decryptor) { decryptor.dispose(); decryptor = null; }
    let failure;
    while (handles.length) {
      try { fs.closeSync(handles.pop()); }
      catch (err) { failure ||= err; }
    }
    if (failure) throw failure;
  };
  try {
    const dbFd = fs.openSync(dbPath, "r");
    handles.push(dbFd);
    if (!sameStat(before[0], fs.fstatSync(dbFd, { bigint: true }))) throw transientError("database changed while opening; retry when TRAE is idle.");
    let walFd = null;
    if (before[1]) {
      walFd = fs.openSync(paths[1], "r");
      handles.push(walFd);
      if (!sameStat(before[1], fs.fstatSync(walFd, { bigint: true }))) throw transientError("WAL changed while opening; retry when TRAE is idle.");
    }
    if (before[2] && before[2].size >= 8n) {
      const journalFd = fs.openSync(paths[2], "r");
      handles.push(journalFd);
      if (readExact(journalFd, Buffer.alloc(8), 0).some((byte) => byte !== 0)) throw error("a rollback transaction is active; retry when TRAE is idle.");
    }
    const size = Number(before[0].size);
    if (size < 100) throw error("database is truncated.");
    const header = readExact(dbFd, Buffer.alloc(100), 0);
    const encrypted = !header.subarray(0, 16).equals(SQLITE_HEADER);
    const encodedSize = encrypted ? PAGE_SIZE : header.readUInt16BE(16);
    const pageSize = encodedSize === 1 ? 65536 : encodedSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) || size % pageSize) throw error("invalid database page size or truncated database.");
    if (encrypted) decryptor = pageDecryptor(header, env);
    const { pages, pageCount } = indexWal(walFd, Number(before[1]?.size || 0n), pageSize);
    const finalPageCount = pageCount == null ? size / pageSize : pageCount;
    if (!finalPageCount || finalPageCount > 0xfffffffe) throw error("invalid database size.");
    const byteLength = finalPageCount * pageSize;
    const getPage = (number) => {
      if (cache.has(number)) {
        const page = cache.get(number);
        cache.delete(number);
        cache.set(number, page);
        return page;
      }
      const page = Buffer.alloc(pageSize);
      try {
        if (pages.has(number)) readExact(walFd, page, pages.get(number));
        else readExact(dbFd, page, (number - 1) * pageSize);
        if (decryptor) decryptor.decrypt(page, number);
        if (number === 1) {
          // Present the committed view as a standalone rollback-mode database.
          page[18] = 1;
          page[19] = 1;
          page.writeUInt32BE(finalPageCount, 28);
          page.writeUInt32BE(page.readUInt32BE(24), 92);
        }
      } catch (err) { page.fill(0); throw err; }
      cache.set(number, page);
      if (cache.size > CACHE_PAGES) {
        const oldest = cache.keys().next().value;
        cache.get(oldest).fill(0);
        cache.delete(oldest);
      }
      return page;
    };
    return {
      byteLength,
      read(target, offset) {
        if (!Number.isSafeInteger(offset) || offset < 0) throw error("invalid read offset.");
        target.fill(0);
        const count = Math.min(target.length, Math.max(0, byteLength - offset));
        let copied = 0;
        while (copied < count) {
          const position = offset + copied;
          const pageOffset = position % pageSize;
          const length = Math.min(count - copied, pageSize - pageOffset);
          const page = getPage(Math.floor(position / pageSize) + 1);
          target.set(page.subarray(pageOffset, pageOffset + length), copied);
          copied += length;
        }
        return count;
      },
      isStable() { return paths.map(statOptional).every((stat, i) => sameStat(before[i], stat)); },
      close,
    };
  } catch (err) { close(); throw err; }
}

module.exports = { openTraeSnapshot };
