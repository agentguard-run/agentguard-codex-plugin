'use strict';
// Keyed input digest. New rows carry an HMAC-SHA256 of the tool input under a
// local key (digest-key.hex, 0600) in place of the unsalted SHA-256, which a
// short input lets anyone recover by guessing. Rows written before keep their
// inputSha256 and still verify; approvals bind to the keyed value.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sdk = require('@agentguard-run/spend');
const matrix = require('./helper-host-matrix.cjs');
const {spawnSync} = require('./helper-test-env.cjs');
const {Engine} = require('../runtime/engine.cjs');
const common = require('../runtime/common.cjs');
const digestKey = require('../runtime/digest-key.cjs');
const {createReader} = require('../runtime/mcp.cjs');
const free = () => ({paid: false, tier: 'free', mode: 'enforce', reason: null});
const permission = result => result.output.hookSpecificOutput?.permissionDecision ?? 'allow';

function fixture(t, policy = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-digest-'));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data);
  Object.assign(process.env, {AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_PLUGIN_POLICY: '', AGENTGUARD_HOME: path.join(data, 'burn')});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', ...policy}));
  const engines = [];
  t.after(async () => {
    for (const engine of engines) await engine.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true});
  });
  const start = async () => { const engine = new Engine({licenseReader: free}); await engine.init(); engines.push(engine); return engine; };
  const rows = () => fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  return {data, start, rows};
}
const raw = (id, input, tool = 'Bash') => ({session_id: 'digest-session', tool_use_id: id, tool_name: tool, cwd: os.tmpdir(), tool_input: input});

test('new rows carry a keyed input digest under a private local key, never the unsalted hash', async t => {
  const f = fixture(t); const engine = await f.start();
  const input = {command: 'ls'};
  const meta = common.metadata(raw('d-1', input), 'spend');
  const key = Buffer.from(fs.readFileSync(path.join(f.data, digestKey.KEY_FILE), 'utf8').trim(), 'hex');
  assert.equal(key.length, 32);
  assert.equal(fs.statSync(path.join(f.data, digestKey.KEY_FILE)).mode & 0o777, 0o600);
  const unsalted = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  assert.equal(meta.inputDigest, crypto.createHmac('sha256', key).update(`input\0${JSON.stringify(input)}`).digest('hex'));
  assert.equal(meta.inputDigestAlg, 'hmac-sha256');
  assert.equal(Object.hasOwn(meta, 'inputSha256'), false);
  assert.equal(common.metadata(raw('d-2', input), 'spend').inputDigest, meta.inputDigest, 'the same input has the same digest');
  assert.notEqual(common.metadata(raw('d-3', {command: 'ls -a'}), 'spend').inputDigest, meta.inputDigest);
  await engine.handle({meta});
  assert.equal(JSON.stringify(f.rows()).includes(unsalted), false);
  assert.equal(f.rows().at(-1).decision.plugin.inputDigest, meta.inputDigest);
  // Another machine's key gives another digest for the same input.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-digest-other-'));
  t.after(() => fs.rmSync(other, {recursive: true, force: true}));
  assert.notEqual(digestKey.keyedDigest(other, 'input', JSON.stringify(input)), meta.inputDigest);
});

test('concurrent first hooks agree on one key', t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-digest-race-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  const script = `const d = require(${JSON.stringify(path.join(__dirname, '../runtime/digest-key.cjs'))}); process.stdout.write(d.keyedDigest(process.argv[1], 'input', 'x'));`;
  const children = Array.from({length: 6}, () => require('node:child_process').spawn(process.execPath, ['-e', script, data], {stdio: ['ignore', 'pipe', 'pipe']}));
  return Promise.all(children.map(child => new Promise(resolve => { let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.on('close', () => resolve(out)); })))
    .then(outputs => {
      assert.equal(new Set(outputs).size, 1, outputs.join(' '));
      assert.match(outputs[0], /^[a-f0-9]{64}$/);
      assert.deepEqual(fs.readdirSync(data).filter(name => name.includes(digestKey.KEY_FILE)), [digestKey.KEY_FILE], 'no temporary file is left behind');
    });
});

test('rows written with the unsalted inputSha256 still verify and list beside keyed rows', async t => {
  const f = fixture(t); const engine = await f.start();
  // A request from an older hook, or one spooled before the upgrade.
  const legacy = {...common.metadata(raw('old-1', {command: 'pwd'}), 'spend')};
  delete legacy.inputDigest; delete legacy.inputDigestAlg;
  legacy.inputSha256 = crypto.createHash('sha256').update(JSON.stringify({command: 'pwd'})).digest('hex');
  assert.equal(permission(await engine.handle({meta: legacy})), 'allow');
  assert.equal(permission(await engine.handle({meta: common.metadata(raw('new-1', {command: 'pwd'}), 'spend')})), 'allow');
  const [old, current] = f.rows().filter(row => row.decision.plugin.event === 'decision');
  assert.equal(old.decision.plugin.inputSha256, legacy.inputSha256);
  assert.equal(current.decision.plugin.inputSha256, undefined);
  assert.match(current.decision.plugin.inputDigest, /^[a-f0-9]{64}$/);
  await engine.flush();
  assert.equal((await sdk.verifyChain(f.rows(), engine.publicKey)).ok, true);
  const reader = createReader({dataDir: f.data});
  assert.equal((await reader.call('verify_chain', {})).ok, true);
  const listed = await reader.call('list_decisions', {limit: 200});
  assert.ok(JSON.stringify(listed).includes('"toolUseId":"old-1"'));
  assert.ok(JSON.stringify(listed).includes('"toolUseId":"new-1"'));
});

test('Codex approvals bind to the keyed digest of the exact input, and pending shows it', async t => {
  if (matrix.isClaude) return;
  const f = fixture(t, {commandRules: [{id: 'publish', match: 'package-publish', action: 'ask'}]}); const engine = await f.start();
  const call = raw('pub-1', {command: 'npm publish'});
  assert.equal(permission(await engine.handle({meta: common.metadata(call, 'spend')})), 'deny');
  const cli = args => require('../runtime/policy-cli.cjs').run(args, {data: f.data, sessionId: 'digest-session'});
  const listing = await cli(['pending']);
  const digest = common.metadata(call, 'spend').inputDigest;
  assert.match(listing, new RegExp(`input digest ${digest.slice(0, 12)}`));
  const ticket = JSON.parse(fs.readFileSync(path.join(f.data, 'policy-approvals', listing.match(/([a-f0-9]{32})/)[1] + '.json'), 'utf8'));
  assert.equal(ticket.inputDigest, digest); assert.equal(ticket.inputSha256, undefined);
  await cli(['approve', listing.match(/([a-f0-9]{32})/)[1]]);
  assert.equal(permission(await engine.handle({meta: common.metadata(raw('pub-2', {command: 'npm publish --tag x'}), 'spend')})), 'deny');
  assert.equal(permission(await engine.handle({meta: common.metadata(raw('pub-3', {command: 'npm publish'}), 'spend')})), 'allow');
});
