#!/usr/bin/env node
'use strict';
// What the AgentGuard mod draws in Claude Code, read without changing anything.
// Sub-agent counts and session tokens come from Burn's gateway session, the
// state the burn gate decides on, summed with Burn's own windowSum. Decisions
// come from this plugin's signed ledger through the read-only reader. Nothing
// here decides: the settings hooks do, and this only reports what they did.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createReader} = require('./mcp.cjs');
const {locations, SPAWN} = require('./common.cjs');

const ROWS = 25;   // decision rows the pane can show
const SCAN = 400;  // newest ledger rows searched for this session's decisions

// Claude Code gives the settings hooks CLAUDE_PLUGIN_DATA but not a mod's
// processes, so the installed plugin's folder is found by its name: agentguard
// then its marketplace, or agentguard-inline for --plugin-dir. When there are
// several, the one whose ledger changed last is this machine's live one.
function dataDirectory(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA) return locations().data;
  const base = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'data');
  let names = [];
  try { names = fs.readdirSync(base); } catch { names = []; }
  let best = null, bestTime = -1;
  for (const name of names) {
    if (!/^agentguard-[A-Za-z0-9_-]+$/.test(name)) continue;
    const dir = path.join(base, name);
    let time;
    try { time = fs.statSync(path.join(dir, 'ledger', 'decisions.ndjson')).mtimeMs; }
    catch { try { time = fs.statSync(path.join(dir, 'public-key.hex')).mtimeMs; } catch { continue; } }
    if (time > bestTime) { best = dir; bestTime = time; }
  }
  return best ?? path.join(os.homedir(), '.agentguard', 'codex-plugin');
}

// Burn's limits for this session, as the burn gate evaluates them: the burst
// window (15 in 15 active minutes) allows stop - 1, the longer window (40 in
// 120) allows stop, and the session token ceiling is sustained.stopTokens.
function burnStatus(sessionId, env = process.env) {
  const burn = require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
  const home = path.resolve(env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));
  const policyFile = path.join(home, 'burn-policy.json');
  const policy = fs.existsSync(policyFile) ? burn.loadPolicy(home, {notice: false}) : burn.DEFAULT_POLICY;
  const t = policy.thresholds ?? burn.DEFAULT_THRESHOLDS;
  // No sessions folder means no launch was ever gated here: report zeros and
  // create nothing.
  const view = fs.existsSync(path.join(home, 'sessions')) ? new burn.Gateway(home, {sign: false}).peek(sessionId) : null;
  const state = view?.state;
  const sum = minutes => state ? burn.windowSum(state.spawnsByActiveMinute, state.activeMinutes, minutes) : 0;
  return {
    // The engine seeds Burn's policy in enforce mode on the first gated launch,
    // so a missing file already means enforce (Engine.burnEnforcing).
    mode: fs.existsSync(policyFile) ? policy.mode : 'enforce',
    burst: {count: sum(t.spawnRate.windowActiveMinutes), limit: t.spawnRate.stop - 1,
      windowActiveMinutes: t.spawnRate.windowActiveMinutes, enforced: t.spawnRate.enforce !== false},
    sustained: {count: sum(t.fanout.windowActiveMinutes), limit: t.fanout.stop, windowActiveMinutes: t.fanout.windowActiveMinutes},
    tokens: {used: state?.totalTokens ?? 0, limit: t.sustained.stopTokens},
    spawns: state?.spawnCount ?? 0,
    running: view?.liveSpawns ?? 0,
    seen: view !== null,
  };
}

// One row of the pane. An asked launch is recorded as a block with asked set:
// the person answered Claude Code's prompt, and an outcome row means it ran.
function result(row, ran) {
  if (row.asked) return ran.has(row.decisionId) ? 'allowed by you' : 'asked you';
  if (row.event === 'fail_open') return 'allowed, check failed open';
  if (row.event === 'fail_closed' || row.action === 'block') return 'stopped';
  if (row.action === 'shadow') return 'flagged';
  return SPAWN.has(row.toolName) ? 'started' : 'allowed';
}

// The work receipt of the last session that ended, counts only, with its
// ledger row number. The newest rows are searched first; an older receipt is
// read once more from the ledger. The pane's signature check covers its row.
async function lastReceipt(reader, rows, total) {
  const row = rows.findLast(item => item.event === 'session_receipt' && item.receipt);
  if (row) return {sequence: row.sequence, at: row.timestamp, sessionId: row.actor?.sessionId ?? null, ...row.receipt};
  if (total <= rows.length) return null;
  const latest = await reader.latestWorkReceipt();
  if (!latest) return null;
  const counts = {...latest};
  for (const key of ['sequence', 'entryHash', 'signedAt', 'sessionId', 'host']) delete counts[key];
  return {sequence: latest.sequence, at: latest.signedAt, sessionId: latest.sessionId, ...counts};
}

async function ledgerStatus(sessionId, dataDir, verify) {
  const reader = createReader({dataDir});
  const total = (await reader.call('list_decisions', {fromSequence: 0, limit: 1})).totalEntries;
  const rows = [];
  for (let sequence = Math.max(0, total - SCAN); sequence !== null && sequence < total;) {
    const page = await reader.call('list_decisions', {fromSequence: sequence, limit: 200});
    rows.push(...page.entries);
    sequence = page.nextSequence;
  }
  const ran = new Set(rows.filter(row => row.entryType === 'outcome').map(row => row.originalDecisionId));
  const mine = rows.filter(row => row.actor?.sessionId === sessionId && row.entryType !== 'outcome'
    && ['decision', 'fail_open', 'fail_closed'].includes(row.event));
  // Launches, and anything that was not a plain allow: the rows a person reads.
  const shown = mine.filter(row => SPAWN.has(row.toolName) || row.action !== 'allow' || row.asked);
  // Each launch by its tool call, so the mod can stamp Claude Code's own row: the latest row wins.
  const launches = {};
  for (const row of mine) if (SPAWN.has(row.toolName) && typeof row.toolUseId === 'string') launches[row.toolUseId] = {sequence: row.sequence, result: result(row, ran)};
  const status = await reader.call('get_status', {sessionId});
  const ledger = {entries: total, verified: null};
  if (verify) {
    const check = await reader.call('verify_chain', {});
    ledger.verified = check.ok === true;
    ledger.signer = typeof check.publicKeyHex === 'string' ? check.publicKeyHex.slice(0, 16) : null;
  }
  return {
    license: {tier: status.license?.tier ?? 'free', paid: status.license?.paid === true, mode: status.license?.mode ?? null},
    ledger,
    receipt: await lastReceipt(reader, rows, total),
    launches,
    recorded: mine.length,
    asked: mine.filter(row => row.asked).length,
    stopped: mine.filter(row => !row.asked && (row.action === 'block' || row.event === 'fail_closed')).length,
    decisions: shown.slice(-ROWS).reverse().map(row => ({sequence: row.sequence, at: row.timestamp, tool: row.toolName,
      result: result(row, ran), reason: row.reasons?.[0] ?? null})),
  };
}

async function status(args, env = process.env) {
  const sessionId = args.session;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(sessionId)) return {v: 1, ok: false, error: 'session_required'};
  const out = {v: 1, ok: true, sessionId, at: new Date().toISOString()};
  try { out.burn = burnStatus(sessionId, env); } catch (error) { out.burn = null; out.burnError = 'burn_unavailable'; if (env.AGENTGUARD_MOD_STATUS_DEBUG === '1') out.burnDebug = String(error?.message ?? error).slice(0, 300); }
  if (args.fields) try {
    const burn = require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
    out.fields = await burn.readStatusMetrics(path.resolve(env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard')), sessionId, args.fields, args.data ? path.resolve(args.data) : dataDirectory(env));
  } catch { out.fields = {}; }
  try { out.ledger = await ledgerStatus(sessionId, args.data ? path.resolve(args.data) : dataDirectory(env), args.verify === true); }
  catch (error) { out.ledger = null; out.ledgerError = 'ledger_unavailable'; if (env.AGENTGUARD_MOD_STATUS_DEBUG === '1') out.debug = String(error?.message ?? error).slice(0, 300); }
  if (!out.burn && !out.ledger) return {v: 1, ok: false, sessionId, error: 'status_unavailable'};
  return out;
}

function parse(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') args.session = argv[++i];
    else if (argv[i] === '--data') args.data = argv[++i];
    else if (argv[i] === '--verify') args.verify = true;
    else if (argv[i] === '--fields') args.fields = argv[++i];
  }
  return args;
}

module.exports = {status, dataDirectory, burnStatus, ledgerStatus, parse};
if (require.main === module) {
  status(parse(process.argv.slice(2)))
    .then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(() => process.stdout.write(JSON.stringify({v: 1, ok: false, error: 'status_unavailable'}) + '\n'));
}
