'use strict';
// Work receipts. When a session ends, the worker appends one signed, chained
// ledger row, a `session_receipt`, that sums the session up in counts: when it
// was active, the tokens Burn recorded, the sub-agents that started, finished
// or ended without finishing, and this plugin's decisions by result. Counts
// only, so both sides of a deal priced on results can trust it, and it never
// holds a prompt, path, command or any other content. A count that cannot be
// proved is left out, never guessed and never set to 0.
//
// The hook sends the request with its session-end message and waits a bounded
// time; the worker builds the receipt from what it already holds: its own
// tally of the ledger rows it wrote, and Burn's reader for the session's
// transcripts. A request the worker could not take is kept in a small local
// file and written at the worker's next start, from the ledger alone.
const fs = require('node:fs');
const path = require('node:path');
const {identifier, SPAWN} = require('./common.cjs');

const RECEIPT_EVENT = 'session_receipt';
const RECEIPT_VERSION = 1;
const SPOOL = 'session-receipts-pending.ndjson';
// The gates whose rows describe a session's tool calls.
const GATES = new Set(['spend', 'burn', 'receipt']);
// A Claude Code sub-agent transcript in the session's `subagents` folder, as
// Burn names it (history/subagent-signals.ts): the sub-agent id is in the name.
const SUBAGENT_FILE = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.jsonl$/;
// A session this plugin never read is read whole at its end only when that
// fits in one short pause of the worker, which answers every session's gates
// one request at a time; a larger one leaves Burn's counts out.
const UNREAD_LIMIT_BYTES = 8 * 1024 * 1024;
const SUBAGENT_KEYS = ['started', 'finished', 'endedWithoutFinishing'];
const DECISION_KEYS = ['allowed', 'asked', 'saidYes', 'saidNo', 'stopped'];
const FIELDS = new Set(['version', 'firstActivityAt', 'lastActivityAt', 'tokens', 'tokenCoverage', 'subagents', 'decisions', 'delegations', 'burnPolicyMode', 'pluginVersion']);
// A delegation row: another agent's message entered the session (untrusted origin).
const DELEGATION_EVENT = 'delegation';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const iso = at => new Date(at).toISOString();

// The one schema for a receipt. The worker checks every receipt with it before
// signing, and the read-only reader checks every receipt row with it, so the
// two can never disagree about a row (the 0.3.15 class of failure).
function validateReceipt(receipt) {
  const fail = () => { throw new Error('Work receipt metadata is invalid.'); };
  if (!plain(receipt) || Object.keys(receipt).some(key => !FIELDS.has(key))) fail();
  if (receipt.version !== RECEIPT_VERSION) fail();
  if (typeof receipt.pluginVersion !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/.test(receipt.pluginVersion)) fail();
  const first = receipt.firstActivityAt, last = receipt.lastActivityAt;
  if ((first === undefined) !== (last === undefined)) fail();
  if (first !== undefined && (!instant(first) || !instant(last) || Date.parse(first) > Date.parse(last))) fail();
  if (receipt.tokens !== undefined && !count(receipt.tokens)) fail();
  if (receipt.tokenCoverage !== undefined && !['authoritative', 'estimated'].includes(receipt.tokenCoverage)) fail();
  if (receipt.burnPolicyMode !== undefined && receipt.burnPolicyMode !== 'enforce' && receipt.burnPolicyMode !== 'shadow') fail();
  const subagents = receipt.subagents;
  if (subagents !== undefined) {
    if (!plain(subagents) || Object.keys(subagents).length !== SUBAGENT_KEYS.length || SUBAGENT_KEYS.some(key => !count(subagents[key]))) fail();
    if (subagents.finished + subagents.endedWithoutFinishing > subagents.started) fail();
  }
  const decisions = receipt.decisions;
  if (decisions !== undefined) {
    if (!plain(decisions) || Object.keys(decisions).some(key => !DECISION_KEYS.includes(key))) fail();
    if (['allowed', 'asked', 'saidYes', 'stopped'].some(key => !count(decisions[key]))) fail();
    if (decisions.saidNo !== undefined && !count(decisions.saidNo)) fail();
    if (decisions.saidYes + (decisions.saidNo ?? 0) > decisions.asked) fail();
  }
  // Present only when at least one message from another agent entered the session.
  if (receipt.delegations !== undefined && (!count(receipt.delegations) || receipt.delegations < 1)) fail();
  return receipt;
}

// What each tool call of a session came to, kept by the worker as it writes
// rows (and rebuilt from the ledger when it starts), so a receipt never needs
// another pass over the ledger. Only rows for tool calls count; a call's result
// is its latest row from the gate that decides it: Burn for sub-agent
// launches, the spend gate for every other tool.
class SessionTally {
  constructor() { this.sessions = new Map(); this.receipted = new Set(); this.receipts = new Map(); }
  observe(decision) {
    const meta = decision?.plugin;
    if (!plain(meta) || typeof meta.sessionId !== 'string') return;
    const id = meta.sessionId;
    if (meta.event === RECEIPT_EVENT) { this.receipted.add(id); this.receipts.set(id, decision); return; }
    const delegation = meta.event === DELEGATION_EVENT && meta.gate === 'control';
    if (!GATES.has(meta.gate) && !delegation) return;
    // New activity invalidates the old ending, while cumulative call identities
    // remain available for a fresh linked receipt after resume or worker restart.
    this.receipted.delete(id);
    let session = this.sessions.get(id);
    if (!session) { session = {first: null, last: null, calls: new Map(), ran: new Set(), delegations: 0}; this.sessions.set(id, session); }
    if (delegation) session.delegations = (session.delegations ?? 0) + 1;
    const at = typeof decision.timestamp === 'string' ? Date.parse(decision.timestamp) : NaN;
    if (Number.isFinite(at)) { session.first = session.first === null ? at : Math.min(session.first, at); session.last = session.last === null ? at : Math.max(session.last, at); }
    const call = typeof meta.toolUseId === 'string' ? meta.toolUseId : null;
    if (!call) return;
    // The host reported the call's result, so the call ran.
    if (meta.gate === 'receipt') { session.ran.add(call); return; }
    if (!['decision', 'fail_open', 'fail_closed'].includes(meta.event)) return;
    if (meta.gate === 'burn' ? !SPAWN.has(meta.toolName) : SPAWN.has(meta.toolName)) return;
    // A launch left to the person's own Burn hook was not decided here.
    if ([meta.reasonCode, meta.policyReasonCode].includes('burn_external_hook')) { session.calls.delete(call); return; }
    const result = meta.asked === true || typeof meta.approvalRuleId === 'string' ? 'asked'
      : meta.event === 'fail_closed' || decision.action === 'block' ? 'stopped' : 'allowed';
    session.calls.set(call, result);
  }
  // Decisions by result, and the first and last row of the session. Asked
  // counts every call held for the person's answer; said yes, the ones that
  // then ran. Hosts do not report a refusal, so said no is known only when
  // every ask ran (it is then 0) and is otherwise left out.
  counts(sessionId) {
    const session = this.sessions.get(sessionId);
    let allowed = 0, asked = 0, saidYes = 0, stopped = 0;
    for (const [call, result] of session?.calls ?? []) {
      if (result === 'asked') { asked++; if (session.ran.has(call)) saidYes++; }
      else if (result === 'stopped') stopped++;
      else allowed++;
    }
    return {first: session?.first ?? null, last: session?.last ?? null,
      decisions: {allowed, asked, saidYes, ...(asked === saidYes ? {saidNo: 0} : {}), stopped},
      ...(session?.delegations ? {delegations: session.delegations} : {})};
  }
}

// Sub-agents as Burn's reader saw them in the session's transcripts: each
// sub-agent transcript is one that started; finished and ended without
// finishing are Burn's own signals (subagent-signals.ts). Unknown, and left
// out, without a Burn 0.3.21 reader or when sub-agent lines sit in the
// session transcript itself, where no sub-agent transcript exists.
function subagentCounts(cursor) {
  if (!cursor || !(cursor.children instanceof Map) || !(cursor.completed instanceof Set) || !(cursor.depthByUuid instanceof Map)) return undefined;
  for (const depth of cursor.depthByUuid.values()) if (depth > 0) return undefined;
  let started = 0, finished = 0, endedWithoutFinishing = 0;
  for (const name of cursor.children.keys()) {
    const id = SUBAGENT_FILE.exec(name)?.[1];
    if (!id) continue;
    started++;
    if (cursor.completed.has(id)) finished++;
    else if (cursor.ended?.has(id) && !cursor.resumed?.has(id)) endedWithoutFinishing++;
  }
  return {started, finished, endedWithoutFinishing};
}

// The tokens Burn recorded for the session, from its own session record, only
// when every usage it recorded is authoritative (read from the transcripts).
function recordedTokens(view) {
  const usage = view?.usage, total = view?.state?.totalTokens;
  if (!plain(usage) || !(usage.authoritative > 0 || usage.estimated > 0) || usage.missing || !count(total)) return undefined;
  return total;
}

// One receipt from counts alone. Every input is read by name and checked, so
// nothing else a caller passes can reach the row.
function buildReceipt({counts, cursor, view, burnPolicyMode, pluginVersion} = {}) {
  const receipt = {version: RECEIPT_VERSION};
  let first = Number.isFinite(counts?.first) ? counts.first : null, last = Number.isFinite(counts?.last) ? counts.last : null;
  for (const at of [view?.state?.startedAt, view?.state?.lastEventAt]) {
    if (!Number.isSafeInteger(at) || at <= 0) continue;
    first = first === null ? at : Math.min(first, at);
    last = last === null ? at : Math.max(last, at);
  }
  if (first !== null && last !== null) { receipt.firstActivityAt = iso(first); receipt.lastActivityAt = iso(last); }
  const tokens = recordedTokens(view);
  if (tokens !== undefined) { receipt.tokens = tokens; if (view.usage.estimated > 0) receipt.tokenCoverage = 'estimated'; }
  const subagents = subagentCounts(cursor);
  if (subagents) receipt.subagents = subagents;
  const decisions = counts?.decisions;
  if (plain(decisions) && ['allowed', 'asked', 'saidYes', 'stopped'].every(key => count(decisions[key]))
      && (decisions.saidNo === undefined || count(decisions.saidNo))) {
    receipt.decisions = Object.fromEntries(DECISION_KEYS.filter(key => decisions[key] !== undefined).map(key => [key, decisions[key]]));
  }
  if (count(counts?.delegations) && counts.delegations > 0) receipt.delegations = counts.delegations;
  if (burnPolicyMode === 'enforce' || burnPolicyMode === 'shadow') receipt.burnPolicyMode = burnPolicyMode;
  receipt.pluginVersion = pluginVersion;
  return validateReceipt(receipt);
}

// The transcript locator a host sends. Only its shape is checked here; the
// worker reads it through Burn.
const transcriptLocator = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && value.endsWith('.jsonl');

// Bytes in a Claude Code session's transcript and its sub-agent transcripts.
function transcriptBytes(transcriptPath) {
  let total = fs.statSync(transcriptPath).size;
  const directory = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try { names = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names) { try { total += fs.statSync(path.join(directory, name)).size; } catch { /* Gone since the listing. */ } }
  return total;
}

// What SessionEnd adds to its session-end request.
function receiptRequest(transcriptPath, now = Date.now()) {
  return {endedAt: now, ...(transcriptLocator(transcriptPath) ? {transcriptPath} : {})};
}

// How long SessionEnd waits for the worker's answer: twice the warm gate
// budget, at least half a second and at most one, inside the hook's own
// two-second timeout on both hosts (Codex caps SessionEnd at three seconds).
function receiptWaitMs(data) {
  try { return Math.min(1000, Math.max(500, 2 * require('./budget.cjs').warmBudget(data))); } catch { return 500; }
}

// SessionEnd's one request to a running worker: its session-end cleanup and,
// for a valid session id, the work receipt, which the worker writes before it
// answers. Without an answer in time the request is kept for the worker's next
// start. It never starts a worker, never throws and never prints.
async function sessionEnd({sessionId, transcriptPath, request, data, now = Date.now()}) {
  const id = identifier(sessionId, null);
  if (!id) {
    try { await request({control: 'session-end', sessionId}, {data, startWorker: false, timeoutMs: 250}); } catch { /* Liveness also ends renewal. */ }
    return 'invalid';
  }
  let reply = null;
  try { reply = await request({control: 'session-end', sessionId, receipt: receiptRequest(transcriptPath, now)}, {data, startWorker: false, timeoutMs: receiptWaitMs(data)}); }
  catch { reply = null; }
  if (reply?.receipt === 'appended' || reply?.receipt === 'duplicate') return reply.receipt;
  return spoolRequest(data, id, now) ? 'spooled' : 'lost';
}

// A request the worker could not take. Only the session id and the time
// it ended are kept; the receipt written later comes from the ledger alone.
function spoolRequest(data, sessionId, endedAt) {
  try {
    fs.mkdirSync(data, {recursive: true, mode: 0o700});
    fs.appendFileSync(path.join(data, SPOOL), JSON.stringify({sessionId, endedAt}) + '\n', {mode: 0o600});
    return true;
  } catch { return false; } // Storage failure is itself fail-open.
}

// The worker takes the waiting requests the way it takes deferred fail-open
// events: the file is renamed before it is read, so a hook appending at the
// same moment starts a new file and nothing is lost. An interrupted batch is
// read again next time; a receipt already written is never written twice.
function takeSpool(data) {
  const file = path.join(data, SPOOL), batch = file + '.recovering';
  if (!fs.existsSync(batch)) {
    try { fs.renameSync(file, batch); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  const requests = [];
  for (const line of fs.readFileSync(batch, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    const sessionId = identifier(value?.sessionId, null);
    if (sessionId) requests.push({sessionId, endedAt: Number.isSafeInteger(value.endedAt) ? value.endedAt : null});
  }
  return requests;
}
function finishSpool(data) {
  try { fs.unlinkSync(path.join(data, SPOOL) + '.recovering'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// A receipt row as the read-only tools return it: its session, host and the
// time it was signed, then the counts.
function receiptView(entry) {
  const decision = entry.decision, meta = decision.plugin;
  return {sessionId: meta.sessionId, host: meta.host ?? 'unknown', signedAt: decision.timestamp, ...meta.receipt};
}
const isReceipt = (entry, sessionId) => entry?.decision?.plugin?.event === RECEIPT_EVENT && (sessionId === undefined || entry.decision.plugin.sessionId === sessionId);

module.exports = {RECEIPT_EVENT, RECEIPT_VERSION, SPOOL, UNREAD_LIMIT_BYTES, SUBAGENT_FILE, validateReceipt, SessionTally, subagentCounts,
  recordedTokens, buildReceipt, transcriptLocator, transcriptBytes, receiptRequest, receiptWaitMs, sessionEnd, spoolRequest, takeSpool, finishSpool,
  receiptView, isReceipt};
