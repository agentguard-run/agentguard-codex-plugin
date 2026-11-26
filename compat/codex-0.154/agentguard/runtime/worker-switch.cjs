#!/usr/bin/env node
'use strict';
// Handing this machine over from an older worker to this version's, on the
// person's word.
//
// One worker serves the whole machine and outlives a plugin update for as long
// as the sessions that started it stay open, so a session on a newer version
// can be decided by an older worker. The person can end that from the
// /agentguard pane. Their press runs `request` here, which only leaves a note
// in the worker's private folder. The session's own next hook sees the note and
// starts `apply` as a separate process, because only a hook carries what a
// worker needs from Claude Code (the plugin's data folder and license option);
// the pane's own processes do not.
//
// `apply` asks the old worker to stop through its mailbox, the way
// `control.cjs stop` does, waits for it to finish its writes and exit, and
// starts this version's worker. It never signals a process, never stops a
// worker of this version or a newer one, and gives up after three tries if a
// session on an older version keeps starting its own worker first.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {locations, identifier} = require('./common.cjs');

const REQUEST_LIFE_MS = 15 * 60 * 1000;   // a press not acted on by then is forgotten
const CLAIM_LIFE_MS = 6 * 60 * 1000;      // an apply that died is not waited for longer than this
const RESULT_LIFE_MS = 60 * 60 * 1000;    // how long the pane reports the outcome
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const mine = () => require('../package.json').version;
const number = text => text.split('.').reduce((sum, part) => sum * 10000 + Number(part), 0);
// A worker from before 0.7.3 announces no version: it is older than any version that can ask.
const older = (worker, plugin) => worker === null || number(worker) < number(plugin);
const files = loc => ({request: path.join(loc.ipc, 'worker.switch'), claim: path.join(loc.ipc, 'worker.switch.applying'), result: path.join(loc.ipc, 'worker.switch.result')});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readNote(file, life, now = Date.now()) {
  try {
    const note = JSON.parse(require('./client.cjs').readPrivate(file, 4096));
    const at = Date.parse(note?.at);
    if (!note || typeof note !== 'object' || Array.isArray(note) || !Number.isFinite(at) || now - at > life || at - now > 60000) return null;
    return note;
  } catch { return null; }
}
// The worker deciding now: {pid, version} with version null for one that announces none, or null for no worker.
function current(loc) {
  try {
    const {workerReady, readPrivate} = require('./client.cjs');
    if (!workerReady(loc)) return null;
    const ready = JSON.parse(readPrivate(loc.ready));
    return {pid: ready.pid, version: typeof ready.version === 'string' && VERSION.test(ready.version) ? ready.version : null};
  } catch { return null; }
}
function pending(loc, now = Date.now()) {
  const note = readNote(files(loc).request, REQUEST_LIFE_MS, now);
  return note && typeof note.to === 'string' && VERSION.test(note.to) ? note : null;
}
// What the pane shows: an open request, and the last outcome while it is recent.
function switchStatus(loc, now = Date.now()) {
  const asked = pending(loc, now), last = readNote(files(loc).result, RESULT_LIFE_MS, now);
  const reasons = ['old_worker_did_not_answer', 'old_worker_still_running', 'older_session_restarted_its_worker', 'new_worker_did_not_start'];
  return {
    requested: asked ? {to: asked.to, at: asked.at} : null,
    last: last && typeof last.ok === 'boolean' && typeof last.to === 'string' && VERSION.test(last.to)
      ? {ok: last.ok, to: last.to, from: typeof last.from === 'string' && VERSION.test(last.from) ? last.from : null, at: last.at,
        ...(last.ok ? {} : {reason: reasons.includes(last.reason) ? last.reason : 'new_worker_did_not_start'})} : null,
  };
}

// One line for a session that starts while an older worker is deciding.
function olderWorkerLine(host, data) {
  const worker = current(locations(data)), plugin = mine();
  if (!worker || !older(worker.version, plugin)) return null;
  return 'AgentGuard: an older worker (' + (worker.version ?? 'from before 0.7.3') + ') is still deciding on this machine, so checks added since then are not running in this session. '
    + (host === 'claude-code' ? 'Open /agentguard and choose Switch to hand this machine over to ' + plugin + ', or close the sessions that started the old worker.'
      : 'This version (' + plugin + ') takes over when the sessions that started the old worker are closed.');
}

// The pane's press. Leaves the note only while an older worker is the one deciding.
function request(data) {
  const {ensurePrivateIpc, writeMessage} = require('./client.cjs');
  const loc = locations(data), plugin = mine();
  const worker = current(loc);
  if (!worker) return {v: 1, ok: true, requested: false, reason: 'no_worker', to: plugin};
  if (!older(worker.version, plugin)) return {v: 1, ok: true, requested: false, reason: 'not_older', worker: worker.version, to: plugin};
  ensurePrivateIpc(loc);
  try { fs.unlinkSync(files(loc).result); } catch { /* No earlier outcome to clear. */ }
  writeMessage(files(loc).request, {to: plugin, at: new Date().toISOString()});
  return {v: 1, ok: true, requested: true, from: worker.version, to: plugin};
}

// The process the new worker should take as this session's host: the one a session-start message names, or the
// hook's own parent (Claude Code or Codex), from which the host is found as at any session start.
function hostPid(message, parent = process.ppid) {
  return Number.isSafeInteger(message?.ownerPid) && message.ownerPid > 1 ? message.ownerPid : parent;
}

// Called by every hook of this version before its own message. One file check
// when nothing was asked. It starts the hand-over as a separate process and
// returns at once: the hook's own call is answered as usual.
function maybeStart(loc, message) {
  const names = files(loc);
  if (!fs.existsSync(names.request)) return false;
  try {
    const asked = pending(loc);
    if (!asked) { try { fs.unlinkSync(names.request); } catch {} return false; }
    // A request is for the version whose pane took the press; another version's hooks leave it alone.
    if (asked.to !== mine()) return false;
    const sessionId = identifier(message?.meta?.sessionId ?? message?.sessionId, null);
    if (!sessionId || sessionId === 'unknown') return false;
    try {
      const stat = fs.lstatSync(names.claim);
      if (Date.now() - stat.mtimeMs <= CLAIM_LIFE_MS) return false;
      fs.unlinkSync(names.claim);
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    const fd = fs.openSync(names.claim, 'wx', 0o600); fs.closeSync(fd);
    const child = spawn(process.execPath, [__filename, 'apply', sessionId, String(hostPid(message))], {detached: true, stdio: 'ignore', env: process.env});
    child.on('error', () => { try { fs.unlinkSync(names.claim); } catch {} });
    child.unref();
    return true;
  } catch { return false; }
}

async function apply(sessionId, parentPid, options = {}) {
  const client = require('./client.cjs');
  const loc = locations(options.data), names = files(loc), plugin = mine();
  const waits = {stopMs: 4000, exitMs: 6000, readyMs: 60000, ...options.waits};
  let from = null;
  const finish = outcome => {
    if (outcome) { try { client.writeMessage(names.result, {...outcome, to: plugin, from, at: new Date().toISOString()}); } catch { /* The pane reads the worker's version either way. */ } }
    try { fs.unlinkSync(names.request); } catch {}
    try { fs.unlinkSync(names.claim); } catch {}
    return outcome;
  };
  try {
    const asked = pending(loc);
    if (!asked || asked.to !== plugin) { try { fs.unlinkSync(names.claim); } catch {} return null; }
    const host = require('./live-sessions.cjs').findHost(parentPid) ?? {};
    const begin = () => client.request({control: 'session-start', sessionId, ...host}, {data: options.data, timeoutMs: Math.min(waits.readyMs, 25000), noSwitch: true}).catch(() => {});
    for (let attempt = 0; attempt < 3; attempt++) {
      const worker = current(loc);
      if (worker && !older(worker.version, plugin)) return finish({ok: true});
      if (worker) {
        from = from ?? worker.version;
        // The same request `control.cjs stop` sends: the worker finishes its writes, answers, and exits.
        try { await client.request({control: 'stop'}, {data: options.data, startWorker: false, timeoutMs: waits.stopMs, noSwitch: true}); }
        catch { return finish({ok: false, reason: 'old_worker_did_not_answer'}); }
        const until = Date.now() + waits.exitMs;
        const alive = () => { try { process.kill(worker.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
        while (alive() && Date.now() < until) await sleep(2);
        if (alive()) return finish({ok: false, reason: 'old_worker_still_running'});
      }
      // This version's worker, started the way any hook starts one, and told of this session.
      await begin();
      const until = Date.now() + waits.readyMs;
      while (!current(loc) && Date.now() < until) await sleep(20);
      const now = current(loc);
      if (!now) return finish({ok: false, reason: 'new_worker_did_not_start'});
      if (!older(now.version, plugin)) return finish({ok: true});
      // A session on an older version made a call in the gap and started its own worker: once more.
    }
    return finish({ok: false, reason: 'older_session_restarted_its_worker'});
  } catch { return finish({ok: false, reason: 'new_worker_did_not_start'}); }
}

module.exports = {request, maybeStart, apply, pending, switchStatus, current, older, olderWorkerLine, hostPid, files, REQUEST_LIFE_MS, CLAIM_LIFE_MS, RESULT_LIFE_MS};
if (require.main === module) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === 'apply') apply(first, second).then(() => process.exit(0), () => process.exit(1));
  else if (mode === 'request') {
    let out;
    try { out = request(first === '--data' && second ? path.resolve(second) : require('./mod-status.cjs').dataDirectory(process.env)); }
    catch { out = {v: 1, ok: false, error: 'switch_unavailable'}; }
    process.stdout.write(JSON.stringify(out) + '\n');
  } else { process.stderr.write('Usage: node runtime/worker-switch.cjs request [--data <folder>]\n'); process.exitCode = 1; }
}
