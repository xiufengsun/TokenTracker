"use strict";

// Shared native protobuf decoder for Usage and Sessions. No message bodies are retained.

function decodeAntigravityVarint(buf, offset) {
  if (!Buffer.isBuffer(buf) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("invalid Antigravity protobuf offset");
  }
  const start = offset;
  let res = 0;
  for (let count = 0; count < 10; count++) {
    if (offset >= buf.length) throw new RangeError("truncated Antigravity protobuf varint");
    const b = buf[offset++];
    // 64 bits is nine 7-bit groups plus one bit of a tenth byte.
    if (count === 9 && b > 1) throw new RangeError("Antigravity protobuf varint exceeds 64 bits");
    res += (b & 0x7f) * 2 ** (count * 7);
    if (!(b & 0x80)) {
      if (Number.isSafeInteger(res)) return [res, offset];
      // Antigravity writes 2^64 - 1 in fields the extractor never reads. The
      // float sum has already lost precision, so re-read the bytes exactly.
      let exact = 0n;
      for (let i = start; i < offset; i++) {
        exact |= BigInt(buf[i] & 0x7f) << BigInt((i - start) * 7);
      }
      return [exact, offset];
    }
  }
  throw new RangeError("overlong Antigravity protobuf varint");
}

function findAntigravityProtoFields(buf) {
  if (!Buffer.isBuffer(buf)) throw new RangeError("invalid Antigravity protobuf payload");
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const [tag, next] = decodeAntigravityVarint(buf, offset);
    if (typeof tag !== "number") throw new RangeError("unsafe Antigravity protobuf field tag");
    offset = next;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (fieldNum <= 0) throw new RangeError("invalid Antigravity protobuf field number");
    if (wireType === 0) {
      // May be a BigInt; token reads use Number.isSafeInteger, so it is never billed.
      const [val, vNext] = decodeAntigravityVarint(buf, offset);
      offset = vNext;
      fields.push({ num: fieldNum, val });
    } else if (wireType === 2) {
      const [len, lNext] = decodeAntigravityVarint(buf, offset);
      offset = lNext;
      if (!Number.isSafeInteger(len) || len > buf.length - offset) {
        throw new RangeError("truncated Antigravity protobuf field");
      }
      fields.push({ num: fieldNum, val: buf.subarray(offset, offset + len) });
      offset += len;
    } else if (wireType === 1) {
      if (buf.length - offset < 8) throw new RangeError("truncated Antigravity protobuf field");
      offset += 8;
    } else if (wireType === 5) {
      if (buf.length - offset < 4) throw new RangeError("truncated Antigravity protobuf field");
      offset += 4;
    } else {
      throw new RangeError("unsupported Antigravity protobuf wire type");
    }
  }
  return fields;
}

function extractAntigravityGenInfo(buf) {
  try {
    const root = findAntigravityProtoFields(buf);
    const f1 = root.find((f) => f.num === 1)?.val;
    if (!f1) return null;

    const inner = findAntigravityProtoFields(f1);
    let model = null;
    const f19 = inner.find((f) => f.num === 19)?.val;
    if (f19) model = Buffer.from(f19).toString("utf8").trim();

    let contextTokens = 0;
    const f9 = inner.find((f) => f.num === 9)?.val;
    if (f9) {
      const f10 = findAntigravityProtoFields(f9).find((f) => f.num === 10)?.val;
      if (f10) {
        const tok = findAntigravityProtoFields(f10).find((f) => f.num === 1)?.val;
        if (Number.isSafeInteger(tok)) contextTokens = tok;
      }
    }

    let lastStepIndex = null;
    for (const f of inner) {
      if (f.num !== 20 || !f.val) continue;
      const kv = findAntigravityProtoFields(f.val);
      const k = kv.find((x) => x.num === 1)?.val;
      const v = kv.find((x) => x.num === 2)?.val;
      if (k && Buffer.from(k).toString("utf8") === "last_step_index" && v) {
        const rawStepIndex = Buffer.from(v).toString("utf8").trim();
        if (/^\d+$/.test(rawStepIndex)) {
          const parsed = Number(rawStepIndex);
          if (Number.isSafeInteger(parsed)) lastStepIndex = parsed;
        }
      }
    }

    let uncachedInput;
    let cachedInput;
    let cacheWrite;
    let outputTokens;
    let textOutput;
    let reasoningOutput;
    let hasUsageMetadata = false;
    let responseId = null;

    const f4 = inner.find((f) => f.num === 4)?.val;
    if (f4) {
      // ModelUsageStats: field 1 is a model enum, never a token counter.
      // Fields 9 and 10 split output into thinking and visible response.
      const f4fields = findAntigravityProtoFields(f4);
      const response = f4fields.find((f) => f.num === 11)?.val;
      if (Buffer.isBuffer(response)) responseId = response.toString("utf8").trim() || null;
      const pTok = f4fields.find((f) => f.num === 2)?.val;
      const wTok = f4fields.find((f) => f.num === 4)?.val;
      const cTok = f4fields.find((f) => f.num === 5)?.val;
      const oTok = f4fields.find((f) => f.num === 3)?.val;
      const tTok = f4fields.find((f) => f.num === 10)?.val;
      const rTok = f4fields.find((f) => f.num === 9)?.val;
      if (
        Number.isSafeInteger(wTok) ||
        Number.isSafeInteger(pTok) ||
        Number.isSafeInteger(cTok) ||
        Number.isSafeInteger(oTok) ||
        Number.isSafeInteger(tTok) ||
        Number.isSafeInteger(rTok)
      ) {
        hasUsageMetadata = true;
        const promptTokens = Number.isSafeInteger(pTok) ? pTok : 0;
        uncachedInput = promptTokens;
        cacheWrite = Number.isSafeInteger(wTok) ? wTok : 0;
        cachedInput = Number.isSafeInteger(cTok) ? cTok : 0;
        outputTokens = Number.isSafeInteger(oTok) ? oTok : 0;
        textOutput = Number.isSafeInteger(tTok) ? tTok : 0;
        reasoningOutput = Number.isSafeInteger(rTok) ? rTok : 0;
      }
    }

    return {
      model,
      responseId,
      contextTokens,
      lastStepIndex,
      ...(hasUsageMetadata
        ? {
            uncachedInput,
            cachedInput,
            cacheWrite,
            outputTokens,
            textOutput,
            reasoningOutput,
            hasUsageMetadata: true,
          }
        : {}),
    };
  } catch (_error) {
    return null;
  }
}

module.exports = { decodeAntigravityVarint, findAntigravityProtoFields, extractAntigravityGenInfo };
