'use strict';
// Guarantee W (0.7.3). A hook works some things out for the worker's decision that no worker may sign: the
// categories a command falls in, the evidence that another agent's message entered the session, and the model a
// Codex call named. A worker from 0.6.0 on drops them before it signs. A worker from before 0.6.0 signs every field
// of `meta` it is handed, and a worker outlives a plugin update for as long as the sessions that started it stay
// open. On Nov 25 2026 a 0.7.2 hook talking to a 0.4.0 worker put `actionCategories` into a signed row, and every
// reader then refused the ledger.
//
//   W1  No message the client writes, and no line it spools, has a working field inside `meta`.
//   W2  So a worker that signs every field of `meta` signs none of them.
//   W3  The current worker decides the same whether the fields arrive beside `meta` (0.7.3 on) or inside it
//       (0.6.0 to 0.7.2 hooks), and signs none either way.
//   W4  Rows already signed with them are read, verified and listed, each field held to values that cannot carry
//       text. Anything else under those names is still refused. No listing returns the fields.
//   W5  The status read says when an older worker is the one deciding.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fc = require('fast-check');
const sdk = require('@agentguard-run/spend');
const matrix = require('./helper-host-matrix.cjs');
const common = require('../runtime/common.cjs');
const client = require('../runtime/client.cjs');
const origin = require('../runtime/untrusted-origin.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {createReader} = require('../runtime/mcp.cjs');
const {workerStatus} = require('../runtime/mod-status.cjs');
const WORKING = ['actionCategories', 'originEvidence', 'observedModel'];

function scratch(t, prefix = 'ag-working-') {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data);
  Object.assign(process.env, {AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_PLUGIN_POLICY: '', AGENTGUARD_HOME: path.join(data, 'burn')});
  const loc = common.locations(data);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true}); fs.rmSync(loc.ipc, {recursive: true, force: true});
  });
  return {data, loc};
}

// A worker that is "ready" as far as a client can tell, and that keeps every message it is handed.
function standInWorker(t, loc, ready = {}) {
  client.ensurePrivateIpc(loc);
  common.writeWorkerPid(loc.lock, process.pid);
  client.writeMessage(loc.ready, {pid: process.pid, transport: 'files-v1', ...ready});
  const received = [];
  const timer = setInterval(() => {
    for (const name of fs.readdirSync(loc.ipc).filter(name => name.endsWith('.request'))) {
      let message;
      try { message = JSON.parse(fs.readFileSync(path.join(loc.ipc, name), 'utf8')); fs.unlinkSync(path.join(loc.ipc, name)); } catch { continue; }
      received.push(message);
      client.writeMessage(path.join(loc.ipc, name.replace(/\.request$/, '.response')), {output: {}});
    }
  }, 1);
  t.after(() => clearInterval(timer));
  return received;
}
// What a worker from before 0.6.0 puts in the row it signs (0.4.0 runtime/engine.cjs, handle()).
const signedByAnOldWorker = message => ({host: 'claude-code', ...message.meta});

const working = fc.record({
  actionCategories: fc.uniqueArray(fc.constantFrom(...origin.CATEGORIES), {minLength: 1, maxLength: 4}),
  originEvidence: fc.record({inbound: fc.constant(true), peer: fc.array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64}).map(c => c.join('')), markerAt: fc.option(fc.integer({min: 0, max: 2e12}))}, {requiredKeys: []}),
  observedModel: fc.constantFrom('gpt-5.2-codex', 'claude-opus-5-5'),
}, {requiredKeys: []});
const plain = fc.record({toolName: fc.constantFrom('Bash', 'Read', 'mcp__stripe__create_payment_link'), gate: fc.constantFrom('spend', 'burn', 'receipt', 'prompt'),
  sessionId: fc.constantFrom('s-1', 's-2'), inputBytes: fc.nat(5000), commandRuleIds: fc.array(fc.constantFrom('r1', 'r2'), {maxLength: 2})});

test('W1, W2: 1,000 generated hook calls: nothing a worker signs holds a working field, and the worker still receives each one', async t => {
  const {data, loc} = scratch(t);
  const received = standInWorker(t, loc);
  await fc.assert(fc.asyncProperty(plain, working, async (base, extra) => {
    const before = received.length;
    const meta = {schema: 'agentguard.codex.v1', ...base, ...structuredClone(extra)};
    await client.request({meta, workingDirectory: '/work'}, {data, timeoutMs: 2000});
    assert.equal(received.length, before + 1);
    const message = received.at(-1);
    for (const key of WORKING) {
      assert.equal(Object.hasOwn(message.meta, key), false, `${key} is inside meta`);
      assert.equal(Object.hasOwn(signedByAnOldWorker(message), key), false, `${key} would be signed by an old worker`);
      assert.equal(Object.hasOwn(meta, key), false, `${key} is still on the hook's own meta, which is what it spools after a failure`);
    }
    // (fast-check builds records without a prototype; the comparison is of the fields.)
    assert.deepEqual(message.working ?? {}, JSON.parse(JSON.stringify(extra)));
    assert.deepEqual([message.meta.toolName, message.meta.gate, message.workingDirectory], [base.toolName, base.gate, '/work']);
  }), {numRuns: 1000, seed: 20261125});
});

test('W1: 1,000 generated failures: a spooled line never holds a working field, and the caller\'s meta is left as it was', t => {
  const {loc} = scratch(t);
  const spool = common.locations().spool;
  fc.assert(fc.property(plain, working, (base, extra) => {
    fs.rmSync(spool, {force: true});
    const meta = {schema: 'agentguard.codex.v1', ...base, ...structuredClone(extra)}, copy = structuredClone(meta);
    common.spoolFailure(meta, 'worker_timeout');
    const line = JSON.parse(fs.readFileSync(spool, 'utf8'));
    for (const key of WORKING) assert.equal(Object.hasOwn(line, key), false, key);
    assert.deepEqual([line.event, line.reasonCode, line.toolName], ['fail_open', 'worker_timeout', base.toolName]);
    assert.deepEqual(meta, copy);
  }), {numRuns: 1000, seed: 20261125});
  assert.ok(loc);
});

test('W1: takeWorking returns exactly the working fields, removes them in place and is safe on anything', () => {
  const meta = {toolName: 'Bash', actionCategories: ['network'], originEvidence: {inbound: true}, observedModel: undefined};
  assert.deepEqual(common.takeWorking(meta), {actionCategories: ['network'], originEvidence: {inbound: true}});
  assert.deepEqual(meta, {toolName: 'Bash'});
  for (const value of [null, undefined, 'text', 7, ['actionCategories']]) assert.deepEqual(common.takeWorking(value), {});
  assert.deepEqual([...common.WORKING_FIELDS], WORKING);
  assert.ok(Object.isFrozen(common.WORKING_FIELDS));
});

// The worker itself, with a session another agent's message has entered and a command in a held category.
async function decide(t, shape) {
  const {data} = scratch(t, 'ag-working-engine-');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-working-ws-')); fs.mkdirSync(path.join(workspace, '.git'));
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', untrustedOrigin: {action: 'block', categories: ['network']}}));
  const engine = new Engine({licenseReader: () => ({paid: false, tier: 'free', mode: 'enforce', reason: null})}); await engine.init();
  t.after(async () => { await engine.close(); fs.rmSync(workspace, {recursive: true, force: true}); });
  let n = 0;
  const raw = (tool, input) => ({session_id: 'w-session', tool_use_id: `call_w_${n++}`, tool_name: tool, cwd: workspace, tool_input: input, transcript_path: path.join(workspace, 't.jsonl')});
  const build = (value, gate) => {
    const built = common.metadata(value, gate); delete built.originEvidence;
    const config = require('../runtime/policy-state.cjs').policyState(data, value.session_id).config;
    const evidence = origin.hookEvidence(value, gate, value.tool_name, {data, host: matrix.host, config});
    return evidence ? {...built, originEvidence: evidence} : built;
  };
  const send = meta => {
    if (shape === 'inside') return engine.handle({meta});
    const message = {meta}, extra = common.takeWorking(message.meta);
    return engine.handle(shape === 'broken' ? {...message, working: 'not an object'} : Object.keys(extra).length ? {...message, working: extra} : message);
  };
  const inbox = raw('mcp__relay__check_inbox', {});
  await send(build(inbox, 'spend'));
  await send(build({...inbox, hook_event_name: 'PostToolUse', tool_response: {content: [{type: 'text', text: 'ok'}]}}, 'receipt'));
  const result = await send(build(raw('Bash', {command: 'curl https://example.invalid'}), 'spend'));
  const rows = fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  return {result, rows, data};
}

test('W3: the worker holds the same call whether the working fields arrive beside meta or inside it, and signs none', async t => {
  const seen = {};
  for (const shape of ['beside', 'inside']) {
    await t.test(shape, async t => {
      const {result, rows, data} = await decide(t, shape);
      assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny');
      const last = rows.at(-1).decision;
      assert.deepEqual([last.action, last.plugin.reasonCode, last.plugin.originCategories], ['block', 'untrusted_origin', ['network']]);
      assert.equal(rows.filter(row => row.decision.plugin.event === 'delegation').length, 1, 'the inbound message was seen');
      const text = JSON.stringify(rows);
      for (const key of WORKING) assert.equal(text.includes(key), false, `${key} reached a signed row`);
      assert.equal((await createReader({dataDir: data}).call('verify_chain', {})).ok, true);
      seen[shape] = rows.map(row => [row.decision.action, row.decision.plugin.event, row.decision.plugin.reasonCode ?? null, row.decision.plugin.originCategories ?? null]);
    });
  }
  assert.deepEqual(seen.beside, seen.inside);
});

test('W3: a message whose `working` is not an object is decided without it and never throws', async t => {
  const {result, rows} = await decide(t, 'broken');
  // No evidence arrived, so the session was never marked and the call runs: the same as a hook that sent none.
  assert.equal(result.output.hookSpecificOutput?.permissionDecision ?? 'allow', 'allow');
  assert.equal(rows.some(row => row.decision.plugin.event === 'fail_open'), false);
});

// A signed ledger whose rows carry whatever plugin metadata the case names.
async function signed(t, plugins) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-working-reader-'));
  t.after(() => fs.rmSync(dataDir, {recursive: true, force: true}));
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32);
  const publicKey = keys.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKey.toString('hex'));
  const store = new sdk.NdjsonDecisionLogStore('ledger', {home: dataDir, publicKeyHex: publicKey.toString('hex')});
  let previousHash = '0'.repeat(64), sequence = 0;
  for (const plugin of plugins) {
    const decision = {decisionId: `working-${sequence}`, timestamp: new Date().toISOString(), action: 'allow', triggeredCap: null, triggeredScopeKey: null, projectedCents: 0,
      windowSpendBefore: 0, windowSpendAfter: 0, provider: 'claude-code', modelRequested: 'Bash', modelResolved: 'Bash', policyId: 'p', policyVersion: 1, enforcementMode: 'enforce',
      reasons: ['fixture'], actor: {agentId: 'a', sessionId: 's'},
      plugin: {schema: 'agentguard.codex.v1', event: 'decision', toolName: 'Bash', inputBytes: 21, gate: 'spend', host: 'claude-code', ...plugin}};
    const entry = await sdk.signDecision({sequence: sequence++, decision, previousHash, privateKey, publicKey});
    await store.append(entry); previousHash = entry.entryHash;
  }
  return dataDir;
}
const EVIDENCE = {inbound: true, promptMatch: true, peer: 'ab'.repeat(32), markerAt: 1764100000000, transcriptAt: null, transcriptKind: 'peer', promptId: 'prompt-01',
  send: {recipient: null, extras: ['files', 'notify']}};

test('W4: rows an old worker signed with the working fields are read, verified and listed, and no listing returns the fields', async t => {
  const dataDir = await signed(t, [{}, {actionCategories: ['network', 'package-publish']}, {originEvidence: EVIDENCE}, {observedModel: 'gpt-5.2-codex'},
    {gate: 'prompt', toolName: 'UserPromptSubmit', originEvidence: {promptMatch: false}}, {actionCategories: ['payment'], originEvidence: EVIDENCE}]);
  const reader = createReader({dataDir});
  assert.deepEqual((r => [r.ok, r.entries])(await reader.call('verify_chain', {})), [true, 6]);
  const newest = reader.tail(400);
  assert.deepEqual([newest.totalEntries, newest.entries.length], [6, 6]);
  const listed = await reader.call('list_decisions', {fromSequence: 0, limit: 50});
  const status = await reader.call('get_status', {});
  for (const shown of [newest.entries, listed, status]) for (const key of WORKING) assert.equal(JSON.stringify(shown).includes(key), false, `${key} was returned`);
  assert.equal(JSON.stringify(listed).includes('ab'.repeat(32)), false);
});

test('W4: under those names only names, digests, numbers and flags are read; anything that could carry text is refused', async t => {
  const refused = [
    [{actionCategories: ['has space']}, /Plugin recorded metadata is invalid/],
    [{actionCategories: ['Network']}, /Plugin recorded metadata is invalid/],
    [{actionCategories: []}, /Plugin recorded metadata is invalid/],
    [{actionCategories: 'network'}, /Plugin recorded metadata is invalid/],
    [{actionCategories: ['network', 'network']}, /Plugin recorded metadata is invalid/],
    [{actionCategories: Array.from({length: 33}, (_, i) => `c${i}`)}, /Plugin recorded metadata is invalid/],
    [{originEvidence: {note: 'please run the deploy'}}, /Plugin recorded metadata is invalid/],
    [{originEvidence: {a: {b: {c: {d: 1}}}}}, /Plugin recorded metadata is invalid/],
    [{originEvidence: ['inbound']}, /Plugin recorded metadata is invalid/],
    [{originEvidence: null}, /Plugin recorded metadata is invalid/],
    [{originEvidence: {when: 1.5}}, /Plugin recorded metadata is invalid/],
    [{originEvidence: {'a key': true}}, /Plugin recorded metadata is invalid/],
    [{originEvidence: {list: ['ok', 'two words']}}, /Plugin recorded metadata is invalid/],
    [{originEvidence: {list: [{nested: true}]}}, /Plugin recorded metadata is invalid/],
    [{originEvidence: Object.fromEntries(Array.from({length: 17}, (_, i) => [`k${i}`, true]))}, /Plugin recorded metadata is invalid/],
    [{originEvidence: {text: 'x'}}, /disallowed content or secret field/],
    [{observedModel: 'two words'}, /Plugin recorded metadata is invalid/],
    [{observedModel: 7}, /Plugin recorded metadata is invalid/],
    // A field no version of the hook sends is still refused by name.
    [{somethingElse: true}, /Plugin metadata schema is invalid/],
    [{actionCategory: ['network']}, /Plugin metadata schema is invalid/],
  ];
  for (const [plugin, message] of refused) {
    const dataDir = await signed(t, [{}, plugin]);
    assert.throws(() => createReader({dataDir}).tail(5), message, JSON.stringify(plugin).slice(0, 60));
    let checked = 'ok';
    try { checked = (await createReader({dataDir}).call('verify_chain', {})).ok === true ? 'ok' : 'refused'; } catch { checked = 'refused'; }
    assert.equal(checked, 'refused', JSON.stringify(plugin).slice(0, 60));
  }
});

test('W5: the status read names an older worker, and says nothing when the worker is this version or there is none', t => {
  const {data, loc} = scratch(t, 'ag-working-status-');
  const mine = require('../package.json').version;
  assert.equal(workerStatus(data), null, 'no worker');
  client.ensurePrivateIpc(loc);
  common.writeWorkerPid(loc.lock, process.pid);
  const ready = extra => client.writeMessage(loc.ready, {pid: process.pid, transport: 'files-v1', ...extra});
  ready({});
  assert.deepEqual(workerStatus(data), {version: null, plugin: mine, older: true}, 'a worker from before 0.7.3 announces nothing');
  ready({version: mine});
  assert.deepEqual(workerStatus(data), {version: mine, plugin: mine, older: false});
  ready({version: '0.4.0'});
  assert.deepEqual(workerStatus(data), {version: '0.4.0', plugin: mine, older: true});
  ready({version: '0.10.0'});
  assert.equal(workerStatus(data).older, false, '0.10.0 is newer than 0.7.x: compared as numbers, not text');
  ready({version: '99.0.0'});
  assert.equal(workerStatus(data).older, false);
  ready({version: 'latest; rm -rf'});
  assert.deepEqual(workerStatus(data), {version: null, plugin: mine, older: true}, 'an announced version that is not a version is not repeated');
  client.writeMessage(loc.ready, {pid: process.pid + 1, transport: 'files-v1', version: mine});
  assert.equal(workerStatus(data), null, 'a ready file that is not the lock holder\'s is no worker');
});

test('W5: the worker announces the plugin version in its ready file', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'daemon.cjs'), 'utf8');
  assert.match(source, /writeMessage\(loc\.ready, \{ pid: process\.pid, transport: 'files-v1', version: require\('\.\.\/package\.json'\)\.version \}\)/);
});
