const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { serveStaticFile } = require("../src/lib/static-server");

test("local HTML loads public instance configuration before eager app modules", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"tokentracker-runtime-html-"));
  const source = '<!doctype html><html><head><script type="module" src="/app.js"></script></head><body>本地用量</body></html>';
  await fs.writeFile(path.join(dir,"index.html"),source);
  await fs.writeFile(path.join(dir,"app.js"),"window.started = true;");
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url,"http://localhost");
    const options = { localRuntimeConfig:url.searchParams.get("local") === "1" };
    if (!await serveStaticFile(dir,url.pathname,res,options)) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/index.html?local=1`);
    const html = await response.text();
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.equal(Number(response.headers.get("content-length")),Buffer.byteLength(html));
    assert.ok(html.indexOf('/api/runtime-config.js') < html.indexOf('type="module"'));
    assert.ok(html.indexOf('runtime_config_unavailable') < html.indexOf('/api/runtime-config.js'));
    assert.equal((html.match(/runtime-config\.js/g)||[]).length,1);
    assert.equal(await (await fetch(`${base}/index.html`)).text(),source);
    assert.equal(await (await fetch(`${base}/app.js?local=1`)).text(),"window.started = true;");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test("static bytes and content length stay bound to the checked file when its path is replaced", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-static-file-race-"));
  const file = path.join(dir, "asset.txt");
  const original = "checked asset\n";
  await fs.writeFile(file, original);
  const open = fs.open;
  const stat = fs.stat;
  let swapped = false;
  async function replaceAfterCheck(info) {
    if (!swapped) {
      swapped = true;
      await fs.rename(file, path.join(dir, "opened-asset.txt"));
      await fs.writeFile(file, "replacement asset has different bytes and length\n");
    }
    return info;
  }
  // Inject the same path replacement at either a path-based stat or fstat.
  // This exercises the race without depending on process timing.
  fs.stat = async (target, ...args) => {
    const info = await stat(target, ...args);
    return target === file ? replaceAfterCheck(info) : info;
  };
  fs.open = async (target, ...args) => {
    const handle = await open(target, ...args);
    if (target === file) {
      const fstat = handle.stat.bind(handle);
      handle.stat = async (...statArgs) => replaceAfterCheck(await fstat(...statArgs));
    }
    return handle;
  };
  const server = http.createServer(async (_req, res) => {
    if (!await serveStaticFile(dir, "/asset.txt", res)) res.writeHead(404).end();
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/asset.txt`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), original);
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(original));
    assert.equal(swapped, true);
  } finally {
    fs.open = open;
    fs.stat = stat;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
