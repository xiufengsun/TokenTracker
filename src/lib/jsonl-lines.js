"use strict";

/**
 * Yield physical JSONL records. Unlike node:readline, this intentionally treats
 * only LF as a record separator so valid U+2028/U+2029 characters inside JSON
 * strings remain part of the record. Reading raw bytes keeps byte budgets exact
 * and lets malformed UTF-8 fail closed.
 * Records longer than maxRecordBytes content bytes (excluding LF) are reported
 * as { line: null, utf8Valid: null, oversized: true } without being buffered
 * beyond the limit or decoded.
 */
class PhysicalJsonlLimitError extends Error {
  constructor(maxPhysicalBytes) {
    super(`physical JSONL byte limit exceeded: ${maxPhysicalBytes}`);
    this.name = "PhysicalJsonlLimitError";
    this.code = "PHYSICAL_JSONL_LIMIT_EXCEEDED";
  }
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodePhysicalLine(buffer, { stripCr = false } = {}) {
  const content = stripCr && buffer.length > 0 && buffer[buffer.length - 1] === 0x0d
    ? buffer.subarray(0, buffer.length - 1)
    : buffer;
  return fatalUtf8Decoder.decode(content);
}

async function* physicalJsonlRecords(input, {
  invalidUtf8 = "throw",
  maxPhysicalBytes = Infinity,
  maxRecordBytes = Infinity,
  mustContain = null,
} = {}) {
  if (invalidUtf8 !== "throw" && invalidUtf8 !== "record") {
    throw new TypeError(`unsupported invalidUtf8 policy: ${invalidUtf8}`);
  }
  const byteLimit = Number.isFinite(maxPhysicalBytes)
    ? Math.max(0, Number(maxPhysicalBytes))
    : Infinity;
  const recordLimit = Number.isFinite(maxRecordBytes)
    ? Math.max(0, Number(maxRecordBytes))
    : Infinity;
  const fragments = [];
  let fragmentsBytes = 0;
  let oversized = false;
  let physicalBytesRead = 0;

  for await (const value of input) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError("physicalJsonlRecords input must emit bytes");
    }
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);

    let start = 0;
    let newline = chunk.indexOf(0x0a);
    while (newline !== -1) {
      const fragment = chunk.subarray(start, newline);
      const physicalBytes = fragmentsBytes + fragment.length + 1;
      if (physicalBytesRead + physicalBytes > byteLimit) {
        throw new PhysicalJsonlLimitError(byteLimit);
      }
      const contentBytes = fragmentsBytes + fragment.length;
      if (oversized || contentBytes > recordLimit) {
        fragments.length = 0;
        fragmentsBytes = 0;
        oversized = false;
        physicalBytesRead += physicalBytes;
        start = newline + 1;
        newline = chunk.indexOf(0x0a, start);
        yield { line: null, utf8Valid: null, oversized: true, physicalBytes, terminated: true };
        continue;
      }
      const lineBuffer = fragments.length === 0
        ? fragment
        : Buffer.concat([...fragments, fragment], fragmentsBytes + fragment.length);
      fragments.length = 0;
      fragmentsBytes = 0;
      physicalBytesRead += physicalBytes;
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
      if (mustContain && lineBuffer.indexOf(mustContain) === -1) {
        yield { line: null, utf8Valid: null, oversized: false, physicalBytes, terminated: true };
        continue;
      }
      let line;
      try {
        line = decodePhysicalLine(lineBuffer, { stripCr: true });
      } catch (error) {
        if (invalidUtf8 === "throw") throw error;
        yield { line: null, utf8Valid: false, oversized: false, physicalBytes, terminated: true };
        continue;
      }
      yield { line, utf8Valid: true, oversized: false, physicalBytes, terminated: true };
    }

    if (start < chunk.length) {
      const fragment = chunk.subarray(start);
      if (physicalBytesRead + fragmentsBytes + fragment.length > byteLimit) {
        throw new PhysicalJsonlLimitError(byteLimit);
      }
      if (!oversized) {
        if (fragmentsBytes + fragment.length > recordLimit) {
          fragments.length = 0;
          oversized = true;
        } else {
          fragments.push(Buffer.from(fragment));
        }
      }
      fragmentsBytes += fragment.length;
    }
  }

  if (fragmentsBytes > 0) {
    if (oversized) {
      yield { line: null, utf8Valid: null, oversized: true, physicalBytes: fragmentsBytes, terminated: false };
      return;
    }
    const lineBuffer = fragments.length === 1
      ? fragments[0]
      : Buffer.concat(fragments, fragmentsBytes);
    let line = null;
    let utf8Valid = true;
    try {
      line = decodePhysicalLine(lineBuffer);
    } catch (error) {
      if (invalidUtf8 === "throw") throw error;
      utf8Valid = false;
    }
    yield { line, utf8Valid, oversized: false, physicalBytes: fragmentsBytes, terminated: false };
  }
}

module.exports = {
  PhysicalJsonlLimitError,
  physicalJsonlRecords,
};
