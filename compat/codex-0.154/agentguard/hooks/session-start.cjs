#!/usr/bin/env node
'use strict';
// The hook only starts a separate lifecycle process. It never resolves a key,
// waits for a service, or opens a socket.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const text = fs.readFileSync(0, 'utf8');
// The first-run line describes enforcement, so it waits while this plugin's
// policy or license selects shadow, or while Burn's own policy chose shadow.
// With no Burn policy yet, the plugin writes one in enforce mode before the
// first spawn it gates.
function enforcing(sessionId) {
  const {locations} = require('../runtime/common.cjs');
  const state = require('../runtime/policy-state.cjs').policyState(locations().data, typeof sessionId === 'string' ? sessionId : 'unknown');
  if (state.license.mode === 'shadow' || (state.config.mode ?? 'enforce') !== 'enforce') return false;
  let burn;
  try { burn = JSON.parse(fs.readFileSync(path.join(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'), 'burn-policy.json'), 'utf8')); }
  catch (error) { return error.code === 'ENOENT'; }
  return burn?.mode === 'enforce' && Boolean(burn.thresholds);
}
// A Burn policy file that exists but that Burn ignores (bad JSON, no "mode", no
// "thresholds") leaves the defaults, which only watch: enforcement is off and
// nothing said so. Burn 0.3.21 names the file and the fix in one line; this
// shows it word for word. Burn 0.3.20 has no such check.
function ignoredPolicyLine() {
  const burn = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/burn');
  if (typeof burn.checkPolicyFile !== 'function') return null;
  const check = burn.checkPolicyFile(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));
  return check?.status === 'ignored' && typeof check.line === 'string' ? check.line : null;
}
function normal() {
let sessionId, source;
try {
  const raw = JSON.parse(text);
  sessionId = raw.session_id || raw.sessionId;
  if (typeof raw.source === 'string') source = raw.source;
  if (typeof sessionId !== 'string' || sessionId.length > 512 || !sessionId) throw new Error();
  const child = spawn(process.execPath, [path.join(__dirname, '../runtime/session-start.cjs'), sessionId, String(process.ppid)],
    {detached: true, stdio: 'ignore', env: process.env});
  child.on('error', () => {});
  child.unref();
} catch { process.stderr.write('agentguard: session startup unavailable; cached license or shadow mode applies.\n'); }
// Without its dependencies the engine cannot run and every tool call fails
// open, so AgentGuard is not on. Say that in one line with the folder to fix,
// and show or use up no once-only line (first run, presets, version, Score)
// until the dependencies load.
let missing = null;
try { missing = require('../runtime/dependencies.cjs').missingDependenciesNotice(); } catch { /* Startup continues as before. */ }
if (missing) { process.stdout.write(JSON.stringify({systemMessage: missing}) + '\n'); return; }
// An ignored policy file is an error, so its line shows even with quiet on,
// comes first, and holds the first-run line (which says limits are on) unclaimed.
let policyLine = null;
try { policyLine = ignoredPolicyLine(); } catch { /* The check never affects startup. */ }
let output = {};
const moments = require('../runtime/upgrade-moments.cjs');
try {
  const data = require('../runtime/common.cjs').locations().data;
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  if (moments.quiet()) throw new Error('quiet');
  fs.writeFileSync(path.join(data, 'policy-preset-hint-seen'), '1\n', {flag: 'wx', mode: 0o600});
  // A command the person can paste, with this plugin's absolute paths.
  const host = require('../runtime/common.cjs').hostContext();
  output = {systemMessage: moments.presetHint({root: host.root || path.resolve(__dirname, '..'), data: host.data, host: host.host})};
} catch { /* A missing hint must never affect session startup. */ }
try {
  const data = require('../runtime/common.cjs').locations().data;
  const policy = require('../runtime/policy-cli.cjs').localPolicy(data);
  if (!require('../runtime/license.cjs').configuredKey(policy)) {
    const message = moments.whatsNew(require('../package.json').version);
    if (message) output.systemMessage = [output.systemMessage, message].filter(Boolean).join('\n');
  }
} catch { /* Version copy never affects startup. */ }
try {
  // The first session on a model this machine has not run: one line, once per
  // model. Claude Code sends `model` at startup only sometimes; a later switch
  // reaches the model switch hook instead. Codex names the model on every hook
  // call; its line leaves out Claude Code's /doctor prompt-audit.
  const host = require('../runtime/common.cjs').hostContext().host;
  const line = require('../runtime/model-switch.cjs').firstSeen(JSON.parse(text).model, {host});
  if (line) output.systemMessage = [output.systemMessage, line].filter(Boolean).join('\n');
} catch { /* The model line never affects startup. */ }
try {
  // Once per machine; its claim is taken only when shown. It is placed first,
  // ahead of the long preset command, so the person reads it before anything else.
  const line = moments.firstRun({host: require('../runtime/common.cjs').hostContext().host, enforcing: !policyLine && enforcing(sessionId)});
  if (line) output.systemMessage = [line, output.systemMessage].filter(Boolean).join('\n');
} catch { /* The first-run line never affects startup. */ }
try {
  // The invitation waits for a session with nothing else to say. Its claim is
  // only taken when it is shown, so a later quiet startup still carries it.
  if (!output.systemMessage && !policyLine) {
    const invite = moments.scoreInvite();
    if (invite) output.systemMessage = invite;
  }
} catch { /* The invitation never affects startup. */ }
if (policyLine) output.systemMessage = [policyLine, output.systemMessage].filter(Boolean).join('\n');
try {
  // The tip from the last session comes after every other line and uses up
  // none of them. It reads one small file and waits for nothing.
  const tip = require('../runtime/session-tip.cjs').take({sessionId, source});
  if (tip) output.systemMessage = [output.systemMessage, tip].filter(Boolean).join('\n');
} catch { /* The tip never affects startup. */ }
process.stdout.write(JSON.stringify(output) + '\n');
}
// Benchmark mode handles the call only with the operator's signed consent for
// this run; otherwise the normal lifecycle path runs.
if (process.env.AGENTGUARD_BENCHMARK === '1') require('../runtime/benchmark.cjs').run('session-start', text).then(handled => { if (!handled) normal(); });
else normal();
