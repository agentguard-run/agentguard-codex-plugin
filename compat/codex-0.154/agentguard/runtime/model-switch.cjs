'use strict';
// Model switches in Claude Code (the PreModelSwitch and PostModelSwitch hook
// events, Claude Code 2.1.251 and later; Codex has neither).
//
// Each model keeps its own prompt cache, so a switch while the cache is warm
// re-sends the whole conversation to the new model uncached. Claude Code sends
// the hook its own estimate of that cost. Before a switch, this file turns the
// estimate into one line. Asking for a yes above a limit is the owner's opt-in:
// Claude Code shows the question only from /model, and treats an ask from
// /config, from turning on fast mode or from the SDK as a refusal, which the
// hook cannot tell apart (they share a source). It never answers "allow",
// which would skip the confirmation Claude Code shows on its own while the
// cache is warm, and it never refuses outright.
//
// After a switch, the hook appends one line to a small local file and the
// worker signs it as a `model_switch` ledger row at its next request: which
// model, to which, how the switch happened and the estimate. The first time
// this machine runs a model, one line points at Claude Code's
// /doctor prompt-audit and at Burn's compare.
//
// Model names, counts and the estimate only: nothing from the conversation is
// read or kept, and nothing here makes a request.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EVENT = 'model_switch';
const PENDING = 'model-switches-pending.ndjson';
// Off unless the owner sets `modelSwitch.askAboveCents` in the policy (whole
// cents; null is off). An ask is a refusal on /config and fast mode, so it is
// never on by default.
const DEFAULT_ASK_ABOVE_CENTS = null;
const MAX_ASK_ABOVE_CENTS = 100000000;
// Estimates under ten cents show no line.
const SHOW_FROM_MICRO_USD = 100000;
// Larger than any plausible estimate; anything above it is not a number Claude Code sent.
const MAX_MICRO_USD = 1e12;
// The pending file stops growing at this size until a worker signs it.
const PENDING_LIMIT_BYTES = 1024 * 1024;
// The first five are Claude Code's own. `observed` is a Codex switch: Codex has
// no switch event, so the worker compares the model each hook call carries.
const SOURCES = ['command', 'picker', 'sdk', 'auto', 'resume', 'observed'];
const SESSION_MODELS = 'session-models.json';
const SESSION_MODELS_LIMIT = 1000;
// Only /model in an interactive session can show Claude Code's confirmation.
// Everywhere else, Claude Code treats "ask" as a refusal, so a request from an
// Agent SDK host or Remote Control is never asked. /config and turning on fast
// mode share the "command" source with /model; the question says what to do there.
const ASKING_SOURCES = new Set(['command', 'picker']);
const TTLS = ['5m', '1h'];
const PRICING = ['configured', 'catalog', 'default'];
const MODEL = /^[A-Za-z0-9._:/@[\]+-]{1,200}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const modelId = value => typeof value === 'string' && MODEL.test(value) ? value : null;
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value) ? value : null;
const instant = value => typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// The hook's input, field by field. A field that is missing or not what
// Claude Code documents becomes null; nothing else from the input survives.
// requested_model is null when the request named the default model, so an
// unusable one is undefined instead.
function read(raw) {
  if (!plain(raw)) return null;
  const event = raw.hook_event_name === 'PreModelSwitch' ? 'pre' : raw.hook_event_name === 'PostModelSwitch' ? 'post' : null;
  if (!event) return null;
  const usd = raw.estimated_cache_write_usd;
  const microUsd = typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 && usd * 1e6 <= MAX_MICRO_USD ? Math.round(usd * 1e6) : null;
  return {event, sessionId: sessionId(raw.session_id), fromModel: modelId(raw.from_model), toModel: modelId(raw.to_model),
    requestedModel: raw.requested_model === null ? null : modelId(raw.requested_model) ?? undefined,
    source: SOURCES.includes(raw.source) ? raw.source : null,
    contextTokens: count(raw.context_tokens) ? raw.context_tokens : null,
    warm: typeof raw.prompt_cache_warm === 'boolean' ? raw.prompt_cache_warm : null,
    ttl: TTLS.includes(raw.cache_ttl) ? raw.cache_ttl : null,
    microUsd, pricing: PRICING.includes(raw.pricing) ? raw.pricing : null};
}

function tokens(value) {
  if (value < 1000) return String(value);
  if (value < 1e6) return `${Math.round(value / 1000)}k`;
  return `${(value / 1e6).toFixed(1)}M`;
}
const dollars = micro => `$${(micro / 1e6).toFixed(2)}`;
const PRICED = {configured: "at your organization's rates", catalog: 'at list price', default: 'at an assumed rate (Claude Code has no price for this model)'};

// What the switch costs, in one line, when it costs something: the cache is
// warm (so the switch forfeits it) and the estimate is at least ten cents.
// After the cache has expired, staying costs the same re-send, so no line.
function costLine(change) {
  if (!change || !change.toModel || change.warm !== true || !change.contextTokens || change.microUsd === null || change.microUsd < SHOW_FROM_MICRO_USD) return null;
  return `AgentGuard: switching to ${change.toModel} re-sends this conversation (about ${tokens(change.contextTokens)} tokens) without its cache: an estimated ${dollars(change.microUsd)}${change.pricing ? ' ' + PRICED[change.pricing] : ''}.`;
}

// The limit from the effective policy: a whole number of cents, or null for never.
function askAboveCents(config) {
  const value = plain(config) && plain(config.modelSwitch) ? config.modelSwitch.askAboveCents : undefined;
  return value === undefined ? DEFAULT_ASK_ABOVE_CENTS : value;
}
function validate(value) {
  if (value === undefined) return;
  const fail = () => { throw new Error('model_switch_policy_invalid'); };
  if (!plain(value) || Object.keys(value).some(key => key !== 'askAboveCents')) fail();
  const limit = value.askAboveCents;
  if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_ASK_ABOVE_CENTS)) fail();
}

// PreModelSwitch output. Under the limit, in shadow, or from a surface that
// cannot ask: the line alone. At or above it: Claude Code's confirmation with
// the line as its question. Never "allow", never "deny".
function decide(change, {askAboveCents: limit = DEFAULT_ASK_ABOVE_CENTS, enforcing = true} = {}) {
  if (!change || change.event !== 'pre') return {};
  const line = costLine(change);
  if (!line) return {};
  const asks = enforcing === true && Number.isSafeInteger(limit) && limit >= 0 && ASKING_SOURCES.has(change.source) && change.microUsd >= limit * 10000;
  if (!asks) return {systemMessage: line};
  return {hookSpecificOutput: {hookEventName: 'PreModelSwitch', permissionDecision: 'ask',
    permissionDecisionReason: `${line} That is at or above the ${dollars(limit * 10000)} AgentGuard asks about. Switch anyway? (From /config or fast mode Claude Code cannot ask and refuses instead: switch with /model.)`}};
}

// The effective limit and mode for this session, from local files only (the
// same read the gates make). A policy that cannot be read keeps the default
// limit, as the gates keep the built-in rules.
function settings(session) {
  try {
    const {locations} = require('./common.cjs');
    const state = require('./policy-state.cjs').policyState(locations().data, session || 'unknown');
    return {askAboveCents: askAboveCents(state.config),
      enforcing: state.license.mode !== 'shadow' && (state.config.mode ?? 'enforce') === 'enforce'};
  } catch { return {askAboveCents: DEFAULT_ASK_ABOVE_CENTS, enforcing: true}; }
}

// PostModelSwitch: one line in the pending file. The worker signs it later,
// so the hook waits for nothing. Storage failure loses only this record.
function pend(data, change, now = Date.now()) {
  if (!change || change.event !== 'post' || !change.sessionId || !change.toModel) return false;
  const file = path.join(data, PENDING);
  try { if (fs.statSync(file).size >= PENDING_LIMIT_BYTES) return false; } catch { /* No file yet. */ }
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const {event, ...fields} = change;
  fs.appendFileSync(file, JSON.stringify({...fields, at: now}) + '\n', {mode: 0o600});
  return true;
}

// The worker takes the file the way it takes the other pending files: renamed
// before it is read, so a hook appending at that moment starts a new file. An
// interrupted batch is read again next time. Every line is checked again.
function takePending(data) {
  const file = path.join(data, PENDING), batch = file + '.recovering';
  if (!fs.existsSync(batch)) {
    try { fs.renameSync(file, batch); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  const changes = [];
  for (const line of fs.readFileSync(batch, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    // A time a Date can hold (the hook writes Date.now()); anything else is a damaged line.
    const at = Number.isSafeInteger(value?.at) && value.at > 0 && value.at <= 8.64e15 ? value.at : null;
    const change = read({...value, hook_event_name: 'PostModelSwitch', session_id: value?.sessionId, from_model: value?.fromModel, to_model: value?.toModel,
      requested_model: value?.requestedModel, context_tokens: value?.contextTokens, prompt_cache_warm: value?.warm, cache_ttl: value?.ttl,
      estimated_cache_write_usd: count(value?.microUsd) ? value.microUsd / 1e6 : null});
    if (change?.sessionId && change.toModel && at !== null) changes.push({...change, at});
  }
  return changes;
}
function finishPending(data) {
  try { fs.unlinkSync(path.join(data, PENDING) + '.recovering'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// The signed row's fields. A value that is not known is left out, never guessed.
function rowFields(change) {
  const fields = {switchedAt: new Date(change.at).toISOString(), toModel: change.toModel};
  if (change.fromModel) fields.fromModel = change.fromModel;
  if (change.requestedModel !== undefined) fields.requestedModel = change.requestedModel;
  if (change.source) fields.switchSource = change.source;
  if (change.contextTokens !== null) fields.contextTokens = change.contextTokens;
  if (change.warm !== null) fields.promptCacheWarm = change.warm;
  if (change.ttl) fields.cacheTtl = change.ttl;
  if (change.microUsd !== null) fields.cacheWriteMicroUsd = change.microUsd;
  if (change.pricing) fields.pricing = change.pricing;
  return fields;
}
// What the read-only reader accepts on a ledger row (runtime/mcp.cjs).
const RECORDED_FIELDS = {
  switchedAt: instant,
  toModel: value => modelId(value) !== null,
  fromModel: value => modelId(value) !== null,
  requestedModel: value => value === null || modelId(value) !== null,
  switchSource: value => SOURCES.includes(value),
  contextTokens: count,
  promptCacheWarm: value => typeof value === 'boolean',
  cacheTtl: value => TTLS.includes(value),
  cacheWriteMicroUsd: value => count(value) && value <= MAX_MICRO_USD,
  pricing: value => PRICING.includes(value),
};

// Codex: the last model the worker saw for each session, so a switch is noticed
// across a worker restart. Session ids, model names and times only; the oldest
// sessions drop out past the limit. A file that cannot be read starts empty.
function readSessionModels(data) {
  const models = new Map();
  try {
    const file = path.join(data, SESSION_MODELS);
    if (fs.statSync(file).size > 512 * 1024) return models;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of Array.isArray(value?.sessions) ? value.sessions : []) {
      if (!Array.isArray(entry) || !sessionId(entry[0]) || !modelId(entry[1]) || !Number.isSafeInteger(entry[2])) continue;
      models.set(entry[0], {model: entry[1], at: entry[2]});
    }
  } catch { /* Nothing seen yet. */ }
  return models;
}
function writeSessionModels(data, models) {
  const sessions = [...models].sort((a, b) => a[1].at - b[1].at).slice(-SESSION_MODELS_LIMIT).map(([id, value]) => [id, value.model, value.at]);
  if (sessions.length < models.size) { models.clear(); for (const [id, model, at] of sessions) models.set(id, {model, at}); }
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, SESSION_MODELS), temporary = `${file}.${process.pid}.${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, JSON.stringify({version: 1, sessions}) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
// The row for a Codex switch the worker noticed: no estimate, Codex sends none.
function observedChange({fromModel, toModel, at}) {
  return {fromModel, toModel, source: 'observed', contextTokens: null, warm: null, ttl: null, microUsd: null, pricing: null, at};
}

// What to run next, by what the installed Burn offers: its per-model view
// (`agentguard-burn models`) when this plugin ships a Burn that has it, else
// `compare`, which every supported Burn has. The `models` form names
// `agentguard-burn@latest`: npx reuses a copy it cached under the bare name,
// and a copy cached before Burn 0.7.2 has no `models` command.
function burnFollowUp(burn) {
  try {
    burn ??= require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
    if (typeof burn.modelsReport === 'function') return 'To see how your sessions on each model differ (tokens, sub-agents, cost): ! npx agentguard-burn@latest models';
  } catch { /* compare below. */ }
  return 'To compare your last two sessions side by side: ! npx agentguard-burn compare';
}

// The first session on a model this machine has not run before: one line, once
// per model. The first model AgentGuard ever sees here sets the baseline and
// shows nothing, so installing AgentGuard never announces a model. A context
// window suffix such as [1m] names the same model. Quiet on shows nothing.
// Claude Code's line names its /doctor prompt-audit; Codex has no such command.
const ADVICE = {
  'claude-code': "Instructions written for your last model can misfire on a new one: Claude Code's /doctor prompt-audit checks your CLAUDE.md files, skills and prompts for them.",
  codex: 'Instructions written for your last model can misfire on a new one, so reread your AGENTS.md files and skills with it in mind.',
};
const FIRST_SEEN = (model, {host = 'claude-code', burn} = {}) => `AgentGuard: first session on ${model} on this machine. ${ADVICE[host] ?? ADVICE['claude-code']} ${burnFollowUp(burn)}`;
const seenId = model => modelId(model)?.replace(/\[[0-9a-z]+\]$/i, '').toLowerCase() || null;
const seenKey = id => 'model-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
function firstSeen(model, {home, now, host, burn} = {}) {
  const id = seenId(model);
  if (!id) return null;
  const moments = require('./upgrade-moments.cjs');
  if (moments.quiet(home)) return null;
  const baseline = moments.claim('models-baseline', {home, now});
  const fresh = moments.claim(seenKey(id), {home, now});
  return !baseline && fresh ? FIRST_SEEN(id, {host, burn}) : null;
}
// The model a switch leaves has run here, whatever this plugin saw before (a
// session start can come without a model). Marked silently, so switching back
// to it never reads as a first session.
function markSeen(model, {home, now} = {}) {
  const id = seenId(model);
  if (!id) return;
  const moments = require('./upgrade-moments.cjs');
  if (moments.quiet(home)) return;
  moments.claim('models-baseline', {home, now});
  moments.claim(seenKey(id), {home, now});
}

module.exports = {EVENT, PENDING, DEFAULT_ASK_ABOVE_CENTS, MAX_ASK_ABOVE_CENTS, SHOW_FROM_MICRO_USD, PENDING_LIMIT_BYTES, SOURCES, ASKING_SOURCES,
  SESSION_MODELS, SESSION_MODELS_LIMIT, RECORDED_FIELDS, read, costLine, askAboveCents, validate, decide, settings, pend, takePending, finishPending,
  rowFields, readSessionModels, writeSessionModels, observedChange, burnFollowUp, firstSeen, markSeen, FIRST_SEEN, modelId};
