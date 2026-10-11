#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['archive', 'restore', 'cleanup', 'erase-user']);
const HELP = `Usage: node scripts/cloud-usage-archive.cjs --user UUID [options]

Default: dry-run. Apply is restricted to a loopback backend in this delivery phase.
Credentials: INSFORGE_SERVICE_ROLE_KEY. Endpoint: --base-url or INSFORGE_BASE_URL.

--action archive|restore|cleanup|erase-user   Default archive
--device UUID                              Optional exact device
--from YYYY-MM-DD --to YYYY-MM-DD           UTC days; to is exclusive
--limit N                                  Default 10; max 100 days or 1000 cleanup rows
--apply                                    Execute the previewed bounded operation
--confirm-user UUID                        Required for erase-user apply; must match --user
--checkpoint PATH                          Default .tmp/cloud-usage-checkpoint.json
--resume                                   Resume the same checkpoint and scope
--dry-run                                  Explicitly keep the default preview behavior
--help                                     Show this help
`;

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Set a valid --base-url or INSFORGE_BASE_URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (!local && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Use an HTTPS backend origin, or an HTTP loopback origin');
  }
  return { baseUrl: url.origin, local };
}
function parseArgs(argv, env = process.env) {
  const values = {}; const flags = new Set();
  const valueNames = new Set(['action', 'user', 'device', 'from', 'to', 'limit', 'base-url', 'checkpoint', 'confirm-user']);
  const flagNames = new Set(['apply', 'resume', 'dry-run', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2);
    if (!argv[i].startsWith('--') || (!valueNames.has(name) && !flagNames.has(name))) throw Error('Unknown option: ' + argv[i]);
    if (Object.hasOwn(values, name) || flags.has(name)) throw Error('Duplicate option: --' + name);
    if (flagNames.has(name)) flags.add(name);
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Missing value: --' + name);
      values[name] = argv[++i];
    }
  }
  if (flags.has('help')) return { help: true };
  const action = values.action || 'archive';
  if (!ACTIONS.has(action)) throw Error('Unknown maintenance action');
  if (!UUID.test(values.user || '')) throw Error('An exact --user UUID is required');
  if (values.device && !UUID.test(values.device)) throw Error('Invalid --device UUID');
  if ((values.from && !validDay(values.from)) || (values.to && !validDay(values.to))
    || (values.from && values.to && values.from >= values.to)) throw Error('Invalid UTC day range');
  const limit = values.limit === undefined ? 10 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > (action === 'cleanup' ? 1000 : 100)) throw Error('Invalid bounded --limit');
  if (flags.has('apply') && flags.has('dry-run')) throw Error('--apply and --dry-run cannot be combined');
  if (flags.has('resume') && !flags.has('apply')) throw Error('--resume requires --apply');
  const target = endpoint(values['base-url'] || env.INSFORGE_BASE_URL);
  if (flags.has('apply') && !target.local) throw Error('Hosted apply is disabled; this runner only applies to loopback backends');
  if (values['confirm-user'] && values['confirm-user'].toLowerCase() !== values.user.toLowerCase()) throw Error('--confirm-user must match the exact --user');
  if (action === 'erase-user' && flags.has('apply') && !values['confirm-user']) throw Error('Erase apply requires --confirm-user matching --user');
  if ((action === 'cleanup' || action === 'erase-user') && (values.device || values.from || values.to)) throw Error('Cleanup and user erasure use the exact user scope without device/day filters');
  return {
    ...target, action, user: values.user.toLowerCase(), device: values.device?.toLowerCase() || null,
    from: values.from || null, to: values.to || null, limit, apply: flags.has('apply'), resume: flags.has('resume'),
    confirmation: values['confirm-user']?.toLowerCase() || null,
    checkpoint: path.resolve(values.checkpoint || '.tmp/cloud-usage-checkpoint.json'),
  };
}
function createRpcClient(baseUrl, key, request = fetch) {
  if (!key) throw Error('Set INSFORGE_SERVICE_ROLE_KEY without writing it into the checkpoint');
  return async (name, params) => {
    const response = await request(baseUrl + '/api/database/rpc/' + name, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(params),
    });
    if (!response.ok) throw Error('RPC ' + name + ' returned HTTP ' + response.status);
    const body = await response.text();
    if (body.length > 1048576) throw Error('Maintenance response exceeded the metadata budget');
    try { return JSON.parse(body); } catch { throw Error('Maintenance RPC returned invalid JSON'); }
  };
}
function scope(options) {
  return { baseUrl: options.baseUrl, action: options.action, user: options.user, device: options.device,
    from: options.from, to: options.to, limit: options.limit };
}
async function saveCheckpoint(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function runMaintenance(options, rpc, output = value => process.stdout.write(JSON.stringify(value) + '\n')) {
  // Enforce local-only writes even when this module is called without parseArgs.
  if (options.apply && !endpoint(options.baseUrl).local) throw Error('Hosted apply is disabled');
  if (options.action === 'erase-user' && options.apply && options.confirmation !== options.user) throw Error('Exact user erasure confirmation required');
  let checkpoint;
  if (options.resume) {
    checkpoint = JSON.parse(await fs.readFile(options.checkpoint, 'utf8'));
    if (checkpoint.version !== 1 || JSON.stringify(checkpoint.scope) !== JSON.stringify(scope(options))
      || !Array.isArray(checkpoint.tasks) || checkpoint.tasks.length > options.limit) throw Error('Checkpoint scope does not match this bounded run');
  } else {
    const plan = await rpc('cloud_usage_maintenance_plan', { p_action: options.action, p_user_id: options.user,
      p_device_id: options.device, p_from: options.from, p_to: options.to, p_limit: options.limit });
    output({ mode: options.apply ? 'apply' : 'dry-run', plan });
    if (!options.apply) return { mode: 'dry-run', plan };
    try { await fs.access(options.checkpoint); throw Error('Checkpoint already exists; use --resume or a new checkpoint path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const targets = options.action === 'cleanup' ? (plan.selected_targets ? [{ user_id: options.user }] : []) : plan.targets;
    if (!Array.isArray(targets) || targets.length > options.limit) throw Error('Server plan exceeded the requested bound');
    checkpoint = { version: 1, scope: scope(options), createdAt: new Date().toISOString(), plan,
      tasks: targets.map(target => ({ target, operation: randomUUID(), phase: 'pending' })) };
    await saveCheckpoint(options.checkpoint, checkpoint);
  }
  for (const task of checkpoint.tasks) {
    if (task.phase === 'done') continue;
    try {
      const params = { p_operation: task.operation, p_user_id: options.user };
      if (options.action === 'archive') {
        if (task.phase === 'pending') {
          const prepared = await rpc('cloud_prepare_usage_archive_operation', { ...params, p_device_id: task.target.device_id, p_day: task.target.day });
          task.generation = prepared.generation;
          task.phase = prepared.empty ? 'done' : 'prepared';
          await saveCheckpoint(options.checkpoint, checkpoint);
        }
        if (task.phase !== 'done') task.result = await rpc('cloud_commit_usage_archive_operation', { p_operation: task.operation });
      } else if (options.action === 'restore') {
        task.result = await rpc('cloud_restore_usage_archive', { ...params, p_device_id: task.target.device_id, p_day: task.target.day });
      } else if (options.action === 'cleanup') {
        task.result = await rpc('cloud_cleanup_usage_archive', { ...params, p_limit: options.limit });
      } else {
        task.result = await rpc('cloud_erase_user_usage', { ...params, p_confirmation: options.confirmation });
      }
      task.phase = 'done'; delete task.error;
      await saveCheckpoint(options.checkpoint, checkpoint);
      output({ completed: task.target, result: task.result || { empty: true } });
    } catch (error) {
      task.error = error.message;
      await saveCheckpoint(options.checkpoint, checkpoint);
      throw error;
    }
  }
  const result = { mode: 'apply', action: options.action, completed: checkpoint.tasks.filter(t => t.phase === 'done').length,
    checkpoint: options.checkpoint };
  output(result); return result;
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  if (options.help) { process.stdout.write(HELP); return; }
  await runMaintenance(options, createRpcClient(options.baseUrl, env.INSFORGE_SERVICE_ROLE_KEY));
}
module.exports = { parseArgs, createRpcClient, runMaintenance, main };
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
