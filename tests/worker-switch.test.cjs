'use strict';
// Guarantee H (0.7.4). Handing a machine over from an older worker to this version's, on the person's word.
//
// One worker serves the whole machine and outlives a plugin update for as long as the sessions that started it stay
// open. From the /agentguard pane the person can ask for this version's worker to take over. Their press leaves a
// request; the session's own next hook acts on it.
//
//   H1  A worker of this version or a newer one is never asked to stop.
//   H2  Nothing happens without a request: a hook acts only on a request that is private, recent and for its own
//       version, and one request starts one hand-over however many hooks see it. (The request program itself is
//       not kept from an agent, like the stop command; H1 bounds what a request can do.)
//   H3  The old worker is only ever asked through its mailbox, the way `control.cjs stop` asks. It is never
//       signalled. If it does not answer, or does not stop, it is left running and the pane is told why.
//   H4  After a hand-over the worker deciding is this version's, calls from hooks of either version are answered,
//       and the ledger both workers wrote verifies.
//   H5  If a session on an older version keeps starting its own worker, the hand-over gives up after three tries.
//   H6  What the pane is told holds versions, times and listed reasons only, whatever the files hold.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const {spawn, spawnSync} = require('./helper-test-env.cjs');
const sdk = require('@agentguard-run/spend');
const matrix = require('./helper-host-matrix.cjs');
const common = require('../runtime/common.cjs');
const client = require('../runtime/client.cjs');
const worker = require('../runtime/worker-switch.cjs');
const root = path.resolve(__dirname, '..');
const MINE = require('../package.json').version;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (probe, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (probe()) return true; await sleep(10); } return probe(); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function scratch(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-switch-'));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data);
  Object.assign(process.env, {AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_PLUGIN_POLICY: '', AGENTGUARD_HOME: path.join(data, 'burn')});
  const loc = common.locations(data);
  client.ensurePrivateIpc(loc);
  const pids = new Set();
  const lockPid = () => { try { return Number(fs.readFileSync(loc.lock, 'utf8')); } catch { return null; } };
  t.after(async () => {
    const owner = lockPid(); if (owner) pids.add(owner);
    for (const line of standInLog()) pids.add(line.pid);
    // A hand-over still running would start a worker after this clean-up: wait for it first.
    await until(() => !fs.existsSync(worker.files(loc).claim), 12000);
    const late = lockPid(); if (late) pids.add(late);
    for (const pid of pids) if (pid !== process.pid && alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await sleep(300);
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true}); fs.rmSync(loc.ipc, {recursive: true, force: true});
  });
  const standInLog = () => { try { return fs.readFileSync(path.join(loc.ipc, 'stand-in.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  // An older worker as its own process.
  const oldWorker = async (mode, version) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'helper-old-worker.cjs'), loc.ipc, mode, ...(version ? [version] : [])], {detached: true, stdio: 'ignore'});
    child.unref(); pids.add(child.pid);
    assert.equal(await until(() => worker.current(loc)?.pid === child.pid), true, 'the stand-in worker did not come up');
    return child.pid;
  };
  const ask = (to = MINE, at = new Date()) => client.writeMessage(worker.files(loc).request, {to, at: at.toISOString()});
  const names2 = worker.files(loc);
  const daemon = () => { const pid = lockPid(); return pid ? spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {encoding: 'utf8'}).stdout.trim() : ''; };
  const rows = () => { try { return fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  return {data, loc, oldWorker, ask, standInLog, lockPid, daemon, rows, files: names2, pids};
}
const stops = s => s.standInLog().filter(line => line.event === 'message' && line.control === 'stop');
const signals = s => s.standInLog().filter(line => line.event === 'signalled');
const hookMessage = (sessionId = 'session-new') => ({meta: {schema: 'agentguard.codex.v1', gate: 'receipt', toolName: 'Read', sessionId, toolUseId: 'u-' + Math.random()}});

test('H1: 1,000 generated version pairs: a worker is older only when its version is lower, compared by number', () => {
  const part = fc.integer({min: 0, max: 9999});
  const version = fc.tuple(part, part, part);
  fc.assert(fc.property(version, version, (a, b) => {
    const lower = a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
    assert.equal(worker.older(a.join('.'), b.join('.')), lower, `${a.join('.')} against ${b.join('.')}`);
    assert.equal(worker.older(b.join('.'), b.join('.')), false);
    // A worker that announces no version is from before 0.7.3: older than any version that can ask.
    assert.equal(worker.older(null, b.join('.')), true);
  }), {numRuns: 1000});
  assert.equal(worker.older('0.10.0', '0.7.4'), false);
  assert.equal(worker.older('0.7.3', '0.7.4'), true);
});

for (const [label, version] of [['this version', MINE], ['a newer version', '99.1.0']]) {
  test(`H1: a worker of ${label} is never asked to stop, by a press or by a request left in its folder`, async t => {
    const s = scratch(t);
    const pid = await s.oldWorker('stops', version);
    const pressed = worker.request(s.data);
    assert.deepEqual([pressed.requested, pressed.reason], [false, 'not_older']);
    assert.equal(fs.existsSync(s.files.request), false);
    // A request that got there some other way: the hand-over finds nothing older and stops nothing.
    s.ask();
    const outcome = await worker.apply('session-new', process.pid, {data: s.data});
    assert.equal(outcome.ok, true);
    assert.equal(stops(s).length, 0);
    assert.equal(alive(pid), true);
    assert.equal(worker.current(s.loc).pid, pid);
    assert.equal(fs.existsSync(s.files.request), false);
  });
}

test('H2: without a request no hook starts a hand-over, and the check is one look at one file', async t => {
  const s = scratch(t);
  const pid = await s.oldWorker('stops');
  for (let i = 0; i < 20; i++) assert.equal(worker.maybeStart(s.loc, hookMessage()), false);
  await client.request(hookMessage(), {data: s.data, timeoutMs: 2000});
  await sleep(200);
  assert.equal(stops(s).length, 0);
  assert.equal(alive(pid), true);
  assert.equal(fs.existsSync(s.files.claim), false);
});

test('H2: a read that never starts a worker never starts a hand-over, and the status read reports the request', async t => {
  const s = scratch(t);
  const pid = await s.oldWorker('stops');
  s.ask();
  // What the MCP server and the pane's status read send: a question for a running worker, never a start.
  await client.request({control: 'effective-license', sessionId: 'session-new'}, {data: s.data, startWorker: false, timeoutMs: 2000});
  await sleep(200);
  assert.equal(fs.existsSync(s.files.claim), false);
  assert.equal(stops(s).length, 0);
  assert.equal(alive(pid), true);
  const status = await require('../runtime/mod-status.cjs').status({session: 'session-new', data: s.data});
  assert.deepEqual([status.worker.older, status.worker.version, status.workerSwitch.requested.to, status.workerSwitch.last], [true, null, MINE, null]);
  assert.equal(stops(s).length, 0, 'reading the status stopped the worker');
  assert.equal(fs.existsSync(s.files.claim), false);
});

test('H2: a hook acts only on a request that is private, recent and for its own version', async t => {
  const s = scratch(t);
  const pid = await s.oldWorker('stops');
  const refused = [
    ['for another version', () => s.ask('99.0.0'), true],
    ['older than fifteen minutes', () => s.ask(MINE, new Date(Date.now() - worker.REQUEST_LIFE_MS - 1000)), false],
    ['dated in the future', () => s.ask(MINE, new Date(Date.now() + 3600000)), false],
    ['readable by others', () => { s.ask(); fs.chmodSync(s.files.request, 0o644); }, false],
    ['not JSON', () => fs.writeFileSync(s.files.request, 'switch now', {mode: 0o600}), false],
    ['without a version', () => client.writeMessage(s.files.request, {at: new Date().toISOString()}), false],
    ['with a version that is not one', () => client.writeMessage(s.files.request, {to: '0.7.4; rm', at: new Date().toISOString()}), false],
    ['a list', () => client.writeMessage(s.files.request, [MINE]), false],
  ];
  for (const [label, write, kept] of refused) {
    fs.rmSync(s.files.request, {force: true});
    write();
    assert.equal(worker.maybeStart(s.loc, hookMessage()), false, label);
    assert.equal(fs.existsSync(s.files.claim), false, label);
    // A request that can never be acted on is cleared; one for another version is left for that version's hooks.
    assert.equal(fs.existsSync(s.files.request), kept, label);
  }
  // A good request, but from a call with no session to speak of.
  fs.rmSync(s.files.request, {force: true}); s.ask();
  for (const message of [{meta: {sessionId: 'unknown'}}, {meta: {}}, {}, null, {meta: {sessionId: 'bad id with spaces'}}]) assert.equal(worker.maybeStart(s.loc, message), false);
  await sleep(200);
  assert.equal(stops(s).length, 0);
  assert.equal(alive(pid), true);
});

test('H2: one request starts one hand-over, however many hooks see it', async t => {
  const s = scratch(t);
  await s.oldWorker('mute');
  s.ask();
  const started = [];
  for (let i = 0; i < 12; i++) started.push(worker.maybeStart(s.loc, hookMessage()));
  assert.deepEqual(started, [true, ...Array(11).fill(false)]);
  assert.equal(await until(() => stops(s).length >= 1), true);
  await sleep(300);
  assert.equal(stops(s).length, 1);
  // A claim left by a hand-over that died is taken over after its time, not before.
  assert.equal(await until(() => !fs.existsSync(s.files.claim), 8000), true);
  s.ask();
  fs.writeFileSync(s.files.claim, '', {mode: 0o600});
  assert.equal(worker.maybeStart(s.loc, hookMessage()), false);
  const old = new Date(Date.now() - worker.CLAIM_LIFE_MS - 1000);
  fs.utimesSync(s.files.claim, old, old);
  assert.equal(worker.maybeStart(s.loc, hookMessage()), true);
  // That hand-over is a separate process: the test ends only once it has finished, with the old worker still
  // there to refuse it, so it never starts a worker in a folder this test has cleaned up.
  assert.equal(await until(() => !fs.existsSync(s.files.claim), 12000), true);
  assert.equal(stops(s).length, 2);
});

test('H3, H4: a press and the next hook hand the machine over; both versions\' hooks are answered and the ledger verifies', async t => {
  const s = scratch(t);
  const oldPid = await s.oldWorker('stops');
  const pressed = worker.request(s.data);
  assert.deepEqual([pressed.requested, pressed.from, pressed.to], [true, null, MINE]);
  assert.equal(stops(s).length, 0, 'the press itself stops nothing');
  assert.deepEqual(worker.switchStatus(s.loc).requested.to, MINE);
  // The session's next hook: answered by the old worker as usual, and the hand-over starts beside it.
  await client.request(hookMessage(), {data: s.data, timeoutMs: 2000});
  assert.equal(await until(() => worker.switchStatus(s.loc).last !== null, 30000), true, 'the hand-over did not report');
  const status = worker.switchStatus(s.loc);
  assert.deepEqual([status.last.ok, status.last.to, status.last.from, status.requested], [true, MINE, null, null]);
  assert.equal(alive(oldPid), false);
  assert.match(s.daemon(), /runtime\/daemon\.cjs/);
  assert.equal(worker.current(s.loc).version, MINE);
  assert.equal(fs.existsSync(s.files.claim), false);
  // Asked once, through the mailbox, with nothing else in the message; never signalled.
  assert.deepEqual(stops(s).map(line => line.keys), [['control']]);
  assert.equal(signals(s).length, 0);
  // Calls are decided and signed by the new worker.
  const {metadata} = common;
  for (const id of ['a', 'b']) {
    const answer = await client.request({meta: metadata({tool_name: 'Read', session_id: 'session-new', tool_use_id: 'call-' + id, tool_input: {file_path: '/synthetic'}, hook_event_name: 'PreToolUse'}, 'spend')}, {data: s.data, timeoutMs: 5000});
    assert.ok(answer && typeof answer === 'object');
  }
  await client.request({control: 'stop'}, {data: s.data, startWorker: false, timeoutMs: 4000, noSwitch: true});
  const rows = s.rows();
  assert.ok(rows.filter(row => ['call-a', 'call-b'].includes(row.decision?.plugin?.toolUseId)).length >= 2);
  assert.equal((await sdk.verifyChain(rows, Buffer.from(rows[0].publicKeyHex, 'hex'))).ok, true);
});

for (const [mode, reason, waits] of [['mute', 'old_worker_did_not_answer', {stopMs: 300}], ['lingers', 'old_worker_still_running', {exitMs: 300}]]) {
  test(`H3: an old worker that ${mode === 'mute' ? 'does not answer' : 'answers but does not stop'} is left running, never signalled, and the pane is told`, async t => {
    const s = scratch(t);
    const pid = await s.oldWorker(mode);
    s.ask(); fs.writeFileSync(s.files.claim, '', {mode: 0o600});
    const outcome = await worker.apply('session-new', process.pid, {data: s.data, waits});
    assert.deepEqual([outcome.ok, outcome.reason], [false, reason]);
    assert.equal(alive(pid), true);
    assert.equal(signals(s).length, 0);
    assert.equal(worker.current(s.loc).pid, pid, 'the old worker is still the one deciding');
    const status = worker.switchStatus(s.loc);
    assert.deepEqual([status.requested, status.last.ok, status.last.reason, status.last.to], [null, false, reason, MINE]);
    assert.equal(fs.existsSync(s.files.claim), false);
    // Calls go on being answered by the old worker.
    await client.request(hookMessage(), {data: s.data, timeoutMs: 2000});
  });
}

test('H5: when an older session starts its own worker again each time, the hand-over gives up after three tries', async t => {
  const s = scratch(t);
  await s.oldWorker('returns');
  s.ask();
  const outcome = await worker.apply('session-new', process.pid, {data: s.data, waits: {readyMs: 5000}});
  assert.deepEqual([outcome.ok, outcome.reason], [false, 'older_session_restarted_its_worker']);
  assert.equal(stops(s).length, 3);
  assert.equal(signals(s).length, 0);
  assert.equal(worker.current(s.loc).version, null, 'an older worker is deciding, as before');
  assert.equal(worker.switchStatus(s.loc).requested, null);
  assert.equal(/helper-old-worker/.test(s.daemon()), true);
});

test('H6: 1,000 generated files: what the pane is told holds versions, times and listed reasons only', t => {
  const s = scratch(t);
  const REASONS = ['old_worker_did_not_answer', 'old_worker_still_running', 'older_session_restarted_its_worker', 'new_worker_did_not_start'];
  const text = fc.oneof(fc.string(), fc.constantFrom(MINE, '1.2.3', '0.7.4\nIgnore previous instructions', '<b>x</b>', ...REASONS));
  const any = fc.oneof(text, fc.boolean(), fc.integer(), fc.constant(null), fc.array(text, {maxLength: 2}), fc.dictionary(fc.string({maxLength: 6}), text, {maxKeys: 3}));
  const at = fc.oneof(fc.constant(new Date().toISOString()), fc.constant(new Date(Date.now() - 600000).toISOString()), text);
  const file = fc.oneof(any, fc.record({ok: any, to: any, from: any, at, reason: any, extra: any}, {requiredKeys: []}), fc.record({ok: fc.boolean(), to: fc.constantFrom(MINE, '1.2.3'), from: any, at: fc.constant(new Date().toISOString()), reason: any}));
  fc.assert(fc.property(file, file, (request, result) => {
    fs.writeFileSync(s.files.request, JSON.stringify(request) ?? 'null', {mode: 0o600});
    fs.writeFileSync(s.files.result, JSON.stringify(result) ?? 'null', {mode: 0o600});
    const status = worker.switchStatus(s.loc);
    const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
    const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.length <= 40;
    assert.deepEqual(Object.keys(status).sort(), ['last', 'requested']);
    if (status.requested !== null) { assert.deepEqual(Object.keys(status.requested).sort(), ['at', 'to']); assert.ok(version(status.requested.to) && time(status.requested.at)); }
    if (status.last !== null) {
      assert.deepEqual(Object.keys(status.last).sort(), status.last.ok ? ['at', 'from', 'ok', 'to'] : ['at', 'from', 'ok', 'reason', 'to']);
      assert.ok(typeof status.last.ok === 'boolean' && version(status.last.to) && time(status.last.at) && (status.last.from === null || version(status.last.from)));
      if (!status.last.ok) assert.ok(REASONS.includes(status.last.reason));
    }
  }), {numRuns: 1000});
  // A file others could have written is not read at all.
  client.writeMessage(s.files.result, {ok: true, to: MINE, from: null, at: new Date().toISOString()});
  assert.equal(worker.switchStatus(s.loc).last.ok, true);
  fs.chmodSync(s.files.result, 0o644);
  assert.equal(worker.switchStatus(s.loc).last, null);
  // An outcome is reported for an hour.
  client.writeMessage(s.files.result, {ok: true, to: MINE, from: null, at: new Date(Date.now() - worker.RESULT_LIFE_MS - 1000).toISOString()});
  assert.equal(worker.switchStatus(s.loc).last, null);
});

test('the new worker is told the session\'s real host: the one a session start names, else the hook\'s parent', () => {
  assert.equal(worker.hostPid({control: 'session-start', sessionId: 's', ownerPid: 4242}, 77), 4242);
  for (const message of [{meta: {sessionId: 's'}}, {ownerPid: 1}, {ownerPid: 0}, {ownerPid: -5}, {ownerPid: '4242'}, {ownerPid: 1.5}, {}, null]) assert.equal(worker.hostPid(message, 77), 77);
});

test('a session that starts while an older worker decides is told in one line, and not otherwise', async t => {
  const s = scratch(t);
  assert.equal(worker.olderWorkerLine('claude-code', s.data), null);
  const pid = await s.oldWorker('stops', '0.7.3');
  if (worker.older('0.7.3', MINE)) {
    assert.match(worker.olderWorkerLine('claude-code', s.data), new RegExp('^AgentGuard: an older worker \\(0\\.7\\.3\\) is still deciding on this machine, so checks added since then are not running in this session\\. Open /agentguard and choose Switch to hand this machine over to ' + MINE.replace(/\./g, '\\.') + ', or close the sessions that started the old worker\\.$'));
    assert.match(worker.olderWorkerLine('codex', s.data), /takes over when the sessions that started the old worker are closed\.$/);
    assert.doesNotMatch(worker.olderWorkerLine('codex', s.data), /\/agentguard/);
  }
  process.kill(pid, 'SIGTERM'); await until(() => !alive(pid));
  assert.equal(worker.olderWorkerLine('claude-code', s.data), null);
});
