'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('./helper-test-env.cjs');
const burn = require('@agentguard-run/burn');
const sdk = require('@agentguard-run/spend');
const {Engine} = require('../runtime/engine.cjs');
const {hostContext, locations, metadata, normalizeHookOutput, matchingExternalBurn, allow, deny, standaloneBurnCommand} = require('../runtime/common.cjs');
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const root = path.resolve(__dirname, '..');
const readRows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const paid = {paid: true, tier: 'solo', seatsUsed: 1, seatLimit: 1, expiresAt: null};
async function fixture(t, options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-claude-test-'));
  const home = path.join(data, 'burn'), config = path.join(data, 'claude');
  fs.mkdirSync(home); fs.mkdirSync(config);
  seedPaidLicense(home, LICENSE_KEY, data);
  const previous = {...process.env};
  for (const key of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'AGENTGUARD_PLUGIN_POLICY', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_PROJECT_DIR']) delete process.env[key];
  Object.assign(process.env, {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: config,
    AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0'});
  const policy = {version: 1, mode: 'enforce', licenseKey: LICENSE_KEY, maxCapability: 'payment_execute', caps: [], ...options.policy};
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
  const burnPolicy = structuredClone(burn.DEFAULT_POLICY);
  burnPolicy.mode = 'enforce';
  burnPolicy.thresholds.fanout = {warn: 1, stop: 1, maxDepth: 2};
  if (options.sustained) burnPolicy.thresholds.sustained = options.sustained;
  fs.writeFileSync(path.join(home, 'burn-policy.json'), JSON.stringify(burnPolicy));
  const transcriptPath = path.join(data, 'transcript.jsonl');
  // Synthetic usage is known by construction, separate from recorded fixtures.
  fs.writeFileSync(transcriptPath, JSON.stringify({uuid: 'synthetic-usage-1', type: 'assistant', timestamp: new Date().toISOString(),
    message: {role: 'assistant', usage: {input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40, output_tokens: 10},
      content: [{type: 'text', text: 'SYNTHETIC_TRANSCRIPT_CONTENT_MUST_NOT_APPEAR'}]}}) + '\n');
  const engine = new Engine({licenseReader: () => options.free ? {paid: false, mode: 'enforce', tier: 'free', reason: null} : paid});
  await engine.init();
  const loc = locations();
  t.after(async () => {
    spawnSync(process.execPath, [path.join(root, 'runtime', 'control.cjs'), 'stop'], {env: process.env, timeout: 5000});
    if (!engine.testClosed) await engine.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(data, {recursive: true, force: true}); fs.rmSync(loc.ipc, {recursive: true, force: true});
  });
  let count = 0;
  const raw = (tool_name = 'Bash', extra = {}) => ({session_id: 'synthetic-claude-session', tool_use_id: `toolu_SYNTHETIC_${count++}`,
    cwd: data, transcript_path: transcriptPath, hook_event_name: 'PreToolUse', tool_name,
    tool_input: {command: 'SYNTHETIC_INPUT_MUST_NOT_APPEAR'}, ...extra});
  const rows = () => readRows(path.join(data, 'ledger', 'decisions.ndjson'));
  const handle = async (input, gate = 'spend') => {
    const result = await engine.handle({meta: metadata(input, gate), transcriptPath, workingDirectory: data});
    assert.equal(result.warning, undefined, 'Normal Claude decisions must not fail open.');
    return normalizeHookOutput(result.output);
  };
  return {data, home, config, transcriptPath, engine, raw, rows, handle, policy,
    receipts: () => readRows(path.join(home, 'receipts.ndjson')),
    verify: async () => assert.equal((await sdk.verifyChain(rows(), engine.publicKey)).ok, true)};
}

test('host paths remain backward compatible and support Claude plugin variables', () => {
  assert.deepEqual(hostContext({}), {host: 'codex', root: undefined, data: undefined, sessionId: undefined});
  assert.deepEqual(hostContext({CLAUDE_PLUGIN_ROOT: '/synthetic/plugin', CLAUDE_PLUGIN_DATA: '/synthetic/data', CLAUDE_SESSION_ID: 'synthetic-session'}),
    {host: 'claude-code', root: '/synthetic/plugin', data: '/synthetic/data', sessionId: 'synthetic-session'});
  assert.deepEqual(hostContext({PLUGIN_ROOT: '/synthetic/codex', PLUGIN_DATA: '/synthetic/codex-data', CODEX_THREAD_ID: 'codex-thread', CLAUDE_PLUGIN_ROOT: '/synthetic/parent'}),
    {host: 'codex', root: '/synthetic/codex', data: '/synthetic/codex-data', sessionId: 'codex-thread'});
});

test('Claude admissions preserve host permission prompts and denials preserve their reason', async t => {
  const f = await fixture(t);
  assert.deepEqual(normalizeHookOutput(allow()), {});
  assert.deepEqual(normalizeHookOutput({...allow(), systemMessage: 'Synthetic advisory.'}), {systemMessage: 'Synthetic advisory.'});
  assert.deepEqual(normalizeHookOutput(deny('synthetic_reason')), deny('synthetic_reason'));
  const raw = f.raw('Read');
  assert.deepEqual(await f.handle(raw), {});
  assert.equal(f.rows()[0].decision.plugin.host, 'claude-code');
  assert.equal(f.rows()[0].decision.provider, 'claude-code');
  assert.equal(metadata({...raw, host: 'codex'}, 'spend').host, 'claude-code');
  await f.verify();
});

test('Claude MCP names preserve the plugin namespace, actor and capability policy', async t => {
  const f = await fixture(t, {policy: {ethicalWall: ['^mcp__plugin_documents_vault__save_document$']}});
  const denied = await f.handle(f.raw('mcp__plugin_documents_vault__save_document', {agent_id: 'synthetic-subagent'}));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const raw = f.raw('mcp__plugin_documents_vault__get_document', {agent_id: 'synthetic-subagent'});
  assert.deepEqual(await f.handle(raw), {});
  const decision = f.rows()[1].decision;
  assert.equal(decision.provider, 'plugin_documents_vault');
  assert.equal(decision.modelRequested, 'get_document');
  assert.equal(decision.actor.agentId, 'synthetic-subagent');
  assert.equal(decision.actor.sessionId, raw.session_id);
  await f.verify();
});

test('Claude shell and notebook tools cannot be classified below data_write', async t => {
  const f = await fixture(t, {policy: {maxCapability: 'read_only', toolRules: [{pattern: '.*', capability: 'read_only'}]}});
  for (const name of ['Bash', 'PowerShell', 'NotebookEdit', 'Edit', 'Write']) {
    const output = await f.handle(f.raw(name));
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(f.rows().at(-1).decision.plugin.capabilityTier, 'data_write');
  }
  assert.deepEqual(await f.handle(f.raw('WebSearch')), {});
  await f.verify();
});

test('Claude PostToolUseFailure signs a failed outcome without retaining error text', async t => {
  const f = await fixture(t); const raw = f.raw();
  await f.handle(raw);
  const error = 'SYNTHETIC_ERROR_CONTENT_MUST_NOT_APPEAR';
  assert.deepEqual(await f.handle({...raw, hook_event_name: 'PostToolUseFailure', error, is_interrupt: false, duration_ms: 19}, 'receipt'), {});
  const rows = f.rows(), outcome = rows[1].decision;
  assert.equal(outcome.plugin.host, 'claude-code');
  assert.equal(outcome.plugin.success, false);
  assert.equal(outcome.plugin.durationMs, 19);
  assert.equal(outcome.plugin.outputBytes, Buffer.byteLength(JSON.stringify(error)));
  assert.equal(outcome.outcomeReceipt.flow, 'claude-code-tool');
  assert.equal(outcome.outcomeReceipt.status, 'failed');
  assert.equal(outcome.originalDecisionId, rows[0].decision.decisionId);
  assert.equal(JSON.stringify(rows).includes(error), false);
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC_INPUT_MUST_NOT_APPEAR'), false);
  await f.verify();
});

test('Claude native usage, cache creation, spawn cap and receipts use the shared Burn gateway', async t => {
  const f = await fixture(t);
  await f.handle(f.raw('Read'), 'burn');
  const first = f.raw('Agent'); assert.equal((await f.handle(first, 'burn')).hookSpecificOutput?.permissionDecision, undefined);
  const second = await f.handle(f.raw('Agent'), 'burn');
  assert.equal(second.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(f.receipts().length, 2);
  for (const receipt of f.receipts()) {
    assert.equal(burn.verifyReceipt(receipt), true);
    assert.equal(receipt.payload.host, 'claude-code');
    assert.equal(receipt.payload.measured.sessionTokens, 100);
  }
  const gatewayState = f.engine.gateway.sessions().find(value => value.sessionId === first.session_id);
  assert.equal(gatewayState.state.totalTokens, 100);
  assert.equal(gatewayState.state.totalCacheRead, 40);
  const paceFile = path.join(f.home, 'pace', crypto.createHash('sha256').update(first.session_id).digest('hex') + '.json');
  const pace = JSON.parse(fs.readFileSync(paceFile, 'utf8'));
  assert.equal(pace.host, 'claude');
  assert.equal(pace.toolEvents, 3);
  assert.equal(pace.lastTurnTokens, 90);
  assert.equal(f.rows().length, 2);
  assert.equal(f.rows().some(value => value.decision.plugin.event === 'fail_open'), false);
  await f.verify();
});

test('Claude free mode enforces Burn stops without changing the installed Burn policy', async t => {
  const f = await fixture(t, {free: true, sustained: {warnTokens: 50, stopTokens: 80}});
  const before = fs.readFileSync(path.join(f.home, 'burn-policy.json'));
  const output = await f.handle(f.raw('Agent'), 'burn');
  assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(f.rows()[0].decision.action, 'block');
  assert.equal(f.rows()[0].decision.plugin.license.reason, null);
  const receipt = f.receipts()[0];
  assert.equal(receipt.payload.policy.mode, 'enforce');
  assert.equal(receipt.payload.blocked, true);
  assert.equal(receipt.payload.verdict, 'STOP');
  assert.equal(fs.readFileSync(path.join(f.home, 'burn-policy.json')).equals(before), true);
  await f.verify();
});

test('an installed standalone Claude Burn hook owns reservations and receipts without duplicate charging', async t => {
  const f = await fixture(t);
  const settingsFile = path.join(f.config, 'settings.json');
  const settings = JSON.stringify({hooks: {PreToolUse: [{matcher: '^Agent$', hooks: [{type: 'command', command: 'agentguard-burn hook'}]}]}});
  fs.writeFileSync(settingsFile, settings);
  const raw = f.raw('Agent');
  assert.equal(matchingExternalBurn(metadata(raw, 'burn'), f.data), true);
  assert.equal(matchingExternalBurn(metadata(f.raw('Read'), 'burn'), f.data), false);
  assert.deepEqual(await f.handle(raw, 'burn'), {});
  assert.equal(f.receipts().length, 0);
  assert.equal(f.engine.gateway, undefined);
  assert.equal(f.rows()[0].decision.plugin.reasonCode, 'burn_external_hook');
  const native = burn.handlePreToolUse(raw, f.home);
  assert.notEqual(native.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(f.receipts().length, 1);
  assert.equal(burn.verifyReceipt(f.receipts()[0]), true);
  const reservations = JSON.parse(fs.readFileSync(path.join(f.home, 'reservations.json'))).reservations;
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].toolUseId, raw.tool_use_id);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), settings);
  await f.handle({...raw, hook_event_name: 'PostToolUse', tool_response: {status: 'async_launched', agentId: 'synthetic-child'}}, 'receipt');
  assert.equal(f.rows()[1].decision.plugin.reasonCode, 'burn_external_verified');
  assert.equal(f.rows()[1].decision.plugin.externalReceiptHash, burn.receiptDigest(f.receipts()[0]));
  assert.equal(f.rows()[2].decision.originalDecisionId, f.rows()[1].decision.decisionId);
  await f.verify();
});

test('Claude subprocesses preserve permissions and verify signed decisions and receipts without sockets', async t => {
  const f = await fixture(t, {policy: {ethicalWall: ['^mcp__documents__save_document$']}});
  await f.engine.close(); f.engine.testClosed = true;
  const preload = path.join(f.data, 'no-sockets.cjs');
  fs.writeFileSync(preload, `const net=require('node:net'),dgram=require('node:dgram'); net.Socket.prototype.connect=()=>{throw new Error('socket_forbidden')};dgram.createSocket=()=>{throw new Error('socket_forbidden')};`);
  const env = {...process.env, NODE_OPTIONS: ['--require', preload].join(' ')};
  const invoke = (script, raw) => {
    const child = spawnSync(process.execPath, [path.join(root, 'hooks', script + '.cjs')], {env, input: JSON.stringify(raw), encoding: 'utf8', timeout: 10000});
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '', 'Normal hook subprocess must not fail open.');
    return JSON.parse(child.stdout);
  };
  assert.equal(invoke('spend-gate', f.raw('mcp__documents__save_document')).hookSpecificOutput.permissionDecision, 'deny');
  const raw = f.raw('mcp__documents__get_document');
  assert.deepEqual(invoke('spend-gate', raw), {});
  assert.deepEqual(invoke('receipt', {...raw, hook_event_name: 'PostToolUse', tool_response: {ok: true}, duration_ms: 4}), {});
  assert.equal(f.rows().length, 3);
  assert.equal(f.rows().every(row => row.decision.plugin.host === 'claude-code'), true);
  await f.verify();
});


test('standalone Burn ownership recognizes executable commands, never comments or incidental text', () => {
  for (const command of ['agentguard-burn hook', 'node /synthetic/node_modules/@agentguard-run/burn/dist/src/cli.js hook',
    'node "/synthetic path/node_modules/@agentguard-run/burn/dist/src/cli.js" hook', 'npx --no-install @agentguard-run/burn hook'])
    assert.equal(standaloneBurnCommand({type: 'command', command}), true, command);
  for (const command of ['echo agentguard-burn hook', '# agentguard-burn hook', 'printf "agentguard-burn hook"',
    'agentguard-burn hook; echo injected', 'node /synthetic/agentguard-burn/dist/src/cli.js hook # comment',
    'node /synthetic/agentguard-codex-plugin/hooks/burn-gate.cjs'])
    assert.equal(standaloneBurnCommand({type: 'command', command}), false, command);
  assert.equal(standaloneBurnCommand({type: 'command', command: 'node', args: ['/synthetic path/@agentguard-run/burn/dist/src/cli.js', 'hook']}), true);
});

test('Claude cursor resumes after restart and gateway replay does not add tokens or spawns twice', async t => {
  const f = await fixture(t);
  fs.appendFileSync(f.transcriptPath, JSON.stringify({uuid: 'synthetic-spawn-record', type: 'assistant', timestamp: new Date().toISOString(),
    message: {role: 'assistant', content: [{type: 'tool_use', name: 'Agent', input: {description: 'SYNTHETIC_DESCRIPTION_MUST_NOT_APPEAR'}}]}}) + '\n');
  await f.handle(f.raw('Read'), 'burn');
  let state = f.engine.gateway.sessions()[0].state;
  assert.equal(state.totalTokens, 100); assert.equal(state.spawnCount, 1);
  await f.engine.close(); f.engine.testClosed = true;
  const next = new Engine({licenseReader: () => paid}); await next.init();
  const raw = f.raw('Read');
  const message = {meta: metadata(raw, 'burn'), transcriptPath: f.transcriptPath, workingDirectory: f.data};
  assert.equal((await next.handle(message)).warning, undefined);
  state = next.gateway.sessions()[0].state;
  assert.equal(state.totalTokens, 100); assert.equal(state.spawnCount, 1);
  // Simulate a crash after the gateway write and before the cursor rename.
  for (const file of fs.readdirSync(path.join(f.data, 'claude-cursors'))) fs.unlinkSync(path.join(f.data, 'claude-cursors', file));
  await next.close();
  const replayed = new Engine({licenseReader: () => paid}); await replayed.init();
  assert.equal((await replayed.handle({...message, meta: metadata(f.raw('Read'), 'burn')})).warning, undefined);
  state = replayed.gateway.sessions()[0].state;
  assert.equal(state.totalTokens, 100); assert.equal(state.spawnCount, 1);
  assert.equal(JSON.stringify(state).includes('SYNTHETIC_DESCRIPTION_MUST_NOT_APPEAR'), false);
  await replayed.close();
});


test('a failed Claude observation leaves its persisted cursor at the last successful gateway write', async t => {
  const f = await fixture(t); await f.handle(f.raw('Read'), 'burn');
  const directory = path.join(f.data, 'claude-cursors'), file = path.join(directory, fs.readdirSync(directory)[0]);
  const before = fs.readFileSync(file);
  fs.appendFileSync(f.transcriptPath, JSON.stringify({uuid: 'synthetic-usage-2', type: 'assistant', timestamp: new Date().toISOString(),
    message: {usage: {input_tokens: 50, output_tokens: 0}, content: []}}) + '\n');
  const original = f.engine.gateway.observe;
  f.engine.gateway.observe = () => {throw new Error('synthetic_observation_failure');};
  const failed = await f.engine.handle({meta: metadata(f.raw('Read'), 'burn'), transcriptPath: f.transcriptPath, workingDirectory: f.data});
  assert.equal(failed.warning, true);
  assert.equal(fs.readFileSync(file).equals(before), true);
  f.engine.gateway.observe = original;
  await f.handle(f.raw('Read'), 'burn');
  assert.equal(f.engine.gateway.sessions()[0].state.totalTokens, 150);
  await f.verify();
});

test('recorded Claude 2.1.275 tool events pass through both gates and content-free signed outcomes', async t => {
  const captured = require('./fixtures/claude-code-2.1.275-hooks.json');
  assert.ok(Array.isArray(captured.payloads));
  const f = await fixture(t);
  const events = captured.payloads.filter(raw => ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(raw.hook_event_name));
  const tools = new Set(events.map(raw => raw.tool_name));
  for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Agent', 'mcp__imanage__get_document', 'mcp__imanage__save_document']) assert.ok(tools.has(tool));
  assert.ok(events.some(raw => raw.hook_event_name === 'PostToolUseFailure' && raw.tool_name === 'Bash'));
  for (const event of events) {
    if (event.hook_event_name === 'PreToolUse') {
      const result = await f.handle(event, 'burn');
      assert.notEqual(result.hookSpecificOutput?.permissionDecision, 'deny');
      assert.deepEqual(await f.handle(event, 'spend'), {});
    } else assert.deepEqual(await f.handle(event, 'receipt'), {});
  }
  const rows = f.rows(), decisions = rows.filter(row => row.decision.plugin.event === 'decision');
  assert.equal(decisions.length, events.filter(raw => raw.hook_event_name === 'PreToolUse').length);
  assert.equal(rows.filter(row => row.decision.plugin.event === 'outcome').length,
    events.filter(raw => raw.hook_event_name !== 'PreToolUse').length);
  assert.equal(rows.every(row => row.decision.plugin.host === 'claude-code'), true);
  assert.equal(rows.some(row => row.decision.plugin.event === 'fail_open'), false);
  for (const event of events) {
    const row = rows.find(row => row.decision.plugin.toolUseId === event.tool_use_id &&
      row.decision.plugin.event === (event.hook_event_name === 'PreToolUse' ? 'decision' : 'outcome'));
    assert.ok(row);
    assert.equal(row.decision.plugin.inputDigest, require('../runtime/digest-key.cjs').keyedDigest(locations().data, 'input', JSON.stringify(event.tool_input ?? {})));
    assert.equal(row.decision.plugin.inputSha256, undefined);
    assert.equal(Object.hasOwn(row.decision.plugin, 'tool_input'), false);
    assert.equal(Object.hasOwn(row.decision.plugin, 'tool_response'), false);
    assert.equal(Object.hasOwn(row.decision.plugin, 'error'), false);
    if (event.agent_id) assert.equal(row.decision.actor.agentId, event.agent_id);
    if (event.hook_event_name === 'PostToolUseFailure') assert.equal(row.decision.outcomeReceipt.status, 'failed');
  }
  await f.verify();
  t.diagnostic(`Recorded Claude 2.1.275: ${events.length} tool events, ${rows.length} signed rows, 0 fail-open events, verified chain.`);
});
