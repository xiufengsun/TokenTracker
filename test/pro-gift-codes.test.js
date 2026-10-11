const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const gifts = require('../scripts/pro-gift-codes.cjs');

function options(file) {
  return { action: 'generate', environment: 'sandbox', days: 30, count: 3,
    expires: new Date(Date.now() + 86400000).toISOString(), label: 'Private test cohort', out: file };
}

test('gift management requires an explicit environment and bounded scope', () => {
  for (const argv of [['list'], ['list', '--environment', 'production'],
    ['generate', '--environment', 'sandbox', '--days', '0'],
    ['disable', '--environment', 'sandbox', '--batch', 'all'],
    ['list', '--environment', 'sandbox', '--grant', randomUUID()],
    ['generate', '--environment', 'sandbox', '--resume', 'private.json', '--days', '30']]) {
    assert.throws(() => gifts.parseArgs(argv));
  }
  assert.equal(gifts.parseArgs(['list', '--environment', 'live']).environment, 'live');
  for (const target of ['http://external.example', 'https://user:secret@example.com', 'https://example.com/?key=x', 'https://example.com/nested']) {
    assert.throws(() => gifts.origin(target));
  }
});

test('uncertain batch creation preserves raw codes privately and retries identical hash-only requests', {skip:process.platform==='win32'}, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-gift-cli-'));
  const file = path.join(await fs.realpath(folder), 'codes.json');
  const config = { baseUrl: 'http://127.0.0.1:8123' };
  let first;
  try {
    await assert.rejects(gifts.run(options(file), config, async (name, body) => {
      first = body;
      assert.equal(name, 'cloud_create_gift_batch');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(saved.codes.length, 3);
      for (const item of saved.codes) {
        assert.match(item.code, /^TT-PRO-(?:[A-F0-9]{8}-){3}[A-F0-9]{8}$/);
        assert.equal(item.code_hash, gifts.codeHash(item.code.toLowerCase().replaceAll('-', ' ')));
        assert.ok(!JSON.stringify(body).includes(item.code));
      }
      if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      throw Error('Connection ended after server commit');
    }));
    const output = await gifts.run({ action: 'generate', environment: 'sandbox', resume: file }, config, async (name, body) => {
      assert.deepEqual(body, first);
      return { id: body.p_batch_id, environment: body.p_environment, count: body.p_codes.length, reused: true };
    });
    assert.equal(output.reused, true);
    assert.equal(output.count, 3);
    assert.ok(!Object.hasOwn(output, 'codes'));
    await assert.rejects(gifts.run({ action: 'generate', environment: 'live', resume: file }, config, () => assert.fail('must not send')));
    const original = JSON.parse(await fs.readFile(file, 'utf8'));
    const corrupt = { ...original, codes: original.codes.map(x => ({ ...x })) };
    corrupt.codes[0].code_hash = '0'.repeat(64);
    assert.throws(() => gifts.validateBatch(corrupt, { environment: 'sandbox' }, config.baseUrl));
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('gift files cannot overwrite existing files or be written into unignored source paths', {skip:process.platform==='win32'}, async () => {
  const root = path.resolve(__dirname, '..');
  await assert.rejects(gifts.privatePath(path.join(root, 'unignored-gift-test.json'), true), /must be ignored/);
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-gift-private-'));
  const file = path.join(await fs.realpath(folder), 'codes.json');
  try {
    await fs.writeFile(file, 'preserve', { mode: 0o600 });
    await assert.rejects(gifts.run(options(file), { baseUrl: 'http://127.0.0.1:8123' }, () => assert.fail('existing file must stop request')));
    assert.equal(await fs.readFile(file, 'utf8'), 'preserve');
    if (process.platform !== 'win32') {
      await fs.chmod(file, 0o644);
      await assert.rejects(gifts.privatePath(file), /private/);
    }
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('private code output fails closed when Git is missing or its check fails unexpectedly', async () => {
  const root = path.resolve(__dirname, '..');
  const script = `require(${JSON.stringify(path.join(root, 'scripts/pro-gift-codes.cjs'))}).privatePath(${JSON.stringify(path.join(root, 'unignored-gift-test.json'))}, true).then(()=>process.exit(9)).catch(()=>process.stdout.write('blocked'))`;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-gift-git-check-'));
  try {
    assert.equal(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, PATH: '' }, encoding: 'utf8' }), 'blocked');
    if (process.platform !== 'win32') {
      await fs.writeFile(path.join(folder, 'git'), '#!/bin/sh\nexit 13\n', { mode: 0o700 });
      assert.equal(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, PATH: folder }, encoding: 'utf8' }), 'blocked');
    }
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('gift admin uses the actual loopback HTTP client and emits no raw-code request', {skip:process.platform==='win32'}, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-gift-http-'));
  const file = path.join(await fs.realpath(folder), 'codes.json');
  let seen;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: seen.body.p_batch_id, environment: seen.body.p_environment, count: seen.body.p_codes.length }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await gifts.run(options(file), { baseUrl }, gifts.createRpcClient(baseUrl, 'local-test-admin'));
    assert.equal(result.count, 3);
    assert.equal(seen.path, '/api/database/rpc/cloud_create_gift_batch');
    assert.equal(seen.auth, 'Bearer local-test-admin');
    assert.deepEqual(Object.keys(seen.body.p_codes[0]).sort(), ['code_hash', 'suffix']);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const item of raw.codes) assert.ok(!JSON.stringify(seen).includes(item.code));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
test('Windows raw-code storage remains closed until NTFS owner-only ACL is verified', {skip:process.platform!=='win32'}, async () => {
  await assert.rejects(gifts.privatePath('private-codes.json',true), /owner-only/);
});
