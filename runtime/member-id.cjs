'use strict';
// One Team person, one seat. The owner reads each person's member ID from the
// dashboard's Members panel (GET /api/dashboard/members) and hands it to them;
// the person enters it once, beside the license key. It is stored in the local
// policy file and read from there. It identifies a person, so like the license
// key it is never written to a receipt, a ledger row, a log line, a status file
// or a transcript. Solo and Free never send it. Contract: docs/TEAM_CAPS_CONTRACT.md.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MEMBER_ID_PATTERN = /^agm_[a-f0-9]{32}$/;
const TEAM_TIERS = /^(?:startup|growth)(?:_pro)?$/;
const isMemberId = value => typeof value === 'string' && MEMBER_ID_PATTERN.test(value);
// Like the key: the Claude Code plugin option first, then the environment, then
// the field saved by `activate member`.
function configuredMemberId(policy = {}) {
  const value = process.env.CLAUDE_PLUGIN_OPTION_MEMBER_ID?.trim() || process.env.AGENTGUARD_MEMBER_ID?.trim() || policy?.memberId;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return isMemberId(trimmed) ? trimmed : null;
}
// The member ID a heartbeat or allowance request may carry: only a Team tier
// has a roster, so every other tier gets null and sends nothing.
function memberIdFor(policy, tier) {
  return TEAM_TIERS.test(String(tier ?? '')) ? configuredMemberId(policy) : null;
}
// Saves the field in the host's policy.json, or removes it with null, keeping
// every other field, the license key included. The write is atomic.
function writeMemberId(data, memberId) {
  if (memberId !== null && !isMemberId(memberId)) throw new Error('Member ID format is invalid.');
  const {personal} = require('./policy-file.cjs').readPolicy(data);
  const {memberId: previous, ...rest} = personal;
  const next = memberId === null ? rest : {...rest, memberId};
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, 'policy.json'), temporary = `${file}.${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', {mode: 0o600, flag: 'wx'}); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ } }
  return {configured: memberId !== null, changed: previous !== (memberId ?? undefined)};
}
module.exports = {MEMBER_ID_PATTERN, TEAM_TIERS, isMemberId, configuredMemberId, memberIdFor, writeMemberId};
