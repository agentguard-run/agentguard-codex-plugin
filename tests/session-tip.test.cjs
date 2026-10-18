'use strict';
// The tip from the last session. SessionEnd records the session that ended and
// starts a detached process that stores Burn's sessionTip line (the "Next: ..."
// line `why` ends with); the next new session shows it once. With Burn 0.3.20,
// which the lockfile installs until 0.3.21 is published, there is no sessionTip:
// the stored record has no tip and nothing shows, and the tests that need a tip
// give the detached step its function directly. Temporary directories only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('./helper-test-env.cjs');
const {once} = require('node:events');
const matrix = require('./helper-host-matrix.cjs');
const {fixture, root} = require('./helper-session-start.cjs');
const tips = require('../runtime/session-tip.cjs');
const moments = require('../runtime/upgrade-moments.cjs');
const burn = require('@agentguard-run/burn');
const hasSessionTip = typeof burn.sessionTip === 'function';
// Burn's fan-out tip in its plugin wording: the action, not a pointer to the plugin the person already runs.
const TIP = "Next: sub-agents used 48.9% of this session's tokens. Give related work to one sub-agent instead of several.";
const LINE = "AgentGuard tip from your last session: sub-agents used 48.9% of this session's tokens. Give related work to one sub-agent instead of several.";
const HOUR = 3600000;

test('Burn 0.3.21 and later give the plugin sessionTip; 0.3.20 does not', () => {
  const [major, minor, patch] = require('@agentguard-run/burn/package.json').version.split('.').map(Number);
  assert.equal(hasSessionTip, major > 0 || minor > 3 || patch >= 21);
});

const at = minutes => new Date(Date.parse('2026-09-27T10:00:00Z') + minutes * 60000).toISOString();
const claudeRecord = (id, time, model, usage, sidechain = false) => JSON.stringify({type: 'assistant', uuid: `synthetic-${id}`, timestamp: time, ...(sidechain ? {isSidechain: true} : {}),
  message: {id: `synthetic-${id}`, model, role: 'assistant', content: [], usage: {input_tokens: usage.input ?? 0, cache_creation_input_tokens: usage.write ?? 0,
    cache_read_input_tokens: usage.read ?? 0, output_tokens: usage.output ?? 0, cache_creation: {ephemeral_5m_input_tokens: usage.write ?? 0, ephemeral_1h_input_tokens: 0}}}}) + '\n';
// Claude Code: two sub-agent transcripts in the session's subagents folder hold most of its tokens.
// Codex: a rollout whose second turn switched models.
function transcript(base) {
  if (matrix.isClaude) {
    const id = '11111111-2222-4333-8444-555555555555', project = path.join(base, 'claude-projects', '-synthetic');
    fs.mkdirSync(path.join(project, id, 'subagents'), {recursive: true});
    fs.writeFileSync(path.join(project, `${id}.jsonl`), claudeRecord('p1', at(0), 'claude-opus-5-5', {input: 2000, write: 20000, output: 500})
      + claudeRecord('p2', at(5), 'claude-opus-5-5', {input: 100, read: 22000, output: 800}));
    for (const n of [1, 2]) fs.writeFileSync(path.join(project, id, 'subagents', `agent-synthetic-${n}.jsonl`),
      claudeRecord(`c${n}`, at(10 * n), 'claude-haiku-4-5-20251001', {input: 5000, write: 40000, read: 30000, output: 2000}, true));
    return path.join(project, `${id}.jsonl`);
  }
  const file = path.join(base, 'codex-sessions', '2026', '09', '27', 'rollout-2026-09-27T10-00-00-synthetic.jsonl');
  const usage = v => ({input_tokens: v.input, cached_input_tokens: 0, cache_write_input_tokens: v.write, output_tokens: v.output, reasoning_output_tokens: 0, total_tokens: v.input + v.output});
  const tokens = (time, total, last = total) => ({type: 'event_msg', timestamp: time, payload: {type: 'token_count', info: {total_token_usage: usage(total), last_token_usage: usage(last), model_context_window: 1000000}}});
  const context = (turn, time, model) => ({type: 'turn_context', timestamp: time, payload: {turn_id: `synthetic-turn-${turn}`, model, cwd: '/synthetic'}});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, [{type: 'session_meta', timestamp: at(0), payload: {id: 'synthetic-codex-session', cwd: '/synthetic'}},
    context(1, at(0), 'gpt-6-sol'), tokens(at(0), {input: 1000, write: 900, output: 10}),
    context(2, at(2), 'gpt-6-astra'), tokens(at(2), {input: 171000, write: 170900, output: 20}, {input: 170000, write: 170000, output: 10})].map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

test('SessionEnd stores the tip Burn gives for the ended session, and the next new session shows it once', t => {
  const f = fixture(t), file = transcript(f.base);
  const expected = hasSessionTip ? burn.sessionTip(file, {home: f.agentguard, context: 'plugin'}) : null;
  if (hasSessionTip) {
    assert.match(expected, /^Next: \S/, 'the fixture has a tip');
    // The Claude Code fixture is a fan-out session: `why` points to the plugin, the plugin names the action.
    if (matrix.isClaude) {
      assert.match(burn.sessionTip(file, {home: f.agentguard}), / https:\/\/agentguard\.run\/burn\/next$/);
      assert.match(expected, /^Next: sub-agents used \d+\.\d% of this session's tokens\. Give related work to one sub-agent instead of several\.$/);
    }
  }
  assert.deepEqual(f.start('first-session'), {});
  assert.deepEqual(f.end('ended-session', file), {});
  // The hook returns at once; the detached process stores the tip with the session id and its times.
  assert.ok(f.waitFor(() => f.record()?.state === 'ready'), `still ${JSON.stringify(f.record())}`);
  const last = f.record();
  assert.equal(last.sessionId, 'ended-session');
  assert.equal(last.tip, expected);
  assert.ok(Number.isFinite(last.endedAt) && last.computedAt >= last.endedAt);
  assert.deepEqual(f.start('next-session'), expected ? {systemMessage: `AgentGuard tip from your last session: ${expected.slice('Next: '.length)}`} : {});
  assert.deepEqual(f.start('third-session'), {});
  // The detached step asks Burn for the plugin wording, with Burn's home for pricing.
  const calls = [];
  tips.ended({sessionId: 'session-z', transcriptPath: file, now: 42, spawnImpl: () => ({on() {}, unref() {}})});
  tips.compute({sessionId: 'session-z', endedAt: 42, transcriptPath: file, sessionTip: (...args) => { calls.push(args); return TIP; }});
  assert.deepEqual(calls, [[file, {home: f.agentguard, context: 'plugin'}]]);
  // The transcript is only read.
  assert.equal(fs.readFileSync(file, 'utf8').includes('synthetic'), true);
});

test('a stored tip shows once, in a new session only, never in the session it came from', t => {
  const f = fixture(t);
  assert.equal(f.stored('session-a', TIP), TIP);
  assert.deepEqual(f.start('session-a', 'resume'), {});
  assert.deepEqual(f.start('session-a'), {}, 'not in the session the tip is about');
  for (const source of ['resume', 'compact', 'fork']) assert.deepEqual(f.start('session-b', source), {}, source);
  assert.equal(f.record().state, 'ready', 'a continued session uses nothing up');
  assert.deepEqual(f.start('session-b'), {systemMessage: LINE});
  assert.equal(f.record().state, 'shown');
  assert.deepEqual(f.start('session-c'), {});
  assert.deepEqual(f.start('session-d', 'clear'), {});
  // A /clear begins a new conversation too.
  f.stored('session-d', TIP.replace('48.9', '51.0'));
  assert.deepEqual(f.start('session-e', 'clear'), {systemMessage: LINE.replace('48.9', '51.0')});
});

test('quiet on silences the tip and SessionEnd reads nothing while it is on', t => {
  const f = fixture(t);
  f.stored('session-a', TIP);
  moments.dismiss(f.agentguard);
  assert.deepEqual(f.start('session-b'), {});
  assert.equal(f.record().state, 'ready', 'quiet uses nothing up');
  fs.rmSync(path.join(f.agentguard, 'upgrade-moments', 'quiet'));
  assert.deepEqual(f.start('session-c'), {systemMessage: LINE});
  moments.dismiss(f.agentguard);
  const spawned = [], file = path.join(f.base, 'session-c.jsonl');
  fs.writeFileSync(file, '');
  assert.equal(tips.ended({sessionId: 'session-c', transcriptPath: file, spawnImpl: (...args) => { spawned.push(args); return {on() {}, unref() {}}; }}), false);
  assert.deepEqual(spawned, [], 'no transcript is read while quiet');
  assert.equal(f.record().state, 'none');
});

test('no tip: a session where nothing stands out shows nothing, and it replaces an older tip', t => {
  const f = fixture(t);
  f.stored('session-a', TIP);
  assert.equal(f.stored('session-b', null), null);
  assert.deepEqual(f.record(), {...f.record(), sessionId: 'session-b', state: 'ready', tip: null});
  assert.deepEqual(f.start('session-c'), {}, 'the older tip is not from the last session');
  // Without a transcript path (a Codex session can end without one) nothing is read either.
  f.stored('session-c', TIP);
  assert.equal(tips.ended({sessionId: 'session-d', transcriptPath: null, spawnImpl: () => assert.fail('nothing to read')}), false);
  assert.equal(f.record().state, 'none');
  assert.deepEqual(f.start('session-e'), {});
  // Burn's line is kept to one bounded line, or not shown at all.
  for (const bad of ['Next: two\nlines', `Next: ${'x'.repeat(1001)}`, 'Siguiente: otro idioma', 'Next: ', 42]) {
    f.stored('session-f', bad);
    assert.equal(f.record().tip, null, JSON.stringify(bad));
    assert.deepEqual(f.start('session-g'), {});
  }
});

test('the same tip is not shown twice within a day; a different one is', t => {
  const f = fixture(t), t0 = Date.parse('2026-09-27T09:00:00Z');
  f.stored('session-a', TIP, t0);
  assert.equal(tips.take({sessionId: 'session-b', now: t0 + HOUR}), LINE);
  f.stored('session-b', TIP, t0 + 2 * HOUR);
  assert.equal(tips.take({sessionId: 'session-c', now: t0 + 3 * HOUR}), null);
  assert.equal(tips.take({sessionId: 'session-c', now: t0 + 25 * HOUR - 1}), null, 'still within a day of showing it');
  assert.equal(f.record().state, 'ready', 'held, not dropped');
  assert.equal(tips.take({sessionId: 'session-d', now: t0 + 25 * HOUR}), LINE);
  f.stored('session-d', TIP.replace('48.9', '12.5'), t0 + 26 * HOUR);
  assert.equal(tips.take({sessionId: 'session-e', now: t0 + 26 * HOUR + 1}), LINE.replace('48.9', '12.5'));
  // Only the last day's lines are kept.
  assert.deepEqual(tips.read(f.data).shown.map(entry => entry.at), [t0 + 25 * HOUR, t0 + 26 * HOUR + 1]);
});

test('a failure while reading the transcript is silent and leaves nothing to show', async t => {
  const f = fixture(t);
  // No transcript file: SessionEnd starts nothing, and the session still counts as the last one.
  f.stored('session-0', TIP);
  assert.deepEqual(f.end('session-a', path.join(f.base, 'gone', 'missing-session.jsonl')), {});
  assert.deepEqual([f.record().sessionId, f.record().state], ['session-a', 'none']);
  assert.deepEqual(f.start('session-b'), {});
  // A transcript that cannot be read: the detached step, started as SessionEnd starts it, exits cleanly and prints nothing.
  const unreadable = path.join(f.base, 'unreadable-session.jsonl');
  fs.writeFileSync(unreadable, '{}\n'); fs.chmodSync(unreadable, 0o000);
  t.after(() => { try { fs.chmodSync(unreadable, 0o600); } catch {} });
  let child;
  assert.equal(tips.ended({sessionId: 'session-c', transcriptPath: unreadable, spawnImpl: (command, args, options) => {
    child = spawn(command, args, {...options, detached: false, stdio: ['ignore', 'pipe', 'pipe']});
    return Object.assign(child, {unref() {}});
  }}), true);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.deepEqual([code, output], [0, '']);
  assert.equal(f.record().tip ?? null, null);
  assert.deepEqual(f.start('session-d'), {});
  // A sessionTip that throws leaves the record computing, which shows nothing.
  const endedAt = Date.now();
  assert.equal(tips.ended({sessionId: 'session-x', transcriptPath: unreadable, now: endedAt, spawnImpl: () => ({on() {}, unref() {}})}), true);
  assert.throws(() => tips.compute({sessionId: 'session-x', endedAt, transcriptPath: unreadable, sessionTip: () => { throw new Error('EACCES'); }}));
  assert.equal(f.record().state, 'computing');
  assert.deepEqual(f.start('session-y'), {});
  // A step for an older session changes nothing once a later one has ended.
  f.stored('session-e', TIP);
  assert.equal(tips.compute({sessionId: 'session-x', endedAt, transcriptPath: unreadable, sessionTip: () => assert.fail('superseded: not read')}), null);
  assert.equal(f.record().sessionId, 'session-e');
  // A process that cannot start is silent too.
  assert.equal(tips.ended({sessionId: 'session-f', transcriptPath: unreadable, spawnImpl: () => { const failed = new (require('node:events'))(); failed.unref = () => {}; setImmediate(() => failed.emit('error', new Error('spawn failed'))); return failed; }}), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.start('session-g'), {});
});

test('the tip comes after the first-run line and every other line and uses none of them up', t => {
  const f = fixture(t, {fresh: true});
  f.stored('session-a', TIP);
  const first = f.start('session-b').systemMessage.split('\n');
  assert.match(first[0], /^AgentGuard is on\. /);
  assert.match(first[1], /^AgentGuard presets: /);
  assert.equal(first.at(-1), LINE);
  assert.equal(first.length, 3);
  // The Score invitation still waits for a start with nothing else to say.
  assert.deepEqual(f.start('session-c'), {systemMessage: moments.SCORE_LINE});
});

test('a held lock skips the tip without waiting, and a lock left by a dead process does not stop it', t => {
  const f = fixture(t);
  f.stored('session-a', TIP);
  const lock = path.join(f.data, tips.FILE + '.lock');
  fs.writeFileSync(lock, '');
  const began = Date.now();
  assert.equal(tips.take({sessionId: 'session-b'}), null);
  assert.ok(Date.now() - began < 100, 'startup never waits on the lock');
  assert.equal(f.record().state, 'ready');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(tips.take({sessionId: 'session-b'}), LINE);
  assert.equal(fs.existsSync(lock), false);
});

test('without its dependencies, session start shows only the dependencies message and keeps the tip for later', t => {
  const f = fixture(t);
  f.stored('session-a', TIP);
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-session-tip-missing-')));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const copy = path.join(temporary, 'plugins', 'cache', 'agentguard', 'agentguard', '0.1.0');
  for (const name of ['runtime', 'hooks', 'config', 'package.json', 'package-lock.json']) fs.cpSync(path.join(root, name), path.join(copy, name), {recursive: true});
  const preload = path.join(temporary, 'no-child.cjs');
  fs.writeFileSync(preload, "require('node:child_process').spawn = () => ({on(){}, unref(){}});");
  const env = {...process.env, ...(matrix.isClaude ? {CLAUDE_PLUGIN_ROOT: copy} : {PLUGIN_ROOT: copy})};
  const start = id => {
    const child = spawnSync(process.execPath, ['-r', preload, path.join(copy, 'hooks', 'session-start.cjs')], {env, encoding: 'utf8', timeout: 20000,
      input: JSON.stringify({session_id: id, hook_event_name: 'SessionStart', source: 'startup'})});
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(start('session-b'), {systemMessage: `AgentGuard can't start: its dependencies are missing. Run npm ci in ${copy}, then start a new session.`});
  assert.equal(f.record().state, 'ready', 'the tip waits');
  fs.cpSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), {recursive: true, verbatimSymlinks: true});
  assert.deepEqual(start('session-c'), {systemMessage: LINE});
});
