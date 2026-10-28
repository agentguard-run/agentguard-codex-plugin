'use strict';
const matrix = require('./helper-host-matrix.cjs');
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helper-test-env.cjs');
const sdk = require('@agentguard-run/spend');
const { Engine, validatePolicy } = require('../runtime/engine.cjs');
const { metadata, locations } = require('../runtime/common.cjs');
const { request } = require('../runtime/client.cjs');
const fixtures = matrix.payloads(require('./fixtures/codex-plugin-pretooluse.json').payloads);
const base = { licenseKey: LICENSE_KEY, version: 1, tenantId: 'synthetic-tenant', mode: 'enforce', maxCapability: 'payment_execute', caps: [], toolRules: [], sessions: {} };
let sequence = 0;
const payload = (name = 'Bash', extra = {}) => ({ ...fixtures.find(p => p.tool_name === 'Bash'), tool_name: name, tool_use_id: `call_SYNTHETIC_TEST_${sequence++}`, ...extra });
const allowed = output => matrix.permission(output) === 'allow';
async function setup(t, policy = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-hook-test-'));
  const hostOld = Object.fromEntries(matrix.envKeys.map(key => [key, process.env[key]]));
  const old = { ...hostOld, PLUGIN_DATA: process.env.PLUGIN_DATA, AGENTGUARD_HOME: process.env.AGENTGUARD_HOME, AGENTGUARD_PLUGIN_POLICY: process.env.AGENTGUARD_PLUGIN_POLICY, AGENTGUARD_LICENSE_KEY: process.env.AGENTGUARD_LICENSE_KEY };
  matrix.environment(process.env, data);
  process.env.AGENTGUARD_HOME = path.join(data, 'burn');
  process.env.AGENTGUARD_LICENSE_KEY = '';
  seedPaidLicense(process.env.AGENTGUARD_HOME, LICENSE_KEY, data);
  delete process.env.AGENTGUARD_PLUGIN_POLICY;
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({ ...base, ...policy }));
  const loc = locations();
  t.after(() => {
    spawnSync(process.execPath, [path.join(__dirname, '..', 'runtime', 'control.cjs'), 'stop'], { env: process.env, timeout: 5000 });
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(loc.ipc, { recursive: true, force: true });
  });
  const engine = new Engine(); await engine.init();
  const rows = () => fs.existsSync(path.join(data, 'ledger', 'decisions.ndjson')) ? fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { data, engine, rows, handle: async (raw, gate = 'spend', {expectedWarning = false} = {}) => { const result = await engine.handle({meta: metadata(raw, gate)}); if (!expectedWarning) assert.equal(result.warning, undefined, 'A normal decision must not fail open.'); return result; }, policy: next => fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({ ...base, ...next })) };
}

test('recorded Codex fixture and synthetic MCP payloads retain the documented input shape', () => {
  const recorded = {payloads: matrix.payloads(require('./fixtures/codex-0.151.0-pretooluse.json').payloads)};
  assert.ok(recorded.payloads.length >= 3);
  for (const raw of [...recorded.payloads, ...fixtures]) {
    assert.equal(raw.hook_event_name, 'PreToolUse');
    assert.equal(typeof raw.tool_input, 'object');
    const meta = metadata(raw, 'spend');
    assert.match(meta.inputDigest, /^[a-f0-9]{64}$/);
    assert.equal(meta.inputDigestAlg, 'hmac-sha256');
    assert.equal(Object.hasOwn(meta, 'inputSha256'), false);
    assert.equal(JSON.stringify(meta).includes('SYNTHETIC_TOOL_INPUT_MUST_NOT_APPEAR'), false);
    assert.equal(Object.hasOwn(meta, 'tool_input'), false);
  }
});

test('exact denied tool returns the supported deny envelope and a signed BLOCK', async t => {
  const f = await setup(t, { deniedTools: ['^mcp__imanage__save_document$'] });
  const result = await f.handle(payload('mcp__imanage__save_document'));
  assert.equal(allowed(result.output), false);
  assert.equal(result.output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /tool_denied/);
  assert.equal(f.rows()[0].decision.action, 'block');
  assert.equal((await sdk.verifyChain(f.rows(), f.engine.publicKey)).ok, true);
});

test('session ethical wall blocks writes while preserving the same tool in another session', async t => {
  const f = await setup(t, { sessions: { restricted: { ethicalWall: ['^mcp__imanage__save_document$'], matterId: 'synthetic-matter', agentId: 'synthetic-agent' } } });
  assert.equal(allowed((await f.handle(payload('mcp__imanage__save_document', { session_id: 'restricted' }))).output), false);
  assert.equal(allowed((await f.handle(payload('mcp__imanage__save_document', { session_id: 'unrestricted' }))).output), true);
  assert.deepEqual({ taskId: f.rows()[0].decision.actor.taskId, agentId: f.rows()[0].decision.actor.agentId }, { taskId: 'synthetic-matter', agentId: 'synthetic-agent' });
});

test('global and session capability limits cannot be raised by a tool rule', async t => {
  const f = await setup(t, { maxCapability: 'read_only', toolRules: [{ pattern: '^Bash$', capability: 'data_write' }] });
  assert.equal(allowed((await f.handle(payload())).output), false);
  f.policy({ maxCapability: 'payment_execute', sessions: { restricted: { maxCapability: 'read_only' } } });
  assert.equal(allowed((await f.handle(payload('Bash', { session_id: 'restricted' }))).output), false);
  assert.equal(allowed((await f.handle(payload('mcp__imanage__get_document', { session_id: 'restricted' }))).output), true);
});

test('payment-like tools retain a payment capability even when a rule classifies them as read-only', async t => {
  const f = await setup(t, { maxCapability: 'data_write', toolRules: [{ pattern: 'checkout', capability: 'read_only' }] });
  const result = await f.handle(payload('mcp__payments__checkout'));
  assert.equal(allowed(result.output), false);
  assert.equal(f.rows()[0].decision.plugin.capabilityTier, 'payment_initiate');
});

test('configured unit costs hit the daily cap on the third call and the chain verifies', async t => {
  const f = await setup(t, { toolRules: [{ pattern: '^Bash$', unitCostCents: 1 }], caps: [{ window: 'per_day', amountCents: 2, action: 'block' }] });
  const results = [];
  for (let i = 0; i < 3; i++) results.push(allowed((await f.handle(payload())).output));
  assert.deepEqual(results, [true, true, false]);
  assert.deepEqual(f.rows().map(row => row.decision.projectedCents), [1, 1, 1]);
  assert.equal((await sdk.verifyChain(f.rows(), f.engine.publicKey)).ok, true);
});

test('per-agent cap selectors isolate two agents in one policy', async t => {
  const f = await setup(t, { toolRules: [{ pattern: '^Bash$', unitCostCents: 1 }], caps: [{ window: 'per_day', amountCents: 1, selector: { agentId: 'agent-a' } }, { window: 'per_day', amountCents: 3, selector: { agentId: 'agent-b' } }] });
  const results = [];
  for (const agent_id of ['agent-a', 'agent-a', 'agent-b']) results.push(allowed((await f.handle(payload('Bash', { agent_id }))).output));
  assert.deepEqual(results, [true, false, true]);
  assert.deepEqual(f.rows().map(row => row.decision.actor.agentId), ['agent-a', 'agent-a', 'agent-b']);
});

test('duplicate pre-tool events do not charge or append twice', async t => {
  const f = await setup(t, { toolRules: [{ pattern: '^Bash$', unitCostCents: 1 }], caps: [{ window: 'per_day', amountCents: 1 }] });
  const raw = payload();
  assert.equal(allowed((await f.handle(raw)).output), true);
  assert.equal(allowed((await f.handle(raw)).output), true);
  assert.equal(f.rows().length, 1);
  assert.equal(allowed((await f.handle(payload())).output), false);
});

test('two sessions share a per-matter cap while an unrelated matter remains allowed', async t => {
  const f = await setup(t, {
    toolRules: [{ pattern: '^Bash$', unitCostCents: 1 }],
    caps: [{ window: 'per_day', amountCents: 1, selector: { taskId: 'matter-a' } }],
    sessions: { 'session-a': { matterId: 'matter-a' }, 'session-b': { matterId: 'matter-a' }, 'session-c': { matterId: 'matter-b' } },
  });
  const results = [];
  for (const session_id of ['session-a', 'session-b', 'session-c']) results.push(allowed((await f.handle(payload('Bash', { session_id }))).output));
  assert.deepEqual(results, [true, false, true]);
  assert.deepEqual(f.rows().map(row => row.decision.actor.taskId), ['matter-a', 'matter-a', 'matter-b']);
  assert.equal((await sdk.verifyChain(f.rows(), f.engine.publicKey)).ok, true);
});

test('PostToolUse joins its decision and stores numeric outcome metadata without content', async t => {
  const f = await setup(t, { defaultMatterId: 'synthetic-matter', toolRules: [{ pattern: '^Bash$', unitCostCents: 2 }] });
  const raw = payload(); await f.handle(raw);
  assert.deepEqual((await f.handle({ ...raw, hook_event_name: 'PostToolUse', duration_ms: 7, tool_response: { text: 'SYNTHETIC_TOOL_OUTPUT_MUST_NOT_APPEAR', exit_code: 0 } }, 'receipt')).output, {});
  const rows = f.rows(), outcome = rows[1].decision;
  assert.equal(outcome.originalDecisionId, rows[0].decision.decisionId);
  assert.equal(outcome.actor.taskId, 'synthetic-matter');
  assert.equal(outcome.plugin.durationMs, 7);
  assert.equal(outcome.plugin.durationSource, 'host');
  assert.equal(outcome.plugin.success, true);
  assert.equal(outcome.plugin.outputBytes > 0, true);
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC_TOOL_INPUT_MUST_NOT_APPEAR'), false);
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC_TOOL_OUTPUT_MUST_NOT_APPEAR'), false);
  assert.equal((await sdk.verifyChain(rows, f.engine.publicKey)).ok, true);
});

test('failed tool results produce a failed outcome with an estimated duration', async t => {
  const f = await setup(t); const raw = payload(); await f.handle(raw);
  await f.handle({ ...raw, tool_response: { exit_code: 1, stderr: 'SYNTHETIC_TOOL_OUTPUT_MUST_NOT_APPEAR' } }, 'receipt');
  const outcome = f.rows()[1].decision;
  assert.equal(outcome.plugin.success, false);
  assert.equal(outcome.plugin.durationSource, 'elapsed_since_decision');
  assert.equal(outcome.outcomeReceipt.status, 'failed');
});

test('invalid policy fails open with a signed event and no raw error text', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.data, 'policy.json'), 'SYNTHETIC_INVALID_POLICY_CONTENT');
  const result = await f.handle(payload(), 'spend', {expectedWarning: true});
  assert.equal(allowed(result.output), true); assert.equal(result.warning, true);
  assert.equal(f.rows()[0].decision.plugin.event, 'fail_open');
  assert.equal(JSON.stringify(f.rows()).includes('SYNTHETIC_INVALID_POLICY_CONTENT'), false);
  assert.equal((await sdk.verifyChain(f.rows(), f.engine.publicKey)).ok, true);
});

test('unmatched PostToolUse is a signed fail-open event instead of a fabricated joined outcome', async t => {
  const f = await setup(t);
  const result = await f.handle(payload(), 'receipt', {expectedWarning: true});
  assert.equal(result.warning, true);
  assert.equal(f.rows()[0].decision.plugin.reasonCode, 'outcome_without_decision');
  assert.equal(f.rows()[0].decision.plugin.event, 'fail_open');
});

test('policy validation rejects unsafe costs and malformed regular expressions', () => {
  for (const patch of [{ caps: [{ window: 'per_day', amountCents: -1 }] }, { toolRules: [{ pattern: '[', unitCostCents: 1 }] }, { maxCapability: 'unknown' }, { toolRules: [{ pattern: '.*', unitCostCents: 0.1 }] }]) assert.throws(() => validatePolicy({ ...base, ...patch }));
});

test('hook subprocesses return valid JSON, signed decisions, and a matching post receipt', async t => {
  const f = await setup(t, { deniedTools: ['^mcp__imanage__save_document$'] });
  const invoke = (script, raw) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', script)], { input: JSON.stringify(raw), encoding: 'utf8', env: process.env, timeout: 10000 });
  const denied = invoke('spend-gate.cjs', payload('mcp__imanage__save_document'));
  assert.equal(denied.status, 0, denied.stderr); assert.equal(denied.stderr, ''); assert.equal(allowed(JSON.parse(denied.stdout)), false);
  const raw = payload('mcp__imanage__get_document');
  const allow = invoke('spend-gate.cjs', raw); assert.equal(allow.status, 0, allow.stderr); assert.equal(allowed(JSON.parse(allow.stdout)), true); assert.equal(allow.stderr, '');
  const post = invoke('receipt.cjs', { ...raw, tool_response: { text: 'SYNTHETIC_TOOL_OUTPUT_MUST_NOT_APPEAR' }, duration_ms: 4 });
  assert.equal(post.status, 0, post.stderr); assert.equal(post.stderr, ''); assert.deepEqual(JSON.parse(post.stdout), {});
  assert.equal(f.rows().length, 3); assert.equal(f.rows().every(row => row.decision.plugin.host === matrix.host), true); assert.equal((await sdk.verifyChain(f.rows(), f.engine.publicKey)).ok, true);
});

test('warm IPC decisions meet the 250ms budget without fail-open and report subprocess startup separately', async t => {
  const f = await setup(t); const warmup = await request({ meta: metadata(payload(), 'spend') });
  assert.equal(warmup.warning, undefined); assert.equal(allowed(warmup.output), true);
  const timings = [];
  for (let i = 0; i < 15; i++) {
    const started = performance.now(); const result = await request({ meta: metadata(payload(), 'spend') });
    timings.push(performance.now() - started); assert.equal(allowed(result.output), true); assert.equal(result.warning, undefined);
  }
  const subprocessStart = performance.now();
  const processResult = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'spend-gate.cjs')], { input: JSON.stringify(payload()), encoding: 'utf8', env: process.env, timeout: 10000 });
  const subprocessMs = performance.now() - subprocessStart;
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.equal(processResult.stderr, ''); assert.equal(allowed(JSON.parse(processResult.stdout)), true);
  assert.equal(f.rows().length, 17);
  assert.equal(f.rows().every(row => row.decision.plugin.event === 'decision'), true);
  const maximum = Math.max(...timings), sorted = timings.toSorted((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * .95) - 1];
  t.diagnostic(`Warm IPC ${timings.length} signed decisions: p95=${p95.toFixed(2)}ms max=${maximum.toFixed(2)}ms; separate Node subprocess total=${subprocessMs.toFixed(2)}ms.`);
  assert.equal(maximum < 250, true, `warm IPC exceeded 250ms: ${maximum}`);
  assert.equal((await sdk.verifyChain(f.rows(), f.engine.publicKey)).ok, true);
});


test('Free decisions enforce local denies and their signed outcomes retain the Free status', async t => {
  const f = await setup(t, {licenseKey: null, deniedTools: ['^mcp__imanage__save_document$']});
  const raw = payload('mcp__imanage__save_document');
  const result = await f.handle(raw);
  assert.equal(allowed(result.output), false);
  assert.equal(result.warning, undefined);
  const read = payload('Read');
  await f.handle(read);
  await f.handle({...read, tool_response: {isError: false}, duration_ms: 5}, 'receipt');
  const rows = f.rows();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].decision.action, 'block');
  assert.equal(rows[2].decision.entryType, 'outcome');
  for (const row of rows) {
    assert.equal(row.decision.enforcementMode, 'enforce');
    assert.equal(row.decision.reasons.includes('license_required'), false);
    assert.equal(row.decision.plugin.license.reason, null);
  }
  assert.equal((await sdk.verifyChain(rows, f.engine.publicKey)).ok, true);
});
