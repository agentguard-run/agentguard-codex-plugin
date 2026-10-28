'use strict';
// Requests that come from another AI agent are untrusted. Agent messaging
// networks put another agent's words in front of the model: through an MCP
// inbox, a reply that comes back into the session, a frame posted into the
// host's own session socket (which hosts report as a prompt), or text another
// hook injects. The model cannot be relied on to tell them apart from the
// owner's, so the limit sits outside the model: once such a message has
// entered a session, the session is marked, and calls that move money, deploy,
// delete, send or launch sub-agents wait for the owner.
//
// What marks a session: a successful inbound messaging tool, a read of a file
// another agent sent, a configured marker in a prompt or a tool result (in
// memory only), a Claude Code transcript entry whose origin is another session,
// or a marker in the newest part of a Codex transcript. What clears it: only
// evidence that the owner is back. In Claude Code, the newest prompt entry in
// the transcript says origin.kind "human" and is newer than the mark; in every
// host, a call held for the owner that the owner approved and that then ran,
// or the owner's own clear-origin command. A prompt alone proves nothing:
// hosts fire UserPromptSubmit for peer messages, sub-agent reports and
// scheduled tasks too.
//
// Only the mark is kept: {tainted, since, originTool, delegationEntryHash},
// in the worker's memory and in one small file per session under the data
// folder. No message, prompt, tool input or output, or transcript text is
// stored, logged or hashed here. Transcripts are read from their tail, within a
// fixed byte budget: in Claude Code only the structural origin fields of user
// entries, in Codex the line text, tested against the markers in memory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// The sensitive action categories, named as the command scanner and the launch
// gate already name them:
//   money      payment       a tool the payment pattern or a tool rule classifies
//                            at payment_initiate or payment_execute, or a
//                            confirmed money-moving command (stripe pay)
//   deploy     deploy, package-publish, website-publish, force-push
//   delete     outside-workspace-delete, page-delete
//   send       network       every shell, connector (MCP), web, browser, fetch,
//                            python and computer call
//   launch     launch        a sub-agent launch (the burn gate)
const CATEGORIES = Object.freeze(['payment', 'deploy', 'package-publish', 'website-publish', 'force-push', 'outside-workspace-delete', 'page-delete', 'network', 'launch']);
const ACTIONS = Object.freeze(['off', 'ask', 'block']);
const RANK = {off: 0, ask: 1, block: 2};
const LISTS = Object.freeze(['inboundTools', 'inboundMarkers', 'inboundPaths', 'categories', 'peerSendTools']);
const FIELDS = Object.freeze(['action', ...LISTS, 'senderField']);
const DEFAULTS = Object.freeze({
  action: 'ask',
  // A generic agent inbox, Reason Network's MCP tools (list_team carries
  // teammates' own words; send_message is kept although its reply arrives
  // later as a new message) and Reason Network's Hermes tools.
  inboundTools: Object.freeze([
    '^mcp__.+__(check_inbox|read_inbox|get_messages|read_messages|receive_messages?|send_message)$',
    '^mcp__(plugin_[^_]+_)?reason-network__(check_inbox|send_message|list_team)$',
    '^reason_network_',
  ]),
  // Unanchored, tested in memory. Reason Network writes the frame tag itself
  // and rewrites look-alike tags inside message bodies, so a body cannot forge
  // it. Repetition is bounded so a long text cannot slow a hook.
  inboundMarkers: Object.freeze([
    '<reason-(message|approval) from="',
    'From [^\\n\']{1,80}\'s agent\\. Reply if useful',
    '\\[Reason Network\\] \\d+ unread message',
  ]),
  // Files another agent sent, saved where Reason Network keeps them.
  inboundPaths: Object.freeze(['~/.reason/network/inbox/']),
  categories: CATEGORIES,
  senderField: 'to',
  // An agent network's own send tool: a plain reply to the agent that last
  // messaged the session is allowed; files, a notification or another
  // recipient wait for the owner.
  peerSendTools: Object.freeze(['^mcp__(plugin_[^_]+_)?reason-network__send_message$', '^reason_network_send_message$']),
});
const REASON = 'untrusted_origin';
const SEND_REASON = 'agent_send';
const ORIGIN = 'agent_message';
const PROMPT_TOOL = 'UserPromptSubmit';
const PEER_TOOL = 'peer_message';
const TRANSCRIPT_TOOL = 'transcript';
const ASK_TEXT = 'This request came from another agent\'s message. AgentGuard asks you before it runs.';
const BLOCK_TEXT = 'This request came from another agent\'s message. AgentGuard does not run it. Send your own message in this session to continue.';
const SEND_TEXT = 'This message to another agent carries files or a notification, or goes to someone other than the agent that last messaged this session. AgentGuard asks you before it is sent.';
const MAX_PATTERNS = 64;
const MAX_LABEL = 256;
const TAIL_BYTES = 262144;
const SCAN_STRING = 262144;
const SCAN_TOTAL = 4 * 1048576;
const SENDER_FIELD = /^[A-Za-z0-9_-]{1,64}$/;
const SEND_EXTRAS = ['files', 'notify'];
const STATE_DIRECTORY = 'origin-state';
// The frame's sender address, for the reply rule. Only its keyed digest leaves the hook.
const FRAME_FROM = /<reason-(?:message|approval) from="([^"\r\n]{1,256})"/gi;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => { throw new Error('untrusted_origin_policy_invalid'); };
// Markers run over text another agent wrote, inside a hook with a fixed
// budget: the command-rule safety check applies, and a broad unbounded
// repetition (.* .+ [^x]* [^x]+) must use a bounded {m,n} instead.
function patterns(list, scanned) {
  if (!Array.isArray(list) || list.length > MAX_PATTERNS) invalid();
  for (const pattern of list) {
    if (typeof pattern !== 'string' || !pattern.length || pattern.length > 512) invalid();
    try { new RegExp(pattern, 'i'); } catch { invalid(); }
    if (scanned) {
      let unsafe = true;
      try { unsafe = require('./org-policy-contract.cjs').unsafePattern(pattern); } catch { unsafe = true; }
      if (unsafe || /(?:^|[^\\])(?:\.|\[\^(?:\\.|[^\]])*\])[*+]/.test(pattern)) invalid();
    }
  }
}
function validate(block) {
  if (block === undefined) return;
  if (!plain(block) || Object.keys(block).some(key => !FIELDS.includes(key))) invalid();
  if (block.action !== undefined && !ACTIONS.includes(block.action)) invalid();
  if (block.inboundTools !== undefined) patterns(block.inboundTools, false);
  if (block.peerSendTools !== undefined) patterns(block.peerSendTools, false);
  if (block.inboundMarkers !== undefined) patterns(block.inboundMarkers, true);
  if (block.inboundPaths !== undefined) {
    if (!Array.isArray(block.inboundPaths) || block.inboundPaths.length > MAX_PATTERNS
      || block.inboundPaths.some(value => typeof value !== 'string' || value.length < 2 || value.length > 512 || !/^(?:~\/|\/)/.test(value))) invalid();
  }
  if (block.categories !== undefined) {
    if (!Array.isArray(block.categories) || block.categories.some(name => !CATEGORIES.includes(name))
      || new Set(block.categories).size !== block.categories.length) invalid();
  }
  if (block.senderField !== undefined && block.senderField !== null && (typeof block.senderField !== 'string' || !SENDER_FIELD.test(block.senderField))) invalid();
}
// Policy layers combine the way deniedTools does: the strictest action that a
// layer states, the union of every list, and the upper layer's sender field
// when it names one. A layer that leaves a setting out adds nothing; the
// defaults fill in what no layer states.
function merge(lower, upper) {
  if (lower === undefined) return upper;
  if (upper === undefined) return lower;
  const result = {};
  const actions = [lower.action, upper.action].filter(value => value !== undefined);
  if (actions.length) result.action = actions.reduce((a, b) => RANK[b] > RANK[a] ? b : a);
  for (const field of LISTS) {
    if (lower[field] !== undefined || upper[field] !== undefined) result[field] = [...new Set([...(lower[field] ?? []), ...(upper[field] ?? [])])];
  }
  if (upper.senderField !== undefined) result.senderField = upper.senderField;
  else if (lower.senderField !== undefined) result.senderField = lower.senderField;
  return result;
}
function settings(config) {
  const block = config?.untrustedOrigin ?? {};
  return {action: block.action ?? DEFAULTS.action,
    inboundTools: block.inboundTools ?? DEFAULTS.inboundTools,
    inboundMarkers: block.inboundMarkers ?? DEFAULTS.inboundMarkers,
    inboundPaths: block.inboundPaths ?? DEFAULTS.inboundPaths,
    categories: new Set(block.categories ?? DEFAULTS.categories),
    senderField: block.senderField === undefined ? DEFAULTS.senderField : block.senderField,
    peerSendTools: block.peerSendTools ?? DEFAULTS.peerSendTools};
}
const compiled = new Map();
function regex(pattern) {
  let value = compiled.get(pattern);
  if (!value) { value = new RegExp(pattern, 'i'); if (compiled.size > 512) compiled.clear(); compiled.set(pattern, value); }
  value.lastIndex = 0;
  return value;
}
const named = (list, toolName) => typeof toolName === 'string' && list.some(pattern => regex(pattern).test(toolName));
const inboundTool = (current, toolName) => named(current.inboundTools, toolName);
const peerSendTool = (current, toolName) => named(current.peerSendTools, toolName);
// In memory only. The text is never written, logged or hashed.
const markerMatch = (current, text) => typeof text === 'string' && current.inboundMarkers.some(pattern => regex(pattern).test(text));
// The sender address of the newest frame in a text, or null.
function frameSender(text) {
  if (typeof text !== 'string') return null;
  let last = null;
  FRAME_FROM.lastIndex = 0;
  for (const match of text.matchAll(FRAME_FROM)) last = match[1];
  return last;
}
// Every string in a value (a tool result, a tool input), each read whole when
// short and by its head and tail when long, within one total budget. The
// unread notice an agent network appends to a result sits at its end.
function strings(value, visit) {
  let budget = SCAN_TOTAL;
  const walk = (item, depth) => {
    if (budget <= 0 || depth > 12) return;
    if (typeof item === 'string') {
      const text = item.length > SCAN_STRING ? item.slice(0, SCAN_STRING / 2) + '\n' + item.slice(-SCAN_STRING / 2) : item;
      budget -= text.length; visit(text); return;
    }
    if (Array.isArray(item)) { for (const entry of item) walk(entry, depth + 1); return; }
    if (item && typeof item === 'object') for (const entry of Object.values(item)) walk(entry, depth + 1);
  };
  walk(value, 0);
}
// What a text says, as booleans and an address: whether a marker matched and
// the newest frame's sender.
function textEvidence(current, value) {
  let marker = false, sender = null;
  strings(value, text => {
    if (markerMatch(current, text)) marker = true;
    const from = frameSender(text);
    if (from !== null) sender = from;
  });
  return {marker, sender};
}
const expandHome = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
// A tool input that names a file another agent sent (a Read of it, a shell
// command that prints it).
function inboundPath(current, input) {
  const roots = current.inboundPaths.flatMap(root => [root, expandHome(root), root.replace(/^~\//, '')]).filter(root => root.length > 1);
  let found = false;
  strings(input, text => { if (!found && roots.some(root => text.includes(root))) found = true; });
  return found;
}
// The configured sender label from an inbound tool's own input, only when the
// field holds a short string. The hook turns it into a keyed digest at once.
function senderLabel(current, input) {
  const field = current.senderField;
  if (!field || !plain(input) || !Object.hasOwn(input, field)) return null;
  const value = input[field];
  return typeof value === 'string' && value.length && value.length <= MAX_LABEL ? value : null;
}
// An agent network send: its recipient label and which extra keys it uses.
// Only the key names leave the hook; the label becomes a keyed digest there.
function sendShape(current, toolName, input) {
  if (!peerSendTool(current, toolName)) return null;
  const to = plain(input) && typeof input.to === 'string' && input.to.length && input.to.length <= MAX_LABEL ? input.to : null;
  const extras = plain(input) ? SEND_EXTRAS.filter(key => Object.hasOwn(input, key) && input[key] !== false && input[key] !== null
    && !(Array.isArray(input[key]) && !input[key].length)) : [];
  return {to, extras};
}
// The categories a call falls in, intersected with the configured ones.
function matched(current, {categories = [], capability, launch = false} = {}) {
  const found = new Set(Array.isArray(categories) ? categories.filter(name => CATEGORIES.includes(name)) : []);
  if (['payment_initiate', 'payment_execute'].includes(capability)) found.add('payment');
  if (launch) found.add('launch');
  return CATEGORIES.filter(name => found.has(name) && current.categories.has(name));
}

// The newest whole lines of a transcript, read from its tail within a fixed
// byte budget. The first line of a partial read is dropped.
function tailLines(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, TAIL_BYTES), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (stat.size > length) lines.shift();
    return lines.filter(Boolean);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Claude Code: the newest user entry that carries an origin, by its structural
// fields only: origin.kind, whether a peer entry is one of the session's own
// tasks (senderTaskId), its time and prompt id. Content is never read out.
//   human  the owner typed it
//   peer   another session posted it into this one
//   other  a sub-agent report, a scheduled task or an automatic continuation
function claudeOrigin(transcriptPath) {
  const lines = tailLines(transcriptPath);
  if (!lines) return null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes('"origin":{')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const kind = entry?.type === 'user' && plain(entry.origin) && typeof entry.origin.kind === 'string' ? entry.origin.kind : null;
    if (!kind) continue;
    const at = Date.parse(entry.timestamp);
    return {kind: kind === 'human' ? 'human' : kind === 'peer' && !Object.hasOwn(entry.origin, 'senderTaskId') ? 'peer' : 'other',
      at: Number.isFinite(at) ? at : null, promptId: typeof entry.promptId === 'string' && entry.promptId.length <= 128 ? entry.promptId : null};
  }
  return null;
}
// Codex: the newest transcript line that matches a marker, by its time, and
// the newest frame sender in it. Text another hook injected (as additional
// context or a stop reason) is only visible here, after the fact.
function codexMarker(current, transcriptPath) {
  const lines = tailLines(transcriptPath);
  if (!lines) return null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index], unescaped = line.includes('\\"') ? line.replace(/\\"/g, '"') : line;
    if (!markerMatch(current, line) && !markerMatch(current, unescaped)) continue;
    const time = /"timestamp":"([^"]{1,64})"/.exec(line)?.[1];
    const at = Date.parse(time);
    return {at: Number.isFinite(at) ? at : null, sender: frameSender(unescaped)};
  }
  return null;
}

// Per-session state files, named by a hash of the session id. A cleared mark
// keeps its file with tainted false, so evidence older than the clear never
// marks the session again.
const stateFile = (data, sessionId) => path.join(path.resolve(data), STATE_DIRECTORY,
  crypto.createHash('sha256').update(String(sessionId)).digest('hex') + '.json');
const UNTAINTED = Object.freeze({tainted: false, since: null, originTool: null, delegationEntryHash: null});
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
// A file that cannot be read or parsed counts as a mark.
function readState(data, sessionId) {
  let text;
  try { text = fs.readFileSync(stateFile(data, sessionId), 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return UNTAINTED;
    return {tainted: true, since: null, originTool: null, delegationEntryHash: null};
  }
  try {
    const value = JSON.parse(text);
    const since = typeof value.since === 'string' && Number.isFinite(Date.parse(value.since)) ? value.since : null;
    if (value.tainted === false) return {...UNTAINTED, since};
    return {tainted: true, since, originTool: typeof value.originTool === 'string' ? value.originTool : null, delegationEntryHash: hex64(value.delegationEntryHash)};
  } catch { return {tainted: true, since: null, originTool: null, delegationEntryHash: null}; }
}
function writeState(data, sessionId, state) {
  const file = stateFile(data, sessionId);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const value = {tainted: state.tainted === true, since: state.since ?? null, originTool: state.tainted ? state.originTool ?? null : null,
    delegationEntryHash: state.tainted ? state.delegationEntryHash ?? null : null};
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or never written. */ } }
}
// Evidence of a message arriving now: a matching prompt, an inbound tool or
// file that ran, a marker in a result.
const fresh = evidence => ['promptMatch', 'inbound', 'inboundPath', 'marker'].some(key => evidence[key] === true);
// What the evidence of one hook does to a session's state: 'taint', 'clear'
// or null. Evidence older than the last change is spent. A human entry clears
// only when it is newer than the mark and is not the prompt that carried a
// marker.
function change(state, evidence, markerPromptId = null) {
  if (!evidence) return null;
  const since = state.since ? Date.parse(state.since) : null;
  const newer = at => since === null || (Number.isFinite(at) && at > since);
  if (!state.tainted) {
    if (fresh(evidence)) return 'taint';
    if (evidence.markerAt !== undefined && evidence.markerAt !== null && newer(evidence.markerAt)) return 'taint';
    if (evidence.transcriptKind === 'peer' && newer(evidence.transcriptAt)) return 'taint';
    return null;
  }
  if (fresh(evidence)) return null;
  if (evidence.transcriptKind === 'human' && since !== null && Number.isFinite(evidence.transcriptAt) && evidence.transcriptAt > since
    && (evidence.transcriptPromptId === null || evidence.transcriptPromptId === undefined || evidence.transcriptPromptId !== markerPromptId)) return 'clear';
  return null;
}

// The worker keeps only fields of the expected types from a hook's evidence.
function cleanEvidence(value) {
  if (!plain(value)) return null;
  const out = {};
  for (const key of ['promptMatch', 'inbound', 'inboundPath', 'marker']) if (value[key] === true) out[key] = true;
  for (const key of ['peer', 'requester']) { const digest = hex64(value[key]); if (digest) out[key] = digest; }
  for (const key of ['markerAt', 'transcriptAt']) if (Number.isSafeInteger(value[key]) || value[key] === null) out[key] = value[key];
  if (['human', 'peer', 'other'].includes(value.transcriptKind)) out.transcriptKind = value.transcriptKind;
  for (const key of ['promptId', 'transcriptPromptId']) if (typeof value[key] === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value[key])) out[key] = value[key];
  if (plain(value.send)) out.send = {recipient: hex64(value.send.recipient), extras: Array.isArray(value.send.extras) ? SEND_EXTRAS.filter(key => value.send.extras.includes(key)) : []};
  return Object.keys(out).length ? out : null;
}
// Every marked session's file on this machine, cleared by the owner's command.
function clearFiles(data) {
  const directory = path.join(path.resolve(data), STATE_DIRECTORY);
  let names = [], cleared = 0;
  try { names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); } catch { return 0; }
  const since = new Date().toISOString();
  for (const name of names) {
    const file = path.join(directory, name);
    let tainted = true;
    try { tainted = JSON.parse(fs.readFileSync(file, 'utf8')).tainted !== false; } catch { /* Unreadable counts as a mark. */ }
    if (!tainted) continue;
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({tainted: false, since, originTool: null, delegationEntryHash: null}) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); cleared++; }
    catch { try { fs.unlinkSync(temporary); } catch { /* Never written. */ } }
  }
  return cleared;
}
// UserPromptSubmit. A prompt with a marker marks the session. Any other prompt
// sends the worker the newest transcript origin (Claude Code), which clears a
// mark only when it shows the owner. The hook prints nothing, so no text is
// added to the conversation. Any error keeps the current state.
async function promptHook(text, options = {}) {
  const {locations, hostContext, identifier} = require('./common.cjs');
  let sessionId, evidence;
  {
    let raw;
    try { raw = JSON.parse(text); } catch { return 'unchanged'; }
    sessionId = identifier(raw?.session_id ?? raw?.sessionId, hostContext().sessionId ?? null);
    if (!sessionId || typeof raw?.prompt !== 'string') return 'unchanged';
    const data = options.data ?? locations().data;
    const current = settings(require('./policy-state.cjs').policyState(data, sessionId).config);
    if (current.action === 'off') return 'off';
    const promptMatch = markerMatch(current, raw.prompt);
    const sender = promptMatch ? frameSender(raw.prompt) : null;
    evidence = {promptMatch, ...(typeof raw.prompt_id === 'string' && raw.prompt_id.length <= 128 ? {promptId: raw.prompt_id} : {}),
      ...(sender ? {peer: require('./digest-key.cjs').keyedDigest(data, 'agent', sender)} : {})};
    if (!promptMatch && hostContext().host === 'claude-code') {
      const origin = claudeOrigin(raw.transcript_path);
      if (origin) Object.assign(evidence, {transcriptKind: origin.kind, transcriptAt: origin.at, transcriptPromptId: origin.promptId});
    }
    // Nothing would change: no worker request at all.
    if (!change(readState(data, sessionId), evidence)) return readState(data, sessionId).tainted ? 'tainted' : 'untainted';
  }
  const meta = {schema: 'agentguard.codex.v1', host: hostContext().host, requestId: crypto.randomUUID(), gate: 'prompt', toolName: PROMPT_TOOL,
    toolUseId: crypto.randomUUID(), sessionId, startedAt: new Date().toISOString(), originEvidence: evidence};
  const reply = await (options.request ?? require('./client.cjs').request)({meta}, options.data ? {data: options.data} : {});
  return typeof reply?.origin === 'string' ? reply.origin : 'unchanged';
}

// The evidence a hook adds to its worker request: booleans, times, prompt ids,
// key names and keyed digests, never text. Any failure leaves it out.
function hookEvidence(raw, gate, toolName, {data, host, config}) {
  const current = settings(config);
  if (current.action === 'off') return null;
  const digest = label => require('./digest-key.cjs').keyedDigest(data, 'agent', label);
  const evidence = {};
  if (gate === 'receipt') {
    const response = host === 'claude-code' && raw.hook_event_name === 'PostToolUseFailure' ? null : raw.tool_response;
    const seen = textEvidence(current, response);
    if (seen.marker) evidence.marker = true;
    if (seen.sender) evidence.peer = digest(seen.sender);
    if (inboundPath(current, raw.tool_input)) evidence.inboundPath = true;
    const label = inboundTool(current, toolName) ? senderLabel(current, raw.tool_input) : null;
    if (label !== null) evidence.requester = digest(label);
  } else {
    const send = gate === 'spend' ? sendShape(current, toolName, raw.tool_input) : null;
    if (send) evidence.send = {recipient: send.to === null ? null : digest(send.to), extras: send.extras};
    if (host === 'claude-code') {
      const origin = claudeOrigin(raw.transcript_path);
      if (origin) Object.assign(evidence, {transcriptKind: origin.kind, transcriptAt: origin.at, transcriptPromptId: origin.promptId});
    } else {
      const marker = codexMarker(current, raw.transcript_path);
      if (marker) { evidence.markerAt = marker.at; if (marker.sender) evidence.peer = digest(marker.sender); }
    }
  }
  return Object.keys(evidence).length ? evidence : null;
}

module.exports = {CATEGORIES, ACTIONS, FIELDS, DEFAULTS, REASON, SEND_REASON, ORIGIN, PROMPT_TOOL, PEER_TOOL, TRANSCRIPT_TOOL,
  ASK_TEXT, BLOCK_TEXT, SEND_TEXT, STATE_DIRECTORY, TAIL_BYTES,
  validate, merge, settings, cleanEvidence, clearFiles, inboundTool, peerSendTool, markerMatch, frameSender, textEvidence, inboundPath, senderLabel, sendShape, matched,
  tailLines, claudeOrigin, codexMarker, stateFile, readState, writeState, change, promptHook, hookEvidence};
