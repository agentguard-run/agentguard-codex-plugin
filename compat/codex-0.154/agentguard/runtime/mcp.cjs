#!/usr/bin/env node
'use strict';

// Read-only stdio MCP. This module never initializes keys, policies, or ledgers.
// One opt-in tool, agent_score, makes a hosted request to the AgentGuard Score
// service at the validated origin it names; every other tool stays offline.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
const { openReport } = require('./open-report.cjs');
const { locations, hostContext } = require('./common.cjs');
const {readPolicy} = require('./policy-file.cjs');
const {readHealth} = require('./health.cjs');
const {RULES} = require('./guard-pack.cjs');
const {readSessionLicense, readLatestLicenseStatus} = require('./license.cjs');
const agentScoreQuestions = require('./agent-score-questions.cjs');
const {RECEIPT_EVENT, validateReceipt, receiptView, isReceipt} = require('./work-receipt.cjs');

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 100000;
const PAGE_LIMIT = 200;
const SCORE_URL = 'https://agentguard.run';
const SCORE_TIMEOUT_MS = 10000;
const SCORE_BODY_LIMIT = 64 * 1024;
const SCORE_TIERS = ['CRITICAL', 'WARNING', 'FAIR', 'GOOD', 'ELITE'];
const SCORE_NETWORK_MESSAGE = 'No usable result was received. The service may have processed the request. I have not retried it or invented a result.';
const SCORE_UNUSABLE_MESSAGE = 'The service returned an unusable result. No result is available to display.';
// The destination named in consent copy is the origin actually in use. It is
// validated before any request: https only, no credentials, no path, query or
// fragment. An unusable AGENTGUARD_SCORE_URL is a refusal, never a fallback.
function resolveScoreOrigin(options = {}) {
  const configured = options.scoreUrl || process.env.AGENTGUARD_SCORE_URL || SCORE_URL;
  let url;
  try { url = new URL(String(configured)); } catch { return {origin: null}; }
  if (url.protocol !== 'https:' || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) return {origin: null};
  return {origin: url.origin};
}
const schemas = {
  get_status: { type: 'object', properties: { day: { type: 'string', description: 'UTC day, YYYY-MM-DD. Defaults to today.' }, sessionId: {type: 'string', description: 'Current host session identifier.'} }, additionalProperties: false },
  list_decisions: { type: 'object', properties: { fromSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: PAGE_LIMIT } }, additionalProperties: false },
  verify_chain: { type: 'object', properties: {}, additionalProperties: false },
  export_receipts: { type: 'object', properties: { sessionId: {type: 'string', description: 'Current host session identifier.'}, fromSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: PAGE_LIMIT } }, additionalProperties: false },
  get_work_receipt: { type: 'object', properties: { sessionId: {type: 'string', description: 'Host session identifier of the session whose receipt to return. Defaults to the latest receipt.'} }, additionalProperties: false },
  agent_score_questions: { type: 'object', properties: {}, additionalProperties: false },
  agent_score: { type: 'object', properties: { answers: { type: 'object', description: 'Answers to every questionnaire question keyed by question id: select questions take one of the published option strings, yes/no questions take true or false.' }, consent: { type: 'boolean', description: 'Must be true. Confirms the user agreed, after being shown the answers and the serviceOrigin returned by agent_score_questions, that the five answers are sent to the AgentGuard Score service at that origin.' }, createShare: { type: 'boolean', description: 'Default false. True only when the user separately asked for a hosted report link, which stores the answers and score on the service and is visible to anyone who has the link.' }, openReport: { type: 'boolean', description: 'Only together with createShare: after a successful score, open the finished report in the default browser on this machine. Nothing else is launched.' } }, required: ['answers', 'consent'], additionalProperties: false },
};
const descriptions = {
  get_status: 'Read recorded host, license tier, seat count and limit, seat storage and verification status, expiry, effective mode, shadow reason, daily signed decision totals, fail-open counts and rates for the last hour and since worker start, and the local quiet display preference. License and health reads are offline.',
  list_decisions: 'Read a bounded page of content-free tool decision summaries from the local ledger.',
  verify_chain: 'Verify every local ledger signature and hash link against the local public verification key; never accesses private keys.',
  export_receipts: 'With a valid paid license, return a page of signed content-free receipts and the public verification key for a records custodian. No files are written. Concatenate pages to verify the complete chain.',
  get_work_receipt: 'Return the signed work receipt of one finished session (the latest receipt when no sessionId is given): counts only, namely first and last activity time, tokens Burn recorded, sub-agents started, finished and ended without finishing, AgentGuard decisions by result, how many messages from other agents entered the session (only when any did), the Burn policy mode and the plugin version. Includes the row signature, whether it is valid and whether the whole local chain verifies against the local public verification key. Offline and read-only; never accesses private keys.',
  agent_score_questions: 'Return the AgentGuard Score questionnaire (intro, question ids, wording, options) and serviceOrigin, the validated address of the service that agent_score would call, so the agent can ask the user and name the destination before scoring. Offline; makes no request.',
  agent_score: 'With the user\'s consent, send the five questionnaire answers to the AgentGuard Score service at the serviceOrigin returned by agent_score_questions (https://agentguard.run unless AGENTGUARD_SCORE_URL is set) and return the score, tier, category breakdown and factors with recommendations. A hosted report link is created only when createShare is true. This is the only MCP tool in this server that makes a hosted request; the request does not include local policy, the decision ledger or the signing key, and the tool reads no local files and writes nothing. It is not read-only because a requested report link is stored by the service. With openReport true, the server launches the operating system browser opener with the report address as a single argument, only after a successful score and only when createShare is also true; AGENTGUARD_NO_BROWSER=1 disables it.',
};
const annotationsFor = name => name === 'agent_score'
  ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = Object.keys(schemas).map(name => ({ name, description: descriptions[name], inputSchema: schemas[name], annotations: annotationsFor(name) }));

const ENTRY_KEYS = new Set(['sequence', 'decision', 'previousHash', 'entryHash', 'signature', 'signerFingerprint', 'builderCode', 'publicKeyHex']);
const DECISION_KEYS = new Set(['decisionId', 'timestamp', 'action', 'triggeredCap', 'triggeredScopeKey', 'projectedCents', 'windowSpendBefore', 'windowSpendAfter', 'provider', 'modelRequested', 'modelResolved', 'policyId', 'policyVersion', 'enforcementMode', 'reasons', 'entryType', 'originalDecisionId', 'actor', 'costBasis', 'provenance', 'outcomeReceipt', 'governanceReceipt', 'estimatedInputTokens', 'estimatedOutputTokens', 'actualInputTokens', 'actualOutputTokens', 'actualCents', 'deltaCents', 'partial', 'plugin']);
const PLUGIN_KEYS = new Set(['schema', 'event', 'toolName', 'inputSha256', 'inputBytes', 'inputKeys', 'toolUseId', 'sessionId', 'agentId', 'capabilityTier', 'unitCostCents', 'chargedCents', 'chargedWindows', 'startedAt', 'durationMs', 'durationSource', 'outputBytes', 'success', 'decisionId', 'gate', 'reasonCode', 'burnReceiptId', 'license', 'policyReasonCode', 'requestId', 'integrity', 'host']);
const FORBIDDEN_KEY = /^(?:tool_input|tool_response|tool_output|input|output|prompt|completion|content|messages|text|body|raw|privateKey|private_key|signingKey|signing_key|secret|secretKey|secret_key|accessToken|access_token|authorization|apiKey|api_key|licenseKey|license_key)$/i;
for (const key of ['commandPolicyHash', 'commandRuleIds', 'commandScanFailed', 'commandScanIncomplete', 'builtInStop', 'approvalNeeded', 'approvalRuleId', 'guardRuleIds', 'guardScanReason', 'guardPack', 'guardPackMessage']) PLUGIN_KEYS.add(key);
// Fields the gates write that are not covered above, each with the only values
// it can hold: the Claude Code permission mode a launch was decided under, an
// asked launch, the Burn policy the first enforced launch seeded, an agent's
// attempt to lift a Burn STOP, and a benchmark run's consent.
const RECORDED_FIELDS = {
  pageGuard: value => require('./page-guard.cjs').receiptValid(value),
  agent_id: value => value === null || typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value),
  agent_type: value => value === null || typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(value),
  depth: value => value === null || Number.isSafeInteger(value) && value >= 0,
  parent_agent_id: value => value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
  spawned_agent_id: value => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value),
  previousReceiptId: value => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value),
  externalReceiptHash: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  externalDecisionId: value => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value),
  launch: value => require('./launch-policy.cjs').receiptValid(value),
  permissionMode: value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value),
  asked: value => value === true,
  burnPolicyMode: value => value === 'enforce' || value === 'shadow',
  burnPolicySha256: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  burnOverride: value => value === 'command' || value === 'file',
  runId: value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value),
  granted: value => typeof value === 'boolean',
  // Requests from other agents: the delegation row (the tool that brought the
  // message in, a keyed requester digest or null), and the link every decision
  // row written while the session is marked carries back to it.
  originTool: value => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value),
  requester: value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  origin: value => value === 'agent_message',
  delegation_entry_hash: value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  originCategories: value => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every(name => require('./untrusted-origin.cjs').CATEGORIES.includes(name)),
  approved_by: value => value === 'owner',
  // The keyed input digest of rows written since it replaced inputSha256.
  inputDigest: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  inputDigestAlg: value => value === 'hmac-sha256',
  clearedBy: value => ['human_prompt', 'owner_approval', 'owner_command'].includes(value),
  agentSend: value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['reply', 'extras'].includes(key))
    && typeof value.reply === 'boolean' && Array.isArray(value.extras) && value.extras.every(key => ['files', 'notify'].includes(key)),
};
for (const key of Object.keys(RECORDED_FIELDS)) PLUGIN_KEYS.add(key);
// A work receipt's counts, on its own `session_receipt` control row only, held
// to the schema the worker signs with (runtime/work-receipt.cjs).
PLUGIN_KEYS.add('receipt');
const GUARD_RULES = new Map(RULES.map(rule => [rule.id, rule]));

function validateGuardMetadata(metadata) {
  if (!metadata) return;
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_./:@-]{1,128}$/.test(value);
  if (metadata.commandPolicyHash !== undefined && !/^[a-f0-9]{64}$/.test(metadata.commandPolicyHash)) throw new Error('Command policy hash is invalid.');
  if (metadata.commandRuleIds !== undefined && (!Array.isArray(metadata.commandRuleIds) || metadata.commandRuleIds.length > 256 || metadata.commandRuleIds.some(id => id !== null && !identifier(id)))) throw new Error('Command rule metadata is invalid.');
  for (const field of ['commandScanFailed', 'commandScanIncomplete', 'approvalNeeded']) if (metadata[field] !== undefined && typeof metadata[field] !== 'boolean') throw new Error('Command state metadata is invalid.');
  if (metadata.builtInStop !== undefined && !['plugin_state', 'policy_cli'].includes(metadata.builtInStop)) throw new Error('Built-in stop metadata is invalid.');
  if (metadata.approvalRuleId !== undefined && !identifier(metadata.approvalRuleId)) throw new Error('Approval rule metadata is invalid.');
  const ids = metadata.guardRuleIds, matches = metadata.guardPack;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > RULES.length || new Set(ids).size !== ids.length || ids.some(id => !GUARD_RULES.has(id)))) throw new Error('Guard rule metadata is invalid.');
  if (metadata.guardScanReason !== undefined && !['guard_branch_unknown', 'guard_scan_incomplete'].includes(metadata.guardScanReason)) throw new Error('Guard scan metadata is invalid.');
  if (matches !== undefined && (!Array.isArray(matches) || matches.length > RULES.length || matches.some(match => !match || typeof match !== 'object' || Array.isArray(match) || Object.keys(match).some(key => !['id', 'action'].includes(key)) || !GUARD_RULES.has(match.id) || !['stop', 'warn', 'off', ...(match.id === 'GP020' ? ['ask'] : [])].includes(match.action)) || new Set(matches.map(match => match.id)).size !== matches.length)) throw new Error('Guard decision metadata is invalid.');
  if (metadata.guardPackMessage !== undefined) {
    const expected = (matches ?? []).filter(match => match.action !== 'off').map(match => `AgentGuard ${match.action === 'stop' ? 'STOP' : match.action === 'ask' ? 'ASK' : 'WARN'} ${match.id}: ${GUARD_RULES.get(match.id).reason}`).join(' ');
    if (typeof metadata.guardPackMessage !== 'string' || metadata.guardPackMessage !== expected) throw new Error('Guard message metadata is invalid.');
  }
}

function metadataOnly(value, depth = 0) {
  if (depth > 12) throw new Error('Ledger metadata nesting is invalid.');
  if (Array.isArray(value)) return value.forEach(item => metadataOnly(item, depth + 1));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error('Ledger contains a disallowed content or secret field.');
    metadataOnly(item, depth + 1);
  }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !ENTRY_KEYS.has(key))) throw new Error('Ledger entry schema is invalid.');
  const decision = entry.decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || Object.keys(decision).some(key => !DECISION_KEYS.has(key))) throw new Error('Ledger decision schema is invalid.');
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0 || !/^[a-f0-9]{64}$/.test(entry.entryHash) || !/^[a-f0-9]{64}$/.test(entry.previousHash) || !/^[a-f0-9]{128}$/.test(entry.signature) || !/^[a-f0-9]{16}$/.test(entry.signerFingerprint)) throw new Error('Ledger signature metadata is invalid.');
  if (typeof decision.timestamp !== 'string' || !Number.isFinite(Date.parse(decision.timestamp)) || typeof decision.decisionId !== 'string' || !Number.isSafeInteger(decision.projectedCents) || decision.projectedCents < 0) throw new Error('Ledger decision metadata is invalid.');
  metadataOnly(decision);
  for (const metadata of [decision.plugin, decision.outcomeReceipt?.plugin]) {
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some(key => !PLUGIN_KEYS.has(key)))) throw new Error('Plugin metadata schema is invalid.');
    if (metadata?.host !== undefined && (typeof metadata.host !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(metadata.host))) throw new Error('Plugin host metadata is invalid.');
    validateGuardMetadata(metadata);
    for (const [key, valid] of Object.entries(RECORDED_FIELDS)) if (metadata?.[key] !== undefined && !valid(metadata[key])) throw new Error('Plugin recorded metadata is invalid.');
    if (metadata?.receipt !== undefined || metadata?.event === RECEIPT_EVENT) {
      if (metadata !== decision.plugin || metadata.event !== RECEIPT_EVENT || metadata.gate !== 'control' || metadata.receipt === undefined) throw new Error('Work receipt metadata is invalid.');
      validateReceipt(metadata.receipt);
    }
    if (metadata?.integrity !== undefined && (!metadata.integrity || typeof metadata.integrity !== 'object' || Array.isArray(metadata.integrity) || Object.keys(metadata.integrity).some(key => !['reason', 'confirmedSequence', 'confirmedHash', 'recoveredHeadHash', 'recoveredRows', 'truncatedBytes', 'checkpointMissing'].includes(key)))) throw new Error('Integrity metadata schema is invalid.');
    if (metadata?.chargedWindows !== undefined && (!Array.isArray(metadata.chargedWindows) || metadata.chargedWindows.some(window => !window || typeof window !== 'object' || Array.isArray(window) || Object.keys(window).some(key => !['scopeKey', 'window', 'windowStart'].includes(key))))) throw new Error('Plugin budget metadata schema is invalid.');
  }
}

function assertArgs(name, args) {
  const schema = schemas[name];
  if (!schema) throw new Error('Unknown tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('Unexpected argument.');
  if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 512)) throw new Error('sessionId must be a host session identifier.');
  if (args.fromSequence !== undefined && (!Number.isSafeInteger(args.fromSequence) || args.fromSequence < 0)) throw new Error('fromSequence must be a non-negative integer.');
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > PAGE_LIMIT)) throw new Error('limit must be an integer from 1 to 200.');
  if (args.day !== undefined && (typeof args.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.day) || !Number.isFinite(Date.parse(args.day)) || new Date(args.day).toISOString().slice(0, 10) !== args.day)) throw new Error('day must be a valid UTC date.');
  if (name === 'agent_score' && args.createShare !== undefined && typeof args.createShare !== 'boolean') throw new Error('createShare must be true or false.');
  if (name === 'agent_score' && args.openReport !== undefined && typeof args.openReport !== 'boolean') throw new Error('openReport must be true or false.');
  // answers and consent are checked inside agentScore so that a missing or
  // false consent produces a score-specific consent_required result.
}

// Read at most `limit` bytes of a response body. The abort signal is honored
// during the read, so one timeout covers the request and the body together.
async function readBodyLimited(response, limit, signal) {
  const aborted = new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
  });
  aborted.catch(() => {});
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const read = reader.read();
        read.catch(() => {});
        const {done, value} = await Promise.race([read, aborted]);
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('oversized');
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      try { reader.cancel().catch(() => {}); } catch {}
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await Promise.race([response.text(), aborted]);
  if (Buffer.byteLength(text) > limit) throw new Error('oversized');
  return text;
}

// Strict transport validation of a score result. Anything outside the
// contract is refused rather than filtered into a partial result.
function parseScorePayload(payload, {origin, createShare}) {
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const isoDate = value => value === undefined || value === null ? null : (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined);
  if (!plain(payload) || payload.ok !== true) return null;
  if (!Number.isInteger(payload.score) || payload.score < 0 || payload.score > 100 || !SCORE_TIERS.includes(payload.tier)) return null;
  if (!plain(payload.breakdown) || Object.values(payload.breakdown).some(value => !Number.isInteger(value))) return null;
  if (!Array.isArray(payload.factors) || payload.factors.some(factor => !plain(factor) || typeof factor.factor !== 'string' || !['positive', 'negative', 'neutral'].includes(factor.impact) || !Number.isInteger(factor.points) || (factor.recommendation !== undefined && typeof factor.recommendation !== 'string'))) return null;
  const scoredAt = isoDate(payload.scoredAt), validUntil = isoDate(payload.validUntil);
  if (scoredAt === undefined || validUntil === undefined) return null;
  const result = { ok: true, score: payload.score, tier: payload.tier, breakdown: {...payload.breakdown},
    factors: payload.factors.map(factor => ({ factor: factor.factor, impact: factor.impact, points: factor.points, ...(factor.recommendation !== undefined ? {recommendation: factor.recommendation} : {}) })),
    shareUrl: createShare && typeof payload.shareUrl === 'string' && payload.shareUrl.startsWith(origin + '/') ? payload.shareUrl : null,
    scoredAt, validUntil, serviceOrigin: origin };
  for (const key of ['assessmentType', 'questionnaireVersion', 'rubricVersion']) if (typeof payload[key] === 'string') result[key] = payload[key];
  return result;
}

// The one hosted request in this server. Never reads the ledger, the policy
// or the keys, and never writes anything. Refuses an unusable origin, missing
// consent and answers outside the published questionnaire before any request.
async function agentScore(args, options) {
  const {origin} = resolveScoreOrigin(options);
  if (!origin) return { ok: false, reason: 'invalid_origin', message: 'AGENTGUARD_SCORE_URL is not a usable service origin: it must be https, with no credentials, path, query or fragment. Nothing was sent.' };
  if (args.consent !== true) {
    return { ok: false, reason: 'consent_required', message: `AgentGuard Score sends the five questionnaire answers to the AgentGuard Score service at ${origin}. Show the user the answers and that destination, ask whether to proceed, then call again with consent: true. Nothing was sent.` };
  }
  const problems = agentScoreQuestions.validateAnswers(args.answers);
  if (problems.length) return { ok: false, reason: 'invalid_answers', problems, message: 'Nothing was sent. Every question must be answered; use agent_score_questions for the question ids and options.' };
  const createShare = args.createShare === true;
  const wantOpen = args.openReport === true;
  if (wantOpen && !createShare) return { ok: false, reason: 'invalid_answers', problems: ['openReport requires createShare: true; the report can only open once a report link exists.'], message: 'Nothing was sent. openReport requires createShare: true.' };
  const doFetch = options.fetch || globalThis.fetch;
  const controller = new AbortController();
  // One timer covers the request, the body read and the parse.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || SCORE_TIMEOUT_MS);
  try {
    const body = JSON.stringify({ answers: args.answers, tier: 'tier1', createShare });
    let response;
    try {
      response = await doFetch(`${origin}/api/score`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch {
      return { ok: false, reason: 'network', message: SCORE_NETWORK_MESSAGE };
    }
    if (!response || !response.ok) return { ok: false, reason: 'service_error', status: response?.status ?? null, message: 'The service returned an error status. No result is available to display.' };
    let text;
    try { text = await readBodyLimited(response, SCORE_BODY_LIMIT, controller.signal); }
    catch (error) {
      if (error?.message === 'oversized') return { ok: false, reason: 'service_error', message: 'The service response exceeded the size limit. No result is available to display.' };
      return { ok: false, reason: 'network', message: SCORE_NETWORK_MESSAGE };
    }
    let payload;
    try { payload = JSON.parse(text); } catch { return { ok: false, reason: 'service_error', message: SCORE_UNUSABLE_MESSAGE }; }
    const result = parseScorePayload(payload, {origin, createShare}) || { ok: false, reason: 'service_error', message: SCORE_UNUSABLE_MESSAGE };
    if (result.ok && wantOpen) result.reportOpened = result.shareUrl ? openReport(result.shareUrl, { origin, ...(options.openReport || {}) }) : false;
    return result;
  } finally { clearTimeout(timer); }
}

function summary(entry) {
  const d = entry.decision;
  const metadata = d.plugin || d.outcomeReceipt?.plugin || {};
  return { sequence: entry.sequence, entryHash: entry.entryHash, decisionId: d.decisionId, timestamp: d.timestamp, action: d.action, entryType: d.entryType || 'decision', provider: d.provider, model: d.modelRequested, actor: d.actor, projectedCents: d.projectedCents, reasons: d.reasons, originalDecisionId: d.originalDecisionId, toolName: metadata.toolName, event: metadata.event, gate: metadata.gate, host: metadata.host || 'unknown', asked: metadata.asked === true, toolUseId: metadata.toolUseId, ...(metadata.launch ? {launch: metadata.launch} : {}), ...(metadata.receipt ? {receipt: metadata.receipt} : {}),
    ...(metadata.event === 'delegation' ? {originTool: metadata.originTool, requester: metadata.requester ?? null} : {}),
    ...(metadata.origin ? {origin: metadata.origin, delegationEntryHash: metadata.delegation_entry_hash ?? null} : {}),
    ...(metadata.approved_by ? {approvedBy: metadata.approved_by} : {}) };
}

function failOpen(decision) {
  const metadata = decision.plugin || decision.outcomeReceipt?.plugin || decision.governanceReceipt || decision.outcomeReceipt || {};
  return metadata.failOpen === true || ['fail_open', 'fail-open'].includes(metadata.event) || ['fail_open', 'fail-open'].includes(metadata.kind);
}

function seatEvidence(status) {
  const seatsUsed = Number.isSafeInteger(status?.seatsUsed) && status.seatsUsed >= 0 ? status.seatsUsed : null;
  const seatLimit = Number.isSafeInteger(status?.seatLimit) && status.seatLimit >= 0 ? status.seatLimit : null;
  const seatStorage = ['kv', 'memory'].includes(status?.seatStorage) ? status.seatStorage : null;
  const seatsVerified = status?.seatsVerified === true && seatStorage === 'kv'
    && seatsUsed !== null && seatLimit !== null;
  return {seatsUsed, seatLimit, seatStorage, seatsVerified};
}

// Display entitlement and seat evidence without the worker's private identity
// bookkeeping. New snapshot fields do not automatically become MCP output.
function displayLicense(status) {
  const fields = ['paid', 'mode', 'reason', 'tier', 'seatsUsed', 'seatLimit',
    'seatStorage', 'seatsVerified', 'seatRefreshedAt', 'expiresAt', 'graceUntil',
    'offlineGrace', 'source', 'refreshedAt', 'seatStatus', 'seatHeartbeatAt',
    'seatHeartbeatError', 'seatRevoked', 'orgPolicySha256', 'orgPolicyVersion', 'statusSource', 'statusError', 'cachedMode'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(status, key))
    .filter(key => status[key] === null || ['string', 'boolean', 'number'].includes(typeof status[key]))
    .map(key => [key, status[key]]));
}

function createReader(options = {}) {
  const dataDir = path.resolve(options.dataDir || locations().data);
  const store = new sdk.NdjsonDecisionLogStore(options.tenant || 'ledger', { home: dataDir });
  const publicKeyPath = path.join(dataDir, options.publicKeyFile || 'public-key.hex');

  async function snapshot() {
    let stat;
    try { stat = fs.statSync(store.filePath); } catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Ledger cannot be read.'); }
    if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new Error('Ledger exceeds the read-only server size limit.');
    // The SDK intentionally skips malformed NDJSON lines. Verify the physical
    // file first so this audit reader never reports a truncated chain as valid.
    const lines = fs.readFileSync(store.filePath, 'utf8').split('\n').filter(line => line.trim());
    if (lines.length > MAX_ROWS) throw new Error('Ledger exceeds the read-only server entry limit.');
    let physical;
    try { physical = lines.map(line => JSON.parse(line)); } catch { throw new Error('Ledger contains malformed JSON.'); }
    physical.forEach(validateEntry);
    const entries = await store.read(0, MAX_ROWS + 1);
    if (entries.length !== physical.length) throw new Error('Ledger changed while reading; retry.');
    const physicalHashes = physical.map(entry => entry.entryHash).sort();
    if (entries.map(entry => entry.entryHash).sort().some((hash, i) => hash !== physicalHashes[i])) throw new Error('Ledger changed while reading; retry.');
    entries.forEach(validateEntry);
    return entries;
  }

  function publicKey(entries) {
    let encoded;
    try { encoded = fs.readFileSync(publicKeyPath, 'utf8').trim(); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Public verification key cannot be read.');
      encoded = entries[0]?.publicKeyHex;
    }
    if (!encoded && entries.length === 0) return null;
    if (typeof encoded !== 'string' || !/^[a-f0-9]{64}$/i.test(encoded)) throw new Error('Public verification key is missing or invalid.');
    const fingerprint = createHash('sha256').update(Buffer.from(encoded, 'hex')).digest('hex').slice(0, 16);
    if (entries.some(entry => entry.signerFingerprint !== fingerprint || (entry.publicKeyHex && entry.publicKeyHex.toLowerCase() !== encoded.toLowerCase()))) throw new Error('Ledger signer does not match the public verification key.');
    return encoded.toLowerCase();
  }

  async function verify(entries) {
    const key = publicKey(entries);
    return { ...(key ? await sdk.verifyChain(entries, Buffer.from(key, 'hex')) : { ok: true }), entries: entries.length, publicKeyHex: key, lastEntryHash: entries.at(-1)?.entryHash || null };
  }

  function pendingRecovery() {
    let count = 0;
    for (const name of ['fail-open-pending.ndjson', 'fail-open-pending.ndjson.recovering']) {
      const filename = path.join(dataDir, name);
      try {
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new Error('Recovery queue cannot be counted safely.');
        // These are physical queue records, not signed or verified decisions.
        // Do not parse, return, replay, or write their payloads from this reader.
        count += fs.readFileSync(filename, 'utf8').split('\n').filter(line => line.trim()).length;
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('Recovery queue cannot be read.'); }
    }
    return { pendingAuditRecovery: count > 0, pendingFailOpenEvents: count, pendingRecoveryStatus: count ? 'unsigned_unverified' : 'none' };
  }

  function license(args, entries) {
    let config;
    try { config = readPolicy(dataDir); }
    catch { return {tier: 'free', mode: 'shadow', reason: 'license_required', paid: false, seatsUsed: null, seatLimit: null, seatStorage: null, seatsVerified: false, expiresAt: null, source: 'policy_unavailable'}; }
    const sessionId = args.sessionId || hostContext().sessionId || entries.at(-1)?.decision.plugin?.sessionId || 'local';
    const parameters = {data: dataDir, sessionId, policy: config.policy, personalPolicy: config.personal};
    const status = !args.sessionId && !hostContext().sessionId && !entries.length && args.displayOnly
      ? readLatestLicenseStatus(parameters) : readSessionLicense(parameters);
    let effectivePolicy = status.paid ? config.policy : config.personal;
    let reason = status.reason, orgPolicySha256 = null, orgPolicyVersion = null;
    try {
      const state = require('./policy-state.cjs').policyState(dataDir, sessionId, {licenseReader: () => status});
      effectivePolicy = state.config; reason = state.license.reason;
      orgPolicySha256 = state.orgPolicy?.sha256 ?? null; orgPolicyVersion = state.orgPolicy?.version ?? null;
    } catch { reason = reason || 'policy_invalid'; }
    return {...status, ...seatEvidence(status), orgPolicySha256, orgPolicyVersion, reason,
      mode: status.mode === 'enforce' && !reason ? effectivePolicy.mode || 'enforce' : 'shadow'};
  }

  async function effectiveStatus(args, entries) {
    const cached = license({...args, displayOnly: true}, entries);
    const sessionId = args.sessionId || hostContext().sessionId || entries.at(-1)?.decision.plugin?.sessionId || 'local';
    const query = options.workerStatus || (parameters => require('./client.cjs').request(
      {control: 'effective-license', sessionId: parameters.sessionId},
      {data: dataDir, startWorker: false, timeoutMs: 250}));
    try {
      const response = await query({data: dataDir, sessionId});
      if (!response?.license || !['shadow', 'enforce'].includes(response.license.mode)) throw new Error('status_unavailable');
      return {...cached, ...response.license, ...seatEvidence({...cached, ...response.license}), statusSource: 'worker', statusError: null};
    } catch {
      // Without a current worker response, cached facts cannot prove enforce.
      return {...cached, cachedMode: cached.mode, mode: 'shadow', reason: cached.reason || 'status_unavailable',
        statusSource: 'cached_unverified', statusError: 'status_unavailable'};
    }
  }

  async function call(name, args = {}) {
    assertArgs(name, args);
    if (name === 'agent_score_questions') {
      const {origin} = resolveScoreOrigin(options);
      return { intro: agentScoreQuestions.INTRO, questions: agentScoreQuestions.QUESTIONS, serviceOrigin: origin, ...(origin ? {} : {serviceOriginError: 'invalid_origin'}) };
    }
    if (name === 'agent_score') return agentScore(args, options);
    const entries = await snapshot();
    if (name === 'verify_chain') return verify(entries);
    if (name === 'get_work_receipt') {
      const entry = entries.findLast(item => isReceipt(item, args.sessionId));
      if (!entry) return {found: false, ...(args.sessionId ? {sessionId: args.sessionId} : {})};
      const verification = await verify(entries);
      const key = Buffer.from(verification.publicKeyHex, 'hex');
      return {found: true, receipt: receiptView(entry),
        signature: {sequence: entry.sequence, entryHash: entry.entryHash, previousHash: entry.previousHash, signature: entry.signature,
          signerFingerprint: entry.signerFingerprint, publicKeyHex: verification.publicKeyHex, valid: await sdk.verifyEntry(entry, key)},
        chain: {verified: verification.ok === true, entries: verification.entries, lastEntryHash: verification.lastEntryHash,
          ...(verification.ok ? {} : {failedAtSequence: Number.isSafeInteger(verification.sequence) ? verification.sequence : null})}};
    }
    if (name === 'get_status') {
      const day = args.day || new Date().toISOString().slice(0, 10);
      const today = entries.filter(entry => entry.decision.timestamp.slice(0, 10) === day);
      const decisions = today.filter(entry => !['outcome', 'settlement'].includes(entry.decision.entryType) && !['integrity', RECEIPT_EVENT].includes(entry.decision.plugin?.event));
      const health = readHealth({data: dataDir, entries});
      const hostCounts = Object.create(null);
      for (const entry of decisions) {
        const host = entry.decision.plugin?.host || entry.decision.outcomeReceipt?.plugin?.host || 'unknown';
        hostCounts[host] = (hostCounts[host] || 0) + 1;
      }
      const sessionId = args.sessionId || hostContext().sessionId;
      const selected = sessionId ? entries.filter(entry => (entry.decision.plugin?.sessionId || entry.decision.actor?.sessionId) === sessionId) : entries;
      const names = [...new Set(selected.map(entry => entry.decision.plugin?.host || entry.decision.outcomeReceipt?.plugin?.host || 'unknown'))];
      const host = names.length === 1 ? names[0] : names.length ? 'mixed' : 'unknown';
      // The local quiet display preference, read without writing anything.
      // Unknown stays null so a caller never treats a missing file as consent.
      let quiet = null;
      try { quiet = require('./upgrade-moments.cjs').quiet() === true; } catch { quiet = null; }
      return { host, hosts: hostCounts, license: displayLicense(await effectiveStatus(args, entries)), health, integrityEvents: today.filter(entry => entry.decision.plugin?.event === 'integrity').length, day, timezone: 'UTC', decisions: decisions.length, spendCents: decisions.filter(entry => entry.decision.action !== 'block').reduce((total, entry) => total + (entry.decision.plugin?.chargedCents ?? entry.decision.projectedCents), 0), blocks: decisions.filter(entry => entry.decision.action === 'block').length, failOpenEvents: today.filter(entry => failOpen(entry.decision)).length, outcomes: today.filter(entry => entry.decision.entryType === 'outcome').length, totalEntries: entries.length, ...pendingRecovery(), displayPreferences: {quiet} };
    }
    const from = args.fromSequence || 0;
    const limit = args.limit || 100;
    const eligible = entries.filter(entry => entry.sequence >= from);
    const page = eligible.slice(0, limit);
    const nextSequence = eligible.length > page.length ? page.at(-1).sequence + 1 : null;
    if (name === 'list_decisions') return { entries: page.map(summary), nextSequence, totalEntries: entries.length };
    const entitlement = license(args, entries);
    if (!entitlement.paid) {
      const error = new Error('Receipt export requires a paid license.');
      error.code = entitlement.reason || 'license_required';
      throw error;
    }
    const verification = await verify(entries);
    if (!verification.ok) throw new Error('Ledger verification failed; export refused.');
    return { format: 'agentguard-signed-receipts-v1', publicKeyHex: verification.publicKeyHex, verified: true, complete: from === 0 && nextSequence === null, entries: page, nextSequence, totalEntries: entries.length, lastEntryHash: verification.lastEntryHash };
  }
  // The latest work receipt with its ledger row number, read like every other
  // row but without the signature check, for displays that verify separately.
  async function latestWorkReceipt(sessionId) {
    const entry = (await snapshot()).findLast(item => isReceipt(item, sessionId));
    return entry ? {sequence: entry.sequence, entryHash: entry.entryHash, ...receiptView(entry)} : null;
  }
  return { call, latestWorkReceipt, filePath: store.filePath };
}

async function handleRpc(request, reader) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (request.id !== undefined && typeof request.id !== 'string' && typeof request.id !== 'number' && request.id !== null)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } };
  if (request.id === undefined) return null;
  const respond = result => ({ jsonrpc: '2.0', id: request.id, result });
  switch (request.method) {
    case 'initialize': return respond({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agentguard', version: require('../package.json').version } });
    case 'ping': return respond({});
    case 'tools/list': return respond({ tools: TOOLS });
    case 'tools/call': {
      const name = request.params?.name;
      try {
        const result = await reader.call(name, request.params?.arguments || {});
        // A refused or failed score call is a tool error that still carries
        // its structured reason, so the caller never mistakes it for a score.
        const failed = name === 'agent_score' && result?.ok === false;
        return respond({ ...(failed ? {isError: true} : {}), content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        if (['license_required', 'seat_limit'].includes(error.code)) return respond({isError: true, content: [{type: 'text', text: `${error.code}: verification is free; receipt export requires a valid paid license and an available seat.`}]});
        if (name === 'agent_score' || name === 'agent_score_questions') return respond({isError: true, content: [{type: 'text', text: 'Request failed: agent_score accepts answers, consent and an optional createShare boolean only; agent_score_questions accepts no arguments. Nothing was sent.'}]});
        // Never return raw filesystem/SDK errors, which could contain contents.
        return respond({ isError: true, content: [{ type: 'text', text: 'Request failed: check the tool arguments, ledger integrity, and the public verification key locally.' }] });
      }
    }
    default: return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found.' } };
  }
}

function startServer(reader = createReader()) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  input.on('line', line => {
    pending = pending.then(async () => {
      if (!line.trim()) return;
      let request;
      try { if (Buffer.byteLength(line) > 1024 * 1024) throw new Error(); request = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON request.' } }) + '\n');
        return;
      }
      const response = await handleRpc(request, reader);
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }).catch(() => { process.stderr.write('agentguard: read-only MCP request failed.\n'); });
  });
  return input;
}

module.exports = { createReader, handleRpc, startServer, TOOLS, resolveScoreOrigin, parseScorePayload };
if (require.main === module) startServer();
