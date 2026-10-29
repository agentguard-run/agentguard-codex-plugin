'use strict';
// The Team caps cache as a status read sees it: the file the worker writes,
// read without the worker and without any request. The shape helpers here are
// shared with the worker's client (team-caps.cjs), which is the only module
// that reserves or releases; nothing here opens a socket or imports it.
const fs = require('node:fs');
const path = require('node:path');
const SCHEMA = 'agentguard.plugin.team-caps.v1';
const KINDS = ['tokens', 'usd_cents'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validWindows = value => Boolean(value) && typeof value === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(value.day ?? '') && /^\d{4}-\d{2}$/.test(value.month ?? '');
const validGrant = grant => Boolean(grant) && typeof grant.grant_id === 'string' && count(grant.granted) && count(grant.spent) && grant.spent <= grant.granted;
const validKind = kind => Boolean(kind) && typeof kind === 'object' && [null, true, false].includes(kind.capped) && Array.isArray(kind.grants) && kind.grants.every(validGrant) && count(kind.overdraft);
function validState(value, fingerprint) {
  return Boolean(value) && typeof value === 'object' && value.schema === SCHEMA && value.license_fingerprint === fingerprint
    && Boolean(value.kinds) && KINDS.every(kind => validKind(value.kinds[kind])) && (value.windows === null || validWindows(value.windows))
    && Boolean(value.token_marks) && typeof value.token_marks === 'object';
}
// What this machine may still spend of a kind: its grants' unspent part, less
// what it spent before the first grant arrived.
const available = kind => kind.grants.reduce((sum, grant) => sum + (grant.granted - grant.spent), 0) - kind.overdraft;
const reachedAt = (kind, now) => kind.reached_until !== null && kind.reached_until !== undefined && isoTime(kind.reached_until) && Date.parse(kind.reached_until) > now;

// Counts and times only; the member ID is not in the file. Null when this
// machine never reserved (Free, Solo, no caps published, or no worker yet).
function readTeamCapsStatus(data, now = Date.now()) {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(data, 'team-caps.json'), 'utf8')); } catch { return null; }
  if (value?.schema !== SCHEMA || !value.kinds || typeof value.kinds !== 'object') return null;
  const kinds = {};
  for (const kind of KINDS) {
    const k = value.kinds[kind];
    if (!validKind(k)) continue;
    kinds[kind] = {capped: k.capped, available: Math.max(0, available(k)), remaining: count(k.remaining) ? k.remaining : null,
      windowResetsAt: isoTime(k.window_resets_at) ? k.window_resets_at : null, reached: reachedAt(k, now), grants: k.grants.length, failOpen: k.fail_open === true};
  }
  return {holder: ['member', 'seat'].includes(value.holder) ? value.holder : null, windows: validWindows(value.windows) ? value.windows : null,
    capSource: hex64(value.cap_source?.sha256) ? value.cap_source.sha256 : null, kinds,
    unavailable: value.unavailable && typeof value.unavailable === 'object' ? {since: isoTime(value.unavailable.since) ? value.unavailable.since : null, failOpen: value.unavailable.fail_open === true} : null,
    stopped: typeof value.stopped?.reason === 'string' ? value.stopped.reason.slice(0, 40) : null};
}
module.exports = {SCHEMA, KINDS, count, hex64, isoTime, validWindows, validGrant, validKind, validState, available, reachedAt, readTeamCapsStatus};
