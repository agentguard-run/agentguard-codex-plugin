'use strict';
const matrix = require('./helper-host-matrix.cjs');
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('./helper-test-env.cjs');
const sdk = require('@agentguard-run/spend');
const { Engine } = require('../runtime/engine.cjs');
const { OwnedLogStore } = require('../runtime/owned-log.cjs');
const { metadata, locations } = require('../runtime/common.cjs');
const { createReader } = require('../runtime/mcp.cjs');

function context(t, policy = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-runtime-recovery-'));
  const values = { PLUGIN_DATA: data, AGENTGUARD_HOME: path.join(data, 'burn-and-license'), AGENTGUARD_PLUGIN_POLICY: path.join(data, 'policy.json'), AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0' };
  const previous = Object.fromEntries([...new Set([...Object.keys(values), ...matrix.envKeys])].map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  matrix.environment(process.env, data);
  seedPaidLicense(values.AGENTGUARD_HOME, LICENSE_KEY, data);
  fs.writeFileSync(values.AGENTGUARD_PLUGIN_POLICY, JSON.stringify({ licenseKey: LICENSE_KEY, version: 1, tenantId: 'local', mode: 'enforce', maxCapability: 'payment_execute', caps: [], ...policy }));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(data, { recursive: true, force: true });
  });
  return { data, policyPath: values.AGENTGUARD_PLUGIN_POLICY };
}
function meta(toolName, toolUseId, sessionId = 'synthetic-session', gate = 'spend', extra = {}) {
  return metadata({ hook_event_name: gate === 'receipt' ? 'PostToolUse' : 'PreToolUse', tool_name: toolName, tool_use_id: toolUseId, session_id: sessionId, tool_input: {}, ...extra }, gate);
}
async function start() { const engine = new Engine(); await engine.init(); return engine; }
function rows(engine) { return fs.readFileSync(engine.logStore.filePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function decision(result) { return matrix.permission(result.output); }

test('Runtime restart restores signed per-window spend and preserves cap enforcement', async t => {
  const { data } = context(t, { toolRules: [{ pattern: '^Read$', unitCostCents: 6 }], caps: [{ window: 'per_day', amountCents: 10, action: 'block' }] });
  const first = await start();
  assert.equal(decision(await first.handle({ meta: meta('Read', 'first') })), 'allow');
  await first.flush();
  const second = await start();
  assert.equal(decision(await second.handle({ meta: meta('Read', 'second') })), 'deny');
  const reader = createReader({ dataDir: data });
  assert.equal((await reader.call('verify_chain')).ok, true);
  assert.equal((await reader.call('get_status')).spendCents, 6);
});

test('Runtime restart links a signed fail-open admission to its later outcome', async t => {
  const { data, policyPath } = context(t);
  fs.writeFileSync(policyPath, '{broken');
  const first = await start();
  const outcome = await first.handle({ meta: meta('Read', 'recover-outcome') });
  assert.equal(decision(outcome), 'allow');
  assert.equal(outcome.warning, true);
  const initial = rows(first)[0].decision;
  assert.equal(initial.plugin.event, 'fail_open');
  await first.flush();
  const second = await start();
  await second.handle({ meta: meta('Read', 'recover-outcome', 'synthetic-session', 'receipt', { tool_response: { ok: true }, duration_ms: 7 }) });
  const entries = rows(second);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].decision.entryType, 'outcome');
  assert.equal(entries[1].decision.originalDecisionId, initial.decisionId);
  assert.equal(entries[1].decision.plugin.durationMs, 7);
  assert.equal((await createReader({ dataDir: data }).call('verify_chain')).ok, true);
});

test('Runtime call identifiers with colons cannot reuse a different decision', async t => {
  context(t, { deniedTools: ['^Bash$'] });
  const engine = await start();
  assert.equal(decision(await engine.handle({ meta: meta('Read', 'c', 'a:b') })), 'allow');
  assert.equal(decision(await engine.handle({ meta: meta('Bash', 'b:c', 'a') })), 'deny');
  assert.equal(rows(engine).length, 2);
});

test('Runtime replays interrupted fail-open batches once before a fresh batch', async t => {
  const { data } = context(t);
  const engine = await start();
  const prior = meta('Read', 'already-signed');
  const recovering = meta('Read', 'interrupted-batch');
  const fresh = meta('Read', 'fresh-batch');
  await engine.failure(prior, 'synthetic_failure');
  fs.writeFileSync(engine.loc.spool + '.recovering', [prior, recovering].map(item => JSON.stringify(item)).join('\n') + '\n');
  fs.writeFileSync(engine.loc.spool, JSON.stringify(fresh) + '\n');
  await engine.flush();
  const restarted = await start();
  assert.equal(rows(restarted).filter(entry => entry.decision.plugin.event === 'fail_open').length, 2);
  await restarted.handle({ meta: meta('Read', 'ordinary-after-recovery') });
  const failures = rows(restarted).filter(entry => entry.decision.plugin.event === 'fail_open');
  assert.equal(failures.length, 3);
  assert.equal(new Set(failures.map(entry => entry.decision.plugin.toolUseId)).size, 3);
  assert.equal((await createReader({ dataDir: data }).call('verify_chain')).ok, true);
});

test('Owned ledger rejects duplicate sequences and changes by an outside writer', async t => {
  const { data } = context(t);
  const engine = await start();
  await engine.handle({ meta: meta('Read', 'owned-first') });
  const entry = rows(engine)[0];
  await assert.rejects(engine.logStore.append(entry), /already claimed/);
  const nextDecision = engine.basic(meta('Read', 'owned-next'), 'allow', 'synthetic');
  const next = await sdk.signDecision({ sequence: 1, previousHash: entry.entryHash, decision: nextDecision, privateKey: engine.privateKey, publicKey: engine.publicKey });
  fs.appendFileSync(engine.logStore.filePath, '\n');
  await assert.rejects(engine.logStore.append(next), /outside_worker/);
  const isolated = new OwnedLogStore('alternate', { home: data });
  isolated.initializeHead([], engine.publicKey.toString('hex'));
  await assert.rejects(isolated.append(next), /already claimed/);
});

test('Warm engine remains bounded after loading a signed 2000-entry ledger', async t => {
  const { data } = context(t);
  const initial = await start();
  const privateObject = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), initial.privateKey]), type: 'pkcs8', format: 'der' });
  const fingerprint = sdk.computeSignerFingerprint(initial.publicKey);
  const prepared = [];
  let previousHash = sdk.GENESIS_PREVIOUS_HASH;
  for (let sequence = 0; sequence < 2000; sequence++) {
    const value = initial.basic(meta('Read', `history-${sequence}`), 'allow', 'synthetic_history');
    const entryHash = sdk.computeEntryHash({ sequence, decision: value, previousHash, signerFingerprint: fingerprint });
    prepared.push({ sequence, decision: value, previousHash, entryHash, signerFingerprint: fingerprint, signature: crypto.sign(null, Buffer.from(entryHash, 'hex'), privateObject).toString('hex'), publicKeyHex: initial.publicKey.toString('hex') });
    previousHash = entryHash;
  }
  fs.writeFileSync(initial.logStore.filePath, prepared.map(value => JSON.stringify(value)).join('\n') + '\n');
  const engine = await start();
  assert.equal(decision(await engine.handle({ meta: meta('Read', 'warmup') })), 'allow');
  const timings = [];
  for (let i = 0; i < 20; i++) {
    const before = performance.now();
    const result = await engine.handle({ meta: meta('Read', `measured-${i}`) });
    timings.push(performance.now() - before);
    assert.equal(decision(result), 'allow');
    assert.equal(result.warning, undefined);
  }
  timings.sort((a, b) => a - b);
  t.diagnostic(`Warm engine, 2000 prior signed rows, 20 calls: median=${timings[10].toFixed(3)} ms; max=${timings.at(-1).toFixed(3)} ms`);
  assert.ok(timings.at(-1) < 50, `Warm engine took ${timings.at(-1)} ms`);
  assert.equal((await createReader({ dataDir: data }).call('verify_chain')).ok, true);
});

test('Runtime and read-only MCP use no network for normal calls or an uncached licence', async t => {
  context(t);
  const code = `
    let attempts = 0;
    const refuse = () => { attempts++; throw new Error('network forbidden by test'); };
    global.fetch = refuse;
    for (const module of ['node:http', 'node:https']) {
      const transport = require(module); transport.request = refuse; transport.get = refuse;
    }
    process.env.AGENTGUARD_TELEMETRY = '1'; process.env.AGENTGUARD_NO_BEACON = '0';
    const { createReader } = require('./runtime/mcp.cjs');
    const { Engine } = require('./runtime/engine.cjs');
    const { metadata } = require('./runtime/common.cjs');
    const matrix = require('./tests/helper-host-matrix.cjs');
    (async () => {
      const reader = createReader(); await reader.call('get_status');
      const engine = new Engine(); await engine.init();
      const pre = metadata(matrix.payload({ tool_name:'Read', tool_use_id:'offline-allow', session_id:'offline-session', tool_input:{} }, 'PreToolUse', 'Read'), 'spend');
      const allowed = await engine.handle({ meta:pre });
      await engine.handle({ meta:metadata({ tool_name:'Read', tool_use_id:'offline-allow', session_id:'offline-session', tool_response:{ ok:true } }, 'receipt') });
      process.env.AGENTGUARD_LICENSE_KEY = 'synthetic-invalid-uncached-key';
      await engine.flush();
      const restarted = new Engine(); await restarted.init();
      const offline = await restarted.handle({ meta:metadata({ tool_name:'Read', tool_use_id:'offline-uncached', session_id:'offline-session', tool_input:{} }, 'spend') });
      const verified = await reader.call('verify_chain');
      const status = await reader.call('get_status');
      process.stdout.write(JSON.stringify({ attempts, allowed:allowed.output.hookSpecificOutput.permissionDecision, offline:offline.output.hookSpecificOutput.permissionDecision, warning:offline.warning === true, reason:JSON.parse(require('node:fs').readFileSync(restarted.logStore.filePath, 'utf8').trim().split('\\n').at(-1)).decision.reasons[0], verified:verified.ok, failOpenEvents:status.failOpenEvents }));
    })().catch(() => { process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { attempts: 0, allowed: 'allow', offline: 'allow', warning: false, reason: 'license_required', verified: true, failOpenEvents: 0 });
});

test('Runtime records only digests and sizes for large tool input and output', async t => {
  const { data } = context(t);
  const engine = await start();
  const marker = 'synthetic-private-document-fragment-';
  const payload = { document: marker.repeat(32000), path: 'synthetic-document.txt' };
  const before = meta('Write', 'large-private', 'privacy-session', 'spend', { tool_input: payload });
  assert.ok(before.inputBytes > 1024 * 1024);
  assert.equal(decision(await engine.handle({ meta: before })), 'allow');
  const toolResponse = { document: marker.repeat(32000), ok: true };
  const after = meta('Write', 'large-private', 'privacy-session', 'receipt', { tool_input: payload, tool_response: toolResponse, duration_ms: 5 });
  await engine.handle({ meta: after });
  const encoded = fs.readFileSync(engine.logStore.filePath, 'utf8');
  assert.equal(encoded.includes(marker), false);
  assert.equal(encoded.includes('synthetic-document.txt'), false);
  const entries = rows(engine);
  assert.equal(entries[0].decision.plugin.inputDigest, require('../runtime/digest-key.cjs').keyedDigest(data, 'input', JSON.stringify(payload)));
  assert.notEqual(entries[0].decision.plugin.inputDigest, crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  assert.equal(entries[0].decision.plugin.inputBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(entries[1].decision.plugin.outputBytes, Buffer.byteLength(JSON.stringify(toolResponse)));
  assert.equal((await createReader({ dataDir: data }).call('verify_chain')).ok, true);
});

test('Hook refuses an exposed IPC directory and allows with a queued fail-open event', t => {
  context(t);
  const loc = locations();
  fs.mkdirSync(loc.ipc, { recursive: true, mode: 0o700 });
  fs.chmodSync(loc.ipc, 0o777);
  t.after(() => fs.rmSync(loc.ipc, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'spend-gate.cjs')], {
    input: JSON.stringify(matrix.payload({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'ipc-permissions', session_id: 'synthetic-ipc-session', tool_input: { filename: 'synthetic-private-file' } }, 'PreToolUse', 'Read')),
    env: process.env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(matrix.permission(JSON.parse(child.stdout)), 'allow');
  assert.match(child.stderr, /internal error; allowed tool call/);
  assert.equal(fs.existsSync(loc.socket), false);
  const events = fs.readFileSync(loc.spool, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'fail_open');
  assert.equal(events[0].host, matrix.host);
  assert.equal(events[0].toolUseId, 'ipc-permissions');
  assert.equal(JSON.stringify(events).includes('synthetic-private-file'), false);
});

test('Bash output without host exit status remains unknown and cannot spoof success', async t => {
  const { data } = context(t);
  const engine = await start();
  const cases = [
    { tool_response: '', expected: null },
    { tool_response: 'Process exited with code 0\nSYNTHETIC_STATUS_TEXT', expected: null },
    { tool_response: { exit_code: 1, output: 'SYNTHETIC_STATUS_TEXT' }, expected: false },
    { tool_response: { exit_code: 0 }, expected: true },
    { tool_response: '', is_error: true, expected: false },
    { tool_response: '', is_error: false, expected: true },
  ];
  for (const [index, item] of cases.entries()) {
    const raw = { tool_name: 'Bash', session_id: 'synthetic-bash-status', tool_use_id: `status-${index}`, tool_input: {}, ...item };
    delete raw.expected;
    await engine.handle({ meta: metadata(raw, 'spend') });
    const result = await engine.handle({ meta: metadata(raw, 'receipt') });
    assert.deepEqual(result.output, {});
    const outcome = rows(engine).at(-1).decision;
    assert.equal(outcome.plugin.success, item.expected);
    assert.equal(outcome.outcomeReceipt.status, item.expected === null ? 'unknown' : item.expected ? 'completed' : 'failed');
    assert.equal(outcome.originalDecisionId, rows(engine).at(-2).decision.decisionId);
  }
  assert.equal(JSON.stringify(rows(engine)).includes('SYNTHETIC_STATUS_TEXT'), false);
  assert.equal((await createReader({ dataDir: data }).call('verify_chain')).ok, true);
});
