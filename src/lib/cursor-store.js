const crypto = require("node:crypto");
const fssync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  ensureDir,
  readJson,
  readJsonStrict,
  writeJson,
} = require("./fs");

const STORE_VERSION = 2;
const STORE_DIRNAME = "cursor-store-v2";
const MANIFEST_FILENAME = "manifest.json";
const GENERATIONS_DIRNAME = "generations";
const DEFERRED_CODEX_AUDIT_FILENAME = "deferred-codex-audit.json";
const SHARDED_CORE_FILENAME = "core-v3.json";
const OPENCODE_MESSAGES_DIRNAME = "opencode-messages";
const OPENCODE_FINGERPRINTS_DIRNAME = "opencode-fingerprints";
const DEFAULT_ACTIVATION_BYTES = 16 * 1024 * 1024;
const PROJECT_ABSENT_CONTEXT_RESCAN_MS = 24 * 60 * 60 * 1000;
const CURSOR_STORE_RETRY_CODE = "TOKENTRACKER_CURSOR_STORE_RETRY";

async function openCursorStore({
  trackerDir,
  cursorsPath = path.join(trackerDir, "cursors.json"),
  activationBytes = DEFAULT_ACTIVATION_BYTES,
  forceV2 = false,
  codexRoots = [],
  failureInjector = null,
} = {}) {
  if (typeof trackerDir !== "string" || trackerDir.length === 0) {
    throw new Error("trackerDir is required");
  }

  const storeRoot = path.join(trackerDir, STORE_DIRNAME);
  const manifestPath = path.join(storeRoot, MANIFEST_FILENAME);
  const normalizedCodexRoots = normalizeCodexRoots(codexRoots);
  const legacyFingerprint = await fingerprintFile(cursorsPath);
  let manifest = await readJson(manifestPath);
  let migratedDuringOpen = false;

  if (isManifest(manifest)) {
    const legacyChanged = legacyFingerprint
      ? !sameFingerprint(legacyFingerprint, manifest.legacyFingerprint)
      : false;
    if (legacyChanged) {
      manifest = await migrateLegacyCursorState({
        cursorsPath,
        storeRoot,
        legacyFingerprint,
        previousManifest: manifest,
        codexRoots: normalizedCodexRoots,
        failureInjector,
      });
      migratedDuringOpen = true;
    }

    const opened = await openManifestGeneration({
      cursorsPath,
      storeRoot,
      manifest,
      codexRoots: normalizedCodexRoots,
      failureInjector,
    });
    if (opened) {
      if (migratedDuringOpen) opened.requiresCommit = true;
      return opened;
    }

    throw cursorStoreCorruption(
      `No valid cursor store generation in ${storeRoot}`,
    );
  }

  const legacySize = Number(legacyFingerprint?.size || 0);
  const shouldActivate = forceV2 || (
    Number.isFinite(activationBytes) &&
    activationBytes >= 0 &&
    legacySize >= activationBytes
  );
  if (!shouldActivate) {
    const cursors = (await readJson(cursorsPath)) || defaultCursorState();
    return new LegacyCursorStore({ cursorsPath, cursors });
  }

  manifest = await migrateLegacyCursorState({
    cursorsPath,
    storeRoot,
    legacyFingerprint,
    previousManifest: null,
    codexRoots: normalizedCodexRoots,
    failureInjector,
  });
  migratedDuringOpen = true;
  const opened = await openManifestGeneration({
    cursorsPath,
    storeRoot,
    manifest,
    codexRoots: normalizedCodexRoots,
    failureInjector,
  });
  if (!opened) throw new Error("Unable to open migrated cursor store");
  if (migratedDuringOpen) opened.requiresCommit = true;
  return opened;
}

async function readCursorStateSummary({ trackerDir, cursorsPath } = {}) {
  const resolvedCursorsPath = cursorsPath || path.join(trackerDir, "cursors.json");
  const storeRoot = path.join(path.dirname(resolvedCursorsPath), STORE_DIRNAME);
  const manifest = await readJson(path.join(storeRoot, MANIFEST_FILENAME));
  if (isManifest(manifest)) {
    const legacyFingerprint = await fingerprintFile(resolvedCursorsPath);
    if (
      legacyFingerprint &&
      !sameFingerprint(legacyFingerprint, manifest.legacyFingerprint)
    ) {
      return summarizeLegacyCursorState(
        await readJson(resolvedCursorsPath),
        { legacyDrift: true },
      );
    }
    const opened = await readGeneration({ storeRoot, generationId: manifest.current }) ||
      await readGeneration({
        storeRoot,
        generationId: manifest.rollback || manifest.previous,
      });
    if (opened) {
      return {
        cursors: opened.core,
        mode: "v2",
        legacyDrift: false,
        fileCount: Number(opened.metadata?.counts?.totalFiles || 0),
        codexFileCount: Number(opened.metadata?.counts?.codexFiles || 0),
        codexEventCount: Number(opened.metadata?.counts?.codexEvents || 0),
        opencodeMessageCount: Number(opened.metadata?.counts?.opencodeMessages || 0),
      };
    }
  }
  return summarizeLegacyCursorState(await readJson(resolvedCursorsPath));
}

function summarizeLegacyCursorState(cursors, { legacyDrift = false } = {}) {
  return {
    cursors,
    mode: "legacy",
    legacyDrift,
    fileCount:
      cursors?.files && typeof cursors.files === "object"
        ? Object.keys(cursors.files).length
        : null,
    codexFileCount: null,
    codexEventCount: Array.isArray(cursors?.codexHashes)
      ? cursors.codexHashes.length
      : null,
  };
}

class LegacyCursorStore {
  constructor({ cursorsPath, cursors }) {
    this.mode = "legacy";
    this.cursorsPath = cursorsPath;
    this.cursors = cursors;
    this.codexEventStore = null;
    this.fileShardLoadCount = 0;
  }

  get fileCount() {
    return Object.keys(this.cursors?.files || {}).length;
  }

  get currentCorePath() {
    return this.cursorsPath;
  }

  async loadCodexFilesForPaths() {}

  async materializeAllCodexState() {}

  async loadOpencodeMessagesForBatch() {
    return null;
  }

  async materializeAllOpencodeState() {}

  async canSkipCodexDay() {
    return false;
  }

  async readDeferredCodexAuditSyncs() {
    return 0;
  }

  async writeDeferredCodexAuditSyncs() {}

  async clearDeferredCodexAuditSyncs() {}

  async commit(cursors = this.cursors) {
    await writeJson(this.cursorsPath, cursors);
  }
}

class V2CursorStore {
  constructor({
    cursorsPath,
    storeRoot,
    manifest,
    generation,
    fallbackGenerationIds,
    codexRoots,
    failureInjector,
  }) {
    this.mode = "v2";
    this.cursorsPath = cursorsPath;
    this.storeRoot = storeRoot;
    this.manifest = manifest;
    this.generation = generation.metadata;
    this.generationDir = generation.directory;
    this.fallbackGenerationIds = Array.isArray(fallbackGenerationIds)
      ? [...fallbackGenerationIds]
      : [];
    this.codexRoots = codexRoots;
    this.cursors = generation.core;
    this.failureInjector = failureInjector;
    this.deferredCodexAuditPath = path.join(
      storeRoot,
      DEFERRED_CODEX_AUDIT_FILENAME,
    );
    this.loadedFileShards = new Map();
    this.loadedEventSets = new Map();
    this.pendingEventKeys = new Map();
    this.skipValidationCache = new Map();
    this.loadedOpencodeMessageShards = new Map();
    this.loadedOpencodeFingerprintShards = new Map();
    this.opencodeFingerprintIndexes = new Map();
    this.materializedOpencodeNamespaces = new Set();
    this.fileShardLoadCount = 0;
    this.opencodeMessageShardLoadCount = 0;
    this.opencodeFingerprintShardLoadCount = 0;
    this.materializedCodexHashes = false;
    this.requiresCommit = generation.metadata.id !== manifest.current;

    this.normalizeGenerationMetadata();
    this.stageInlineOpencodeMessages();

    if (!this.cursors.files || typeof this.cursors.files !== "object") {
      this.cursors.files = {};
    }

    const self = this;
    this.codexEventStore = {
      get size() {
        let pending = 0;
        for (const values of self.pendingEventKeys.values()) pending += values.size;
        return Number(self.generation?.counts?.codexEvents || 0) + pending;
      },
      has(key) {
        return self.hasCodexEvent(key);
      },
      add(key) {
        self.addCodexEvent(key);
      },
    };
  }

  get fileCount() {
    return Number(this.generation?.counts?.totalFiles || 0);
  }

  get currentCorePath() {
    return path.join(this.generationDir, this.generation?.coreFile || "core.json");
  }

  normalizeGenerationMetadata() {
    if (!this.generation.opencodeMessages) this.generation.opencodeMessages = {};
    if (!this.generation.opencodeFingerprints) this.generation.opencodeFingerprints = {};
  }

  stageInlineOpencodeMessages() {
    const states = opencodeNamespaceStates(this.cursors.opencode);
    const messageCount = Array.from(states.values()).reduce(
      (sum, state) => sum + Object.keys(state.messages || {}).length,
      0,
    );
    if (messageCount === 0) return;
    if (
      Object.keys(this.generation.opencodeMessages).length > 0 ||
      Object.keys(this.generation.opencodeFingerprints).length > 0
    ) {
      throw cursorStoreCorruption("OpenCode messages exist in both core and shards");
    }
    for (const namespace of states.keys()) {
      this.materializedOpencodeNamespaces.add(namespace);
    }
    this.requiresCommit = true;
  }

  async loadCodexFilesForPaths(paths, cursors = this.cursors) {
    const shardKeys = new Set();
    for (const entry of Array.isArray(paths) ? paths : []) {
      const filePath = typeof entry === "string" ? entry : entry?.path;
      if (!isCodexSessionCursorPathForRoots(filePath, this.codexRoots)) continue;
      shardKeys.add(codexFileShardKey(filePath));
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        for (const shardKey of shardKeys) {
          await this.loadFileShard(shardKey, cursors);
        }
        return { restarted: attempt > 0 };
      } catch (error) {
        if (!isCursorStoreRetry(error) || attempt > 0) throw error;
      }
    }
    return { restarted: false };
  }

  async loadFileShard(shardKey, cursors = this.cursors) {
    try {
      return await this.loadFileShardUnchecked(shardKey, cursors);
    } catch (error) {
      if (
        error?.code !== "TOKENTRACKER_CURSOR_STORE_CORRUPT" ||
        !this.activateFallbackGeneration(cursors)
      ) {
        throw error;
      }
      throw cursorStoreRetry(error);
    }
  }

  async loadFileShardUnchecked(shardKey, cursors = this.cursors) {
    if (this.loadedFileShards.has(shardKey)) {
      mergeFileShardIntoCursors(this.loadedFileShards.get(shardKey).data, cursors);
      return this.loadedFileShards.get(shardKey).data;
    }
    const metadata = this.generation?.codexFiles?.[shardKey] || null;
    const filePath = metadata?.file
      ? path.join(this.generationDir, metadata.file)
      : null;
    let data = {};
    if (filePath) {
      let raw;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (error) {
        throw cursorStoreCorruption(
          `Unable to read Codex cursor shard ${metadata.file}`,
          error,
        );
      }
      assertShardIntegrity(raw, metadata, `Codex cursor shard ${metadata.file}`);
      try {
        data = JSON.parse(raw);
      } catch (error) {
        throw cursorStoreCorruption(
          `Invalid Codex cursor shard ${metadata.file}`,
          error,
        );
      }
    }
    const normalized = data && typeof data === "object" && !Array.isArray(data)
      ? data
      : {};
    if (
      filePath &&
      (normalized !== data || Object.keys(normalized).length !== metadata.count)
    ) {
      throw cursorStoreCorruption(`Invalid Codex cursor shard ${metadata.file}`);
    }
    this.loadedFileShards.set(shardKey, {
      data: normalized,
      originalSerialized: JSON.stringify(normalized),
    });
    this.fileShardLoadCount += 1;
    mergeFileShardIntoCursors(normalized, cursors);
    return normalized;
  }

  async materializeAllCodexState(cursors = this.cursors) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        for (const shardKey of Object.keys(this.generation?.codexFiles || {})) {
          await this.loadFileShard(shardKey, cursors);
        }
        const hashes = [];
        for (const shardKey of Object.keys(this.generation?.codexEvents || {})) {
          const values = this.loadEventSet(shardKey, cursors);
          for (const key of values) hashes.push(key);
        }
        for (const values of this.pendingEventKeys.values()) {
          for (const key of values) hashes.push(key);
        }
        cursors.codexHashes = hashes;
        this.materializedCodexHashes = true;
        return { restarted: attempt > 0 };
      } catch (error) {
        if (!isCursorStoreRetry(error) || attempt > 0) throw error;
      }
    }
    return { restarted: false };
  }

  async loadOpencodeMessagesForBatch({
    namespace = "flat",
    messageKeys = [],
    fingerprints = [],
  } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const loaded = await this.loadOpencodeMessagesForBatchUnchecked({
          namespace,
          messageKeys,
          fingerprints,
        });
        if (loaded) loaded.restarted = attempt > 0;
        return loaded;
      } catch (error) {
        if (
          !isCursorStoreRetry(error) ||
          normalizeOpencodeNamespace(namespace) !== "flat" ||
          attempt > 0
        ) {
          throw error;
        }
      }
    }
    return null;
  }

  async loadOpencodeMessagesForBatchUnchecked({
    namespace,
    messageKeys,
    fingerprints,
  }) {
    const normalizedNamespace = normalizeOpencodeNamespace(namespace);
    const activeRoot = this.cursors.opencode;
    const activeRootIsFlat = Boolean(
      activeRoot &&
      typeof activeRoot === "object" &&
      activeRoot.native === undefined &&
      activeRoot.wsl === undefined,
    );
    const state = normalizedNamespace !== "flat" && activeRootIsFlat
      ? activeRoot
      : opencodeStateForNamespace(this.cursors, normalizedNamespace, true);
    if (!state || this.materializedOpencodeNamespaces.has(normalizedNamespace)) return null;
    const messages = state.messages && typeof state.messages === "object"
      ? state.messages
      : (state.messages = {});
    const managed = hasOpencodeNamespaceShards({
      namespace: normalizedNamespace,
      metadata: this.generation,
      loadedMessages: this.loadedOpencodeMessageShards,
      loadedFingerprints: this.loadedOpencodeFingerprintShards,
    });
    if (!managed && Object.keys(messages).length > 0) return null;
    if (!managed && this.generation.coreFile !== SHARDED_CORE_FILENAME) return null;

    const wantedMessageKeys = Array.from(new Set(
      Array.from(messageKeys || []).filter((key) => typeof key === "string" && key.length > 0),
    ));
    for (const shardKey of new Set(wantedMessageKeys.map((key) => (
      opencodeMessageShardKey(key, normalizedNamespace)
    )))) {
      const alreadyLoaded = this.loadedOpencodeMessageShards.has(shardKey);
      const data = await this.loadOpencodeMessageShard(shardKey);
      if (!alreadyLoaded) Object.assign(messages, data);
    }

    const wantedFingerprints = new Set(
      Array.from(fingerprints || []).filter((value) => (
        typeof value === "string" && value.length > 0
      )),
    );
    for (const messageKey of wantedMessageKeys) {
      const previousFingerprint = messages[messageKey]?.fingerprint;
      if (typeof previousFingerprint === "string" && previousFingerprint.length > 0) {
        wantedFingerprints.add(previousFingerprint);
      }
    }
    for (const shardKey of new Set(Array.from(wantedFingerprints, (fingerprint) => (
      opencodeFingerprintShardKey(fingerprint, normalizedNamespace)
    )))) {
      await this.loadOpencodeFingerprintShard(shardKey, normalizedNamespace);
    }

    if (!this.opencodeFingerprintIndexes.has(normalizedNamespace)) {
      this.opencodeFingerprintIndexes.set(normalizedNamespace, new Map());
    }
    return {
      fingerprintIndex: this.opencodeFingerprintIndexes.get(normalizedNamespace),
      restarted: false,
    };
  }

  async loadOpencodeMessageShard(shardKey) {
    try {
      return await this.loadOpencodeMessageShardUnchecked(shardKey);
    } catch (error) {
      if (
        error?.code !== "TOKENTRACKER_CURSOR_STORE_CORRUPT" ||
        !this.activateFallbackGeneration(this.cursors)
      ) {
        throw error;
      }
      throw cursorStoreRetry(error);
    }
  }

  async loadOpencodeMessageShardUnchecked(shardKey) {
    if (this.loadedOpencodeMessageShards.has(shardKey)) {
      return this.loadedOpencodeMessageShards.get(shardKey).data;
    }
    const metadata = this.generation.opencodeMessages[shardKey] || null;
    const data = await readJsonObjectShard({
      generationDir: this.generationDir,
      metadata,
      label: `OpenCode message shard ${metadata?.file || shardKey}`,
    });
    this.loadedOpencodeMessageShards.set(shardKey, { data });
    this.opencodeMessageShardLoadCount += 1;
    return data;
  }

  async loadOpencodeFingerprintShard(shardKey, namespace) {
    try {
      return await this.loadOpencodeFingerprintShardUnchecked(shardKey, namespace);
    } catch (error) {
      if (
        error?.code !== "TOKENTRACKER_CURSOR_STORE_CORRUPT" ||
        !this.activateFallbackGeneration(this.cursors)
      ) {
        throw error;
      }
      throw cursorStoreRetry(error);
    }
  }

  async loadOpencodeFingerprintShardUnchecked(shardKey, namespace) {
    const alreadyLoaded = this.loadedOpencodeFingerprintShards.has(shardKey);
    if (!alreadyLoaded) {
      const metadata = this.generation.opencodeFingerprints[shardKey] || null;
      const data = await readJsonObjectShard({
        generationDir: this.generationDir,
        metadata,
        label: `OpenCode fingerprint shard ${metadata?.file || shardKey}`,
        validate: (value) => Array.isArray(value) && value.every((item) => (
          typeof item === "string" && item.length > 0
        )),
      });
      this.loadedOpencodeFingerprintShards.set(shardKey, { data });
      this.opencodeFingerprintShardLoadCount += 1;
    }
    if (!this.opencodeFingerprintIndexes.has(namespace)) {
      this.opencodeFingerprintIndexes.set(namespace, new Map());
    }
    const index = this.opencodeFingerprintIndexes.get(namespace);
    if (!alreadyLoaded) {
      for (const [fingerprint, owners] of Object.entries(
        this.loadedOpencodeFingerprintShards.get(shardKey).data,
      )) {
        index.set(fingerprint, new Set(owners));
      }
    }
    return index;
  }

  async materializeAllOpencodeState() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const namespaces = opencodeNamespacesForStore({
          state: this.cursors.opencode,
          metadata: this.generation,
          loadedMessages: this.loadedOpencodeMessageShards,
          loadedFingerprints: this.loadedOpencodeFingerprintShards,
        });
        for (const namespace of namespaces) {
          const state = opencodeStateForNamespace(this.cursors, namespace, true);
          if (!state.messages || typeof state.messages !== "object") state.messages = {};
          for (const shardKey of opencodeShardKeysForNamespace(
            namespace,
            this.generation.opencodeMessages,
            this.loadedOpencodeMessageShards,
          )) {
            Object.assign(
              state.messages,
              await this.loadOpencodeMessageShard(shardKey),
            );
          }
          for (const shardKey of opencodeShardKeysForNamespace(
            namespace,
            this.generation.opencodeFingerprints,
            this.loadedOpencodeFingerprintShards,
          )) {
            await this.loadOpencodeFingerprintShard(shardKey, namespace);
          }
          this.materializedOpencodeNamespaces.add(namespace);
        }
        return { restarted: attempt > 0 };
      } catch (error) {
        if (!isCursorStoreRetry(error) || attempt > 0) throw error;
      }
    }
    return { restarted: false };
  }

  async canSkipCodexDay({
    filePath,
    dayInventoryCache,
    nowMs = Date.now(),
  } = {}) {
    const shardKey = codexFileShardKey(filePath);
    if (shardKey === "misc") return false;
    const dayDir = codexDayDirectory(filePath);
    if (!dayDir) return false;
    const shardMetadata = this.generation?.codexFiles?.[shardKey];
    const directoryMetadata = shardMetadata?.directories?.[dayDir];
    const inventory = dayInventoryCache?.days?.[dayDir];
    if (
      !directoryMetadata?.complete ||
      !inventory ||
      typeof inventory.statKey !== "string" ||
      inventory.statKey !== directoryMetadata.statKey ||
      !Array.isArray(inventory.files) ||
      inventory.files.length !== directoryMetadata.fileCount
    ) {
      return false;
    }

    if (this.skipValidationCache.has(shardKey)) {
      return this.skipValidationCache.get(shardKey);
    }
    const valid = await validateProjectSummary(shardMetadata.projectSummary, nowMs);
    this.skipValidationCache.set(shardKey, valid);
    return valid;
  }

  async readDeferredCodexAuditSyncs() {
    const state = await readJson(this.deferredCodexAuditPath);
    const count = Number(state?.syncsSinceFullScan || 0);
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  }

  async writeDeferredCodexAuditSyncs(count) {
    const normalized = Math.max(0, Math.floor(Number(count) || 0));
    if (normalized === 0) {
      await this.clearDeferredCodexAuditSyncs();
      return;
    }
    await writeJson(this.deferredCodexAuditPath, {
      version: 1,
      syncsSinceFullScan: normalized,
      updatedAt: new Date().toISOString(),
    });
  }

  async clearDeferredCodexAuditSyncs() {
    await fs.unlink(this.deferredCodexAuditPath).catch(() => {});
  }

  hasCodexEvent(key) {
    const shardKey = codexEventShardKey(key);
    if (this.pendingEventKeys.get(shardKey)?.has(key)) return true;
    return this.loadEventSet(shardKey).has(key);
  }

  addCodexEvent(key) {
    if (typeof key !== "string" || key.length === 0) return;
    const shardKey = codexEventShardKey(key);
    const loaded = this.loadedEventSets.get(shardKey);
    if (loaded?.has(key)) return;
    if (!this.pendingEventKeys.has(shardKey)) {
      this.pendingEventKeys.set(shardKey, new Set());
    }
    this.pendingEventKeys.get(shardKey).add(key);
    if (loaded) loaded.add(key);
  }

  loadEventSet(shardKey, cursors = this.cursors) {
    try {
      return this.loadEventSetUnchecked(shardKey);
    } catch (error) {
      if (
        error?.code !== "TOKENTRACKER_CURSOR_STORE_CORRUPT" ||
        !this.activateFallbackGeneration(cursors)
      ) {
        throw error;
      }
      throw cursorStoreRetry(error);
    }
  }

  loadEventSetUnchecked(shardKey) {
    if (this.loadedEventSets.has(shardKey)) {
      return this.loadedEventSets.get(shardKey);
    }
    const metadata = this.generation?.codexEvents?.[shardKey] || null;
    const filePath = metadata?.file
      ? path.join(this.generationDir, metadata.file)
      : null;
    let raw = "";
    if (filePath) {
      try {
        raw = fssync.readFileSync(filePath, "utf8");
      } catch (e) {
        throw cursorStoreCorruption(
          `Unable to read Codex event shard ${metadata.file}`,
          e,
        );
      }
      assertShardIntegrity(raw, metadata, `Codex event shard ${metadata.file}`);
    }
    const rows = raw.split("\n").filter(Boolean);
    const values = new Set(rows);
    if (
      filePath &&
      (rows.length !== metadata.count || values.size !== metadata.count)
    ) {
      throw cursorStoreCorruption(`Invalid Codex event shard ${metadata.file}`);
    }
    this.loadedEventSets.set(shardKey, values);
    return values;
  }

  activateFallbackGeneration(cursors = this.cursors) {
    let fallback = null;
    while (!fallback && this.fallbackGenerationIds.length > 0) {
      fallback = readGenerationSync({
        storeRoot: this.storeRoot,
        generationId: this.fallbackGenerationIds.shift(),
      });
    }
    if (!fallback) return false;

    const fallbackCore = cloneJson(fallback.core);
    replaceObjectContents(this.cursors, fallbackCore);
    if (cursors !== this.cursors) {
      replaceObjectContents(cursors, cloneJson(fallback.core));
    }
    this.generation = fallback.metadata;
    this.generationDir = fallback.directory;
    this.loadedFileShards.clear();
    this.loadedEventSets.clear();
    this.pendingEventKeys.clear();
    this.skipValidationCache.clear();
    this.loadedOpencodeMessageShards.clear();
    this.loadedOpencodeFingerprintShards.clear();
    this.opencodeFingerprintIndexes.clear();
    this.materializedOpencodeNamespaces.clear();
    this.materializedCodexHashes = false;
    this.requiresCommit = true;
    this.normalizeGenerationMetadata();
    this.stageInlineOpencodeMessages();
    return true;
  }

  async commitOpencodeShards({ cursors, generationDir, metadata }) {
    const states = opencodeNamespaceStates(cursors.opencode);
    const currentNamespaces = new Set(states.keys());

    for (const shardMap of [metadata.opencodeMessages, metadata.opencodeFingerprints]) {
      for (const [shardKey, entry] of Object.entries(shardMap)) {
        if (currentNamespaces.has(opencodeShardNamespace(shardKey))) continue;
        if (entry?.file) await fs.unlink(path.join(generationDir, entry.file)).catch(() => {});
        delete shardMap[shardKey];
      }
    }

    for (const [namespace, state] of states) {
      const messages = state.messages && typeof state.messages === "object"
        ? state.messages
        : {};
      const managed = hasOpencodeNamespaceShards({
        namespace,
        metadata: this.generation,
        loadedMessages: this.loadedOpencodeMessageShards,
        loadedFingerprints: this.loadedOpencodeFingerprintShards,
      });
      const materialized = this.materializedOpencodeNamespaces.has(namespace) ||
        (!managed && Object.keys(messages).length > 0);

      if (materialized) {
        await removeOpencodeNamespaceShards({ generationDir, metadata, namespace });
        const partitioned = partitionOpencodeMessages(messages, namespace);
        for (const [shardKey, data] of partitioned.messageShards) {
          await writeOpencodeShard({
            generationDir,
            metadataMap: metadata.opencodeMessages,
            directory: OPENCODE_MESSAGES_DIRNAME,
            shardKey,
            data,
          });
        }
        for (const [shardKey, data] of partitioned.fingerprintShards) {
          await writeOpencodeShard({
            generationDir,
            metadataMap: metadata.opencodeFingerprints,
            directory: OPENCODE_FINGERPRINTS_DIRNAME,
            shardKey,
            data,
          });
        }
        continue;
      }

      const dirtyMessageShards = new Set([
        ...opencodeShardKeysForNamespace(
          namespace,
          {},
          this.loadedOpencodeMessageShards,
        ),
        ...Object.keys(messages).map((key) => opencodeMessageShardKey(key, namespace)),
      ]);
      for (const shardKey of dirtyMessageShards) {
        const data = {};
        for (const [messageKey, entry] of Object.entries(messages)) {
          if (opencodeMessageShardKey(messageKey, namespace) === shardKey) {
            data[messageKey] = entry;
          }
        }
        await writeOpencodeShard({
          generationDir,
          metadataMap: metadata.opencodeMessages,
          directory: OPENCODE_MESSAGES_DIRNAME,
          shardKey,
          data,
        });
      }

      const fingerprintIndex = this.opencodeFingerprintIndexes.get(namespace) || new Map();
      for (const shardKey of opencodeShardKeysForNamespace(
        namespace,
        {},
        this.loadedOpencodeFingerprintShards,
      )) {
        const data = {};
        for (const [fingerprint, owners] of fingerprintIndex) {
          if (opencodeFingerprintShardKey(fingerprint, namespace) === shardKey) {
            data[fingerprint] = Array.from(owners);
          }
        }
        await writeOpencodeShard({
          generationDir,
          metadataMap: metadata.opencodeFingerprints,
          directory: OPENCODE_FINGERPRINTS_DIRNAME,
          shardKey,
          data,
        });
      }
    }
  }

  async commit(cursors = this.cursors) {
    const generationId = newGenerationId();
    const generationDir = generationDirectory(this.storeRoot, generationId);
    let published = false;
    try {
      await ensureDir(path.join(generationDir, "codex-files"));
      await ensureDir(path.join(generationDir, "codex-events"));
      await ensureDir(path.join(generationDir, OPENCODE_MESSAGES_DIRNAME));
      await ensureDir(path.join(generationDir, OPENCODE_FINGERPRINTS_DIRNAME));

      const nextMetadata = {
        version: STORE_VERSION,
        id: generationId,
        createdAt: new Date().toISOString(),
        coreFile: SHARDED_CORE_FILENAME,
        codexFiles: cloneJson(this.generation?.codexFiles || {}),
        codexEvents: cloneJson(this.generation?.codexEvents || {}),
        opencodeMessages: cloneJson(this.generation?.opencodeMessages || {}),
        opencodeFingerprints: cloneJson(this.generation?.opencodeFingerprints || {}),
        counts: {},
      };

      await cloneGenerationFiles({
        fromDirectory: this.generationDir,
        toDirectory: generationDir,
        metadata: nextMetadata,
      });

      const codexShardKeysPresent = new Set();
      for (const filePath of Object.keys(cursors.files || {})) {
        if (isCodexSessionCursorPathForRoots(filePath, this.codexRoots)) {
          codexShardKeysPresent.add(codexFileShardKey(filePath));
        }
      }
      for (const shardKey of codexShardKeysPresent) {
        if (!this.loadedFileShards.has(shardKey) && nextMetadata.codexFiles[shardKey]) {
          await this.loadFileShardUnchecked(shardKey, cursors);
        }
      }

      const { coreFiles, codexFilesByShard } = partitionCursorFiles(
        cursors.files,
        this.codexRoots,
      );
      const dirtyFileShards = new Set([
        ...this.loadedFileShards.keys(),
        ...codexFilesByShard.keys(),
      ]);
      for (const shardKey of dirtyFileShards) {
        const data = codexFilesByShard.get(shardKey) || {};
        const relativeFile = path.join("codex-files", `${safeShardFilename(shardKey)}.json`);
        const targetPath = path.join(generationDir, relativeFile);
        await fs.unlink(targetPath).catch(() => {});
        if (Object.keys(data).length === 0) {
          delete nextMetadata.codexFiles[shardKey];
          continue;
        }
        const serialized = `${JSON.stringify(data)}\n`;
        await fs.writeFile(targetPath, serialized, "utf8");
        nextMetadata.codexFiles[shardKey] = buildCodexFileShardMetadata({
          shardKey,
          data,
          relativeFile,
          serialized,
          dayInventoryCache: cursors.codexDayInventoryCache,
        });
      }

      if (this.materializedCodexHashes || Array.isArray(cursors.codexHashes)) {
        await rebuildEventShards({
          generationDir,
          metadata: nextMetadata,
          hashes: Array.isArray(cursors.codexHashes) ? cursors.codexHashes : [],
        });
      } else {
        for (const [shardKey, pending] of this.pendingEventKeys.entries()) {
          if (pending.size === 0) continue;
          const existing = this.loadEventSetUnchecked(shardKey);
          for (const key of pending) existing.add(key);
          const relativeFile = path.join("codex-events", `${safeShardFilename(shardKey)}.txt`);
          const targetPath = path.join(generationDir, relativeFile);
          await fs.unlink(targetPath).catch(() => {});
          const serialized = serializeEventSet(existing);
          await fs.writeFile(targetPath, serialized, "utf8");
          nextMetadata.codexEvents[shardKey] = buildEventShardMetadata({
            relativeFile,
            values: existing,
            serialized,
          });
        }
      }

      await this.commitOpencodeShards({
        cursors,
        generationDir,
        metadata: nextMetadata,
      });

      const core = {
        ...cursors,
        files: coreFiles,
        opencode: cloneOpencodeCoreState(cursors.opencode),
      };
      delete core.codexHashes;
      await fs.writeFile(
        path.join(generationDir, nextMetadata.coreFile),
        `${JSON.stringify(core)}\n`,
        "utf8",
      );

      nextMetadata.counts = calculateGenerationCounts(nextMetadata, coreFiles);
      await fs.writeFile(
        path.join(generationDir, "generation.json"),
        `${JSON.stringify(nextMetadata, null, 2)}\n`,
        "utf8",
      );

      await maybeInjectFailure(this.failureInjector, "beforeManifestSwap");

      const compatibleGeneration = this.generation?.coreFile === "core.json"
        ? this.generation.id
        : this.manifest?.previous || null;
      const nextManifest = {
        version: STORE_VERSION,
        current: generationId,
        rollback: this.generation?.id || null,
        // Older v2 readers reject core-v3.json and fall back to this frozen,
        // fully-inline checkpoint instead of opening an empty message index.
        previous: compatibleGeneration,
        legacyFingerprint: this.manifest?.legacyFingerprint || null,
        updatedAt: new Date().toISOString(),
      };
      await writeJson(path.join(this.storeRoot, MANIFEST_FILENAME), nextManifest);
      published = true;

      this.manifest = nextManifest;
      this.generation = nextMetadata;
      this.generationDir = generationDir;
      this.cursors = core;
      this.loadedFileShards.clear();
      this.loadedEventSets.clear();
      this.pendingEventKeys.clear();
      this.skipValidationCache.clear();
      this.loadedOpencodeMessageShards.clear();
      this.loadedOpencodeFingerprintShards.clear();
      this.opencodeFingerprintIndexes.clear();
      this.materializedOpencodeNamespaces.clear();
      this.materializedCodexHashes = false;
      this.fallbackGenerationIds = [nextManifest.rollback].filter(Boolean);
      this.requiresCommit = false;
      await cleanupGenerations(this.storeRoot, new Set([
        nextManifest.current,
        nextManifest.rollback,
        nextManifest.previous,
      ].filter(Boolean)));
    } catch (error) {
      if (!published) {
        await fs.rm(generationDir, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
  }
}

async function migrateLegacyCursorState({
  cursorsPath,
  storeRoot,
  legacyFingerprint,
  previousManifest,
  codexRoots,
  failureInjector,
}) {
  const cursors = await readLegacyCursorStateForMigration(cursorsPath);
  const generationId = newGenerationId();
  const generationDir = generationDirectory(storeRoot, generationId);
  await ensureDir(path.join(generationDir, "codex-files"));
  await ensureDir(path.join(generationDir, "codex-events"));

  const { coreFiles, codexFilesByShard } = partitionCursorFiles(
    cursors.files || {},
    codexRoots,
  );
  const eventShards = partitionEventHashes(cursors.codexHashes || []);
  const core = { ...cursors, files: coreFiles };
  delete core.codexHashes;

  const metadata = {
    version: STORE_VERSION,
    id: generationId,
    createdAt: new Date().toISOString(),
    coreFile: "core.json",
    codexFiles: {},
    codexEvents: {},
    counts: {},
  };

  for (const [shardKey, data] of codexFilesByShard.entries()) {
    const relativeFile = path.join("codex-files", `${safeShardFilename(shardKey)}.json`);
    const serialized = `${JSON.stringify(data)}\n`;
    await fs.writeFile(
      path.join(generationDir, relativeFile),
      serialized,
      "utf8",
    );
    metadata.codexFiles[shardKey] = buildCodexFileShardMetadata({
      shardKey,
      data,
      relativeFile,
      serialized,
      dayInventoryCache: cursors.codexDayInventoryCache,
    });
  }

  for (const [shardKey, values] of eventShards.entries()) {
    const relativeFile = path.join("codex-events", `${safeShardFilename(shardKey)}.txt`);
    const serialized = serializeEventSet(values);
    await fs.writeFile(
      path.join(generationDir, relativeFile),
      serialized,
      "utf8",
    );
    metadata.codexEvents[shardKey] = buildEventShardMetadata({
      relativeFile,
      values,
      serialized,
    });
  }

  await fs.writeFile(
    path.join(generationDir, metadata.coreFile),
    `${JSON.stringify(core)}\n`,
    "utf8",
  );
  metadata.counts = calculateGenerationCounts(metadata, coreFiles);
  await fs.writeFile(
    path.join(generationDir, "generation.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );

  await maybeInjectFailure(failureInjector, "beforeMigrationManifestSwap");
  const manifest = {
    version: STORE_VERSION,
    current: generationId,
    previous: isManifest(previousManifest) ? previousManifest.current : null,
    legacyFingerprint: legacyFingerprint || null,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(path.join(storeRoot, MANIFEST_FILENAME), manifest);
  await cleanupGenerations(storeRoot, new Set([
    manifest.current,
    manifest.previous,
  ].filter(Boolean)));
  return manifest;
}

async function readLegacyCursorStateForMigration(cursorsPath) {
  const result = await readJsonStrict(cursorsPath);
  if (result.status === "missing") return defaultCursorState();
  if (result.status !== "ok") {
    throw cursorStoreCorruption(
      `Unable to read legacy cursor state ${cursorsPath}`,
      result.error,
    );
  }
  if (!isCursorStateRoot(result.value)) {
    throw cursorStoreCorruption(`Invalid legacy cursor state ${cursorsPath}`);
  }
  if (
    result.value.codexHashes !== undefined &&
    !Array.isArray(result.value.codexHashes)
  ) {
    throw cursorStoreCorruption(`Invalid legacy Codex event state ${cursorsPath}`);
  }
  return result.value;
}

async function openManifestGeneration({
  cursorsPath,
  storeRoot,
  manifest,
  codexRoots,
  failureInjector,
}) {
  const generationIds = Array.from(new Set([
    manifest.current,
    manifest.rollback || manifest.previous,
  ].filter(Boolean)));
  for (let index = 0; index < generationIds.length; index += 1) {
    const generationId = generationIds[index];
    const generation = await readGeneration({ storeRoot, generationId });
    if (!generation) continue;
    return new V2CursorStore({
      cursorsPath,
      storeRoot,
      manifest,
      generation,
      fallbackGenerationIds: generationIds.slice(index + 1),
      codexRoots,
      failureInjector,
    });
  }
  return null;
}

async function readGeneration({ storeRoot, generationId }) {
  if (typeof generationId !== "string" || generationId.length === 0) return null;
  const directory = generationDirectory(storeRoot, generationId);
  const metadata = await readJson(path.join(directory, "generation.json"));
  if (!isGenerationMetadata(metadata, generationId)) {
    return null;
  }
  const core = await readJson(path.join(directory, metadata.coreFile));
  if (!isCursorStateRoot(core)) return null;
  if (!(await generationReferencesExist(directory, metadata))) return null;
  const counts = calculateGenerationCounts(metadata, core.files);
  if (!sameGenerationCounts(counts, metadata.counts)) return null;
  return { directory, metadata, core };
}

function readGenerationSync({ storeRoot, generationId }) {
  if (typeof generationId !== "string" || generationId.length === 0) return null;
  const directory = generationDirectory(storeRoot, generationId);
  try {
    const metadata = JSON.parse(
      fssync.readFileSync(path.join(directory, "generation.json"), "utf8"),
    );
    if (!isGenerationMetadata(metadata, generationId)) return null;
    const core = JSON.parse(
      fssync.readFileSync(path.join(directory, metadata.coreFile), "utf8"),
    );
    if (!isCursorStateRoot(core)) return null;
    if (!generationReferencesExistSync(directory, metadata)) return null;
    const counts = calculateGenerationCounts(metadata, core.files);
    if (!sameGenerationCounts(counts, metadata.counts)) return null;
    return { directory, metadata, core };
  } catch (_error) {
    return null;
  }
}

function isCursorStateRoot(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.files &&
    typeof value.files === "object" &&
    !Array.isArray(value.files)
  );
}

function isGenerationMetadata(metadata, generationId) {
  const shardedOpencode = metadata?.coreFile === SHARDED_CORE_FILENAME;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.version !== STORE_VERSION ||
    metadata.id !== generationId ||
    (metadata.coreFile !== "core.json" && !shardedOpencode) ||
    !metadata.codexFiles ||
    typeof metadata.codexFiles !== "object" ||
    Array.isArray(metadata.codexFiles) ||
    !metadata.codexEvents ||
    typeof metadata.codexEvents !== "object" ||
    Array.isArray(metadata.codexEvents) ||
    !metadata.counts ||
    typeof metadata.counts !== "object" ||
    Array.isArray(metadata.counts)
  ) {
    return false;
  }
  if (
    shardedOpencode &&
    (!metadata.opencodeMessages ||
      typeof metadata.opencodeMessages !== "object" ||
      Array.isArray(metadata.opencodeMessages) ||
      !metadata.opencodeFingerprints ||
      typeof metadata.opencodeFingerprints !== "object" ||
      Array.isArray(metadata.opencodeFingerprints))
  ) {
    return false;
  }

  return (
    validShardMetadataMap(metadata.codexFiles, "codex-files") &&
    validShardMetadataMap(metadata.codexEvents, "codex-events") &&
    (!shardedOpencode || (
      validShardMetadataMap(metadata.opencodeMessages, OPENCODE_MESSAGES_DIRNAME) &&
      validShardMetadataMap(metadata.opencodeFingerprints, OPENCODE_FINGERPRINTS_DIRNAME)
    ))
  );
}

function validShardMetadataMap(shards, expectedDirectory) {
  const files = new Set();
  for (const entry of Object.values(shards)) {
    const reference = normalizeShardReference(entry?.file, expectedDirectory);
    const count = Number(entry?.count);
    const bytes = Number(entry?.bytes);
    if (
      !reference ||
      files.has(reference.name) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      typeof entry?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      return false;
    }
    files.add(reference.name);
  }
  return true;
}

async function generationReferencesExist(directory, metadata) {
  for (const [expectedDirectory, shards] of generationShardMaps(metadata)) {
    const expectedNames = Object.values(shards)
      .map((entry) => normalizeShardReference(entry.file, expectedDirectory).name);
    if (expectedNames.length === 0) continue;

    let entries;
    try {
      entries = await fs.readdir(path.join(directory, expectedDirectory), {
        withFileTypes: true,
      });
    } catch (_e) {
      return false;
    }
    const files = new Map(entries.map((entry) => [entry.name, entry]));
    if (expectedNames.some((name) => !files.get(name)?.isFile())) return false;
  }
  return true;
}

function generationReferencesExistSync(directory, metadata) {
  for (const [expectedDirectory, shards] of generationShardMaps(metadata)) {
    const expectedNames = Object.values(shards)
      .map((entry) => normalizeShardReference(entry.file, expectedDirectory).name);
    if (expectedNames.length === 0) continue;

    let entries;
    try {
      entries = fssync.readdirSync(path.join(directory, expectedDirectory), {
        withFileTypes: true,
      });
    } catch (_error) {
      return false;
    }
    const files = new Map(entries.map((entry) => [entry.name, entry]));
    if (expectedNames.some((name) => !files.get(name)?.isFile())) return false;
  }
  return true;
}

function normalizeShardReference(relativeFile, expectedDirectory) {
  if (typeof relativeFile !== "string" || relativeFile.length === 0) return null;
  const normalized = relativeFile.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    parts.length !== 2 ||
    parts[0] !== expectedDirectory ||
    !parts[1] ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    return null;
  }
  return { directory: expectedDirectory, name: parts[1] };
}

function generationShardMaps(metadata) {
  return [
    ["codex-files", metadata.codexFiles || {}],
    ["codex-events", metadata.codexEvents || {}],
    [OPENCODE_MESSAGES_DIRNAME, metadata.opencodeMessages || {}],
    [OPENCODE_FINGERPRINTS_DIRNAME, metadata.opencodeFingerprints || {}],
  ];
}

function sameGenerationCounts(left, right) {
  return [
    "nonCodexFiles",
    "codexFiles",
    "totalFiles",
    "codexEvents",
    "opencodeMessages",
    "opencodeFingerprints",
  ].every((key) => Number(left?.[key] || 0) === Number(right?.[key] || 0));
}

async function cloneGenerationFiles({ fromDirectory, toDirectory, metadata }) {
  for (const [, shards] of generationShardMaps(metadata)) {
    for (const entry of Object.values(shards)) {
      if (entry?.file) await cloneOrCopy(fromDirectory, toDirectory, entry.file);
    }
  }
}

async function cloneOrCopy(fromDirectory, toDirectory, relativeFile) {
  const source = path.join(fromDirectory, relativeFile);
  const target = path.join(toDirectory, relativeFile);
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target, fssync.constants.COPYFILE_FICLONE);
}

async function rebuildEventShards({ generationDir, metadata, hashes }) {
  for (const entry of Object.values(metadata.codexEvents || {})) {
    if (entry?.file) await fs.unlink(path.join(generationDir, entry.file)).catch(() => {});
  }
  metadata.codexEvents = {};
  for (const [shardKey, values] of partitionEventHashes(hashes).entries()) {
    const relativeFile = path.join("codex-events", `${safeShardFilename(shardKey)}.txt`);
    const serialized = serializeEventSet(values);
    await fs.writeFile(
      path.join(generationDir, relativeFile),
      serialized,
      "utf8",
    );
    metadata.codexEvents[shardKey] = buildEventShardMetadata({
      relativeFile,
      values,
      serialized,
    });
  }
}

function buildCodexFileShardMetadata({
  shardKey,
  data,
  relativeFile,
  serialized,
  dayInventoryCache,
}) {
  const directories = {};
  const configs = new Map();
  let absentFreshUntil = null;

  for (const [filePath, cursor] of Object.entries(data || {})) {
    const dayDir = codexDayDirectory(filePath);
    if (dayDir) {
      if (!directories[dayDir]) directories[dayDir] = { paths: [] };
      directories[dayDir].paths.push(filePath);
    }
    const context = cursor?.projectFileContext;
    if (context?.absent === true) {
      const checkedAtMs = Number(context.checkedAtMs);
      if (Number.isFinite(checkedAtMs) && checkedAtMs > 0) {
        const expiresAt = checkedAtMs + PROJECT_ABSENT_CONTEXT_RESCAN_MS;
        absentFreshUntil = absentFreshUntil == null
          ? expiresAt
          : Math.min(absentFreshUntil, expiresAt);
      } else {
        absentFreshUntil = 0;
      }
      continue;
    }
    for (const config of projectConfigs(context)) {
      configs.set(config.configPath, config);
    }
  }

  for (const [dayDir, value] of Object.entries(directories)) {
    const inventory = dayInventoryCache?.days?.[dayDir];
    const inventoryFiles = Array.isArray(inventory?.files) ? inventory.files : [];
    const complete = Boolean(
      typeof inventory?.statKey === "string" &&
      inventoryFiles.length > 0 &&
      inventoryFiles.every((name) => {
        const filePath = path.join(dayDir, name);
        const cursor = data[filePath];
        const offset = Number(cursor?.offset);
        const projectOffset = Number(cursor?.projectOffset);
        return (
          Number.isFinite(offset) && offset > 0 &&
          Number.isFinite(projectOffset) && projectOffset >= offset &&
          cursor?.projectFileContext && typeof cursor.projectFileContext === "object"
        );
      })
    );
    directories[dayDir] = {
      statKey: typeof inventory?.statKey === "string" ? inventory.statKey : null,
      fileCount: inventoryFiles.length,
      complete,
    };
  }

  return {
    file: relativeFile,
    shardKey,
    count: Object.keys(data || {}).length,
    ...buildShardIntegrity(serialized),
    directories,
    projectSummary: {
      configs: Array.from(configs.values()),
      absentFreshUntil,
    },
  };
}

function buildEventShardMetadata({ relativeFile, values, serialized }) {
  return {
    file: relativeFile,
    count: values.size,
    ...buildShardIntegrity(serialized),
  };
}

function buildShardIntegrity(serialized) {
  return {
    bytes: Buffer.byteLength(serialized),
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
  };
}

function assertShardIntegrity(raw, metadata, label) {
  const integrity = buildShardIntegrity(raw);
  if (
    integrity.bytes !== metadata?.bytes ||
    integrity.sha256 !== metadata?.sha256
  ) {
    throw cursorStoreCorruption(`Integrity check failed for ${label}`);
  }
}

async function readJsonObjectShard({
  generationDir,
  metadata,
  label,
  validate = (value) => value && typeof value === "object" && !Array.isArray(value),
}) {
  if (!metadata?.file) return {};
  let raw;
  try {
    raw = await fs.readFile(path.join(generationDir, metadata.file), "utf8");
  } catch (error) {
    throw cursorStoreCorruption(`Unable to read ${label}`, error);
  }
  assertShardIntegrity(raw, metadata, label);
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw cursorStoreCorruption(`Invalid ${label}`, error);
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length !== metadata.count ||
    Object.values(data).some((value) => !validate(value))
  ) {
    throw cursorStoreCorruption(`Invalid ${label}`);
  }
  return data;
}

async function writeOpencodeShard({
  generationDir,
  metadataMap,
  directory,
  shardKey,
  data,
}) {
  const previousFile = metadataMap[shardKey]?.file;
  if (previousFile) await fs.unlink(path.join(generationDir, previousFile)).catch(() => {});
  if (Object.keys(data).length === 0) {
    delete metadataMap[shardKey];
    return;
  }
  const relativeFile = path.join(directory, `${shardKey}.json`);
  const serialized = `${JSON.stringify(data)}\n`;
  await fs.writeFile(path.join(generationDir, relativeFile), serialized, "utf8");
  metadataMap[shardKey] = {
    file: relativeFile,
    count: Object.keys(data).length,
    ...buildShardIntegrity(serialized),
  };
}

async function removeOpencodeNamespaceShards({ generationDir, metadata, namespace }) {
  for (const shardMap of [metadata.opencodeMessages, metadata.opencodeFingerprints]) {
    for (const [shardKey, entry] of Object.entries(shardMap)) {
      if (opencodeShardNamespace(shardKey) !== namespace) continue;
      if (entry?.file) await fs.unlink(path.join(generationDir, entry.file)).catch(() => {});
      delete shardMap[shardKey];
    }
  }
}

function normalizeOpencodeNamespace(value) {
  return value === "native" || value === "wsl" ? value : "flat";
}

function opencodeNamespaceStates(state) {
  const out = new Map();
  if (!state || typeof state !== "object" || Array.isArray(state)) return out;
  if (state.native !== undefined || state.wsl !== undefined) {
    for (const namespace of ["native", "wsl"]) {
      const child = state[namespace];
      if (child && typeof child === "object" && !Array.isArray(child)) {
        out.set(namespace, child);
      }
    }
  } else {
    out.set("flat", state);
  }
  return out;
}

function opencodeStateForNamespace(cursors, namespace, create = false) {
  if (!cursors.opencode || typeof cursors.opencode !== "object" || Array.isArray(cursors.opencode)) {
    if (!create) return null;
    cursors.opencode = namespace === "flat" ? {} : { native: {}, wsl: {} };
  }
  const root = cursors.opencode;
  const namespaced = root.native !== undefined || root.wsl !== undefined;
  if (namespace === "flat") return namespaced ? null : root;
  if (!namespaced) return null;
  if (!root[namespace] || typeof root[namespace] !== "object" || Array.isArray(root[namespace])) {
    if (!create) return null;
    root[namespace] = {};
  }
  return root[namespace];
}

function opencodeShardHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 2);
}

function opencodeMessageShardKey(messageKey, namespace = "flat") {
  return `${normalizeOpencodeNamespace(namespace)}-${opencodeShardHash(messageKey)}`;
}

function opencodeFingerprintShardKey(fingerprint, namespace = "flat") {
  return `${normalizeOpencodeNamespace(namespace)}-${opencodeShardHash(fingerprint)}`;
}

function opencodeShardNamespace(shardKey) {
  const namespace = typeof shardKey === "string" ? shardKey.split("-", 1)[0] : "";
  return namespace === "native" || namespace === "wsl" ? namespace : "flat";
}

function opencodeShardKeysForNamespace(namespace, metadataMap, loadedMap) {
  return Array.from(new Set([
    ...Object.keys(metadataMap || {}),
    ...Array.from(loadedMap?.keys?.() || []),
  ].filter((shardKey) => opencodeShardNamespace(shardKey) === namespace)));
}

function hasOpencodeNamespaceShards({
  namespace,
  metadata,
  loadedMessages,
  loadedFingerprints,
}) {
  return (
    opencodeShardKeysForNamespace(namespace, metadata.opencodeMessages, loadedMessages).length > 0 ||
    opencodeShardKeysForNamespace(namespace, metadata.opencodeFingerprints, loadedFingerprints).length > 0
  );
}

function opencodeNamespacesForStore({
  state,
  metadata,
  loadedMessages,
  loadedFingerprints,
}) {
  const namespaces = new Set(opencodeNamespaceStates(state).keys());
  for (const shardKey of [
    ...Object.keys(metadata.opencodeMessages || {}),
    ...Object.keys(metadata.opencodeFingerprints || {}),
    ...Array.from(loadedMessages.keys()),
    ...Array.from(loadedFingerprints.keys()),
  ]) {
    namespaces.add(opencodeShardNamespace(shardKey));
  }
  return namespaces;
}

function partitionOpencodeMessages(messages, namespace) {
  const messageShards = new Map();
  const fingerprintShards = new Map();
  for (const messageKey in messages || {}) {
    const entry = messages[messageKey];
    const messageShard = opencodeMessageShardKey(messageKey, namespace);
    if (!messageShards.has(messageShard)) messageShards.set(messageShard, {});
    messageShards.get(messageShard)[messageKey] = entry;
    const fingerprint = typeof entry?.fingerprint === "string" ? entry.fingerprint : null;
    if (!fingerprint || entry?.dedupedForkCopy === true) continue;
    const fingerprintShard = opencodeFingerprintShardKey(fingerprint, namespace);
    if (!fingerprintShards.has(fingerprintShard)) fingerprintShards.set(fingerprintShard, {});
    const shard = fingerprintShards.get(fingerprintShard);
    if (!shard[fingerprint]) shard[fingerprint] = [];
    shard[fingerprint].push(messageKey);
  }
  return { messageShards, fingerprintShards };
}

function cloneOpencodeCoreState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  if (state.native !== undefined || state.wsl !== undefined) {
    const clone = { ...state };
    for (const namespace of ["native", "wsl"]) {
      if (!state[namespace] || typeof state[namespace] !== "object") continue;
      clone[namespace] = { ...state[namespace] };
      delete clone[namespace].messages;
    }
    return clone;
  }
  const clone = { ...state };
  delete clone.messages;
  return clone;
}

async function validateProjectSummary(summary, nowMs) {
  if (!summary || typeof summary !== "object") return false;
  const absentFreshUntil = Number(summary.absentFreshUntil);
  if (Number.isFinite(absentFreshUntil) && absentFreshUntil > 0 && nowMs >= absentFreshUntil) {
    return false;
  }
  if (summary.absentFreshUntil === 0) return false;
  for (const config of Array.isArray(summary.configs) ? summary.configs : []) {
    const configPath = typeof config?.configPath === "string" ? config.configPath : null;
    if (!configPath) return false;
    const stat = await fs.stat(configPath).catch(() => null);
    if (
      !stat?.isFile() ||
      stat.mtimeMs !== config.configMtimeMs ||
      stat.size !== config.configSize
    ) {
      return false;
    }
  }
  return true;
}

function projectConfigs(context) {
  if (!context || typeof context !== "object") return [];
  const raw = Array.isArray(context.configs) ? context.configs : [context];
  const out = [];
  for (const config of raw) {
    const configPath = typeof config?.configPath === "string" ? config.configPath : null;
    if (!configPath) continue;
    out.push({
      configPath,
      configMtimeMs: Number.isFinite(config.configMtimeMs) ? config.configMtimeMs : null,
      configSize: Number.isFinite(config.configSize) ? config.configSize : null,
    });
  }
  return out;
}

function partitionCursorFiles(files, codexRoots = []) {
  const coreFiles = {};
  const codexFilesByShard = new Map();
  for (const [filePath, cursor] of Object.entries(files || {})) {
    if (!isCodexSessionCursorPathForRoots(filePath, codexRoots)) {
      coreFiles[filePath] = cursor;
      continue;
    }
    const shardKey = codexFileShardKey(filePath);
    if (!codexFilesByShard.has(shardKey)) codexFilesByShard.set(shardKey, {});
    codexFilesByShard.get(shardKey)[filePath] = cursor;
  }
  return { coreFiles, codexFilesByShard };
}

function partitionEventHashes(hashes) {
  const shards = new Map();
  for (const key of Array.isArray(hashes) ? hashes : []) {
    if (typeof key !== "string" || key.length === 0) continue;
    const shardKey = codexEventShardKey(key);
    if (!shards.has(shardKey)) shards.set(shardKey, new Set());
    shards.get(shardKey).add(key);
  }
  return shards;
}

function mergeFileShardIntoCursors(data, cursors) {
  if (!cursors.files || typeof cursors.files !== "object") cursors.files = {};
  for (const [filePath, cursor] of Object.entries(data || {})) {
    if (!(filePath in cursors.files)) cursors.files[filePath] = cursor;
  }
}

function calculateGenerationCounts(metadata, coreFiles) {
  const nonCodexFiles = Object.keys(coreFiles || {}).length;
  const codexFiles = Object.values(metadata.codexFiles || {})
    .reduce((sum, entry) => sum + Number(entry?.count || 0), 0);
  const codexEvents = Object.values(metadata.codexEvents || {})
    .reduce((sum, entry) => sum + Number(entry?.count || 0), 0);
  const opencodeMessages = Object.values(metadata.opencodeMessages || {})
    .reduce((sum, entry) => sum + Number(entry?.count || 0), 0);
  const opencodeFingerprints = Object.values(metadata.opencodeFingerprints || {})
    .reduce((sum, entry) => sum + Number(entry?.count || 0), 0);
  return {
    nonCodexFiles,
    codexFiles,
    totalFiles: nonCodexFiles + codexFiles,
    codexEvents,
    opencodeMessages,
    opencodeFingerprints,
  };
}

function isCodexSessionCursorPath(filePath, codexRoots = []) {
  return isCodexSessionCursorPathForRoots(
    filePath,
    normalizeCodexRoots(codexRoots),
  );
}

function isCodexSessionCursorPathForRoots(filePath, codexRoots) {
  if (typeof filePath !== "string") return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (/\/\.codex\/(?:archived_)?sessions\//.test(normalized)) return true;
  return codexRoots.some((root) => (
    normalized.startsWith(`${root}/sessions/`) ||
    normalized.startsWith(`${root}/archived_sessions/`)
  ));
}

function normalizeCodexRoots(roots) {
  const values = Array.isArray(roots) ? roots : [roots];
  return Array.from(new Set(values
    .filter((root) => typeof root === "string" && root.trim().length > 0)
    .map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""))));
}

function codexFileShardKey(filePath) {
  if (typeof filePath !== "string") return "misc";
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "misc";
}

function codexDayDirectory(filePath) {
  if (codexFileShardKey(filePath) === "misc") return null;
  return path.dirname(filePath);
}

function codexEventShardKey(key) {
  if (typeof key !== "string") return "misc";
  const separator = key.indexOf(":");
  const day = separator >= 0 ? key.slice(separator + 1, separator + 11) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "misc";
}

function safeShardFilename(shardKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(shardKey) ? shardKey : "misc";
}

function serializeEventSet(values) {
  const rows = Array.from(values || []);
  return rows.length > 0 ? `${rows.join("\n")}\n` : "";
}

function defaultCursorState() {
  return { version: 1, files: {}, updatedAt: null };
}

function newGenerationId() {
  return `gen-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function generationDirectory(storeRoot, generationId) {
  return path.join(storeRoot, GENERATIONS_DIRNAME, generationId);
}

function isManifest(value) {
  return Boolean(
    value &&
    value.version === STORE_VERSION &&
    typeof value.current === "string" &&
    value.current.length > 0
  );
}

async function fingerprintFile(filePath) {
  try {
    const stat = await fs.stat(filePath, { bigint: true });
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    };
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function sameFingerprint(left, right) {
  if (!left || !right) return left === right;
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
    .every((key) => String(left[key]) === String(right[key]));
}

async function cleanupGenerations(storeRoot, keep) {
  const root = path.join(storeRoot, GENERATIONS_DIRNAME);
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function cursorStoreCorruption(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "TOKENTRACKER_CURSOR_STORE_CORRUPT";
  return error;
}

function cursorStoreRetry(cause) {
  const error = new Error(
    "Cursor store generation changed; restart the operation",
    cause ? { cause } : undefined,
  );
  error.code = CURSOR_STORE_RETRY_CODE;
  return error;
}

function isCursorStoreRetry(error) {
  return error?.code === CURSOR_STORE_RETRY_CODE;
}

async function maybeInjectFailure(injector, stage) {
  if (typeof injector === "function") await injector(stage);
}

module.exports = {
  DEFAULT_ACTIVATION_BYTES,
  STORE_DIRNAME,
  STORE_VERSION,
  codexEventShardKey,
  codexFileShardKey,
  opencodeFingerprintShardKey,
  opencodeMessageShardKey,
  isCodexSessionCursorPath,
  isCursorStoreRetry,
  openCursorStore,
  readCursorStateSummary,
};
