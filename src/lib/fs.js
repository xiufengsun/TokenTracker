const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function writeFileAtomic(filePath, content, { mode } = {}) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  // Include a UUID so two writes in the same millisecond do not share a tmp
  // path (Date.now() alone collides under concurrent writers).
  const tmp = `${filePath}.tmp.${Date.now()}.${crypto.randomUUID()}`;
  // mode only applies to newly created files; passing it keeps the tmp file
  // private from creation instead of relying on a later chmod that a crash
  // between write and chmod would skip.
  await fs.writeFile(
    tmp,
    content,
    mode == null ? { encoding: "utf8" } : { encoding: "utf8", mode },
  );
  await fs.rename(tmp, filePath);
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

async function readJsonStrict(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { status: "ok", value: JSON.parse(raw), error: null };
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return { status: "missing", value: null, error: err };
    }
    if (err && err.name === "SyntaxError") {
      return { status: "invalid", value: null, error: err };
    }
    return { status: "error", value: null, error: err };
  }
}

async function writeJson(filePath, obj) {
  await writeFileAtomic(filePath, JSON.stringify(obj, null, 2) + "\n");
}

async function chmod600IfPossible(filePath) {
  try {
    await fs.chmod(filePath, 0o600);
  } catch (_e) {}
}

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_HEARTBEAT_MS = 30 * 1000;
const MAX_RECLAIM_DEPTH = 4;
const MAX_RECLAIM_SWEEP_DEPTH = 64;
const TRANSITION_GUARD_RETRY_MS = 5;
const TRANSITION_GUARD_ATTEMPTS = 1000;

function parseLockOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    const token = typeof parsed?.token === "string" ? parsed.token : null;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !token) return null;
    return { pid, token };
  } catch (_e) {
    return null;
  }
}

function heartbeatPathFor(lockPath, token) {
  const tokenDigest = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  return `${lockPath}.heartbeat.${tokenDigest}`;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e?.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user. Unknown
    // errors are treated conservatively so a live lock is never reclaimed.
    return true;
  }
}

async function existingLockCanBeReclaimed(lockPath) {
  let lockHandle = null;
  try {
    // Inspect one opened inode instead of stat-ing a path and then reading
    // that path. The latter is a TOCTOU window and is also unsafe if a
    // concurrent reclaimer replaces the lock between the two operations.
    lockHandle = await fs.open(lockPath, "r");
    const [stat, raw] = await Promise.all([
      lockHandle.stat(),
      lockHandle.readFile({ encoding: "utf8" }),
    ]);
    const owner = parseLockOwner(raw);
    if (owner) {
      if (!isProcessAlive(owner.pid)) return true;

      // New leases keep a token-specific heartbeat separate from the owner
      // file. This lets a PID that has since been reused be recognized as an
      // abandoned lease without reclaiming a live, long-running sync whose
      // heartbeat is still fresh. Locks from before heartbeat support retain
      // the conservative live-PID behavior.
      let heartbeatHandle = null;
      try {
        heartbeatHandle = await fs.open(heartbeatPathFor(lockPath, owner.token), "r");
        const heartbeat = await heartbeatHandle.stat();
        return Date.now() - heartbeat.mtimeMs > LOCK_STALE_MS;
      } catch (_e) {
        return false;
      } finally {
        await heartbeatHandle?.close().catch(() => {});
      }
    }
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch (e) {
    // The lock disappeared between open and inspection, so retry acquisition.
    if (e?.code === "ENOENT") return true;
    return false;
  } finally {
    await lockHandle?.close().catch(() => {});
  }
}

async function inspectLock(lockPath) {
  let raw = null;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { exists: false, pid: null, alive: false };
    return { exists: true, pid: null, alive: true };
  }
  const owner = parseLockOwner(raw);
  if (!owner) return { exists: true, pid: null, alive: true };
  return { exists: true, pid: owner.pid, alive: isProcessAlive(owner.pid) };
}

// Drop an abandoned lock file. The rename makes the removal atomic, so two
// sweepers racing on the same debris cannot delete a lease installed in
// between: only the winner of the rename removes anything.
async function removeAbandonedLockFile(lockPath) {
  if (!(await existingLockCanBeReclaimed(lockPath))) return false;
  const quarantinePath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (_e) {
    return false;
  }
  const owner = parseLockOwner(await fs.readFile(quarantinePath, "utf8").catch(() => ""));
  if (owner) {
    await fs.unlink(heartbeatPathFor(lockPath, owner.token)).catch(() => {});
  }
  await fs.unlink(quarantinePath).catch(() => {});
  return true;
}

// A sync killed while it held a transition guard leaves `${lockPath}.reclaim`
// behind, and the next reclaimer then nests its own guard on top of that
// orphan. Four nested levels exhaust MAX_RECLAIM_DEPTH, after which every
// acquisition gives up forever instead of healing (issue #431). Recursion
// cannot clean the chain — each level needs a guard one level deeper — so sweep
// it iteratively. Only levels whose owner is dead or whose heartbeat expired are
// removed, deepest first: dropping a shallow guard while a deeper orphan
// survives would just rebuild the same clogged chain on the next attempt.
async function sweepAbandonedReclaimGuards(lockPath) {
  const chain = [];
  let guardPath = lockPath;
  for (let depth = 0; depth < MAX_RECLAIM_SWEEP_DEPTH; depth += 1) {
    guardPath = `${guardPath}.reclaim`;
    try {
      await fs.access(guardPath);
    } catch (_e) {
      break;
    }
    chain.push(guardPath);
  }

  let removed = 0;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (await removeAbandonedLockFile(chain[index])) removed += 1;
  }
  return removed > 0;
}

function startLockHeartbeat(handle, heartbeatHandle) {
  const beat = async () => {
    try {
      const now = new Date();
      await Promise.all([
        handle.utimes(now, now),
        heartbeatHandle.utimes(now, now),
      ]);
    } catch (_e) {
      // A failed heartbeat makes the lease eligible for bounded stale
      // reclamation. The owning sync will still finish or release normally.
    }
  };
  const timer = setInterval(() => {
    void beat();
  }, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return timer;
}

async function releaseOwnedLock(
  lockPath,
  handle,
  heartbeatHandle,
  heartbeatTimer,
  token,
  {
    beforeReleaseUnlink = null,
    reclaimDepth = 0,
    serializeRelease = true,
  } = {},
) {
  let transitionGuard = null;
  if (serializeRelease) {
    // Reclaimers use the same guard while moving a stale lease aside. Holding
    // it across token validation and unlink makes that ownership transition
    // indivisible: an old owner cannot delete a replacement installed by a
    // concurrent stale-lock reclaimer.
    for (let attempt = 0; attempt < TRANSITION_GUARD_ATTEMPTS; attempt += 1) {
      transitionGuard = await openLock(`${lockPath}.reclaim`, {
        quietIfLocked: true,
        reclaimDepth: reclaimDepth + 1,
        // This short-lived internal guard is the serialization primitive; its
        // own release must not recursively acquire another transition guard.
        serializeRelease: false,
      });
      if (transitionGuard) break;
      await new Promise((resolve) => setTimeout(resolve, TRANSITION_GUARD_RETRY_MS));
    }
    if (!transitionGuard) {
      clearInterval(heartbeatTimer);
      await handle.close().catch(() => {});
      await heartbeatHandle?.close().catch(() => {});
      await fs.unlink(heartbeatPathFor(lockPath, token)).catch(() => {});
      throw new Error(`Timed out serializing lock release: ${lockPath}`);
    }
  }

  try {
    clearInterval(heartbeatTimer);
    await handle.close().catch(() => {});
    await heartbeatHandle?.close().catch(() => {});
    const owner = parseLockOwner(await fs.readFile(lockPath, "utf8"));
    if (owner?.token === token) {
      if (typeof beforeReleaseUnlink === "function") {
        await beforeReleaseUnlink({ lockPath });
      }
      await fs.unlink(lockPath).catch(() => {});
      await fs.unlink(heartbeatPathFor(lockPath, token)).catch(() => {});
    }
  } catch (_e) {
    // Missing or replaced owner paths are already released from this token's
    // perspective. Other failures retain the conservative no-delete outcome.
  } finally {
    await transitionGuard?.release();
  }
}

async function openLock(
  lockPath,
  {
    quietIfLocked = false,
    beforeReclaim = null,
    beforeReleaseUnlink = null,
    reclaimDepth = 0,
    serializeRelease = true,
    sweptReclaimGuards = false,
  } = {},
) {
  try {
    const handle = await fs.open(lockPath, "wx");
    const token = crypto.randomUUID();
    const heartbeatPath = heartbeatPathFor(lockPath, token);
    let heartbeatHandle = null;
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + "\n",
        "utf8",
      );
      heartbeatHandle = await fs.open(heartbeatPath, "wx");
      await heartbeatHandle.writeFile(`${token}\n`, "utf8");
      const heartbeatTimer = startLockHeartbeat(handle, heartbeatHandle);
      return {
        async release() {
          await releaseOwnedLock(
            lockPath,
            handle,
            heartbeatHandle,
            heartbeatTimer,
            token,
            {
              beforeReleaseUnlink,
              reclaimDepth,
              serializeRelease,
            },
          );
        },
      };
    } catch (e) {
      await heartbeatHandle?.close().catch(() => {});
      await fs.unlink(heartbeatPath).catch(() => {});
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e && e.code === "EEXIST") {
      if (await existingLockCanBeReclaimed(lockPath)) {
        if (typeof beforeReclaim === "function") {
          await beforeReclaim({ lockPath });
        }
        if (reclaimDepth >= MAX_RECLAIM_DEPTH) return null;

        // Serialize all reclaimers before re-checking the target. A stale
        // check can be shared by many contenders; only the holder of this
        // atomic guard may move the old lease out of the way.
        const reclaimGuard = await openLock(`${lockPath}.reclaim`, {
          quietIfLocked: true,
          reclaimDepth: reclaimDepth + 1,
          serializeRelease: false,
        });
        if (!reclaimGuard) {
          // Either a live reclaimer holds the guard (nothing to do) or the guard
          // chain is clogged with abandoned guards. Sweeping the latter is the
          // only escape, and it is attempted once per acquisition. beforeReclaim
          // already ran, so the retry must not invoke it a second time.
          if (!sweptReclaimGuards && (await sweepAbandonedReclaimGuards(lockPath))) {
            return openLock(lockPath, {
              quietIfLocked,
              beforeReleaseUnlink,
              reclaimDepth,
              serializeRelease,
              sweptReclaimGuards: true,
            });
          }
          return null;
        }

        let quarantinePath = null;
        try {
          // Re-check while holding the guard. A competing reclaimer may have
          // already replaced the target since our initial stale inspection.
          if (!(await existingLockCanBeReclaimed(lockPath))) return null;

          quarantinePath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
          try {
            await fs.rename(lockPath, quarantinePath);
          } catch (renameError) {
            if (renameError?.code === "ENOENT") {
              return openLock(lockPath, {
                quietIfLocked,
                beforeReleaseUnlink,
                reclaimDepth,
                serializeRelease,
              });
            }
            if (!quietIfLocked) {
              process.stdout.write("Another sync is already running.\n");
            }
            return null;
          }

          const staleOwner = parseLockOwner(
            await fs.readFile(quarantinePath, "utf8").catch(() => ""),
          );
          if (staleOwner) {
            // The heartbeat name contains the old token, so it cannot belong
            // to a replacement lease created after the atomic rename.
            await fs.unlink(heartbeatPathFor(lockPath, staleOwner.token)).catch(() => {});
          }
          return await openLock(lockPath, {
            quietIfLocked,
            beforeReleaseUnlink,
            reclaimDepth,
            serializeRelease,
          });
        } finally {
          if (quarantinePath) await fs.unlink(quarantinePath).catch(() => {});
          await reclaimGuard.release();
        }
      }
      if (!quietIfLocked) {
        process.stdout.write("Another sync is already running.\n");
      }
      return null;
    }
    throw e;
  }
}

module.exports = {
  ensureDir,
  writeFileAtomic,
  readJson,
  readJsonStrict,
  writeJson,
  chmod600IfPossible,
  openLock,
  inspectLock,
};
