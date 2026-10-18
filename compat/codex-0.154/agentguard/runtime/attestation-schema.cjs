'use strict';
// The public contract. No policy or ledger object is ever spread into it.
const crypto = require('node:crypto');
const SCHEMA = 'agentguard.attestation.v1';
const DAY_MS = 86400000;
const PRESETS = ['solo-dev', 'careful', 'strict', 'website', 'copies-ask'];
const GUARD_RULE_IDS = [...Array.from({length: 20}, (_, index) => `GP${String(index + 1).padStart(3, '0')}`), 'inbox-reset-codes'];
const COUNT_KEYS = ['allowed', 'asked', 'approved', 'denied', 'failOpen'];
const ROOT_KEYS = ['schema', 'pluginVersion', 'createdAt', 'windowStart', 'windowEnd', 'host', 'limits', 'counts', 'chain', 'publicKeyHex', 'signerFingerprint'];
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const mode = value => ['enforce', 'shadow'].includes(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function invalid() { throw new Error('Attestation fields are invalid.'); }
function fields(value, required, optional = []) {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key))
      || Reflect.ownKeys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function list(value, check) {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) invalid(); check(value[i]); }
}
function validLabel(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 60
    && !/[^A-Za-z0-9 -]/.test(value) && value.trim().length > 0;
}
// JSON primitives only. Sorting is recursive; array order is retained.
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    list(value, () => {});
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string')) invalid();
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function validate(value, signed) {
  fields(value, [...ROOT_KEYS, ...(signed ? ['signature'] : [])], ['label']);
  if (value.schema !== SCHEMA || !['claude-code', 'codex'].includes(value.host)
      || typeof value.pluginVersion !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/.test(value.pluginVersion)
      || /[^0-9A-Za-z.-]/.test(value.pluginVersion)
      || ![value.createdAt, value.windowStart, value.windowEnd].every(instant)
      || value.windowEnd !== value.createdAt) invalid();
  const days = (Date.parse(value.windowEnd) - Date.parse(value.windowStart)) / DAY_MS;
  if (![7, 30].includes(days)) invalid();
  if (Object.hasOwn(value, 'label') && !validLabel(value.label)) invalid();
  const limits = value.limits;
  fields(limits, ['mode', 'preset', 'caps', 'subAgentLimits', 'guardRules']);
  if (!mode(limits.mode) || (limits.preset !== null && !PRESETS.includes(limits.preset))) invalid();
  list(limits.caps, cap => {
    fields(cap, ['window', 'amountCents', 'action', 'scope']);
    if (!['per_call', 'per_session', 'per_minute', 'per_hour', 'per_day', 'per_month'].includes(cap.window)
        || !count(cap.amountCents) || !['block', 'shadow', 'allow'].includes(cap.action)
        || !['global', 'scoped', 'session'].includes(cap.scope)) invalid();
  });
  const sub = limits.subAgentLimits;
  fields(sub, ['mode', 'spawnRate', 'fanout', 'maxDepth', 'launchMaxDepth', 'sessionTokenLimit']);
  if (!mode(sub.mode) || !count(sub.maxDepth) || !count(sub.sessionTokenLimit)
      || (sub.launchMaxDepth !== null && (!count(sub.launchMaxDepth) || sub.launchMaxDepth < 1))) invalid();
  for (const [name, extra] of [['spawnRate', ['enforced']], ['fanout', []]]) {
    const window = sub[name];
    fields(window, ['count', 'windowActiveMinutes', ...extra]);
    if (!count(window.count) || !Number.isFinite(window.windowActiveMinutes) || window.windowActiveMinutes <= 0) invalid();
  }
  if (typeof sub.spawnRate.enforced !== 'boolean' || (limits.mode === 'shadow' && sub.mode !== 'shadow')
      || (sub.mode === 'shadow' && sub.spawnRate.enforced)) invalid();
  list(limits.guardRules, rule => {
    fields(rule, ['id', 'action']);
    if (!GUARD_RULE_IDS.includes(rule.id) || !['warn', 'ask', 'stop'].includes(rule.action)) invalid();
  });
  const ids = limits.guardRules.map(rule => rule.id);
  if (new Set(ids).size !== ids.length || canonical(ids) !== canonical([...ids].sort())) invalid();
  fields(value.counts, COUNT_KEYS);
  if (!Object.values(value.counts).every(count)) invalid();
  const c = value.counts;
  const decisions = c.allowed + c.asked + c.denied + c.failOpen;
  if (!count(decisions) || c.approved > c.asked) invalid();
  const chain = value.chain;
  fields(chain, ['entries', 'firstSequence', 'lastSequence', 'ok']);
  if (!count(chain.entries) || chain.ok !== true || decisions > chain.entries) invalid();
  if (chain.entries === 0) {
    if (chain.firstSequence !== null || chain.lastSequence !== null) invalid();
  } else if (!count(chain.firstSequence) || !count(chain.lastSequence)
      || chain.lastSequence < chain.firstSequence || chain.lastSequence - chain.firstSequence + 1 < chain.entries) invalid();
  if (!hex(value.publicKeyHex, 64) || !hex(value.signerFingerprint, 16)
      || crypto.createHash('sha256').update(Buffer.from(value.publicKeyHex, 'hex')).digest('hex').slice(0, 16) !== value.signerFingerprint) invalid();
  if (signed && !hex(value.signature, 128)) invalid();
  return value;
}
function validatePayload(value) { return validate(value, false); }
function validateAttestation(value) { return validate(value, true); }
function verifyAttestation(value) {
  try {
    validateAttestation(value);
    const {signature, ...payload} = value;
    const key = crypto.createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value.publicKeyHex, 'hex')]), type: 'spki', format: 'der'});
    return crypto.verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
module.exports = {SCHEMA, DAY_MS, PRESETS, COUNT_KEYS, canonical, fields, validLabel, validatePayload, validateAttestation, verifyAttestation};
