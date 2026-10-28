'use strict';
// Policy loading and merging are synchronous local reads, including in hooks.
const fs = require('node:fs');
const path = require('node:path');
const {validateEnvelope, mergeGuardPack, TIERS} = require('./org-policy-contract.cjs');
const orgEnabled = license => /^(?:startup|growth)(?:_pro)?$/.test(license?.tier ?? '');
const soloEnabled = license => license?.paid === true && /^solo(?:_pro)?$/.test(license?.tier ?? '');
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readCachedOrgPolicy(data, {keyFingerprint} = {}) {
  const status = readJson(path.join(data, 'org-policy-status.json'));
  if (!keyFingerprint || status?.license_fingerprint !== keyFingerprint) return {envelope: null, reason: 'org_policy_unavailable', status};
  if (status.status === 'none') return {envelope: null, reason: null, status};
  const cached = readJson(path.join(data, 'org-policy.json'));
  if (cached?.license_fingerprint !== keyFingerprint) return {envelope: null, reason: 'org_policy_unavailable', status};
  const {license_fingerprint: ignored, ...envelope} = cached;
  if (validateEnvelope(envelope).length || status.org_policy_sha256 !== envelope.sha256) return {envelope: null, reason: 'org_policy_invalid', status};
  if (!['ready', 'shadow'].includes(status.status)) return {envelope: null, reason: 'org_policy_invalid', status};
  return {envelope, reason: status.status === 'shadow' ? (status.reason || 'org_policy_unavailable') : null, status};
}
function mergeScope(lower = {}, upper = {}) {
  const result = {...lower, ...upper};
  const commandGroups = [...(lower.commandRuleGroups ?? (lower.commandRules ? [lower.commandRules] : [])), ...(upper.commandRuleGroups ?? (upper.commandRules ? [upper.commandRules] : []))];
  if (commandGroups.length) result.commandRuleGroups = commandGroups;
  const groups = [...(lower.allowedToolGroups ?? (lower.allowedTools === undefined ? [] : [lower.allowedTools])),
    ...(upper.allowedToolGroups ?? (upper.allowedTools === undefined ? [] : [upper.allowedTools]))];
  if (groups.length) result.allowedToolGroups = groups;
  for (const field of ['deniedTools', 'ethicalWall']) {
    if (lower[field] !== undefined || upper[field] !== undefined) result[field] = [...new Set([...(lower[field] ?? []), ...(upper[field] ?? [])])];
  }
  const ceilings = [lower.maxCapability, upper.maxCapability].filter(value => value !== undefined);
  if (ceilings.length) result.maxCapability = ceilings.reduce((a, b) => TIERS.indexOf(a) <= TIERS.indexOf(b) ? a : b);
  if (lower.caps !== undefined || upper.caps !== undefined) result.caps = [...(lower.caps ?? []), ...(upper.caps ?? [])];
  return result;
}
function mergeLayers(lower, upper) {
  const result = mergeScope(lower, upper);
  result.toolRules = [...(lower.toolRules ?? []), ...(upper.toolRules ?? [])];
  // Requests from other agents: strictest action, united patterns and categories.
  if (lower.untrustedOrigin !== undefined || upper.untrustedOrigin !== undefined) result.untrustedOrigin = require('./untrusted-origin.cjs').merge(lower.untrustedOrigin, upper.untrustedOrigin);
  result.sessions = {};
  for (const id of new Set([...Object.keys(lower.sessions ?? {}), ...Object.keys(upper.sessions ?? {})])) {
    Object.defineProperty(result.sessions, id, {value: mergeScope(lower.sessions?.[id], upper.sessions?.[id]), enumerable: true, writable: true, configurable: true});
  }
  return result;
}
function mergeOrgPolicy(personal, team, orgPolicy) {
  const lower = team ? mergeLayers(personal, team) : personal;
  const result = mergeLayers(lower, orgPolicy);
  result.guardPack = mergeGuardPack(personal, team, orgPolicy);
  result.mode = (orgPolicy.mode ?? 'enforce') === 'enforce' ? 'enforce' : (lower.mode ?? 'enforce');
  // An org's omitted tenant/payment expression has the documented default.
  // Lower files must not redirect the actor away from an org-scoped cap or
  // unclassify payment-like tools. Explicit org tool rules are applied last.
  result.tenantId = orgPolicy.tenantId ?? 'local';
  result.paymentPattern = orgPolicy.paymentPattern ?? require('./policy-schema.cjs').DEFAULT_PAYMENT_PATTERN;
  if (orgPolicy.defaultMatterId !== undefined) {
    result.defaultMatterId = orgPolicy.defaultMatterId;
    for (const [id, session] of Object.entries(result.sessions)) session.matterId = orgPolicy.sessions?.[id]?.matterId ?? orgPolicy.defaultMatterId;
  }
  if (personal.licenseKey) result.licenseKey = personal.licenseKey;
  return result;
}
module.exports = {readCachedOrgPolicy, mergeOrgPolicy, mergeScope, orgEnabled, soloEnabled};
