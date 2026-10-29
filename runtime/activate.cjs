#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {locations, hostContext} = require('./common.cjs');
const {readPolicy} = require('./policy-file.cjs');
const {readSessionLicense} = require('./license.cjs');
// Asks the running worker to resolve this session's license again (validation
// and seat registration), so a new key or member ID takes effect now rather
// than at the next heartbeat. This process opens no socket.
async function refreshed(data, policy, options) {
  const sessionId = options.sessionId || hostContext().sessionId || 'local';
  const host = require('./live-sessions.cjs').findHost(process.ppid);
  try {
    const response = await (options.request || require('./client.cjs').request)({control: 'license-refresh', sessionId, ...host}, {data, timeoutMs: 5000});
    return response.license || readSessionLicense({data, sessionId, policy});
  } catch { return {...readSessionLicense({data, sessionId, policy}), mode: 'shadow', reason: 'license_unavailable'}; }
}
async function activate(key, options = {}) {
  if (typeof key !== 'string' || !/^ag_[A-Za-z0-9_-]{4,1000}$/.test(key.trim())) throw new Error('License key format is invalid.');
  const data = options.data || locations().data;
  const {personal} = readPolicy(data);
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, 'policy.json');
  const temporary = file + '.' + crypto.randomUUID();
  fs.writeFileSync(temporary, JSON.stringify({...personal, licenseKey: key.trim()}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, file);
  const source = readPolicy(data);
  let policy = source.policy;
  let status = await refreshed(data, policy, options);
  if (require('./org-policy.cjs').orgEnabled(status)) {
    const org = require('./org-policy.cjs').readCachedOrgPolicy(data, {keyFingerprint: crypto.createHash('sha256').update(require('./license.cjs').configuredKey(policy)).digest('hex')});
    if (org.envelope) policy = require('./org-policy.cjs').mergeOrgPolicy(source.personal, source.shared, org.envelope.policy);
    if (org.reason) status = {...status, mode: 'shadow', reason: status.reason || org.reason};
  }
  try { require('./engine.cjs').validatePolicy(policy); } catch { status = {...status, mode: 'shadow', reason: status.reason || 'policy_invalid'}; }
  return {tier: status.tier, mode: status.paid && status.mode !== 'shadow' ? (policy.mode || 'enforce') : 'shadow', reason: status.reason, seatsUsed: status.seatsUsed,
    seatLimit: status.seatLimit, seatStorage: status.seatStorage ?? null, seatsVerified: status.seatsVerified === true, expiresAt: status.expiresAt, offlineGrace: status.offlineGrace,
    ...seatFields(status)};
}
// The Team member ID (`agm_` and 32 hexadecimal characters), or `off` to remove
// it. Saved beside the license key in policy.json; this session's seat is then
// registered again under the person. The ID itself is never printed.
async function setMember(input, options = {}) {
  const {isMemberId, writeMemberId} = require('./member-id.cjs');
  const value = String(input ?? '').trim();
  const clear = value === '' || value === 'off';
  if (!clear && !isMemberId(value)) throw new Error('Member ID format is invalid.');
  const data = options.data || locations().data;
  const written = writeMemberId(data, clear ? null : value);
  const policy = readPolicy(data).policy;
  const status = await refreshed(data, policy, options);
  return {memberConfigured: written.configured, tier: status.tier, mode: status.paid && status.mode !== 'shadow' ? (policy.mode || 'enforce') : 'shadow', reason: status.reason,
    seatsUsed: status.seatsUsed, seatLimit: status.seatLimit, ...seatFields(status)};
}
// What a Team heartbeat said about the person's seat; absent for other tiers.
function seatFields(status) {
  return {seatUnit: status.seatUnit ?? null, memberStatus: status.memberStatus ?? null, memberMachines: status.memberMachines ?? null};
}
module.exports = {activate, setMember};
if (require.main === module) {
  const member = process.argv[2] === 'member';
  const sessionId = process.argv[member ? 3 : 2];
  const input = fs.readFileSync(0, 'utf8').trim();
  (member ? setMember(input, {sessionId}) : activate(input, {sessionId}))
    .then(async status => { await require('./session-start.cjs').track(sessionId || hostContext().sessionId || 'local', process.ppid).catch(() => {}); process.stdout.write(JSON.stringify(status) + '\n'); })
    .catch(() => {process.stderr.write(member ? 'agentguard: the member ID could not be saved; use agm_ followed by 32 hexadecimal characters, or off.\n'
      : 'agentguard: activation could not complete; inspect local policy and license status.\n');process.exitCode = 1;});
}
