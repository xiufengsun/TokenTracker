const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setup, migration } = require('./helpers/cloud-usage-archive-fixture');
const { parseArgs, createRpcClient } = require('../scripts/cloud-usage-archive.cjs');
const execute = promisify(execFile);
const script = path.resolve(__dirname, '../scripts/cloud-usage-archive.cjs');
let db, server, baseUrl, directory;
const key = randomUUID();
const calls = [];
let loseResponseFor;
before(async () => {
  db = await setup(); await db.exec(migration('20261005120000_cloud-usage-archive.sql'));
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-archive-runner-'));
  server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); res.end('{}'); return; }
    const name = req.url.split('/').pop();
    if (!/^cloud_[a-z_]+$/.test(name)) { res.writeHead(404); res.end('{}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const params = JSON.parse(raw), names = Object.keys(params);
      if (names.some(n => !/^p_[a-z_]+$/.test(n))) throw Error('invalid argument');
      calls.push({ name, params });
      // Actual typed SQL and actual project_admin ACLs behind a loopback HTTP
      // transport. This fixture does not emulate external merchant payment.
      const value = await db.transaction(async tx => {
        await tx.exec('SET LOCAL ROLE project_admin');
        return (await tx.query(`SELECT public.${name}(${names.map((n, i) => n + '=>$' + (i + 1)).join(',')}) AS result`,
          names.map(n => params[n] && typeof params[n] === 'object' ? JSON.stringify(params[n]) : params[n]))).rows[0].result;
      });
      if (loseResponseFor === name) { loseResponseFor = null; res.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  await new Promise(resolve => server?.close(resolve)); await db?.close();
  await fs.rm(directory, { recursive: true, force: true });
});
async function fixture(days = 1) {
  const user = randomUUID(), device = randomUUID();
  await db.query('INSERT INTO auth.users VALUES($1)', [user]);
  await db.query("INSERT INTO tokentracker_devices(id,user_id,device_name,platform,machine_id) VALUES($1,$2,'Runner fixture','web',$3)", [device, user, randomUUID()]);
  for (let day = 1; day <= days; day++) {
    await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
      cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
      billable_total_tokens,conversations,total_cost_usd) VALUES($1,$2,'codex','gpt-6',$3,100,0,0,0,0,100,100,1,0)`, [user, device, '2026-01-' + String(day).padStart(2, '0') + 'T02:00:00Z']);
  }
  return { user, device, checkpoint: path.join(directory, randomUUID() + '.json') };
}
async function cli(f, args = []) {
  return execute(process.execPath, [script, '--user', f.user, '--checkpoint', f.checkpoint, ...args], {
    env: { ...process.env, INSFORGE_BASE_URL: baseUrl, INSFORGE_SERVICE_ROLE_KEY: key }, timeout: 20000,
  });
}
const count = async (table, user) => (await db.query(`SELECT count(*)::integer n FROM ${table} WHERE user_id=$1`, [user])).rows[0].n;

test('CLI defaults to a bounded dry-run with no checkpoint or database write', async () => {
  const f = await fixture(3), beforeCalls = calls.length;
  const result = await cli(f, ['--limit', '1']);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.mode, 'dry-run'); assert.equal(output.plan.available_targets, 3);
  assert.equal(output.plan.selected_targets, 1); assert.equal(output.plan.targets[0].hot_rows, 1);
  assert.equal(calls.length - beforeCalls, 1); assert.equal(calls.at(-1).name, 'cloud_usage_maintenance_plan');
  assert.equal(await count('tokentracker_hourly', f.user), 3);
  assert.equal(await count('tokentracker_usage_maintenance_operations', f.user), 0);
  await assert.rejects(fs.access(f.checkpoint), { code: 'ENOENT' });
  assert.ok(!result.stdout.includes(key));
});

test('CLI apply checkpoints before preparing and respects its one-day bound', async () => {
  const f = await fixture(3); const result = await cli(f, ['--apply', '--limit', '1']);
  const checkpoint = JSON.parse(await fs.readFile(f.checkpoint, 'utf8'));
  assert.equal(checkpoint.tasks.length, 1); assert.equal(checkpoint.tasks[0].phase, 'done');
  assert.equal(await count('tokentracker_hourly', f.user), 2);
  assert.equal(await count('tokentracker_usage_archive_manifest', f.user), 1);
  assert.ok(!JSON.stringify(checkpoint).includes(key)); assert.ok(!result.stdout.includes(key));
  // Windows reports synthetic mode bits; chmod does not model NTFS ACLs.
  if (process.platform !== 'win32')
    assert.equal((await fs.stat(f.checkpoint)).mode & 0o777, 0o600);
  await assert.rejects(cli(f, ['--apply', '--limit', '1']), error => /Checkpoint already exists/.test(error.stderr));
});

test('lost preparation response resumes the same server generation instead of creating another', async () => {
  const f = await fixture(); loseResponseFor = 'cloud_prepare_usage_archive_operation';
  await assert.rejects(cli(f, ['--apply']), error => /fetch failed/.test(error.stderr));
  let checkpoint = JSON.parse(await fs.readFile(f.checkpoint, 'utf8'));
  assert.equal(checkpoint.tasks[0].phase, 'pending');
  assert.equal(await count('tokentracker_usage_archive_generations', f.user), 1);
  assert.equal(await count('tokentracker_hourly', f.user), 1);
  await cli(f, ['--apply', '--resume']);
  checkpoint = JSON.parse(await fs.readFile(f.checkpoint, 'utf8'));
  assert.equal(checkpoint.tasks[0].phase, 'done');
  assert.equal(await count('tokentracker_usage_archive_generations', f.user), 1);
  assert.equal(await count('tokentracker_hourly', f.user), 0);
});

test('lost commit response resumes an already committed operation and preserves later hot data', async () => {
  const f = await fixture(); loseResponseFor = 'cloud_commit_usage_archive_operation';
  await assert.rejects(cli(f, ['--apply']), error => /fetch failed/.test(error.stderr));
  const checkpoint = JSON.parse(await fs.readFile(f.checkpoint, 'utf8'));
  assert.equal(checkpoint.tasks[0].phase, 'prepared');
  assert.equal(await count('tokentracker_usage_archive_manifest', f.user), 1);
  await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
    cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
    billable_total_tokens,conversations,total_cost_usd) VALUES($1,$2,'codex','gpt-6','2026-01-01T02:00:00Z',0,0,0,0,0,0,0,1,0)`, [f.user, f.device]);
  await cli(f, ['--apply', '--resume']);
  assert.equal(await count('tokentracker_hourly', f.user), 1);
  assert.equal((await db.query('SELECT total_tokens::integer n FROM cloud_usage_hourly($1,$2,NULL,NULL)', [f.user, f.device])).rows[0].n, 0);
  const replay = JSON.parse(await fs.readFile(f.checkpoint, 'utf8'));
  assert.equal(replay.tasks[0].result.replayed, true);
  await assert.rejects(cli(f, ['--apply', '--resume', '--limit', '1']), error => /scope does not match/.test(error.stderr));
});

test('CLI restore uses the real SQL RPC and retains a newer hot zero value', async () => {
  const f = await fixture(); await cli(f, ['--apply']);
  await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
    cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
    billable_total_tokens,conversations,total_cost_usd) VALUES($1,$2,'codex','gpt-6','2026-01-01T02:00:00Z',0,0,0,0,0,0,0,1,0)`, [f.user, f.device]);
  f.checkpoint = path.join(directory, randomUUID() + '.json');
  await cli(f, ['--action', 'restore', '--apply']);
  assert.equal(await count('tokentracker_usage_archive_manifest', f.user), 0);
  assert.equal((await db.query('SELECT total_tokens::integer n FROM tokentracker_hourly WHERE user_id=$1', [f.user])).rows[0].n, 0);
});

test('CLI erasure requires exact confirmation and scopes its SQL operation to one user', async () => {
  const f = await fixture(), other = await fixture();
  const beforeCalls = calls.length;
  await assert.rejects(cli(f, ['--action', 'erase-user', '--apply']), error => /confirm-user/.test(error.stderr));
  await assert.rejects(cli(f, ['--action', 'erase-user', '--apply', '--confirm-user', other.user]), error => /match/.test(error.stderr));
  assert.equal(calls.length, beforeCalls);
  await cli(f, ['--action', 'erase-user', '--apply', '--confirm-user', f.user]);
  assert.equal(await count('tokentracker_hourly', f.user), 0); assert.equal(await count('tokentracker_hourly', other.user), 1);
  assert.equal((await db.query('SELECT count(*)::integer n FROM auth.users WHERE id=$1', [f.user])).rows[0].n, 1);
});

test('CLI cleanup previews and removes only one expired superseded metadata generation', async () => {
  const f = await fixture(); await cli(f, ['--apply']);
  await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,
    cached_input_tokens,cache_creation_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
    billable_total_tokens,conversations,total_cost_usd) VALUES($1,$2,'codex','gpt-6','2026-01-01T02:00:00Z',0,0,0,0,0,0,0,1,0)`, [f.user, f.device]);
  f.checkpoint = path.join(directory, randomUUID() + '.json'); await cli(f, ['--apply']);
  await db.query("UPDATE tokentracker_usage_archive_generations SET committed_at=now()-interval '31 days' WHERE user_id=$1 AND status='superseded'", [f.user]);
  const preview = await cli(f, ['--action', 'cleanup', '--limit', '1']);
  assert.equal(JSON.parse(preview.stdout.trim()).plan.selected_targets, 1);
  f.checkpoint = path.join(directory, randomUUID() + '.json');
  await cli(f, ['--action', 'cleanup', '--limit', '1', '--apply']);
  assert.equal(await count('tokentracker_usage_archive_generations', f.user), 1);
  assert.equal(await count('tokentracker_usage_archive_manifest', f.user), 1);
  assert.equal((await db.query('SELECT total_tokens::integer n FROM cloud_usage_hourly($1,$2,NULL,NULL)', [f.user, f.device])).rows[0].n, 0);
});

test('checkpoint creation failure happens before any prepare or commit RPC', async () => {
  const f = await fixture(), blocker = path.join(directory, randomUUID());
  await fs.writeFile(blocker, 'blocker'); f.checkpoint = path.join(blocker, 'checkpoint.json');
  const firstCall = calls.length;
  await assert.rejects(cli(f, ['--apply']));
  assert.deepEqual(calls.slice(firstCall).map(c => c.name), ['cloud_usage_maintenance_plan']);
  assert.equal(await count('tokentracker_usage_archive_generations', f.user), 0);
  assert.equal(await count('tokentracker_hourly', f.user), 1);
});

test('hosted apply and invalid dates/scopes are rejected before making a request', () => {
  const user = randomUUID();
  assert.throws(() => parseArgs(['--user', user, '--apply', '--base-url', 'https://example.insforge.app'], {}), /Hosted apply is disabled/);
  assert.throws(() => parseArgs(['--user', user, '--base-url', 'http://127.0.0.1.evil.test'], {}), /HTTPS backend/);
  assert.throws(() => parseArgs(['--user', user, '--base-url', baseUrl, '--from', '2026-02-30'], {}), /UTC day/);
  assert.throws(() => parseArgs(['--user', user, '--base-url', baseUrl, '--limit', '101'], {}), /bounded/);
  assert.throws(() => parseArgs(['--user', user, '--base-url', baseUrl, '--action', 'erase-user', '--device', randomUUID()], {}), /without device/);
  assert.equal(parseArgs(['--user', user, '--base-url', 'https://example.insforge.app'], {}).apply, false);
});

test('RPC client does not follow redirects carrying its service credential', async () => {
  let leaked = false;
  const receiver = http.createServer((req, res) => { leaked = !!req.headers.authorization; res.end('{}'); });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const redirector = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:' + receiver.address().port }); res.end(); });
  await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve));
  try {
    const rpc = createRpcClient('http://127.0.0.1:' + redirector.address().port, key);
    await assert.rejects(rpc('cloud_usage_maintenance_plan', { p_user_id: randomUUID() }));
    assert.equal(leaked, false);
  } finally { await new Promise(resolve => redirector.close(resolve)); await new Promise(resolve => receiver.close(resolve)); }
});
