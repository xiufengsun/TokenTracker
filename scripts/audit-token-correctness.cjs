#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getSourceScope } = require("../src/lib/source-metadata");

function readJsonlRows(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

function rowKey(row) {
  return [row?.source || "", row?.model || "", row?.hour_start || ""].join("|");
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function isReasoningInformational(source) {
  const normalized = String(source || "").trim().toLowerCase();
  // Codex and OmO both fold reasoning into output_tokens, so their
  // reasoning_output_tokens column is informational and must not be summed
  // into the total-token invariant.
  return normalized === "codex" || normalized === "omo";
}

function isLegacyInclusiveCodexRow(row) {
  const source = String(row?.source || "").trim().toLowerCase();
  if (source !== "codex" && source !== "every-code") return false;
  const input = toNumber(row.input_tokens);
  const cacheRead = toNumber(row.cached_input_tokens);
  const output = toNumber(row.output_tokens);
  const total = toNumber(row.total_tokens);
  return cacheRead > 0 && input >= cacheRead && total === input + output;
}

function auditRows(inputRows) {
  const rows = Array.isArray(inputRows) ? inputRows : [];
  const latestByKey = new Map();
  const countsByKey = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    countsByKey.set(key, (countsByKey.get(key) || 0) + 1);
    latestByKey.set(key, row);
  }

  const sources = {};
  const invariantSamples = [];
  for (const row of latestByKey.values()) {
    const source = String(row?.source || "unknown").trim().toLowerCase() || "unknown";
    if (!sources[source]) {
      sources[source] = {
        source,
        source_scope: getSourceScope(source),
        rows: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        sum_parts: 0,
        total_minus_parts: 0,
        invariant_failures: 0,
        duplicate_bucket_keys: 0,
        unknown_model_rows: 0,
        cache_read_ratio: 0,
        first_day: null,
        last_day: null,
      };
    }
    const agg = sources[source];
    const rawInput = toNumber(row.input_tokens);
    const output = toNumber(row.output_tokens);
    const cacheRead = toNumber(row.cached_input_tokens);
    const cacheWrite = toNumber(row.cache_creation_input_tokens);
    const reasoning = toNumber(row.reasoning_output_tokens);
    const total = toNumber(row.total_tokens);
    const input = isLegacyInclusiveCodexRow(row) ? rawInput - cacheRead : rawInput;
    const baseParts = input + output + cacheRead + cacheWrite;
    let sumParts = baseParts + (isReasoningInformational(source) ? 0 : reasoning);
    if (isReasoningInformational(source) && reasoning > 0 && total === baseParts + reasoning) {
      sumParts = baseParts + reasoning;
    }
    const diff = total - sumParts;
    const day = String(row.hour_start || "").slice(0, 10);

    agg.rows += 1;
    agg.total_tokens += total;
    agg.input_tokens += input;
    agg.output_tokens += output;
    agg.cached_input_tokens += cacheRead;
    agg.cache_creation_input_tokens += cacheWrite;
    agg.reasoning_output_tokens += reasoning;
    agg.sum_parts += sumParts;
    agg.total_minus_parts += diff;
    if (!row.model || row.model === "unknown") agg.unknown_model_rows += 1;
    if (day) {
      if (!agg.first_day || day < agg.first_day) agg.first_day = day;
      if (!agg.last_day || day > agg.last_day) agg.last_day = day;
    }
    if (diff !== 0) {
      agg.invariant_failures += 1;
      if (invariantSamples.length < 20) {
        invariantSamples.push({
          source,
          model: row.model || "unknown",
          hour_start: row.hour_start || null,
          total_tokens: total,
          sum_parts: sumParts,
          total_minus_parts: diff,
        });
      }
    }
  }

  let duplicateBucketKeys = 0;
  for (const [key, count] of countsByKey.entries()) {
    if (count <= 1) continue;
    duplicateBucketKeys += 1;
    const source = String(key.split("|")[0] || "unknown").trim().toLowerCase() || "unknown";
    if (sources[source]) sources[source].duplicate_bucket_keys += 1;
  }

  for (const source of Object.values(sources)) {
    source.cache_read_ratio =
      source.total_tokens > 0
        ? Number((source.cached_input_tokens / source.total_tokens).toFixed(4))
        : 0;
  }

  return {
    generated_at: new Date().toISOString(),
    raw: {
      rows: rows.length,
      unique_bucket_keys: latestByKey.size,
      duplicate_bucket_keys: duplicateBucketKeys,
    },
    sources,
    invariant_samples: invariantSamples,
  };
}

function main() {
  const queuePath =
    process.argv[2] || path.join(os.homedir(), ".tokentracker", "tracker", "queue.jsonl");
  const { rows, malformed } = readJsonlRows(queuePath);
  const result = auditRows(rows);
  result.queue_path = queuePath;
  result.malformed_rows = malformed;
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  auditRows,
  readJsonlRows,
};
