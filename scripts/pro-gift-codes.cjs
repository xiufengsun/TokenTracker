#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAYS = new Set([30, 90, 365]);
const HELP = `Usage: node scripts/pro-gift-codes.cjs ACTION --environment sandbox|live [options]

Actions: generate, list, codes, disable, revoke
Credentials: INSFORGE_SERVICE_ROLE_KEY and INSFORGE_BASE_URL, or --project-file PATH.

generate --days 30|90|365 --count 1..1000 --expires ISO_DATE --label TEXT --out PRIVATE_JSON
generate --resume PRIVATE_JSON              Retry the same saved batch after a timeout
list                                       List at most 100 batches
codes --batch UUID                         List at most 1000 code suffixes and claims
disable --batch UUID                       Disable unclaimed codes in one batch
revoke --grant UUID                        Revoke one claimed entitlement

Raw codes are saved once to a private file, never printed or sent to the database.
Disabling a batch preserves previously claimed membership. Revocation is separate.
Gifts do not cancel a Waffo subscription or change its charge date.
`;

function origin(value) {
  let u;
  try { u = new URL(value); } catch { throw Error('Set a valid InsForge backend origin'); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      !(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) {
    throw Error('Use an HTTPS backend origin or an HTTP loopback origin');
  }
  return u.origin;
}

function parseArgs(argv) {
  if (argv.includes('--help')) return { help: true };
  const [action, ...args] = argv;
  if (!['generate', 'list', 'codes', 'disable', 'revoke'].includes(action)) throw Error('Choose a supported action');
  const values = {};
  const names = new Set(['environment', 'project-file', 'days', 'count', 'expires', 'label', 'out', 'resume', 'batch', 'grant']);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !names.has(name) || Object.hasOwn(values, name) ||
        !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Invalid or duplicate option');
    values[name] = args[i + 1];
  }
  if (!['sandbox', 'live'].includes(values.environment)) throw Error('Choose --environment sandbox or live explicitly');
  const common = ['environment', 'project-file'];
  const allowed = action === 'generate' ? [...common, 'days', 'count', 'expires', 'label', 'out', 'resume'] :
    action === 'list' ? common : [...common, action === 'revoke' ? 'grant' : 'batch'];
  if (Object.keys(values).some(k => !allowed.includes(k))) throw Error('Option does not belong to this action');
  if (action === 'generate' && values.resume) {
    if (['days', 'count', 'expires', 'label', 'out'].some(k => Object.hasOwn(values, k))) throw Error('Resume uses the saved batch scope');
  } else if (action === 'generate') {
    values.days = Number(values.days); values.count = Number(values.count);
    if (!DAYS.has(values.days) || !Number.isInteger(values.count) || values.count < 1 || values.count > 1000) throw Error('Invalid duration or batch size');
    const expires = Date.parse(values.expires || '');
    if (!Number.isFinite(expires) || expires <= Date.now() || !values.out || !values.label ||
        values.label.length > 120 || /[\u0000-\u001f\u007f]/.test(values.label)) throw Error('Set a future expiry, label and private output path');
    values.expires = new Date(expires).toISOString();
  } else if (action !== 'list' && !UUID.test(values[action === 'revoke' ? 'grant' : 'batch'] || '')) {
    throw Error('An exact batch or grant UUID is required');
  }
  return { action, ...values };
}

function codeHash(code) {
  if (typeof code !== 'string' || code.length > 256 || /[^\x00-\x7f]/.test(code)) throw Error('Invalid gift code format');
  const canonical = code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^TTPRO[0-9A-F]{32}$/.test(canonical)) throw Error('Invalid gift code format');
  return createHash('sha256').update(canonical).digest('hex');
}

function createBatch(options, baseUrl) {
  const codes = Array.from({ length: options.count }, () => {
    const hex = randomBytes(16).toString('hex').toUpperCase();
    const code = 'TT-PRO-' + hex.match(/.{8}/g).join('-');
    return { code, code_hash: codeHash(code), suffix: hex.slice(-8) };
  });
  return { version: 1, baseUrl, environment: options.environment, batchId: randomUUID(),
    durationDays: options.days, redeemBefore: options.expires, label: options.label, codes };
}

function validateBatch(batch, options, baseUrl) {
  if (!batch || batch.version !== 1 || batch.baseUrl !== baseUrl || batch.environment !== options.environment ||
      !UUID.test(batch.batchId || '') || !DAYS.has(batch.durationDays) || typeof batch.label !== 'string' ||
      !batch.label || batch.label.length > 120 || /[\u0000-\u001f\u007f]/.test(batch.label) ||
      !Number.isFinite(Date.parse(batch.redeemBefore)) || !Array.isArray(batch.codes) ||
      batch.codes.length < 1 || batch.codes.length > 1000) throw Error('Saved batch does not match this target');
  const hashes = new Set();
  for (const item of batch.codes) {
    if (typeof item.code !== 'string' || item.code.length > 128 || item.code_hash !== codeHash(item.code) ||
        item.suffix !== item.code.replace(/[\s-]/g, '').slice(-8).toUpperCase() || hashes.has(item.code_hash)) throw Error('Saved code integrity check failed');
    hashes.add(item.code_hash);
  }
  return batch;
}

async function readPrivateFile(file, maxBytes, message) {
  // Check and read the same opened inode. A path-based lstat followed by
  // readFile could otherwise follow a replacement link or different file.
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || info.mode & 0o077 || info.uid !== process.getuid()) throw Error(message);
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw Error(message);
    return bytes.subarray(0, offset).toString('utf8');
  } finally { await handle.close(); }
}

async function privatePath(value, writing = false) {
  if (process.platform === 'win32') throw Error('Private raw-code files require the verified macOS/Linux owner-only storage path');
  const file = path.resolve(value);
  if (path.extname(file) !== '.json') throw Error('Use a private .json output file');
  const parent = path.dirname(file);
  if (writing) await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent) throw Error('Do not use symlinked private directories');
  const gitOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) };
  let repository;
  try { repository = execFileSync('git', ['-C', parent, 'rev-parse', '--show-toplevel'], gitOptions).trim(); }
  catch (error) {
    if (error.status !== 128 || !/^fatal: not a git repository(?:\s|\()/i.test(String(error.stderr || ''))) {
      throw Error('Cannot verify the private output location');
    }
  }
  if (repository) {
    try { execFileSync('git', ['-C', repository, 'check-ignore', '--quiet', '--', file], gitOptions); }
    catch { throw Error('Raw code files inside a repository must be ignored'); }
  }
  if (!writing) {
    await readPrivateFile(file, 1048576, 'Saved codes require a private owner-only file');
  }
  return file;
}

async function connection(options, env) {
  if (options['project-file']) {
    if (process.platform === 'win32') throw Error('Use server-side environment credentials; Windows configuration-file ACL has not been verified');
    const file = path.resolve(options['project-file']);
    const value = JSON.parse(await readPrivateFile(file, 65536, 'Project configuration must be private'));
    if (typeof value.api_key !== 'string' || !value.api_key) throw Error('Project configuration lacks its server key');
    return { baseUrl: origin(value.oss_host), key: value.api_key };
  }
  if (!env.INSFORGE_SERVICE_ROLE_KEY) throw Error('Set INSFORGE_SERVICE_ROLE_KEY or --project-file without putting keys in arguments');
  return { baseUrl: origin(env.INSFORGE_BASE_URL), key: env.INSFORGE_SERVICE_ROLE_KEY };
}

function createRpcClient(baseUrl, key, request = fetch) {
  return async (name, params) => {
    const response = await request(baseUrl + '/api/database/rpc/' + name, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(params),
    });
    if (!response.ok) throw Error('Gift operation returned HTTP ' + response.status + '; the saved batch can be retried');
    const raw = await response.text();
    if (raw.length > 1048576) throw Error('Gift response exceeded its bound');
    let data;
    try { data = JSON.parse(raw); } catch { throw Error('Gift operation returned invalid JSON'); }
    if (data?.ok === false || data?.error) throw Error('Gift operation was rejected');
    return data;
  };
}

async function run(options, config, rpc) {
  if (options.action === 'generate') {
    const file = await privatePath(options.resume || options.out, !options.resume);
    const batch = options.resume ? validateBatch(JSON.parse(await readPrivateFile(file, 1048576, 'Saved codes require a private owner-only file')), options, config.baseUrl) : createBatch(options, config.baseUrl);
    if (!options.resume) await fs.writeFile(file, JSON.stringify(batch, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const result = await rpc('cloud_create_gift_batch', { p_environment: batch.environment, p_batch_id: batch.batchId,
      p_duration_days: batch.durationDays, p_redeem_before: batch.redeemBefore, p_label: batch.label,
      p_codes: batch.codes.map(({ code_hash, suffix }) => ({ code_hash, suffix })) });
    if (result?.id !== batch.batchId || result.environment !== batch.environment || result.count !== batch.codes.length) throw Error('Gift batch acknowledgement did not match the saved scope');
    return { batch_id: batch.batchId, environment: batch.environment, count: batch.codes.length,
      duration_days: batch.durationDays, redeem_before: batch.redeemBefore, private_file: file, reused: result.reused === true };
  }
  const common = { p_environment: options.environment };
  if (options.action === 'list') return rpc('cloud_list_gift_batches', { ...common, p_limit: 100 });
  if (options.action === 'codes') return rpc('cloud_list_gift_codes', { ...common, p_batch_id: options.batch, p_limit: 1000 });
  if (options.action === 'disable') return rpc('cloud_disable_gift_batch', { ...common, p_batch_id: options.batch });
  return rpc('cloud_revoke_gift', { ...common, p_grant_id: options.grant });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) return process.stdout.write(HELP);
  const config = await connection(options, env);
  const result = await run(options, config, createRpcClient(config.baseUrl, config.key));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
module.exports = { parseArgs, origin, codeHash, createBatch, validateBatch, privatePath, connection, createRpcClient, run, main };
if (require.main === module) main().catch(() => {
  process.stderr.write('Gift management failed. Check the target, private file and server permissions. Retry the same batch with --resume after an uncertain response.\n');
  process.exitCode = 1;
});
