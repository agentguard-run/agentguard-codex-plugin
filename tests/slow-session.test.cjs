'use strict';
// Guarantee Q (0.7.5). A call is answered in time however large its session has grown.
//
// Reading a session for Burn (its tokens, its sub-agents, Burn's pace notes) costs time in proportion to the
// session, and until 0.7.5 every call waited for it. A hook waits a quarter of a second for the worker. Found on a
// real machine on Nov 26 2026: in a session with 363 sub-agents and 33 billion tokens about 4 in 10 gate calls were
// allowed unchecked on a worker timeout, the spend gate's among them, because both gates queue behind the read.
//
//   Q1  An ordinary call in a session that is slow to read is answered without reading the session.
//   Q2  Nothing is lost: once the reads have run, the tokens counted are exactly the tokens in the transcripts,
//       whatever the order of calls, launches, growth, worker restarts and failed reads.
//   Q3  A launch is decided on counts read before its answer, also in a slow session.
//   Q4  After a read that took D, the same session is not read again for 25 x D (at least 1 s, at most 15 s),
//       and one session is read per turn, so waiting calls are answered between reads.
//   Q5  A read that fails is said at the session's next call, as a failed read always was, and only once.
//   Q6  A session that is quick to read is read before every answer, as before 0.7.5.
//   Q7  A launch's hooks wait as long as a cold start may take; an ordinary call's wait is unchanged.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
require('./helper-test-env.cjs');
const burn = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/burn');
const common = require('../runtime/common.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = common;
const root = path.resolve(__dirname, '..');
const readsSubagents = common.readsSubagents(burn);
const iso = at => new Date(at).toISOString();
let seq = 0;
const usageLine = (tokens, at = Date.now()) => JSON.stringify({type: 'assistant', uuid: `q-uuid-${++seq}`, timestamp: iso(at), message: {id: `q-msg-${seq}`, model: 'claude-opus-5-5', role: 'assistant',
  content: [], usage: {input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, cache_creation: {ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0}}}}) + '\n';
const ALWAYS_SLOW = {slowReadMs: -1, slowSessionBytes: -1};
const permission = output => output?.hookSpecificOutput?.permissionDecision ?? 'allow';
const POLICY_FILE = ['burn', 'policy.json'].join('-');

function home(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-slow-session-'));
  const names = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  for (const key of names) delete process.env[key];
  const burnHome = path.join(data, 'burn');
  Object.assign(process.env, {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: path.join(data, 'claude'), AGENTGUARD_HOME: burnHome, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce'}));
  fs.mkdirSync(burnHome, {recursive: true});
  fs.writeFileSync(path.join(burnHome, POLICY_FILE), JSON.stringify({...burn.DEFAULT_POLICY, mode: 'enforce'}));
  const engines = [];
  t.after(() => {
    for (const engine of engines) { clearTimeout(engine.readTimer); if (engine.logStore && engine.logStore.fd !== undefined && !engine.logStore.closed) { engine.logStore.closed = true; try { fs.closeSync(engine.logStore.fd); } catch {} } }
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true});
  });
  const start = async (readLimits = ALWAYS_SLOW) => { const engine = new Engine({readLimits}); await engine.init(); engines.push(engine); return engine; };
  let sessions = 0;
  // One session: its transcript, its sub-agent folder, and what has been written to them.
  const session = () => {
    const id = `q-session-${++sessions}`, transcript = path.join(data, `${id}.jsonl`), subagents = path.join(data, id, 'subagents');
    fs.writeFileSync(transcript, ''); fs.mkdirSync(subagents, {recursive: true});
    const s = {id, transcript, written: 0, calls: 0};
    s.grow = (tokens, child = null) => { fs.appendFileSync(child === null || !readsSubagents ? transcript : path.join(subagents, `agent-c${child}.jsonl`), usageLine(tokens)); s.written += tokens; };
    s.meta = (tool = 'Bash') => metadata({session_id: id, tool_use_id: `${id}-call-${s.calls++}`, tool_name: tool, cwd: data, tool_input: tool === 'Bash' ? {command: 'ls'} : {description: 'x', prompt: 'p'}, hook_event_name: 'PreToolUse', transcript_path: transcript}, 'burn');
    s.call = (engine, tool) => engine.handle({meta: s.meta(tool), transcriptPath: transcript, workingDirectory: data});
    s.counted = engine => engine.gateway?.peek(id)?.state?.totalTokens ?? 0;
    return s;
  };
  return {data, burnHome, start, session};
}

test('Q1, Q2: an ordinary call in a slow session is answered without reading it, and the count is exact once the read has run', async t => {
  const h = home(t), engine = await h.start(), s = h.session();
  s.grow(1000); s.grow(500, 0); s.grow(250, 1);
  // Every read of a session goes through invokeBurn; it is counted here.
  const real = engine.invokeBurn.bind(engine);
  let reads = 0;
  engine.invokeBurn = (...args) => { reads++; return real(...args); };
  for (let i = 0; i < 5; i++) {
    const answer = await s.call(engine);
    assert.equal(answer.warning, undefined);
    assert.equal(permission(answer.output), 'allow');
  }
  assert.equal(reads, 0, 'the session was read before an answer');
  assert.equal(s.counted(engine), 0);
  assert.equal(engine.sessionReads.get(s.id).pending !== null, true);
  assert.equal(engine.settleReads(), 1, 'five calls leave one read to do, not five');
  assert.equal(reads, 1);
  assert.equal(s.counted(engine), s.written);
  assert.equal(engine.sessionReads.get(s.id).pending, null);
  // With nothing new asked for, nothing more is read.
  assert.equal(engine.settleReads(), 0);
});

test('Q2: 300 generated sessions of calls, launches, growth and reads: the count always ends exact, and never runs ahead', async t => {
  const h = home(t), engine = await h.start();
  const step = fc.oneof(
    fc.record({kind: fc.constant('grow'), tokens: fc.integer({min: 1, max: 5000}), child: fc.option(fc.integer({min: 0, max: 3}), {nil: null})}),
    fc.record({kind: fc.constant('call')}), fc.record({kind: fc.constant('call')}),
    fc.record({kind: fc.constant('launch')}), fc.record({kind: fc.constant('read')}));
  await fc.assert(fc.asyncProperty(fc.array(step, {minLength: 1, maxLength: 14}), async steps => {
    const s = h.session();
    for (const one of steps) {
      if (one.kind === 'grow') s.grow(one.tokens, one.child);
      else if (one.kind === 'call') { const answer = await s.call(engine); assert.equal(answer.warning, undefined); }
      else if (one.kind === 'launch') { const answer = await s.call(engine, 'Agent'); assert.equal(answer.warning, undefined); assert.equal(s.counted(engine), s.written, 'a launch was decided on a stale count'); }
      else engine.settleReads();
      assert.ok(s.counted(engine) <= s.written, 'more tokens counted than were written');
    }
    // A last call asks for a read; once it has run the count is exact.
    await s.call(engine); engine.settleReads();
    assert.equal(s.counted(engine), s.written);
  }), {numRuns: 300});
});

test('Q2: 1,000 generated runs of the reader itself with worker restarts, stops and failed stores: nothing is counted twice or lost', t => {
  const h = home(t);
  const step = fc.oneof(
    fc.record({kind: fc.constant('grow'), tokens: fc.integer({min: 1, max: 5000}), child: fc.option(fc.integer({min: 0, max: 3}), {nil: null})}),
    fc.record({kind: fc.constant('grow'), tokens: fc.integer({min: 1, max: 5000}), child: fc.option(fc.integer({min: 0, max: 3}), {nil: null})}),
    fc.record({kind: fc.constant('read')}), fc.record({kind: fc.constant('read')}),
    fc.record({kind: fc.constant('crash')}),      // a worker that dies: a new one starts from the cursor last written
    fc.record({kind: fc.constant('stop')}),       // a worker that stops: it writes its cursors first
    fc.record({kind: fc.constant('fail')}));      // the gateway refuses to store once
  fc.assert(fc.property(fc.array(step, {minLength: 1, maxLength: 16}), steps => {
    const s = h.session();
    let gateway = new burn.Gateway(h.burnHome, {sign: false});
    const read = () => common.claudeUsage(burn, gateway, {sessionId: s.id}, s.transcript);
    for (const one of steps) {
      if (one.kind === 'grow') s.grow(one.tokens, one.child);
      else if (one.kind === 'read') read();
      else if (one.kind === 'crash') gateway = new burn.Gateway(h.burnHome, {sign: false});
      else if (one.kind === 'stop') { common.flushClaudeCursors(burn, gateway); gateway = new burn.Gateway(h.burnHome, {sign: false}); }
      else {
        const observe = gateway.observe;
        gateway.observe = () => { throw new Error('store refused'); };
        try { assert.throws(read, /store refused/); } finally { gateway.observe = observe; }
      }
      assert.ok((gateway.peek(s.id)?.state?.totalTokens ?? 0) <= s.written);
    }
    read();
    assert.equal(gateway.peek(s.id)?.state?.totalTokens ?? 0, s.written);
  }), {numRuns: 1000});
});

test('Q2: the cursor is written before more has been read than the gateway can tell apart on a second reading', t => {
  const h = home(t), s = h.session();
  let gateway = new burn.Gateway(h.burnHome, {sign: false});
  const file = common.claudeCursorFile(s.id, s.transcript).file;
  const read = () => common.claudeUsage(burn, gateway, {sessionId: s.id}, s.transcript);
  s.grow(1); read();
  const first = fs.readFileSync(file, 'utf8');
  // 6,000 events in batches of 300, read as they arrive, then the worker dies without a word.
  for (let batch = 0; batch < 20; batch++) { let text = ''; for (let i = 0; i < 300; i++) { text += usageLine(7); s.written += 7; } fs.appendFileSync(s.transcript, text); read(); }
  assert.notEqual(fs.readFileSync(file, 'utf8'), first, 'the cursor was never written again');
  assert.ok(common.CURSOR_SAVE_EVENTS <= 2000, 'well inside the 4,000 event ids the gateway keeps');
  gateway = new burn.Gateway(h.burnHome, {sign: false});
  read();
  assert.equal(gateway.peek(s.id).state.totalTokens, s.written);
  // A stop writes what is not written yet, so the next worker reads nothing twice.
  s.grow(11); read();
  assert.equal(common.flushClaudeCursors(burn, gateway), 1);
  assert.equal(common.flushClaudeCursors(burn, gateway), 0);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.cursor.offset, fs.statSync(s.transcript).size);
});

test('Q3: a launch in a slow session is stopped on tokens no read has counted yet', async t => {
  const h = home(t), engine = await h.start(), s = h.session();
  s.grow(1000);
  assert.equal(permission((await s.call(engine, 'Agent')).output), 'allow');
  // Past the session token limit, written after the last read. Ordinary calls do not read it.
  s.grow(burn.DEFAULT_THRESHOLDS.sustained.stopTokens + 1);
  await s.call(engine); await s.call(engine);
  assert.ok(s.counted(engine) < burn.DEFAULT_THRESHOLDS.sustained.stopTokens);
  const answer = await s.call(engine, 'Agent');
  assert.match(permission(answer.output), /^(ask|deny)$/);
  assert.equal(s.counted(engine), s.written);
});

test('Q4: after a read that took D the session waits 25 x D, at least one second and at most fifteen; one session is read per turn', async t => {
  const h = home(t), engine = await h.start();
  const limits = engine.readLimits();
  assert.deepEqual([limits.gapFactor, limits.gapMinMs, limits.gapMaxMs, limits.slowReadMs, limits.slowSessionBytes], [25, 1000, 15000, -1, -1]);
  const a = h.session(), b = h.session();
  a.grow(10); b.grow(20);
  await a.call(engine); await b.call(engine);
  engine.runDueRead(true);
  assert.deepEqual([a.counted(engine), b.counted(engine)], [10, 0], 'two sessions were read in one turn');
  engine.runDueRead(true);
  assert.deepEqual([a.counted(engine), b.counted(engine)], [10, 20]);
  fc.assert(fc.property(fc.double({min: 0, max: 5000, noNaN: true}), fc.integer({min: 0, max: 20000}), (tookMs, sinceMs) => {
    const state = engine.readState(a.id);
    a.grow(1);
    state.pending = {meta: a.meta(), transcriptPath: a.transcript, mode: 'enforce'};
    state.lastMs = tookMs; state.lastEnd = Date.now() - sinceMs;
    const gap = Math.min(15000, Math.max(1000, 25 * tookMs)), before = a.counted(engine);
    engine.runDueRead(true);
    // 50 ms either side of the line is left to the clock.
    if (sinceMs < gap - 50) assert.equal(a.counted(engine), before, `read ${sinceMs} ms after a read of ${tookMs} ms`);
    if (sinceMs > gap + 50) assert.equal(a.counted(engine), a.written);
    state.pending = null;
  }), {numRuns: 1000});
});

test('Q4: a read asked for is done by itself after the answer, with no further call', async t => {
  // The gap is set short here so the test does not wait on the clock; Q4 above holds the real gap.
  const h = home(t), engine = await h.start({...ALWAYS_SLOW, gapMinMs: 20, gapFactor: 0}), s = h.session();
  s.grow(123);
  await s.call(engine);
  engine.afterReply();
  assert.equal(s.counted(engine), 0);
  for (let i = 0; i < 100 && s.counted(engine) !== 123; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.counted(engine), 123);
  // And again after more growth.
  s.grow(77);
  await s.call(engine); engine.afterReply();
  for (let i = 0; i < 200 && s.counted(engine) !== 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.counted(engine), 200);
});

test('Q5: a failed read is said at the next call, once, and a note a read found is given with the next answer, once', async t => {
  const h = home(t), engine = await h.start(), s = h.session();
  s.grow(10);
  const real = engine.invokeBurn.bind(engine);
  await s.call(engine);
  // Burn wrote to stderr during the read: the read failed.
  engine.invokeBurn = (...args) => ({...real(...args), observationFailed: true});
  engine.settleReads();
  const failed = await s.call(engine);
  assert.equal(failed.warning, true, 'a failed read was not reported');
  // A read that throws is a failed read too.
  engine.invokeBurn = () => { throw new Error('burn could not read'); };
  engine.settleReads();
  assert.equal((await s.call(engine)).warning, true);
  engine.invokeBurn = (...args) => { const result = real(...args); return {...result, output: {...result.output, systemMessage: 'Cache rewrites: a note from Burn'}}; };
  engine.settleReads();
  const noted = await s.call(engine);
  assert.equal(noted.warning, undefined);
  assert.match(noted.output.systemMessage, /Cache rewrites: a note from Burn/);
  // Given once: the next answer, before any further read, does not repeat it.
  assert.equal((await s.call(engine)).output.systemMessage, undefined);
  engine.invokeBurn = real;
  engine.settleReads();
  const plain = await s.call(engine);
  assert.equal(plain.warning, undefined);
  assert.equal(plain.output.systemMessage, undefined);
});

test('Q6: a session that is quick to read is read before every answer; one that turns slow is read after', async t => {
  const h = home(t), engine = await h.start({}), s = h.session();
  for (let i = 0; i < 4; i++) {
    s.grow(100 + i);
    await s.call(engine);
    assert.equal(s.counted(engine), s.written, 'a quick session answered on a stale count');
  }
  assert.equal(engine.sessionReads.get(s.id).pending, null);
  assert.equal(engine.sessionReads.get(s.id).reads, undefined);
  // Each read before an answer is timed: that is how a session is found to have become slow.
  const timed = engine.sessionReads.get(s.id).lastMs;
  assert.ok(typeof timed === 'number' && timed >= 0 && timed < 5000, 'a read before an answer was not timed');
  // The same session once its reads take longer than the limit.
  engine.sessionReads.get(s.id).lastMs = engine.readLimits().slowReadMs + 1;
  s.grow(5);
  await s.call(engine);
  assert.equal(s.counted(engine), s.written - 5);
  engine.settleReads();
  assert.equal(s.counted(engine), s.written);
  // And a session this worker has never read, larger than the size limit, is not read before its first answer.
  const big = h.session();
  fs.appendFileSync(big.transcript, usageLine(9) + JSON.stringify({type: 'user', uuid: 'pad', message: {role: 'user', content: 'x'.repeat(engine.readLimits().slowSessionBytes)}}) + '\n');
  big.written += 9;
  await big.call(engine);
  assert.equal(big.counted(engine), 0);
  engine.settleReads();
  assert.equal(big.counted(engine), 9);
  // Codex is read before the answer as before.
  assert.equal(engine.slowSession({host: 'codex', sessionId: 'c', toolName: 'shell'}, big.transcript), null);
});

test('Q7: the hooks of a launch wait as long as a cold start may take; an ordinary call keeps the policy\'s wait', t => {
  const h = home(t);
  const {launchWait} = require('../runtime/client.cjs'), budget = require('../runtime/budget.cjs');
  assert.equal(budget.LAUNCH_MS, 1500);
  assert.ok(budget.LAUNCH_MS < budget.HOST_TIMEOUT_MS - 100);
  for (const tool of ['Agent', 'Task']) assert.deepEqual(launchWait({toolName: tool}, h.data), {timeoutMs: 1500});
  fc.assert(fc.property(fc.oneof(fc.constantFrom('Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'mcp__x__agent', 'agent', 'TaskList', 'unknown', ''), fc.string()), tool => {
    fc.pre(!common.SPAWN.has(tool));
    assert.deepEqual(launchWait({toolName: tool}, h.data), {});
  }), {numRuns: 1000});
  // A longer wait set in the policy is kept for a launch too.
  fs.writeFileSync(path.join(h.data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', hookBudgetMs: 1800}));
  assert.deepEqual(launchWait({toolName: 'Agent'}, h.data), {timeoutMs: 1800});
  assert.deepEqual(launchWait({}, h.data), {});
});
