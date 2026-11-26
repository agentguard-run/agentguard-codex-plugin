'use strict';
// Model switches (PreModelSwitch and PostModelSwitch in Claude Code).
//
// Guarantees, in plain words:
//   1. Before a switch AgentGuard only ever adds a line or asks. It never answers
//      "allow" (which would skip Claude Code's own confirmation while the cache
//      is warm) and never refuses on its own.
//   2. It asks exactly when the cache is warm, the estimate is at least ten
//      cents and at or above the owner's limit, the request came from /model,
//      /config, fast mode or the picker (never the Agent SDK), and the policy
//      enforces. Shadow never asks.
//   3. Nothing from the hook input reaches a line, a question or the ledger
//      except model names that pass the model name check, counts and the
//      documented enumerations.
//   4. After a switch, one signed ledger row per switch, which the read-only
//      reader verifies, and a session's closing receipt stays its last row.
//   5. The first-session line shows once per model and never for the first
//      model AgentGuard sees on a machine.
// Temporary directories only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const {spawnSync} = require('./helper-test-env.cjs');
const burn = require('@agentguard-run/burn');
const sdk = require('@agentguard-run/spend');
const modelSwitch = require('../runtime/model-switch.cjs');
const {validatePolicy} = require('../runtime/policy-schema.cjs');
const root = path.resolve(__dirname, '..');
const ORIGINAL_ENV = {...process.env};
const ENV_KEYS = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY'];
const RUNS = 2000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const pre = (extra = {}) => ({session_id: 'switch-session', transcript_path: '/tmp/x.jsonl', cwd: '/tmp', hook_event_name: 'PreModelSwitch',
  from_model: 'claude-sonnet-5', to_model: 'claude-opus-5', requested_model: 'opus', source: 'command', context_tokens: 182340,
  prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 1.1396, pricing: 'catalog', ...extra});
const post = extra => pre({hook_event_name: 'PostModelSwitch', ...extra});

function directories(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-model-switch-')));
  const data = path.join(base, 'data'), home = path.join(base, 'agentguard');
  for (const dir of [data, home]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  // SessionStart's lifecycle helper would start the license worker, which plays no part here.
  const preload = path.join(base, 'no-child.cjs');
  fs.writeFileSync(preload, "require('node:child_process').spawn = () => ({on(){}, unref(){}});");
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  return {base, data, home, preload};
}
function inProcess(t, {policy} = {}) {
  const dirs = directories(t);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dirs.data, HOME: dirs.base, CLAUDE_CONFIG_DIR: path.join(dirs.base, 'claude'),
    AGENTGUARD_HOME: dirs.home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  fs.writeFileSync(path.join(dirs.data, 'policy.json'), JSON.stringify(policy ?? {version: 1, mode: 'enforce'}));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
    Object.assign(process.env, ORIGINAL_ENV);
  });
  return dirs;
}
function hook(dirs, input, {script = 'model-switch.cjs', host = 'claude-code'} = {}) {
  const env = {...process.env, HOME: dirs.base, AGENTGUARD_HOME: dirs.home, AGENTGUARD_NOTIFY_SUPPRESS: '1'};
  for (const key of ENV_KEYS) delete env[key];
  Object.assign(env, host === 'claude-code' ? {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dirs.data} : {PLUGIN_ROOT: root, PLUGIN_DATA: dirs.data});
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-r', dirs.preload, path.join(root, 'hooks', script)], {input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  return {output: JSON.parse(result.stdout.trim().split('\n').at(-1)), ms: Date.now() - started, stderr: result.stderr};
}

// The rule in guarantee 2, written separately from the code under test.
function oracleAsks(raw, limit, enforcing) {
  const usd = raw.estimated_cache_write_usd;
  const micro = typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 && usd * 1e6 <= 1e12 ? Math.round(usd * 1e6) : null;
  const shown = raw.hook_event_name === 'PreModelSwitch' && typeof raw.to_model === 'string' && /^[A-Za-z0-9._:/@[\]+-]{1,200}$/.test(raw.to_model) && raw.prompt_cache_warm === true
    && Number.isSafeInteger(raw.context_tokens) && raw.context_tokens > 0 && micro !== null && micro >= 100000;
  return shown && enforcing === true && Number.isSafeInteger(limit) && limit >= 0 && ['command', 'picker'].includes(raw.source) && micro >= limit * 10000;
}
const texts = output => [output.systemMessage, output.hookSpecificOutput?.permissionDecisionReason].filter(value => value !== undefined);

const modelName = fc.oneof(fc.constantFrom('claude-opus-5', 'claude-opus-5-5[1m]', 'us.anthropic.claude-sonnet-5-v1:0', 'opus', 'claude-fable-5-2'),
  fc.stringMatching(/^[A-Za-z0-9._:/@+-]{1,40}$/));
const anything = fc.oneof(fc.string({maxLength: 60}), fc.integer(), fc.double(), fc.boolean(), fc.constant(null), fc.constant(undefined),
  fc.array(fc.string({maxLength: 5}), {maxLength: 3}), fc.dictionary(fc.string({maxLength: 5}), fc.string({maxLength: 5}), {maxKeys: 2}));
const hookInput = fc.record({
  session_id: fc.oneof(fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/), anything),
  hook_event_name: fc.oneof(fc.constantFrom('PreModelSwitch', 'PostModelSwitch'), anything),
  from_model: fc.oneof(modelName, anything), to_model: fc.oneof(modelName, anything),
  requested_model: fc.oneof(modelName, fc.constant(null), anything),
  source: fc.oneof(fc.constantFrom(...modelSwitch.SOURCES), anything),
  context_tokens: fc.oneof(fc.integer({min: 0, max: 5_000_000}), anything),
  prompt_cache_warm: fc.oneof(fc.boolean(), anything), cache_ttl: fc.oneof(fc.constantFrom('5m', '1h'), anything),
  estimated_cache_write_usd: fc.oneof(fc.double({min: 0, max: 200, noNaN: true}), fc.integer({min: -5, max: 50}), anything),
  pricing: fc.oneof(fc.constantFrom('configured', 'catalog', 'default'), anything),
}, {requiredKeys: []});
const limitArb = fc.oneof(fc.integer({min: 0, max: 20000}), fc.constant(null), fc.constant(undefined), anything);

test('a switch shows one line; asking is the owner\'s opt-in, and then Claude Code asks with the figure', () => {
  assert.deepEqual(modelSwitch.decide(modelSwitch.read(pre())), {systemMessage:
    'AgentGuard: switching to claude-opus-5 re-sends this conversation (about 182k tokens) without its cache: an estimated $1.14 at list price.'});
  // Off by default: Claude Code treats an ask from /config or fast mode as a refusal.
  assert.equal(modelSwitch.DEFAULT_ASK_ABOVE_CENTS, null);
  assert.deepEqual(Object.keys(modelSwitch.decide(modelSwitch.read(pre({estimated_cache_write_usd: 900})))), ['systemMessage']);
  const limit = {askAboveCents: 500};
  const asked = modelSwitch.decide(modelSwitch.read(pre({estimated_cache_write_usd: 7.2})), limit);
  assert.equal(asked.hookSpecificOutput.hookEventName, 'PreModelSwitch');
  assert.equal(asked.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(asked.hookSpecificOutput.permissionDecisionReason, /an estimated \$7\.20 at list price\. That is at or above the \$5\.00 AgentGuard asks about\. Switch anyway\?/);
  // Exactly at the limit asks; one micro-dollar under does not.
  assert.equal(modelSwitch.decide(modelSwitch.read(pre({estimated_cache_write_usd: 5})), limit).hookSpecificOutput?.permissionDecision, 'ask');
  assert.equal(modelSwitch.decide(modelSwitch.read(pre({estimated_cache_write_usd: 4.999999})), limit).hookSpecificOutput, undefined);
  // The owner's own limit, and null for never.
  assert.equal(modelSwitch.decide(modelSwitch.read(pre()), {askAboveCents: 100}).hookSpecificOutput?.permissionDecision, 'ask');
  assert.equal(modelSwitch.decide(modelSwitch.read(pre({estimated_cache_write_usd: 900})), {askAboveCents: null}).hookSpecificOutput, undefined);
  // The Agent SDK, shadow and an expired cache never ask; an expired cache shows nothing.
  assert.equal(modelSwitch.decide(modelSwitch.read(pre({source: 'sdk', estimated_cache_write_usd: 900})), limit).hookSpecificOutput, undefined);
  assert.equal(modelSwitch.decide(modelSwitch.read(pre({estimated_cache_write_usd: 900})), {...limit, enforcing: false}).hookSpecificOutput, undefined);
  assert.deepEqual(modelSwitch.decide(modelSwitch.read(pre({prompt_cache_warm: false, estimated_cache_write_usd: 900})), limit), {});
  // Under ten cents, before the first response, and after the switch: nothing.
  assert.deepEqual(modelSwitch.decide(modelSwitch.read(pre({estimated_cache_write_usd: 0.09}))), {});
  assert.deepEqual(modelSwitch.decide(modelSwitch.read(pre({context_tokens: 0}))), {});
  assert.deepEqual(modelSwitch.decide(modelSwitch.read(post())), {});
  // Pricing words and token units.
  assert.match(modelSwitch.costLine(modelSwitch.read(pre({pricing: 'configured', context_tokens: 1_250_000}))), /about 1\.3M tokens.*at your organization's rates\.$/);
  assert.match(modelSwitch.costLine(modelSwitch.read(pre({pricing: 'default', context_tokens: 640}))), /about 640 tokens.*assumed rate/);
});

test(`property: before a switch AgentGuard only adds a line or asks, and asks exactly by the rule (${RUNS} inputs)`, () => {
  fc.assert(fc.property(hookInput, limitArb, fc.oneof(fc.boolean(), anything), (raw, limit, enforcing) => {
    const output = modelSwitch.decide(modelSwitch.read(raw), {askAboveCents: limit, enforcing});
    assert.ok(Object.keys(output).every(key => ['systemMessage', 'hookSpecificOutput'].includes(key)));
    assert.ok(!('systemMessage' in output && 'hookSpecificOutput' in output));
    const decision = output.hookSpecificOutput?.permissionDecision;
    assert.ok(decision === undefined || decision === 'ask');
    // decide() treats an undefined limit as the default.
    const effective = limit === undefined ? modelSwitch.DEFAULT_ASK_ABOVE_CENTS : limit;
    assert.equal(decision === 'ask', oracleAsks(raw, effective, enforcing === undefined ? true : enforcing));
    for (const text of texts(output)) { assert.doesNotMatch(text, CONTROL); assert.ok(text.length <= 700, text); }
    assert.doesNotThrow(() => JSON.stringify(output));
  }), {numRuns: RUNS, seed: 20261113});
});

test(`property: no input text reaches a line or the pending record except checked model names (${RUNS} inputs)`, t => {
  const dirs = directories(t);
  const sentinel = fc.stringMatching(/^[a-z]{4,10} [a-z]{4,10}$/).map(words => 'SECRET ' + words);
  fc.assert(fc.property(hookInput, sentinel, fc.constantFrom('from_model', 'to_model', 'requested_model', 'source', 'cache_ttl', 'pricing', 'session_id'),
    (raw, secret, field) => {
      const input = {...raw, [field]: secret};
      const change = modelSwitch.read(input);
      const output = modelSwitch.decide(change, {askAboveCents: 0});
      for (const text of texts(output)) assert.ok(!text.includes(secret));
      const file = path.join(dirs.data, modelSwitch.PENDING);
      try { fs.unlinkSync(file); } catch {}
      if (change) modelSwitch.pend(dirs.data, {...change, event: 'post'});
      if (fs.existsSync(file)) assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET'));
    }), {numRuns: RUNS, seed: 20261114});
});

test(`property: a pending switch reads back exactly as the hook saw it, and a bad line is skipped (${RUNS} inputs)`, t => {
  const dirs = directories(t);
  fc.assert(fc.property(hookInput, fc.integer({min: 1, max: 4_102_444_800_000}), (raw, at) => {
    const file = path.join(dirs.data, modelSwitch.PENDING);
    for (const name of [file, file + '.recovering']) { try { fs.unlinkSync(name); } catch {} }
    const change = modelSwitch.read({...raw, hook_event_name: 'PostModelSwitch'});
    const written = modelSwitch.pend(dirs.data, change, at);
    fs.appendFileSync(file, '{not json\n["array"]\n{"sessionId":"x","toModel":"has space","at":1}\n');
    const taken = modelSwitch.takePending(dirs.data);
    modelSwitch.finishPending(dirs.data);
    if (!written) return assert.equal(taken.length, 0);
    assert.equal(taken.length, 1);
    const defined = value => Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== 'event' && item !== undefined));
    assert.deepEqual(defined(taken[0]), {...defined(change), at});
    const fields = modelSwitch.rowFields(taken[0]);
    for (const [key, value] of Object.entries(fields)) assert.ok(modelSwitch.RECORDED_FIELDS[key](value), `${key}=${JSON.stringify(value)}`);
  }), {numRuns: RUNS, seed: 20261115});
});

test(`property: the policy accepts exactly a root modelSwitch with a whole-cent askAboveCents or null (${RUNS} inputs)`, () => {
  const valid = value => value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => key === 'askAboveCents')
    && (value.askAboveCents === undefined || value.askAboveCents === null || (Number.isSafeInteger(value.askAboveCents) && value.askAboveCents >= 0 && value.askAboveCents <= 100000000)));
  const candidate = fc.oneof(fc.record({askAboveCents: fc.oneof(fc.integer({min: -10, max: 200000000}), fc.double(), fc.constant(null), anything)}, {requiredKeys: []}),
    fc.record({askAboveCents: fc.integer({min: 0, max: 100}), other: anything}), anything);
  fc.assert(fc.property(candidate, value => {
    const policy = {version: 1, mode: 'enforce', ...(value === undefined ? {} : {modelSwitch: value})};
    if (valid(value)) assert.doesNotThrow(() => validatePolicy(policy));
    else assert.throws(() => validatePolicy(policy), /model_switch_policy_invalid/);
  }), {numRuns: RUNS, seed: 20261116});
  assert.throws(() => validatePolicy({version: 1, sessions: {s: {modelSwitch: {askAboveCents: 1}}}}), /model_switch_policy_invalid/);
});

test('the hook asks under the owner\'s policy, never in shadow, and answers {} to anything unreadable', t => {
  const dirs = directories(t);
  const write = policy => fs.writeFileSync(path.join(dirs.data, 'policy.json'), JSON.stringify(policy));
  write({version: 1, mode: 'enforce', modelSwitch: {askAboveCents: 100}});
  const asked = hook(dirs, pre());
  assert.equal(asked.output.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(asked.output.hookSpecificOutput.permissionDecisionReason, /\$1\.00 AgentGuard asks about/);
  assert.ok(asked.ms < 2000, `${asked.ms} ms`);
  write({version: 1, mode: 'shadow', modelSwitch: {askAboveCents: 100}});
  assert.deepEqual(Object.keys(hook(dirs, pre()).output), ['systemMessage']);
  write({version: 1, mode: 'enforce', modelSwitch: {askAboveCents: null}});
  assert.deepEqual(Object.keys(hook(dirs, pre({estimated_cache_write_usd: 900})).output), ['systemMessage']);
  // A policy file that cannot be read keeps the default: the line, no ask.
  fs.writeFileSync(path.join(dirs.data, 'policy.json'), '{broken');
  assert.deepEqual(Object.keys(hook(dirs, pre({estimated_cache_write_usd: 900})).output), ['systemMessage']);
  // No limit in the policy: the line only.
  write({version: 1, mode: 'enforce'});
  assert.deepEqual(Object.keys(hook(dirs, pre({estimated_cache_write_usd: 900})).output), ['systemMessage']);
  for (const input of ['', 'not json', '[]', 'null', JSON.stringify({hook_event_name: 'PreToolUse'})]) assert.deepEqual(hook(dirs, input).output, {});
  assert.equal(fs.existsSync(path.join(dirs.data, modelSwitch.PENDING)), false);
});

test('after a switch the hook appends one record and the worker signs it as one verified model_switch row', async t => {
  const dirs = inProcess(t);
  assert.equal(hook(dirs, post()).output.hookSpecificOutput, undefined);
  hook(dirs, post({from_model: 'claude-opus-5', to_model: 'claude-haiku-5-5', source: 'auto', requested_model: null, prompt_cache_warm: false}));
  assert.equal(fs.readFileSync(path.join(dirs.data, modelSwitch.PENDING), 'utf8').trim().split('\n').length, 2);
  const {Engine} = require('../runtime/engine.cjs');
  const {metadata} = require('../runtime/common.cjs');
  const {createReader} = require('../runtime/mcp.cjs');
  const engine = new Engine({licenseReader: () => ({paid: false, tier: 'free', mode: 'enforce', reason: null})});
  await engine.init();
  t.after(async () => { await engine.close(); });
  const read = {session_id: 'switch-session', tool_use_id: 'toolu_switch_1', cwd: dirs.base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {file_path: '/tmp/a'}, permission_mode: 'default'};
  assert.equal((await engine.handle({meta: metadata(read, 'spend')})).output.hookSpecificOutput?.permissionDecision ?? 'allow', 'allow');
  await engine.flush();
  assert.equal(fs.existsSync(path.join(dirs.data, modelSwitch.PENDING)), false);
  assert.equal(fs.existsSync(path.join(dirs.data, modelSwitch.PENDING + '.recovering')), false);
  const rows = fs.readFileSync(path.join(dirs.data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
  const switches = rows.filter(row => row.decision.plugin?.event === 'model_switch');
  assert.equal(switches.length, 2);
  assert.ok(rows.indexOf(switches[1]) < rows.findIndex(row => row.decision.plugin?.toolName === 'Read'));
  const [first, second] = switches.map(row => row.decision);
  assert.equal(first.action, 'allow');
  assert.equal(first.actor.sessionId, 'switch-session');
  assert.deepEqual(Object.fromEntries(Object.entries(first.plugin).filter(([key]) => key in modelSwitch.RECORDED_FIELDS && key !== 'switchedAt')), {
    toModel: 'claude-opus-5', fromModel: 'claude-sonnet-5', requestedModel: 'opus', switchSource: 'command', contextTokens: 182340,
    promptCacheWarm: true, cacheTtl: '5m', cacheWriteMicroUsd: 1139600, pricing: 'catalog'});
  assert.equal(second.plugin.switchSource, 'auto');
  assert.equal(second.plugin.requestedModel, null);
  assert.equal(second.plugin.promptCacheWarm, false);
  assert.equal((await sdk.verifyChain(rows, engine.publicKey)).ok, true);
  const reader = createReader({dataDir: dirs.data});
  assert.equal((await reader.call('verify_chain', {})).ok, true);
  const listed = await reader.call('list_decisions', {});
  assert.ok(JSON.stringify(listed).includes('model_switch'));
});

test('a switch signed after a session\'s receipt is followed by a fresh receipt, so Burn still counts the session', async t => {
  const dirs = inProcess(t);
  const {Engine} = require('../runtime/engine.cjs');
  const engine = new Engine({licenseReader: () => ({paid: false, tier: 'free', mode: 'enforce', reason: null})});
  await engine.init();
  t.after(async () => { await engine.close(); });
  const {metadata} = require('../runtime/common.cjs');
  const read = {session_id: 'switch-session', tool_use_id: 'toolu_switch_2', cwd: dirs.base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {file_path: '/tmp/a'}, permission_mode: 'default'};
  await engine.handle({meta: metadata(read, 'spend')});
  assert.equal((await engine.sessionReceipt({sessionId: 'switch-session'})).receipt, 'appended');
  assert.equal((await engine.sessionReceipt({sessionId: 'switch-session'})).receipt, 'duplicate');
  // The session is resumed: Claude Code restores its model, then it ends again.
  hook(dirs, post({source: 'resume', requested_model: 'claude-opus-5'}));
  // The switch row is followed at once by the receipt signed again; the ending then has nothing new.
  assert.equal((await engine.sessionReceipt({sessionId: 'switch-session'})).receipt, 'duplicate');
  await engine.flush();
  const rows = fs.readFileSync(path.join(dirs.data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
  const own = rows.filter(row => row.decision.plugin?.sessionId === 'switch-session');
  assert.deepEqual(own.slice(-2).map(row => row.decision.plugin.event), ['model_switch', 'session_receipt']);
  const tally = await burn.sessionTally('switch-session', {data: dirs.data});
  assert.notEqual(tally.status, 'missing', JSON.stringify(tally));
});

const FREE = () => ({paid: false, tier: 'free', mode: 'enforce', reason: null});
const readCall = (dirs, session, id) => ({session_id: session, tool_use_id: id, cwd: dirs.base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {file_path: '/tmp/a'}, permission_mode: 'default'});
const sessionEvents = (dirs, session) => ledger(dirs).filter(row => row.decision.plugin?.sessionId === session).map(row => row.decision.plugin.event);

test('review finding 1: a switch made before a session ended stays before its receipt when no worker was running', async t => {
  const dirs = inProcess(t);
  const {Engine} = require('../runtime/engine.cjs');
  const {metadata} = require('../runtime/common.cjs');
  let engine = new Engine({licenseReader: FREE});
  await engine.init();
  await engine.handle({meta: metadata(readCall(dirs, 'switch-session', 'toolu_f1'), 'spend')});
  await engine.close();
  // No worker: the switch and then the ending both wait in their files.
  hook(dirs, post());
  assert.equal(require('../runtime/work-receipt.cjs').spoolRequest(dirs.data, 'switch-session', Date.now()), true);
  engine = new Engine({licenseReader: FREE});
  await engine.init();
  t.after(() => engine.close());
  await engine.flush();
  assert.deepEqual(sessionEvents(dirs, 'switch-session').slice(-2), ['model_switch', 'session_receipt']);
  assert.notEqual((await burn.sessionTally('switch-session', {data: dirs.data})).status, 'missing');
});

test('review finding 1: a switch that reaches the worker after the receipt is followed by that receipt signed again', async t => {
  const dirs = inProcess(t);
  const {Engine} = require('../runtime/engine.cjs');
  const {metadata} = require('../runtime/common.cjs');
  const engine = new Engine({licenseReader: FREE});
  await engine.init();
  t.after(() => engine.close());
  await engine.handle({meta: metadata(readCall(dirs, 'switch-session', 'toolu_f1b'), 'spend')});
  assert.equal((await engine.sessionReceipt({sessionId: 'switch-session'})).receipt, 'appended');
  // The hook finished just after the session ended; another session's call drains it.
  hook(dirs, post());
  await engine.handle({meta: metadata(readCall(dirs, 'other-session', 'toolu_other'), 'spend')});
  await engine.flush();
  assert.deepEqual(sessionEvents(dirs, 'switch-session').slice(-3), ['session_receipt', 'model_switch', 'session_receipt']);
  const receipts = ledger(dirs).filter(row => row.decision.plugin?.event === 'session_receipt').map(row => row.decision);
  assert.deepEqual(receipts[1].plugin.receipt, receipts[0].plugin.receipt);
  assert.equal(receipts[1].plugin.previousReceiptId, receipts[0].decisionId);
  assert.notEqual((await burn.sessionTally('switch-session', {data: dirs.data})).status, 'missing');
  const {createReader} = require('../runtime/mcp.cjs');
  assert.equal((await createReader({dataDir: dirs.data}).call('verify_chain', {})).ok, true);
});

test('review finding 4: a damaged line in the pending file is skipped and never holds back the lines after it', async t => {
  const dirs = inProcess(t);
  const line = (session, at) => JSON.stringify({sessionId: session, fromModel: 'claude-sonnet-5', toModel: 'claude-opus-5', source: 'command', at});
  fs.writeFileSync(path.join(dirs.data, modelSwitch.PENDING), [line('before', Date.now()), line('damaged', 9e15), line('after', Date.now())].join('\n') + '\n');
  const {Engine} = require('../runtime/engine.cjs');
  const {metadata} = require('../runtime/common.cjs');
  const engine = new Engine({licenseReader: FREE});
  await engine.init();
  t.after(() => engine.close());
  for (let i = 0; i < 3; i++) await engine.handle({meta: metadata(readCall(dirs, 'other-session', `toolu_f4_${i}`), 'spend')});
  await engine.flush();
  const switches = ledger(dirs).filter(row => row.decision.plugin?.event === 'model_switch').map(row => row.decision.plugin.sessionId);
  assert.deepEqual(switches, ['before', 'after']);
  assert.equal(fs.existsSync(path.join(dirs.data, modelSwitch.PENDING + '.recovering')), false);
});

test('review finding 4, each guard alone: the reader refuses a time a Date cannot hold, and the worker skips a row it cannot build', async t => {
  const dirs = inProcess(t);
  const file = path.join(dirs.data, modelSwitch.PENDING);
  const line = (session, at) => JSON.stringify({sessionId: session, toModel: 'claude-opus-5', at});
  fs.writeFileSync(file, [line('ok', 1_800_000_000_000), line('too-late', 8.64e15 + 1), line('zero', 0), line('max', 8.64e15)].join('\n') + '\n');
  assert.deepEqual(modelSwitch.takePending(dirs.data).map(change => change.sessionId), ['ok', 'max']);
  modelSwitch.finishPending(dirs.data);
  // The worker's own guard, with the reader's bypassed: a change whose row throws is skipped.
  const {Engine} = require('../runtime/engine.cjs');
  const engine = new Engine({licenseReader: FREE});
  await engine.init();
  t.after(() => engine.close());
  const original = modelSwitch.takePending;
  modelSwitch.takePending = () => [{sessionId: 'first', toModel: 'claude-opus-5', at: Date.now()}, {sessionId: 'broken', toModel: 'claude-opus-5', at: 9e15},
    {sessionId: 'last', toModel: 'claude-opus-5', at: Date.now()}];
  try { await engine.drainModelSwitches(); } finally { modelSwitch.takePending = original; }
  await engine.flush();
  assert.deepEqual(ledger(dirs).filter(row => row.decision.plugin?.event === 'model_switch').map(row => row.decision.plugin.sessionId), ['first', 'last']);
});

test('review finding 5: a switch marks the model it leaves as seen, so switching back is never a first session', t => {
  const dirs = directories(t);
  // The first thing AgentGuard ever sees here is a switch: the model left is the baseline.
  assert.match(hook(dirs, post({from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5'})).output.systemMessage, /first session on claude-opus-5-5/);
  assert.deepEqual(hook(dirs, post({from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5'})).output, {});
  assert.deepEqual(hook(dirs, post({from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5'})).output, {});
});

test('the first session on a model shows one line once; the first model AgentGuard ever sees shows none', t => {
  const dirs = directories(t);
  const options = {home: dirs.home};
  assert.equal(modelSwitch.firstSeen('claude-fable-5-2', options), null);
  assert.equal(modelSwitch.firstSeen('claude-fable-5-2', options), null);
  const line = modelSwitch.firstSeen('claude-opus-5-5', options);
  assert.equal(line, modelSwitch.FIRST_SEEN('claude-opus-5-5'));
  assert.match(line, /\/doctor prompt-audit/);
  // The Burn this plugin ships (0.7.2) has the per-model view, so the line names it.
  assert.match(line, /! npx agentguard-burn@latest models$/);
  assert.doesNotMatch(line, /agentguard-burn compare/);
  // The same model under its context window suffix or another case is not new.
  assert.equal(modelSwitch.firstSeen('claude-opus-5-5[1m]', options), null);
  assert.equal(modelSwitch.firstSeen('Claude-Opus-5-5', options), null);
  for (const bad of [undefined, null, 42, '', 'two words', 'x'.repeat(201), {id: 'claude-opus-5'}]) assert.equal(modelSwitch.firstSeen(bad, options), null);
  require('../runtime/upgrade-moments.cjs').dismiss(dirs.home);
  assert.equal(modelSwitch.firstSeen('claude-haiku-5-5', options), null);
});

test('session start shows the first-session line in each host\'s words, and the switch hook shows it after a switch', t => {
  const dirs = directories(t);
  const start = model => hook(dirs, {session_id: 'start-session', hook_event_name: 'SessionStart', source: 'startup', model}, {script: 'session-start.cjs'}).output.systemMessage ?? '';
  assert.doesNotMatch(start('claude-fable-5-2'), /first session on/);
  const first = start('claude-opus-5-5');
  assert.match(first, /AgentGuard: first session on claude-opus-5-5 on this machine/);
  // The hook's own line names the per-model view of the Burn this plugin ships.
  assert.match(first, /first session on claude-opus-5-5 on this machine\..*! npx agentguard-burn@latest models/);
  assert.doesNotMatch(first, /agentguard-burn compare/);
  assert.doesNotMatch(start('claude-opus-5-5'), /first session on/);
  assert.match(hook(dirs, post({to_model: 'claude-sonnet-5-5'})).output.systemMessage, /first session on claude-sonnet-5-5/);
  // Codex: its own words, without Claude Code's command.
  const codex = hook(dirs, {session_id: 'codex-session', hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-6'}, {script: 'session-start.cjs', host: 'codex'});
  assert.match(codex.output.systemMessage, /AgentGuard: first session on gpt-6 on this machine\. .*AGENTS\.md/);
  assert.doesNotMatch(codex.output.systemMessage, /\/doctor/);
});

test('the next step names Burn\'s per-model view when the installed Burn has it, else compare', () => {
  assert.match(modelSwitch.burnFollowUp({modelsReport() {}}), /! npx agentguard-burn@latest models$/);
  assert.match(modelSwitch.burnFollowUp({}), /! npx agentguard-burn compare$/);
  assert.match(modelSwitch.FIRST_SEEN('claude-opus-5-5', {burn: {modelsReport() {}}}), /\/doctor prompt-audit.*agentguard-burn@latest models$/);
  // The Burn this plugin ships decides. Burn 0.7.2 has the per-model view, so the line names it.
  assert.equal(typeof require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/burn').modelsReport, 'function');
  assert.match(modelSwitch.burnFollowUp(), /! npx agentguard-burn@latest models$/);
});

// npx reuses a copy it cached under the bare name, and a copy cached before Burn 0.7.2 has no models command: it
// prints Burn's help and exits 64. The line therefore asks npx for the latest wrapper by name.
test('the per-model line never names the bare agentguard-burn, whose cached copy can be an older Burn', () => {
  const lines = [modelSwitch.burnFollowUp(), modelSwitch.burnFollowUp({modelsReport() {}}),
    ...['claude-code', 'codex'].flatMap(host => [modelSwitch.FIRST_SEEN('claude-opus-5-5', {host}), modelSwitch.FIRST_SEEN('gpt-6', {host, burn: {modelsReport() {}}})])];
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.match(line, /! npx agentguard-burn@latest models$/);
    assert.doesNotMatch(line, /agentguard-burn(?!@latest) models/);
    assert.equal(line.match(/agentguard-burn/g).length, 1);
  }
});

test('Codex hook calls carry the main thread\'s model to the worker and never into a row', t => {
  const dirs = directories(t);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {PLUGIN_ROOT: root, PLUGIN_DATA: dirs.data, HOME: dirs.base, AGENTGUARD_HOME: dirs.home, AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key]; Object.assign(process.env, ORIGINAL_ENV); });
  const {metadata} = require('../runtime/common.cjs');
  const raw = {session_id: 'codex-1', tool_use_id: 'call_1', cwd: dirs.base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {file_path: '/tmp/a'}, model: 'gpt-6'};
  assert.equal(metadata(raw, 'spend').observedModel, 'gpt-6');
  assert.equal(metadata({...raw, agent_id: 'sub-1'}, 'spend').observedModel, undefined);
  assert.equal(metadata({...raw, model: 'two words'}, 'spend').observedModel, undefined);
  process.env.CLAUDE_PLUGIN_ROOT = root; process.env.CLAUDE_PLUGIN_DATA = dirs.data; delete process.env.PLUGIN_ROOT; delete process.env.PLUGIN_DATA;
  assert.equal(metadata(raw, 'spend').observedModel, undefined);
});

async function codexEngine(t, dirs) {
  const {Engine} = require('../runtime/engine.cjs');
  const engine = new Engine({licenseReader: () => ({paid: false, tier: 'free', mode: 'enforce', reason: null})});
  await engine.init();
  // A test may close it itself to restart the worker; close once.
  const close = engine.close.bind(engine);
  let closing;
  engine.close = () => (closing ??= close());
  t.after(() => engine.close());
  return engine;
}
function codexDirs(t) {
  const dirs = directories(t);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {PLUGIN_ROOT: root, PLUGIN_DATA: dirs.data, HOME: dirs.base, AGENTGUARD_HOME: dirs.home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  fs.writeFileSync(path.join(dirs.data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce'}));
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key]; Object.assign(process.env, ORIGINAL_ENV); });
  return dirs;
}
const ledger = dirs => fs.readFileSync(path.join(dirs.data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(text => JSON.parse(text));

test('Codex: a changed model between hook calls is one signed observed switch, and survives a worker restart', async t => {
  const dirs = codexDirs(t);
  const {metadata} = require('../runtime/common.cjs');
  let engine = await codexEngine(t, dirs), n = 0;
  const call = (model, session = 'codex-1') => engine.handle({meta: metadata({session_id: session, tool_use_id: `call_${n++}`, cwd: dirs.base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {file_path: '/tmp/a'}, model}, 'spend')});
  await call('gpt-6'); await call('gpt-6'); await call('gpt-6-mini'); await call('gpt-6-mini', 'codex-2');
  await engine.close();
  engine = await codexEngine(t, dirs);
  await call('gpt-6');
  await engine.flush();
  const rows = ledger(dirs);
  const switches = rows.filter(row => row.decision.plugin?.event === 'model_switch').map(row => row.decision.plugin);
  assert.deepEqual(switches.map(p => [p.sessionId, p.fromModel, p.toModel, p.switchSource]), [['codex-1', 'gpt-6', 'gpt-6-mini', 'observed'], ['codex-1', 'gpt-6-mini', 'gpt-6', 'observed']]);
  for (const p of switches) for (const key of ['contextTokens', 'promptCacheWarm', 'cacheTtl', 'cacheWriteMicroUsd', 'pricing', 'requestedModel']) assert.equal(p[key], undefined, key);
  assert.ok(rows.every(row => !JSON.stringify(row).includes('observedModel')));
  const {createReader} = require('../runtime/mcp.cjs');
  assert.equal((await createReader({dataDir: dirs.data}).call('verify_chain', {})).ok, true);
});

test(`property: Codex observed switches are exactly the model changes per session (${RUNS / 10} sequences)`, async t => {
  const dirs = codexDirs(t);
  const engine = await codexEngine(t, dirs);
  const sequences = fc.sample(fc.array(fc.tuple(fc.constantFrom('s1', 's2', 's3'), fc.constantFrom('gpt-6', 'gpt-6-mini', 'o9', 'two words', '')), {maxLength: 12}), {numRuns: RUNS / 10, seed: 20261117});
  let round = 0, total = 0;
  for (const sequence of sequences) {
    round++;
    const expected = [], last = new Map();
    for (const [session, model] of sequence) {
      const id = `r${round}-${session}`;
      const row = await engine.observeModel(id, model);
      if (!modelSwitch.modelId(model)) { assert.equal(row, null); continue; }
      const before = last.get(id);
      last.set(id, model);
      if (before !== undefined && before !== model) expected.push([id, before, model]);
      assert.equal(row !== null, before !== undefined && before !== model);
    }
    total += expected.length;
  }
  await engine.flush();
  const switches = ledger(dirs).filter(row => row.decision.plugin?.event === 'model_switch');
  assert.equal(switches.length, total);
  const reread = modelSwitch.readSessionModels(dirs.data);
  assert.ok(reread.size <= modelSwitch.SESSION_MODELS_LIMIT);
});

test('the Codex session model file stays bounded and ignores bad entries', t => {
  const dirs = directories(t);
  const models = new Map(Array.from({length: modelSwitch.SESSION_MODELS_LIMIT + 50}, (_, i) => [`s${i}`, {model: 'gpt-6', at: i + 1}]));
  modelSwitch.writeSessionModels(dirs.data, models);
  const back = modelSwitch.readSessionModels(dirs.data);
  assert.equal(back.size, modelSwitch.SESSION_MODELS_LIMIT);
  assert.equal(back.has('s0'), false);
  assert.equal(back.get(`s${modelSwitch.SESSION_MODELS_LIMIT + 49}`).model, 'gpt-6');
  fs.writeFileSync(path.join(dirs.data, modelSwitch.SESSION_MODELS), JSON.stringify({version: 1, sessions: [['ok', 'gpt-6', 1], ['bad id with space', 'gpt-6', 2], ['x', 'two words', 3], ['y', 'gpt-6', 'soon'], 'junk']}));
  assert.deepEqual([...modelSwitch.readSessionModels(dirs.data).keys()], ['ok']);
  fs.writeFileSync(path.join(dirs.data, modelSwitch.SESSION_MODELS), '{broken');
  assert.equal(modelSwitch.readSessionModels(dirs.data).size, 0);
});

test('Claude Code registers both switch events; the Codex hooks leave them out', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8')).hooks;
  for (const event of ['PreModelSwitch', 'PostModelSwitch']) {
    assert.equal(claude[event].length, 1);
    assert.equal(claude[event][0].matcher, undefined);
    // A PreModelSwitch hook that times out blocks the switch: ten seconds for a slow start.
    assert.deepEqual(claude[event][0].hooks, [{type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/model-switch.cjs"', timeout: event === 'PreModelSwitch' ? 10 : 2}]);
  }
  const codex = JSON.parse(fs.readFileSync(path.join(root, 'hooks/codex-hooks.json'), 'utf8')).hooks;
  assert.equal(codex.PreModelSwitch, undefined);
  assert.equal(codex.PostModelSwitch, undefined);
});
