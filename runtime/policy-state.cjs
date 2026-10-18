'use strict';
// Shared by hooks and the worker. Only local files are read here.
const {createHash} = require('node:crypto');
const {readPolicy} = require('./policy-file.cjs');
const {readSessionLicense, configuredKey} = require('./license.cjs');
const {readCachedOrgPolicy, mergeOrgPolicy, orgEnabled, soloEnabled} = require('./org-policy.cjs');
const {mergeGuardPack} = require('./org-policy-contract.cjs');
const {validatePolicy} = require('./policy-schema.cjs');
// A Solo snapshot is the user's own policy on another machine: it and the local
// personal file can each tighten a Guard Pack rule, and neither can loosen one.
const RANK = {off: 0, warn: 1, ask: 2, stop: 3};
function tighten(first, second) {
  const thresholds = [first, second].map(value => value.pageGuard?.internalLinkThreshold).filter(value => value !== undefined);
  return {rules: Object.fromEntries(Object.keys(first.rules).map(id => [id, RANK[second.rules[id]] > RANK[first.rules[id]] ? second.rules[id] : first.rules[id]])),
    ...(thresholds.length ? {pageGuard: {internalLinkThreshold: Math.min(...thresholds)}} : {})};
}
// The sync state is read from disk only, so a hook and the worker always see
// the same Solo policy; a worker-side failure is written there (engine.recordOrgFailure).
function policyState(data, sessionId, {licenseReader = readSessionLicense} = {}) {
  const source = readPolicy(data);
  let license = licenseReader({data, sessionId, policy: source.policy, personalPolicy: source.personal});
  let config = license.paid || !source.team ? source.policy : source.personal;
  let org = null;
  if (orgEnabled(license) || soloEnabled(license)) {
    const key = configuredKey(source.policy);
    org = readCachedOrgPolicy(data, {keyFingerprint: key ? createHash('sha256').update(key).digest('hex') : null});
    if (soloEnabled(license) && org.reason) org = {...org, envelope: null};
    if (org.envelope) {
      validatePolicy(source.personal);
      if (source.shared) validatePolicy({...source.personal, ...source.shared});
      // A personal snapshot replaces policy settings on each Solo machine.
      // Team constraints still combine monotonically across policy layers.
      config = soloEnabled(license) ? {...source.personal, ...org.envelope.policy}
        : mergeOrgPolicy(source.personal, source.shared, org.envelope.policy);
    }
    if (org.reason && !soloEnabled(license)) license = {...license, mode: 'shadow', reason: license.reason || org.reason};
  }
  config = {...config, guardPack: soloEnabled(license) && org?.envelope
    ? tighten(mergeGuardPack(source.personal, null, undefined), mergeGuardPack(org.envelope.policy, null, undefined))
    : mergeGuardPack(source.personal, license.paid ? source.shared : null, org?.envelope?.policy)};
  return {config: validatePolicy(config), license, orgPolicy: org?.envelope ?? null, syncReason: org?.reason ?? null};
}
module.exports = {policyState};
