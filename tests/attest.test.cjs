'use strict';
const {spawnSync} = require('./helper-test-env.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fc = require('fast-check');
const sdk = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/spend');
const {attest, run, parseArgs} = require('../runtime/attest.cjs');
const {SCHEMA, DAY_MS, canonical, validateAttestation, validatePayload, verifyAttestation} = require('../runtime/attestation-schema.cjs');
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const root = path.resolve(__dirname, '..');
const privateValues = ['fixture-command-sensitive', 'fixture-argument-sensitive', 'fixture-prompt-sensitive',
  'fixture-private-file.txt', '/fixture/private/workspace', 'fixture-session-sensitive',
  'fixture-model-sensitive', 'fixture-username-sensitive', 'fixture-license-sensitive'];
const at = offset => new Date(NOW + offset).toISOString();

function decision(id, options = {}) {
  const {plugin, ...rest} = options;
  return {decisionId: id, timestamp: at(-1000), action: 'allow', triggeredCap: null, triggeredScopeKey: null,
    projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0,
    provider: 'codex', modelRequested: privateValues[6], modelResolved: privateValues[6],
    policyId: 'fixture-policy', policyVersion: 1, enforcementMode: 'enforce', reasons: privateValues,
    actor: {tenantId: 'fixture', sessionId: privateValues[5], userId: privateValues[7]}, ...rest,
    plugin: {schema: 'agentguard.codex.v1', event: 'decision', host: 'codex', gate: 'spend', toolName: 'Read',
      sessionId: privateValues[5], toolUseId: id, ...plugin}};
}
function outcome(id, original, options = {}) {
  return decision(id, {entryType: 'outcome', originalDecisionId: original,
    ...options, plugin: {gate: 'receipt', event: 'outcome', toolUseId: original, ...options.plugin}});
}
async function fixture(t, decisions = [decision('allowed')], policy) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-attest-'));
  const dataDir = path.join(directory, 'data'), home = path.join(directory, 'burn');
  fs.mkdirSync(path.join(dataDir, 'ledger'), {recursive: true}); fs.mkdirSync(home);
  const previous = {};
  for (const name of ['AGENTGUARD_LICENSE_KEY', 'CLAUDE_PLUGIN_OPTION_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID']) {
    previous[name] = process.env[name]; delete process.env[name];
  }
  const priorHome = process.env.AGENTGUARD_HOME;
  process.env.AGENTGUARD_HOME = home;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
    priorHome === undefined ? delete process.env.AGENTGUARD_HOME : process.env.AGENTGUARD_HOME = priorHome;
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({type: 'pkcs8', format: 'der'}).subarray(-32);
  const publicKey = keys.publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  fs.writeFileSync(path.join(dataDir, 'signing-key.hex'), privateKey.toString('hex'), {mode: 0o600});
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKey.toString('hex'));
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify(policy ?? JSON.parse(fs.readFileSync(path.join(root, 'runtime/presets/strict.json')))));
  const file = path.join(dataDir, 'ledger/decisions.ndjson');
  const entries = [];
  for (const d of decisions) entries.push({...await sdk.signDecision({sequence: entries.length, decision: d,
    previousHash: entries.at(-1)?.entryHash ?? sdk.GENESIS_PREVIOUS_HASH, privateKey, publicKey}), publicKeyHex: publicKey.toString('hex')});
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  const context = {dataDir, home, host: 'codex', now: NOW};
  const env = {...process.env, PLUGIN_DATA: dataDir, AGENTGUARD_HOME: home,
    AGENTGUARD_LICENSE_KEY: '', CLAUDE_PLUGIN_OPTION_LICENSE_KEY: ''};
  const cli = (args = [], host = 'codex') => {
    const launchEnv = {...env};
    if (host === 'claude-code') {
      delete launchEnv.PLUGIN_DATA; delete launchEnv.PLUGIN_ROOT;
      launchEnv.CLAUDE_PLUGIN_DATA = dataDir; launchEnv.CLAUDE_PLUGIN_ROOT = root;
    }
    return spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/attest-offline.cjs'),
      path.join(root, 'runtime/attest.cjs'), ...args], {env: launchEnv, encoding: 'utf8', timeout: 15000});
  };
  return {directory, dataDir, home, file, entries, keys, publicKey, privateKey, context, cli};
}
function allBytes(directory) {
  return fs.readdirSync(directory, {recursive: true}).filter(name => fs.statSync(path.join(directory, name)).isFile())
    .sort().map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]);
}

test('attestation signs every public field with the existing Ed25519 key and prints sorted canonical JSON', async t => {
  const f = await fixture(t);
  const before = allBytes(f.directory);
  const a = await attest({label: 'Public team'}, f.context);
  assert.equal(a.schema, SCHEMA); assert.equal(a.label, 'Public team');
  assert.equal(a.pluginVersion, require('../package.json').version);
  assert.equal(a.createdAt, at(0)); assert.equal(a.windowEnd, at(0)); assert.equal(a.windowStart, at(-30 * DAY_MS));
  assert.deepEqual(a.chain, {entries: 1, firstSequence: 0, lastSequence: 0, ok: true});
  const {signature, ...payload} = a;
  assert.equal(crypto.verify(null, Buffer.from(canonical(payload)), f.keys.publicKey, Buffer.from(signature, 'hex')), true);
  assert.equal(verifyAttestation(a), true);
  assert.equal(a.signerFingerprint, sdk.computeSignerFingerprint(f.publicKey));
  const output = await run(['--label', 'Public team'], f.context);
  assert.equal(output.json, canonical(a) + '\n');
  assert.equal(verifyAttestation(JSON.parse(output.json)), true);
  const sorted = value => {
    if (Array.isArray(value)) return value.forEach(sorted);
    if (!value || typeof value !== 'object') return;
    assert.deepEqual(Object.keys(value), Object.keys(value).sort()); Object.values(value).forEach(sorted);
  };
  sorted(JSON.parse(output.json));
  assert.deepEqual(allBytes(f.directory), before);
});

test('each attested field is covered by the signature and unknown fields are refused at every level', async t => {
  const f = await fixture(t), a = await attest({label: 'Public'}, f.context);
  const paths = [[], ['limits'], ['limits', 'caps', 0], ['limits', 'subAgentLimits'],
    ['limits', 'subAgentLimits', 'spawnRate'], ['limits', 'subAgentLimits', 'fanout'], ['limits', 'guardRules', 0], ['counts'], ['chain']];
  for (const parts of paths) {
    const changed = structuredClone(a); let target = changed;
    for (const part of parts) target = target[part];
    target.unexpected = 'must be rejected';
    assert.throws(() => validateAttestation(changed), /invalid/);
    assert.equal(verifyAttestation(changed), false);
  }
  for (const name of Object.keys(a)) {
    const changed = structuredClone(a);
    if (name === 'label') changed.label = 'Different';
    else if (name === 'host') changed.host = 'claude-code';
    else if (name === 'limits') changed.limits.caps[0].amountCents++;
    else if (name === 'counts') { changed.counts.allowed--; changed.counts.denied++; }
    else if (name === 'chain') { changed.chain.firstSequence++; changed.chain.lastSequence++; }
    else if (name === 'signature') changed.signature = '0'.repeat(128);
    else delete changed[name];
    assert.equal(verifyAttestation(changed), false, 'Every field must be signed');
  }
  for (const parts of [['limits', 'caps'], ['limits', 'guardRules']]) {
    const changed = structuredClone(a); changed[parts[0]][parts[1]].extra = true;
    assert.throws(() => validateAttestation(changed), /invalid/);
  }
  const changed = structuredClone(a); changed.limits.caps[Symbol('extra')] = true;
  assert.throws(() => validateAttestation(changed), /invalid/);
  const {signature, ...payload} = a;
  assert.throws(() => validatePayload({...payload, signature}), /invalid/);
});

test('publication never includes fixture commands, arguments, prompts, names, paths, sessions, models, users or credentials', async t => {
  const f = await fixture(t);
  const output = await run([], f.context);
  for (const value of [...privateValues, f.privateKey.toString('hex'), f.directory]) {
    assert.ok(!output.json.includes(value), 'Private fixture material reached the output');
  }
  const payload = JSON.parse(output.json);
  assert.equal(Object.hasOwn(payload, 'label'), false); assert.equal(Object.hasOwn(payload, 'domain'), false);
  assert.equal(payload.counts.allowed, 1);
});

test('public schema rejects invalid types, inconsistent totals, dates, bounds and non-JSON values', async t => {
  const f = await fixture(t), a = await attest({}, f.context);
  for (const mutate of [
    value => { value.chain.ok = false; }, value => { value.chain.firstSequence = 1; },
    value => { value.chain.entries++; }, value => { value.counts.allowed = -1; },
    value => { value.counts.approved = 1; }, value => { value.counts.allowed++; },
    value => { value.windowStart = at(-366 * DAY_MS); }, value => { value.windowEnd = at(-1); },
    value => { value.createdAt = '2026-02-30T00:00:00.000Z'; }, value => { value.host = 'another'; },
    value => { value.limits.caps[0].action = 'ask'; }, value => { value.limits.caps[0].amountCents = 1.5; },
    value => { value.limits.caps[0].window = 'year'; }, value => { value.limits.preset = 'arbitrary'; },
    value => { value.limits.mode = 'on'; }, value => { value.limits.guardRules = true; },
    value => { value.limits.subAgentLimits.spawnRate.windowActiveMinutes = 0; },
    value => { value.limits.subAgentLimits.spawnRate.enforced = 1; },
    value => { value.limits.subAgentLimits.mode = 'shadow'; },
    value => { value.limits.mode = 'shadow'; },
    value => { value.limits.guardRules.push(value.limits.guardRules[0]); },
    value => { value.limits.guardRules.reverse(); },
    value => { value.limits.guardRules[0].id = 'private-rule'; }, value => { value.signature = 'a'.repeat(126); },
    value => { delete value.counts.failOpen; }, value => { value.publicKeyHex = '0'.repeat(64); },
    value => { value.publicKeyHex += '\n'; }, value => { value.signerFingerprint += '\n'; },
    value => { value.signature += '\n'; }, value => { value.pluginVersion += '\n'; },
  ]) {
    const changed = structuredClone(a); mutate(changed);
    assert.throws(() => validateAttestation(changed), /invalid/);
  }
  for (const value of [undefined, NaN, Infinity, new Date(), [undefined], new Array(2), {value: undefined}]) {
    assert.throws(() => canonical(value), /invalid/);
  }
});

test('counts distinguish asks, linked approvals, policy blocks, fail-closed events and signed fail-open events', async t => {
  const f = await fixture(t, [
    decision('allowed'), decision('shadow', {action: 'shadow', enforcementMode: 'shadow'}),
    decision('native-ask', {action: 'block', plugin: {toolName: 'Agent', gate: 'burn', asked: true}}),
    outcome('native-result', 'native-ask'),
    decision('command-ask', {plugin: {approvalRuleId: 'network'}}), outcome('command-result', 'command-ask', {plugin: {success: false}}),
    decision('held', {action: 'block', plugin: {approvalNeeded: true}}),
    decision('blocked', {action: 'block'}), decision('fail-closed', {plugin: {event: 'fail_closed'}}),
    decision('fail-open', {plugin: {event: 'fail_open'}}),
    decision('other-gate', {plugin: {gate: 'burn'}}),
    decision('control', {plugin: {gate: 'control', event: 'session_receipt'}}),
    decision('mirror', {plugin: {toolName: 'Agent', gate: 'burn', reasonCode: 'burn_external_hook'}}),
    decision('different-host', {plugin: {host: 'claude-code'}}),
    decision('settlement', {entryType: 'settlement'}),
  ]);
  const a = await attest({}, f.context);
  assert.deepEqual(a.counts, {allowed: 2, asked: 3, approved: 2, denied: 2, failOpen: 1});
  assert.equal(a.chain.entries, 14);
});

test('rolling window includes its boundaries, excludes future rows and does not infer unresolved asks or cross-session approvals', async t => {
  const f = await fixture(t, [
    decision('old', {timestamp: at(-7 * DAY_MS - 1)}),
    decision('start', {timestamp: at(-7 * DAY_MS)}), decision('end', {timestamp: at(0)}),
    decision('future', {timestamp: at(1)}),
    decision('old-ask', {timestamp: at(-7 * DAY_MS - 1), plugin: {approvalRuleId: 'network'}}), outcome('old-result', 'old-ask'),
    decision('unresolved', {plugin: {approvalRuleId: 'network'}}),
    outcome('wrong-session', 'unresolved', {plugin: {sessionId: 'another-fixture-session'}}),
    outcome('wrong-call', 'unresolved', {plugin: {toolUseId: 'another-fixture-call'}}),
  ]);
  const a = await attest({days: 7}, f.context);
  assert.deepEqual(a.counts, {allowed: 2, asked: 1, approved: 0, denied: 0, failOpen: 0});
  assert.deepEqual(a.chain, {entries: 6, firstSequence: 1, lastSequence: 8, ok: true});
  assert.equal((await attest({days: 30}, f.context)).windowStart, at(-30 * DAY_MS));
});

test('verification covers old and other-host rows, physical order, signatures, links, malformed tails and blank records', async t => {
  const f = await fixture(t, [decision('old', {timestamp: at(-60 * DAY_MS)}),
    decision('other-host', {plugin: {host: 'claude-code'}}), decision('recent')]);
  const original = fs.readFileSync(f.file, 'utf8');
  const corrupt = mutate => { const rows = structuredClone(f.entries); mutate(rows); return rows.map(row => JSON.stringify(row) + '\n').join(''); };
  for (const text of [
    corrupt(rows => { rows[0].decision.action = 'block'; }),
    corrupt(rows => { rows[1].signature = '0'.repeat(128); }),
    corrupt(rows => rows.reverse()), corrupt(rows => rows.splice(1, 1)),
    corrupt(rows => { rows[2].previousHash = '0'.repeat(64); }),
    corrupt(rows => { rows[2].publicKeyHex = '0'.repeat(64); }),
    original + '{unfinished', original + '\n', 'null\n',
  ]) {
    fs.writeFileSync(f.file, text);
    await assert.rejects(attest({days: 7}, f.context), /Ledger|ledger/);
    const result = f.cli(['--days', '7', '--out', path.join(f.directory, 'never-created.json')]);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(f.directory, 'never-created.json')), false);
    assert.doesNotMatch(result.stderr, /AgentGuard Verified/);
    for (const value of privateValues) assert.ok(!result.stderr.includes(value), 'Failure must not echo private data');
  }
  fs.writeFileSync(f.file, original);
  assert.equal((await attest({}, f.context)).chain.ok, true);
});

test('an append or policy change while the whole chain verifies refuses the snapshot', async t => {
  const f = await fixture(t);
  const first = attest({}, f.context);
  fs.appendFileSync(f.file, JSON.stringify(f.entries[0]) + '\n');
  await assert.rejects(first, /changed/);
  fs.writeFileSync(f.file, JSON.stringify(f.entries[0]) + '\n');
  const second = attest({}, f.context);
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({version: 1, mode: 'shadow'}));
  await assert.rejects(second, /changed/);
});

test('missing or mismatched keys never initialize an installation or write an attestation', async t => {
  const f = await fixture(t);
  for (const name of ['signing-key.hex', 'public-key.hex', 'ledger/decisions.ndjson']) {
    const file = path.join(f.dataDir, name), original = fs.readFileSync(file);
    fs.unlinkSync(file); const before = allBytes(f.directory);
    await assert.rejects(attest({}, f.context));
    assert.deepEqual(allBytes(f.directory), before); fs.writeFileSync(file, original);
  }
  fs.writeFileSync(path.join(f.dataDir, 'signing-key.hex'), '1'.repeat(64));
  await assert.rejects(attest({}, f.context), /keys/);
});

test('read limits refuse oversized ledgers without attesting a partial history', async t => {
  const f = await fixture(t);
  fs.truncateSync(f.file, 64 * 1024 * 1024 + 1);
  await assert.rejects(attest({}, f.context), /read limit/);
  fs.writeFileSync(f.file, '{}\n'.repeat(100001));
  await assert.rejects(attest({}, f.context), /entry limit/);
});

test('empty existing ledger has explicit empty chain bounds and zero counts', async t => {
  const f = await fixture(t, []), a = await attest({}, f.context);
  assert.deepEqual(a.chain, {entries: 0, firstSequence: null, lastSequence: null, ok: true});
  assert.ok(Object.values(a.counts).every(value => value === 0));
  assert.equal(verifyAttestation(a), true);
});

test('limits reflect shipped presets, current global caps and actual Burn thresholds', async t => {
  const f = await fixture(t);
  assert.deepEqual((await attest({}, f.context)).limits.subAgentLimits, {mode: 'enforce',
    spawnRate: {count: 15, windowActiveMinutes: 15, enforced: true}, fanout: {count: 40, windowActiveMinutes: 120},
    maxDepth: 2, launchMaxDepth: null, sessionTokenLimit: 5000000000});
  for (const name of ['solo-dev', 'careful', 'strict', 'website', 'copies-ask']) {
    const defaults = JSON.parse(fs.readFileSync(path.join(root, 'config/default-policy.json')));
    const preset = JSON.parse(fs.readFileSync(path.join(root, 'runtime/presets', name + '.json')));
    fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({...defaults, ...preset}));
    const a = await attest({}, f.context);
    assert.equal(a.limits.preset, name);
    assert.deepEqual(a.limits.caps, (preset.caps ?? []).map(cap => ({...cap, scope: 'global'})));
  }
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', max_depth: 1,
    caps: [{window: 'per_day', amountCents: 1234}, {window: 'per_session', amountCents: 50, selector: {sessionId: privateValues[5]}}],
    commandRules: [{id: 'ask-network', match: 'network', action: 'ask'}],
    guardPack: {rules: {GP020: 'ask'}}}));
  fs.writeFileSync(path.join(f.home, 'burn-policy.json'), JSON.stringify({mode: 'enforce', thresholds: {
    spawnRate: {stop: 5, windowActiveMinutes: 3, enforce: false}, fanout: {stop: 17, windowActiveMinutes: 22, maxDepth: 3}, sustained: {stopTokens: 99}}}));
  const a = await attest({}, f.context);
  assert.equal(a.limits.preset, null);
  assert.deepEqual(a.limits.caps, [{window: 'per_day', amountCents: 1234, action: 'block', scope: 'global'},
    {window: 'per_session', amountCents: 50, action: 'block', scope: 'scoped'}]);
  assert.ok(a.limits.guardRules.some(rule => rule.id === 'GP020' && rule.action === 'ask'));
  assert.deepEqual(a.limits.subAgentLimits, {mode: 'enforce', spawnRate: {count: 4, windowActiveMinutes: 3, enforced: false},
    fanout: {count: 17, windowActiveMinutes: 22}, maxDepth: 3, launchMaxDepth: 1, sessionTokenLimit: 99});
  const policy = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'policy.json')));
  policy.caps[1].amountCents++;
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify(policy));
  assert.equal((await attest({}, f.context)).limits.caps[1].amountCents, 51);
});

test('shadow policies, personal guard overrides and custom rule IDs cannot claim stronger or unsafe public settings', async t => {
  const rules = Object.fromEntries(require('../runtime/org-policy-contract.cjs').GUARD_RULE_IDS.map(id => [id, 'off']));
  const f = await fixture(t, undefined, {version: 1, mode: 'shadow', guardPack: {rules}});
  let a = await attest({}, f.context);
  assert.equal(a.limits.mode, 'shadow'); assert.equal(a.limits.subAgentLimits.mode, 'shadow');
  assert.equal(a.limits.subAgentLimits.spawnRate.enforced, false);
  assert.ok(a.limits.guardRules.length > 0, 'Personal overrides cannot disable the built-in guard pack');
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce'}));
  fs.writeFileSync(path.join(f.home, 'burn-policy.json'), JSON.stringify({mode: 'shadow', thresholds: {}}));
  a = await attest({}, f.context);
  assert.equal(a.limits.mode, 'enforce'); assert.equal(a.limits.subAgentLimits.mode, 'shadow');
  fs.writeFileSync(path.join(f.dataDir, 'policy.json'), JSON.stringify({version: 1, commandRules: [{id: '/private/rule', match: 'network', action: 'ask'}]}));
  assert.equal(canonical(await attest({}, f.context)).includes('/private/rule'), false);
  fs.writeFileSync(path.join(f.home, 'burn-policy.json'), '{invalid');
  await assert.rejects(attest({}, f.context), /Burn policy/);
});

test('cached Team settings and credentials stay offline and an admin-disabled guard pack is reported as off', async t => {
  const key = privateValues[8], f = await fixture(t, undefined, {version: 1, mode: 'enforce', licenseKey: key});
  const {hashPolicy, GUARD_RULE_IDS} = require('../runtime/org-policy-contract.cjs');
  require('./helper-paid-license.cjs').seedPaidLicense(f.home, key, f.dataDir);
  const policy = {version: 1, guardPack: {rules: Object.fromEntries(GUARD_RULE_IDS.map(id => [id, 'off']))}};
  const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
  const envelope = {version: 1, published_at: at(-DAY_MS), sha256: hashPolicy(policy), policy};
  fs.writeFileSync(path.join(f.dataDir, 'org-policy.json'), JSON.stringify({...envelope, license_fingerprint: fingerprint}));
  fs.writeFileSync(path.join(f.dataDir, 'org-policy-status.json'), JSON.stringify({license_fingerprint: fingerprint, status: 'ready', org_policy_sha256: envelope.sha256}));
  const a = await attest({}, f.context);
  assert.deepEqual(a.limits.guardRules, []); assert.equal(a.limits.mode, 'enforce'); assert.equal(a.limits.preset, null);
  const result = f.cli();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes(key));
  assert.deepEqual(JSON.parse(result.stdout).limits.guardRules, []);
});

test('CLI permits only 7 or 30 days and labels with ASCII letters, digits, spaces and hyphens', () => {
  assert.equal(parseArgs([]).days, 30);
  assert.equal(parseArgs(['--days', '7']).days, 7);
  assert.equal(parseArgs(['--label', 'x'.repeat(60)]).label.length, 60);
  assert.equal(parseArgs(['--label', 'Public Team - 2']).label, 'Public Team - 2');
  for (const days of ['0', '1', '-1', '365', '1.5', 'NaN', 'Infinity', '3e1', '07']) assert.throws(() => parseArgs(['--days', days]));
  for (const label of ['', ' ', 'x'.repeat(61), 'line\nbreak', 'Team\n', 'Team\r', 'Team\r\n', '\t', '\x7f', '\u202e', '\ud800', 'á', 'a/b', 'a\\b', 'a.b', 'a@b', 'a_b', '<b>', 'a😀']) assert.throws(() => parseArgs(['--label', label]));
  for (const args of [['--unknown', 'x'], ['--domain', 'example.com'], ['--days'], ['--days', '7', '--days', '30'], ['--label', '--out'], ['positional']]) assert.throws(() => parseArgs(args));
});

test('Free CLI stays offline and writes only stdout or the requested new file', async t => {
  const f = await fixture(t, [decision('claude', {plugin: {host: 'claude-code'}})]);
  const before = allBytes(f.directory);
  const first = f.cli(['--days', '30', '--label', 'Public team'], 'claude-code');
  assert.equal(first.status, 0, first.stderr);
  const a = JSON.parse(first.stdout); assert.equal(a.host, 'claude-code'); assert.equal(a.counts.allowed, 1);
  assert.equal(verifyAttestation(a), true);
  assert.equal(first.stdout, canonical(a) + '\n');
  assert.equal(first.stderr, '');
  assert.deepEqual(allBytes(f.directory), before);
  const out = path.join(f.directory, 'public-attestation.json');
  const second = f.cli(['--out', out], 'claude-code');
  assert.equal(second.status, 0, second.stderr); assert.equal(second.stdout, '');
  assert.equal(verifyAttestation(JSON.parse(fs.readFileSync(out))), true);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const saved = fs.readFileSync(out);
  assert.notEqual(f.cli(['--out', out]).status, 0);
  assert.deepEqual(fs.readFileSync(out), saved);
  const link = path.join(f.directory, 'out-link.json'); fs.symlinkSync(out, link);
  assert.notEqual(f.cli(['--out', link]).status, 0);
  assert.deepEqual(fs.readFileSync(out), saved);
});

test('privacy fuzz keeps every sandbox ledger command and path out of the bundle', async t => {
  const strings = fc.sample(fc.string({minLength: 1, maxLength: 100}), {numRuns: 128, seed: 20261009});
  const secrets = strings.map((text, index) => ({
    command: `echo PRIVATE_COMMAND_${index}_${text}`,
    path: `/sandbox/private-path-${index}/${text}/private-file.txt`,
  }));
  const rows = secrets.map(({command, path: privatePath}, index) => decision(`fuzz-${index}`, {
    command, path: privatePath, plugin: {command, path: privatePath, input: {command, path: privatePath}},
  }));
  const f = await fixture(t, rows);
  const {json} = await run([], f.context), bundle = JSON.parse(json);
  assert.equal(bundle.counts.allowed, 128);
  assert.equal(verifyAttestation(bundle), true);
  const outputStrings = [];
  const visit = value => {
    if (typeof value === 'string') outputStrings.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(bundle);
  for (const secret of secrets.flatMap(Object.values)) {
    assert.ok(!json.includes(secret) && !outputStrings.some(value => value.includes(secret)), 'Ledger command or path leaked');
  }
});

test('scoped and session caps publish amounts without identifiers or custom rule names', async t => {
  const f = await fixture(t, undefined, {version: 1, mode: 'enforce', max_depth: 3,
    caps: [{window: 'per_day', amountCents: 222, selector: {agentId: privateValues[7]}}],
    sessions: {[privateValues[5]]: {max_depth: 1, caps: [{window: 'per_session', amountCents: 111}]}},
    commandRules: [{id: privateValues[0], match: 'network', action: 'ask'}]});
  const a = await attest({}, f.context), text = canonical(a);
  assert.equal(a.limits.subAgentLimits.launchMaxDepth, 1);
  assert.deepEqual(a.limits.caps, [
    {window: 'per_session', amountCents: 111, action: 'block', scope: 'session'},
    {window: 'per_day', amountCents: 222, action: 'block', scope: 'scoped'},
  ]);
  for (const value of privateValues) assert.ok(!text.includes(value));
});

test('other-host and out-of-period rows cannot populate an empty selected period', async t => {
  const f = await fixture(t, [decision('old', {timestamp: at(-30 * DAY_MS - 1)}),
    decision('future', {timestamp: at(1)}), decision('other', {plugin: {host: 'claude-code'}})]);
  for (const days of [7, 30]) {
    const a = await attest({days}, f.context);
    assert.deepEqual(a.chain, {entries: 0, firstSequence: null, lastSequence: null, ok: true});
    assert.ok(Object.values(a.counts).every(value => value === 0));
  }
});

test('helper model routing counts as allowed without publishing a model name', async t => {
  const f = await fixture(t, [decision('routed', {action: 'downgrade', plugin: {gate: 'burn', toolName: 'spawn_agent'}})]);
  const a = await attest({}, f.context);
  assert.deepEqual(a.counts, {allowed: 1, asked: 0, approved: 0, denied: 0, failOpen: 0});
  assert.equal(canonical(a).includes(privateValues[6]), false);
});

test('offline verifier works without local keys, policy, ledger or an installed SDK', async t => {
  const f = await fixture(t), a = await attest({label: 'Public Team'}, f.context);
  const out = path.join(f.directory, 'bundle.json');
  fs.writeFileSync(out, JSON.stringify(a, null, 2));
  const standalone = path.join(f.directory, 'standalone'); fs.mkdirSync(standalone);
  fs.copyFileSync(path.join(root, 'runtime/attestation-schema.cjs'), path.join(standalone, 'schema.cjs'));
  const script = "const fs = require('node:fs'); const b = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const verify = require(process.argv[2]).verifyAttestation; fs.readFileSync = () => {throw new Error('unexpected file read');}; Date.now = () => {throw new Error('unexpected clock read');}; if (!verify(Object.freeze(b))) process.exit(1);";
  const pure = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/attest-offline.cjs'),
    '-e', script, out, path.join(standalone, 'schema.cjs')], {encoding: 'utf8'});
  assert.equal(pure.status, 0, pure.stderr);
  assert.equal(require('../runtime/attest.cjs').verifyAttestation, verifyAttestation);
  fs.rmSync(f.dataDir, {recursive: true}); fs.rmSync(f.home, {recursive: true});
  const before = allBytes(f.directory), result = f.cli(['verify', out]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.match(result.stdout, /schema and signature are valid/);
  assert.match(result.stdout, /Public Team/); assert.match(result.stdout, /Plugin 0\.6\.1 for Codex/);
  assert.match(result.stdout, /Policy at creation: strict, enforce mode/);
  assert.match(result.stdout, /1 allowed, 0 asked, 0 confirmed approvals, 0 denied by policy, 0 failed open/);
  assert.match(result.stdout, /1 entries.*sequences 0 through 0/);
  assert.match(result.stdout, /does not prove work quality/);
  assert.deepEqual(allBytes(f.directory), before);
});

test('hand-edited bundles fail both offline verifiers without echoing their contents', async t => {
  const f = await fixture(t), a = await attest({label: 'Public Team'}, f.context);
  const out = path.join(f.directory, 'edited.json');
  for (const mutate of [
    b => { b.label = 'Edited Team'; }, b => { b.counts.allowed = 0; },
    b => { b.limits.caps[0].amountCents++; }, b => { b.pluginVersion = '0.4.1'; },
    b => { b.host = 'claude-code'; }, b => { b.signature = '0'.repeat(128); },
    b => { b.command = privateValues[0]; }, b => { b.label = '../private'; },
  ]) {
    const b = structuredClone(a); mutate(b);
    fs.writeFileSync(out, JSON.stringify(b));
    assert.equal(verifyAttestation(b), false);
    const result = f.cli(['verify', out]);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid schema or signature/);
    assert.ok(!result.stderr.includes(privateValues[0]));
  }
  for (const text of ['{broken', 'null', '[]', 'x'.repeat(1024 * 1024 + 1)]) {
    fs.writeFileSync(out, text);
    assert.equal(f.cli(['verify', out]).status, 1);
  }
  for (const args of [['verify'], ['verify', out, 'extra'], ['verify', path.join(f.directory, 'absent')]]) {
    const result = f.cli(args); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  }
});

test('a valid signature cannot admit unsafe labels or unknown content fields', async t => {
  const f = await fixture(t), a = await attest({}, f.context);
  for (const change of [{command: privateValues[0]}, {label: privateValues[4]}, {domain: 'example.com'}, {label: 'a@b'}, {label: 'Public\n'}]) {
    const {signature, ...payload} = {...a, ...change};
    const signed = {...payload, signature: crypto.sign(null, Buffer.from(canonical(payload)), f.keys.privateKey).toString('hex')};
    assert.equal(verifyAttestation(signed), false, 'Schema checks must not trust signed content');
  }
});
