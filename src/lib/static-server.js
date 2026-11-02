const fsPromises = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { negotiateEncoding } = require("./accept-encoding");

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);
const COMPRESSIBLE_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".xml", ".txt", ".webmanifest"]);
const STATIC_COMPRESSION_CACHE_MAX = 16;
const STATIC_COMPRESSION_MAX_BYTES = 8 * 1024 * 1024;
const staticCompressionCache = new Map();

function sendNotAcceptable(res) {
  const message = "Not Acceptable";
  res.writeHead(406, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
    "Vary": "Accept-Encoding",
  });
  res.end(message);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

async function compressedAsset(filePath, stat, encoding, handle) {
  const key = `${filePath}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${encoding}`;
  const cached = staticCompressionCache.get(key);
  if (cached) return cached;
  const source = await handle.readFile();
  const body = encoding === "br"
    ? await brotliCompress(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
    : await gzip(source);
  staticCompressionCache.set(key, body);
  while (staticCompressionCache.size > STATIC_COMPRESSION_CACHE_MAX) {
    staticCompressionCache.delete(staticCompressionCache.keys().next().value);
  }
  return body;
}

/**
 * Serve a static file from baseDir. Returns true if served, false otherwise.
 * For SPA: caller should fall back to index.html when this returns false.
 */
async function serveStaticFile(baseDir, pathname, res, { localRuntimeConfig = false, acceptEncoding = "" } = {}) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(baseDir, safePath);

  // prevent directory traversal
  if (!filePath.startsWith(baseDir)) return false;

  // Watch for the client going away from the start: if the browser cancels the
  // request during the awaits below, "close" fires before the stream exists and
  // a listener added later never runs, leaking the FileHandle (fatal on Node 25+).
  let clientGone = res.destroyed;
  let stream = null;
  res.once("close", () => {
    clientGone = true;
    if (stream) stream.destroy();
  });

  let handle;
  try {
    handle = await fsPromises.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    if (clientGone) return true; // finally closes the handle

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const isHtml = ext === ".html";
    const negotiation = negotiateEncoding(acceptEncoding);
    if (!negotiation.encoding && !negotiation.identityAllowed) {
      sendNotAcceptable(res);
      return true;
    }

    if (isHtml && localRuntimeConfig && path.basename(filePath) === "index.html") {
      if (!negotiation.identityAllowed) {
        sendNotAcceptable(res);
        return true;
      }
      const source = await handle.readFile("utf8");
      const content = source.replace(/<head(?:\s[^>]*)?>/i,
        "$&\n<script>window.__TOKENTRACKER_RUNTIME_CONFIG__={configurationError:\"runtime_config_unavailable\"};</script>\n<script src=\"/api/runtime-config.js\"></script>");
      if (clientGone) return true;
      res.writeHead(200, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(content), "Cache-Control": "no-store" });
      res.end(content);
      return true;
    }

    if (clientGone) return true;

    const encoding = negotiation.encoding;
    if (encoding && COMPRESSIBLE_EXTENSIONS.has(ext) && stat.size > 1024 && stat.size <= STATIC_COMPRESSION_MAX_BYTES) {
      let compressed = null;
      try {
        compressed = await compressedAsset(filePath, stat, encoding, handle);
      } catch (error) {
        console.warn("[static-server] compression failed, serving identity:", error?.message || error);
      }
      if (clientGone) return true;
      if (compressed) {
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": compressed.length,
          "Content-Encoding": encoding,
          "Vary": "Accept-Encoding",
          "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
        });
        res.end(compressed);
        return true;
      }
    }

    if (!negotiation.identityAllowed) {
      sendNotAcceptable(res);
      return true;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Vary": "Accept-Encoding",
      "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
    });

    stream = handle.createReadStream({ start: 0 });
    handle = null; // The stream owns and closes this descriptor.
    stream.on("error", (error) => res.destroy(error));
    stream.pipe(res);
    return true;
  } catch (_e) {
    return false;
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = { serveStaticFile };
