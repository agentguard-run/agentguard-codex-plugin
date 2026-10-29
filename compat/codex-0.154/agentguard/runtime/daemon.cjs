'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { locations, writeWorkerPid } = require('./common.cjs');
const { ensurePrivateIpc, readPrivate, writeMessage } = require('./client.cjs');
const loc = locations();
let watcher, idle, rescan, engine, health, live, heartbeats, heartbeatTimer, teamCaps, stopPromise, draining = false, stopped = false;
function ownsWorker() {
  try { return readPrivate(loc.lock) === String(process.pid); } catch { return false; }
}
function stop(responsePath) {
  if (stopPromise) return stopPromise;
  stopped = true; clearTimeout(idle); clearInterval(rescan); clearInterval(heartbeatTimer); heartbeats?.stop(); watcher?.close();
  stopPromise = (async () => {
    let timer;
    try {
      // Grants this worker still holds go back to the team; a release that
      // does not finish in time is closed by the server after the next day.
      await Promise.race([
        Promise.all([engine?.flush(), health?.persist(), live?.persist(), teamCaps?.releaseAll().catch(() => {})]),
        new Promise(resolve => { timer = setTimeout(resolve, 1500); }),
      ]);
    } catch { /* An unconfirmed tail is reconciled at the next startup. */ }
    finally { clearTimeout(timer); }
    if (responsePath) { try { writeMessage(responsePath, {}); } catch {} }
    if (ownsWorker()) { try { fs.unlinkSync(loc.lock); } catch {} try { fs.unlinkSync(loc.ready); } catch {} }
    process.exit(0);
  })();
  return stopPromise;
}
function touch() {
  clearTimeout(idle);
  idle = setTimeout(() => { if (live?.ids().length) touch(); else void stop(); }, 300000);
}
async function main() {
  ensurePrivateIpc(loc);
  const owner = Number(readPrivate(loc.lock));
  if (owner !== process.pid && owner !== process.ppid) return;
  writeWorkerPid(loc.lock, process.pid);
  const { Engine } = require('./engine.cjs');
  const {HealthTracker} = require('./health.cjs');
  health = new HealthTracker({data: loc.data});
  health.recordPending();
  engine = new Engine(); await engine.init();
  // Team caps: reserve and release run here, in the background, never in a hook.
  teamCaps = new (require('./team-caps.cjs').TeamCapsClient)({data: loc.data});
  engine.attachTeamCaps(teamCaps);
  const counts = new (require('./counts-sync.cjs').DailyCountsScheduler)({data: loc.data, flush: () => engine.flush()});
  for (const sessionId of engine.tally.receipts.keys()) counts.completed(sessionId);
  live = new (require('./live-sessions.cjs').LiveSessions)({data: loc.data});
  const starts = new Map();
  function loadOrg(sessionId) { engine.clearSessionFailure(sessionId, 'org'); try { engine.context({sessionId}); } catch { engine.orgPolicyDigests?.delete(sessionId); } }
  heartbeats = new (require('./seat-heartbeat.cjs').SeatHeartbeatScheduler)({data: loc.data, isLive: id => live.confirmHost(id),
    orgPolicyDigest: id => engine.orgPolicyDigests?.get(id) ?? null, onOrgRefresh: loadOrg,
    onOrgFailure: (id, reason) => engine.recordOrgFailure(id, reason),
    onSeatRefresh: (id, value) => require('./worker-session.cjs').recoverSeatState(engine, id, value),
    onSeatFailure: (id, reason) => engine.setSessionFailure(id, 'seat', reason)});
  function beginSession(message) {
    const {policy, personal} = require('./policy-file.cjs').readPolicy(loc.data);
    const key = require('./license.cjs').configuredKey(policy);
    const tag = JSON.stringify([message.sessionId, key]);
    if (message.control === 'license-refresh') starts.delete(tag);
    if (!starts.has(tag)) {
      // A restarted worker must not trust a previously ready disk file before
      // it has re-observed the seat, including revocations it could not save.
      engine.setSessionFailure(message.sessionId, 'startup', engine.preferredSessionFailure(message.sessionId) === 'seat_revoked' ? 'seat_revoked' : 'license_unavailable');
      const work = require('./worker-session.cjs').refreshWorkerSession({data: loc.data, sessionId: message.sessionId, policy, personalPolicy: personal,
        forceActivation: true, orgPolicySha256: engine.orgPolicyDigests?.get(message.sessionId) ?? null})
        .then(status => { if (starts.get(tag) !== work) return status; require('./worker-session.cjs').recoverSessionState(engine, message.sessionId, status); loadOrg(message.sessionId); if (status.policySyncFailed) engine.recordOrgFailure(message.sessionId, 'org_policy_unavailable'); observe(message.sessionId, message.ownerPid, message.ownerIdentity); teamCaps.sessionStarted(message.sessionId); return status; });
      starts.set(tag, work);
      work.catch(error => { if (starts.get(tag) !== work) return; starts.delete(tag); engine.setSessionFailure(message.sessionId, 'startup', error?.code === 'seat_revoked' ? 'seat_revoked' : error?.source === 'org' ? 'org_policy_unavailable' : 'license_unavailable'); });
    }
    return starts.get(tag);
  }
  function observe(sessionId, ownerPid, ownerIdentity) {
    live.observe(sessionId, ownerPid, ownerIdentity);
    try { heartbeats.observe(sessionId, require('./policy-file.cjs').readPolicy(loc.data).policy); } catch {}
  }
  for (const id of live.ids()) {
    try { heartbeats.observe(id, require('./policy-file.cjs').readPolicy(loc.data).policy); void beginSession({control: 'session-start', sessionId: id}).catch(() => {}); } catch {}
  }
  // Network renewal runs independently of gate handling and never delays replies.
  heartbeatTimer = setInterval(() => {
    try {
      const policy = require('./policy-file.cjs').readPolicy(loc.data).policy;
      for (const id of live.ids()) heartbeats.observe(id, policy);
    } catch {}
    void heartbeats.tick().catch(() => {}); void live.persist().catch(() => {}); void counts.tick(); teamCaps.tick(live.ids());
  }, 1000);
  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        if (!ownsWorker()) return stop();
        const name = fs.readdirSync(loc.ipc).filter(name => /^\d{16}-\d+-[a-f0-9-]{36}\.request$/.test(name)).sort()[0];
        if (!name) break;
        const input = path.join(loc.ipc, name), output = input.replace(/\.request$/, '.response');
        let message;
        try { message = JSON.parse(readPrivate(input)); }
        catch { try { fs.unlinkSync(input); } catch {} continue; }
        try { fs.unlinkSync(input); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        touch();
        if (message.control === 'stop') return stop(output);
        if (message.control === 'policy-push') {
          // The license is read from a live session's cached status, so a push
          // never resolves a synthetic session over the network.
          const sessionId = live.ids().includes(message.sessionId) ? message.sessionId : live.ids()[0] ?? message.sessionId;
          void require('./org-policy-refresh.cjs').pushPersonalPolicy({data: loc.data, sessionId})
            .then(result => {
              require('./worker-session.cjs').recordPushResult(engine, live.ids(), result, loadOrg);
              writeMessage(output, result.error ? {error: result.error} : {sha256: result.sha256, version: result.version});
            }).catch(() => { writeMessage(output, {error: 'Policy sync unavailable. Local policy is unchanged.'}); });
          continue;
        }
        if (message.control === 'benchmark-consent') {
          engine.benchmarkConsent(message.runId, message.granted !== false)
            .then(result => writeMessage(output, result))
            .catch(error => writeMessage(output, {error: error?.message === 'benchmark_run_id_invalid' ? 'Run id must be 1 to 256 letters, digits, dots, colons, underscores or dashes.' : 'Benchmark consent unavailable. Enforcement is unchanged.'}));
          continue;
        }
        if (message.control === 'origin-clear') {
          // The owner's clear-origin command, from their own terminal.
          const id = message.sessionId === 'all' ? 'all' : require('./common.cjs').identifier(message.sessionId, null);
          if (!id) { writeMessage(output, {error: 'Use a session id or all.'}); continue; }
          engine.clearOrigins(id).then(result => writeMessage(output, result))
            .catch(() => writeMessage(output, {error: 'Clear unavailable. The mark is unchanged.'}));
          continue;
        }
        if (message.control === 'effective-license') {
          try {
            const state = engine.context({sessionId: message.sessionId});
            writeMessage(output, {license: {...state.license, mode: state.mode, orgPolicySha256: state.orgPolicy?.sha256 ?? null, orgPolicyVersion: state.orgPolicy?.version ?? null}});
          } catch { writeMessage(output, {license: {mode: 'shadow', reason: 'policy_invalid'}}); }
          continue;
        }
        if (['session-start', 'session-end', 'license-refresh'].includes(message.control)) {
          if (message.control === 'session-end') {
            for (const tag of starts.keys()) { if (JSON.parse(tag)[0] === message.sessionId) starts.delete(tag); }
            live.forget(message.sessionId); heartbeats.forget(message.sessionId); engine.orgPolicyDigests?.delete(message.sessionId);
            // The last live session ended: the team's allowance this machine holds goes back.
            if (!live.ids().length) void teamCaps.releaseAll().catch(() => {});
            // Sign a fresh closing summary after new session activity, before
            // the reply. An unchanged repeated ending stays idempotent.
            let receipt = null;
            if (message.receipt && typeof message.receipt === 'object') {
              try { receipt = await engine.sessionReceipt({sessionId: message.sessionId, transcriptPath: message.receipt.transcriptPath}); }
              catch { receipt = {receipt: 'failed'}; }
            }
            writeMessage(output, receipt ?? {});
            if (receipt) {
              engine.afterReply();
              if (['appended', 'duplicate'].includes(receipt.receipt)) { counts.completed(message.sessionId); void counts.tick(); }
            }
          }
          else {
            observe(message.sessionId, message.ownerPid, message.ownerIdentity);
            // Never await a network operation in the gate drain. Activation
            // receives a later file reply; SessionStart returns immediately.
            const activation = message.control === 'license-refresh';
            try {
              void beginSession(message).then(status => { if (activation) writeMessage(output, {license: status}); })
                .catch(() => { if (activation) writeMessage(output, {license: {paid: false, mode: 'shadow', tier: 'free', reason: 'license_unavailable'}}); });
            } catch { if (activation) writeMessage(output, {license: {paid: false, mode: 'shadow', tier: 'free', reason: 'license_unavailable'}}); }
            if (!activation) writeMessage(output, {});
          }
          void live.persist().catch(() => {}); continue;
        }
        try {
          health.recordPending();
          const result = await engine.handle(message);
          const snapshot = health.record({requestId: message.meta?.requestId, gate: message.meta?.gate,
            startedAt: message.meta?.startedAt, failOpen: result.warning === true,
            cause: result.cause || (result.warning ? 'policy_or_runtime_error' : undefined)});
          if (snapshot.warning) result.healthWarning = snapshot.warning;
          writeMessage(output, result);
        } catch {
          health.record({requestId: message.meta?.requestId, gate: message.meta?.gate,
            startedAt: message.meta?.startedAt, failOpen: true, cause: 'worker_request'});
          writeMessage(output, {transportError: 'worker_request'});
        } finally {
          // Publish the reply before scheduling durability or metric storage.
          engine.afterReply();
          if (message.meta?.sessionId) live.observe(message.meta.sessionId);
          void health.persist().catch(() => {});
        }
      }
    } catch { stop(); }
    finally { draining = false; }
  }
  function cleanup() {
    const now = Date.now();
    for (const name of fs.readdirSync(loc.ipc)) {
      if (!/^\d{16}-\d+-[a-f0-9-]{36}\.(request|response)$/.test(name)) continue;
      const file = path.join(loc.ipc, name);
      try { if (now - fs.lstatSync(file).mtimeMs > 30000) fs.unlinkSync(file); } catch {}
    }
  }
  cleanup();
  function scheduleRescan(intervalMs) {
    clearInterval(rescan);
    let cleanedAt = Date.now();
    rescan = setInterval(() => {
      if (Date.now() - cleanedAt >= 1000) { cleanup(); cleanedAt = Date.now(); }
      void drain();
    }, intervalMs);
  }
  function pollingFallback() {
    watcher?.close(); watcher = undefined; scheduleRescan(4);
  }
  // Watching provides the fast path. Sandboxed hosts may disallow filesystem
  // watchers, so bounded local polling remains available without a socket.
  try {
    watcher = fs.watch(loc.ipc, () => { void drain(); });
    watcher.on('error', pollingFallback);
    // A watcher can coalesce or omit an event without reporting an error.
    // Its backup must run inside the warm hook deadline, even on a quiet host.
    scheduleRescan(25);
  } catch { pollingFallback(); }
  writeMessage(loc.ready, { pid: process.pid, transport: 'files-v1' });
  touch(); engine.afterReply(); void health.persist().catch(() => {}); void drain();
  process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
}
main().catch(() => { void stop(); });
