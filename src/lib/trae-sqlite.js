const fs = require("node:fs");

let enginePromise;
let queryQueue = Promise.resolve();

async function createEngine() {
  const [{ default: initialize }, sqlite, { FacadeVFS }] = await Promise.all([
    import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    import("@journeyapps/wa-sqlite"),
    import("@journeyapps/wa-sqlite/src/FacadeVFS.js"),
  ]);
  const module = await initialize({
    wasmBinary: fs.readFileSync(require.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm")),
  });
  const api = sqlite.Factory(module);
  const snapshots = new Map();
  const handles = new Map();

  // Register one VFS for the lifetime of the engine. Each query gets a distinct
  // virtual filename, without accumulating WASM callbacks or touching disk.
  class TraeVFS extends FacadeVFS {
    constructor() {
      super("tokentracker-trae", module);
    }

    jOpen(name, fileId, flags, outputFlags) {
      const state = snapshots.get(name);
      if (!state || !(flags & sqlite.SQLITE_OPEN_MAIN_DB)) return sqlite.SQLITE_CANTOPEN;
      handles.set(fileId, state);
      outputFlags.setInt32(0, sqlite.SQLITE_OPEN_READONLY, true);
      return sqlite.SQLITE_OK;
    }

    jRead(fileId, output, offset) {
      const state = handles.get(fileId);
      if (!state) return sqlite.SQLITE_IOERR_READ;
      // FacadeVFS passes a proxy over WASM memory, not a native Uint8Array.
      // Keep the temporary buffer small and erase it after copying its page.
      const buffer = Buffer.alloc(output.byteLength);
      try {
        const count = state.snapshot.read(buffer, offset);
        if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) {
          throw new Error("Invalid TRAE snapshot read length.");
        }
        buffer.fill(0, count);
        output.set(buffer);
        return count === buffer.length ? sqlite.SQLITE_OK : sqlite.SQLITE_IOERR_SHORT_READ;
      } catch (err) {
        state.error ||= err;
        output.fill(0);
        return sqlite.SQLITE_IOERR_READ;
      } finally {
        buffer.fill(0);
      }
    }

    jFileSize(fileId, output) {
      const state = handles.get(fileId);
      if (!state) return sqlite.SQLITE_IOERR_FSTAT;
      output.setBigInt64(0, BigInt(state.snapshot.byteLength), true);
      return sqlite.SQLITE_OK;
    }

    jClose(fileId) {
      handles.delete(fileId);
      return sqlite.SQLITE_OK;
    }

    jAccess(name, flags, output) {
      output.setInt32(0, snapshots.has(name) ? 1 : 0, true);
      return sqlite.SQLITE_OK;
    }

    jWrite() { return sqlite.SQLITE_READONLY; }
    jTruncate() { return sqlite.SQLITE_READONLY; }
    jDelete() { return sqlite.SQLITE_READONLY; }
  }

  const vfs = new TraeVFS();
  api.vfs_register(vfs, false);
  return { api, sqlite, snapshots, handles, vfs, nextId: 0 };
}

/**
 * Query a read-only, random-access snapshot without materializing its database.
 * The caller owns snapshot cleanup; only the projected SQL rows leave this VFS.
 */
async function querySnapshot(snapshot, callback) {
  if (!Number.isSafeInteger(snapshot.byteLength) || snapshot.byteLength < 0) {
    throw new Error("Invalid TRAE snapshot size.");
  }
  enginePromise ||= createEngine().catch((err) => {
    enginePromise = undefined;
    throw err;
  });
  const engine = await enginePromise;
  const { api, sqlite, snapshots, handles, vfs } = engine;
  const name = `trae-${++engine.nextId}.db`;
  const state = { snapshot, error: null };
  snapshots.set(name, state);
  let db;
  let failure;
  try {
    db = await api.open_v2(name, sqlite.SQLITE_OPEN_READONLY, vfs.name);
    const query = async (sql) => {
      const rows = [];
      try {
        await api.exec(db, sql, (values, columns) => {
          rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index]])));
        });
      } catch (err) {
        throw state.error || err;
      }
      return rows;
    };
    await query("PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY;");
    return await callback(query);
  } catch (err) {
    failure = state.error || err;
    throw failure;
  } finally {
    try {
      if (db) await api.close(db);
    } catch (err) {
      if (!failure) throw state.error || err;
    } finally {
      snapshots.delete(name);
      for (const [fileId, opened] of handles) {
        if (opened === state) handles.delete(fileId);
      }
    }
  }
}

function withTraeSqlite(snapshot, callback) {
  // The package's async convenience API shares temporary WASM allocations.
  // Serialize access to the single engine even when callers read in parallel.
  const operation = queryQueue.then(() => querySnapshot(snapshot, callback));
  queryQueue = operation.catch(() => {});
  return operation;
}

module.exports = { withTraeSqlite };
