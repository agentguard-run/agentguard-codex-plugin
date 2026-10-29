'use strict';

// Only the detached worker invokes network resolution, including activation.
// Hooks call readSessionLicense only, reading a content-free local snapshot.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 2000;
const SCHEMA = 'agentguard.plugin.license.v1';
const SEAT_ENDPOINT = 'https://agentguard.run/api/license/seats';
const heartbeatPending = new Map();
const PAID_TIERS = new Set(['solo', 'startup', 'growth', 'solo_pro', 'startup_pro', 'growth_pro']);
const pending = new Map();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const nowOf = now => typeof now === 'function' ? now() : (now ?? Date.now());
const home = () => path.resolve(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));

// In Claude Code the key comes first from the plugin option license_key, which
// Claude Code asks for, keeps in the system credential store and hands to the
// hooks and the MCP server as CLAUDE_PLUGIN_OPTION_LICENSE_KEY. Codex, and
// installs that set a key before the option existed, use AGENTGUARD_LICENSE_KEY
// or the key saved by activation in the plugin policy.
function configuredKey(policy = {}) {
  const value = process.env.CLAUDE_PLUGIN_OPTION_LICENSE_KEY?.trim() || process.env.AGENTGUARD_LICENSE_KEY?.trim() || policy.licenseKey;
  return typeof value === 'string' ? value.trim() : '';
}
function identity({data, sessionId, policy}) {
  const key = configuredKey(policy);
  const sessionFingerprint = digest(String(sessionId || 'unknown'));
  const keyFingerprint = key ? digest(key) : null;
  const directory = path.join(path.resolve(data), 'license-status', 'sessions');
  return {key, keyFingerprint, sessionFingerprint, directory,
    file: path.join(directory, `${sessionFingerprint}-${keyFingerprint || 'free'}.json`)};
}
function licenseStatusPath(options) { return identity(options).file; }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function expiry(status) {
  if (status.expiresAt === null || status.expiresAt === undefined) return null;
  return typeof status.expiresAt === 'string' && Number.isFinite(Date.parse(status.expiresAt))
    ? Date.parse(status.expiresAt) : NaN;
}
function eligible(status, now, grace = false) {
  if (!status || status.valid !== true || !PAID_TIERS.has(status.tier)) return false;
  const at = expiry(status);
  return at === null || (Number.isFinite(at) && now < at + (grace ? GRACE_MS : 0));
}
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function sessionProcessId(sessionFingerprint) {
  const hex = digest(`agentguard-seat-v1:${sessionFingerprint}`).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
function seatIdentity(id, sdkPayload, existing) {
  const machineFingerprint = /^[a-f0-9]{64}$/.test(existing?.machineFingerprint || '')
    ? existing.machineFingerprint : sdkPayload.machine_fingerprint;
  if (!/^[a-f0-9]{64}$/.test(machineFingerprint || '')) throw new Error('Seat identity unavailable.');
  return {machineFingerprint, processId: sessionProcessId(id.sessionFingerprint)};
}
function seatFields(seat, now) {
  const seatsUsed = count(seat?.activeSeats), seatLimit = count(seat?.maxActiveSeats);
  const valid = typeof seat?.ok === 'boolean' && seatsUsed !== null && seatLimit !== null;
  const storage = ['kv', 'memory'].includes(seat?.storage) ? seat.storage : null;
  return {valid, seatsUsed, seatLimit, seatStorage: storage,
    seatsVerified: valid && storage === 'kv',
    ...(valid ? {seatRefreshedAt: new Date(now).toISOString()} : {})};
}
// What a Team heartbeat that carried a member ID was counted as. Only the
// documented values are kept; the member ID itself is never stored here.
function memberFields(seat) {
  const fields = {};
  if (['member', 'session'].includes(seat?.seatUnit)) fields.seatUnit = seat.seatUnit;
  if (['active', 'over_limit', 'unknown'].includes(seat?.memberStatus)) fields.memberStatus = seat.memberStatus;
  if (count(seat?.memberMachines) !== null) fields.memberMachines = seat.memberMachines;
  return fields;
}
// The seat heartbeat body: exactly the four documented fields, plus the roster
// member ID for a Team tier when the person entered one.
function seatBody(id, registeredIdentity, orgPolicySha256, memberId) {
  return {license_key: id.key, machine_fingerprint: registeredIdentity.machineFingerprint, process_id: registeredIdentity.processId,
    org_policy_sha256: /^[a-f0-9]{64}$/.test(orgPolicySha256 || '') ? orgPolicySha256 : null,
    ...(memberId ? {member_id: memberId} : {})};
}
function limits(status) {
  return count(status?.features?.maxActiveSeats) ?? count(status?.seats)
    ?? (String(status?.tier).startsWith('growth') ? 50 : String(status?.tier).startsWith('startup') ? 10 : String(status?.tier).startsWith('solo') ? 3 : 1);
}
function snapshot(id, status, now, values = {}) {
  const at = status ? expiry(status) : null;
  return {schema: SCHEMA, sessionFingerprint: id.sessionFingerprint, keyFingerprint: id.keyFingerprint,
    paid: false, mode: 'shadow', reason: 'license_required', tier: PAID_TIERS.has(status?.tier) ? status.tier : 'free',
    seatsUsed: null, seatLimit: limits(status), seatStorage: null, seatsVerified: false, seatRefreshedAt: null, expiresAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    graceUntil: Number.isFinite(at) ? new Date(at + GRACE_MS).toISOString() : null,
    offlineGrace: false, source: 'missing', refreshedAt: new Date(now).toISOString(), ...values};
}
function matchStatus(value, id) {
  return value?.schema === SCHEMA && value.sessionFingerprint === id.sessionFingerprint
    && value.keyFingerprint === id.keyFingerprint;
}
function freeStatus(id, now, options) {
  const policy = options.personalPolicy || options.policy || {};
  return snapshot(id, null, now, {mode: policy.mode === 'shadow' ? 'shadow' : 'enforce',
    reason: null, source: 'local', seatLimit: 1, seatStatus: 'local'});
}
function effective(value, now) {
  if (!value.paid || !PAID_TIERS.has(value.tier)) return {...value, paid: false, mode: 'shadow'};
  const at = expiry(value);
  if (Number.isNaN(at) || (at !== null && now >= at + GRACE_MS)) {
    return {...value, paid: false, mode: 'shadow', reason: 'license_required', offlineGrace: false};
  }
  if (value.seatRevoked) return {...value, mode: 'shadow', reason: 'seat_revoked', offlineGrace: at !== null && now >= at};
  return {...value, mode: value.mode === 'shadow' ? 'shadow' : 'enforce',
    reason: value.mode === 'shadow' ? value.reason || 'license_unavailable' : null, offlineGrace: at !== null && now >= at};
}
function writeStatus(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, file);
}
function readSessionLicense(options) {
  const id = identity(options);
  const now = nowOf(options.now);
  // Free follows the current local policy, including after an upgrade from
  // an older no-key snapshot. A configured key always uses the paid checks.
  if (!id.key) return freeStatus(id, now, options);
  const value = readJson(id.file);
  if (matchStatus(value, id) && (value.source !== 'resolving' || value.resolvingShadow === true || value.seatRevoked)) return effective(value, now);
  // Session startup resolves remotely outside hooks. A previously validated
  // paid customer retains cached access while that detached refresh starts.
  const cached = id.key ? cachedStatus(id) : null;
  if (eligible(cached, now, true)) {
    const at = expiry(cached);
    return snapshot(id, cached, now, {paid: true, mode: 'enforce', reason: null,
      source: value?.source === 'resolving' ? 'cached_pending' : 'offline_cache',
      offlineGrace: at !== null && now >= at, seatStatus: 'unknown'});
  }
  return snapshot(id, null, now, {source: id.key ? 'unresolved' : 'missing'});
}
// This helper is for status display only. It must not authorize an export or
// tool in a different session using the most recently opened session's seat.
function readLatestLicenseStatus(options) {
  const id = identity(options);
  if (!id.key) return readSessionLicense(options);
  let files;
  try { files = fs.readdirSync(id.directory); } catch { return readSessionLicense(options); }
  const suffix = `-${id.keyFingerprint || 'free'}.json`;
  const values = files.filter(file => /^[a-f0-9]{64}-(?:[a-f0-9]{64}|free)\.json$/.test(file) && file.endsWith(suffix))
    .map(file => readJson(path.join(id.directory, file)))
    .filter(value => value?.schema === SCHEMA && value.keyFingerprint === id.keyFingerprint && value.source !== 'resolving' && Number.isFinite(Date.parse(value.refreshedAt)))
    .sort((a, b) => Date.parse(b.refreshedAt) - Date.parse(a.refreshedAt));
  return values.length ? effective(values[0], nowOf(options.now)) : readSessionLicense(options);
}

function cachedStatus(id) {
  return readJson(path.join(home(), `license-${id.keyFingerprint}.json`))?.status || null;
}

async function httpPostJson(url, payload, {signal}) {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify(payload), signal, redirect: 'error'});
  if (!response.ok) throw new Error('License service unavailable.');
  return response.json();
}

async function refresh(options, id) {
  const now = nowOf(options.now);
  const cached = cachedStatus(id);
  let status = null;
  let source = 'remote';
  let seat = null;
  let seatFailure = false;
  let registeredIdentity = null;
  const controller = new AbortController();
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  const aborted = new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('License refresh timed out.')), {once: true});
  });
  aborted.catch(() => {});
  // The same deadline covers validation and seat registration, including a
  // transport that is injected by an embedding runtime or test.
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  const transport = async (url, payload) => {
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error('License refresh timed out.');
    return Promise.race([Promise.resolve().then(() => (options.postJson || httpPostJson)(url, payload,
      {signal: controller.signal, deadline})), aborted]);
  };
  try {
    const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
    try {
      status = await sdk.validateLicenseKey(id.key, {home: home(), nowMs: now, force: true, postJson: transport});
    } catch {
      status = cached;
      source = 'offline_cache';
    }
    const paid = eligible(status, now, source === 'offline_cache');
    if (!paid) return snapshot(id, status, now, {source, ...(options.previousSeatRevoked ? {seatRevoked: true, reason: 'seat_revoked'} : {})});
    // One person, one seat: a Team heartbeat names the person by roster member
    // ID when one is configured. Solo and Free tiers never send it.
    const memberId = require('./member-id.cjs').memberIdFor(options.policy, status.tier);
    // The SDK provides the existing installation identity and seat protocol.
    // Its validation callback reuses this session's result, so only one actual
    // validation request is made and cached paid seats are still registered.
    try {
      await sdk.validateAndRegisterLicense(id.key, {home: home(), nowMs: now, force: true,
        postJson: async (url, payload) => {
          if (new URL(url).pathname === '/api/license/validate') return status;
          try {
            registeredIdentity = seatIdentity(id, payload);
            seat = await transport(SEAT_ENDPOINT, seatBody(id, registeredIdentity, options.orgPolicySha256, memberId));
            return seat;
          }
          catch (error) { seatFailure = true; throw error; }
        }});
    } catch {
      if (!seat || seat.ok !== false) seatFailure = true;
    }
    if (seat?.ok !== true || count(seat?.activeSeats) === null || count(seat?.maxActiveSeats) === null) seatFailure = true;
    const seatLimit = count(seat?.maxActiveSeats) ?? limits(status);
    const seatsUsed = count(seat?.activeSeats);
    // A person refused because every seat is taken (over_limit) is the existing
    // over-limit case: shadow with seat_limit, tried again at the next heartbeat.
    const overLimit = seat?.ok === false || seat?.memberStatus === 'over_limit' || (seatsUsed !== null && seatsUsed > seatLimit);
    const at = expiry(status);
    const observation = seatFields(seat, now);
    const seatRevoked = seat?.revoked === true || (options.previousSeatRevoked === true && !(observation.valid && seat?.revoked === false));
    const reason = seatRevoked ? 'seat_revoked' : overLimit ? (seat?.error === 'license_not_found' ? 'license_required' : 'seat_limit')
      : source === 'offline_cache' ? 'license_unavailable' : seatFailure ? 'seat_unavailable' : null;
    return snapshot(id, status, now, {paid: !overLimit || seatRevoked, mode: reason ? 'shadow' : 'enforce', reason, seatRevoked,
      seatRevocationConfirmed: observation.valid && typeof seat?.revoked === 'boolean' ? seat.revoked : null,
      seatsUsed, seatLimit, seatStorage: observation.seatStorage, seatsVerified: observation.seatsVerified,
      seatRefreshedAt: observation.seatRefreshedAt ?? null, ...(observation.valid ? memberFields(seat) : {}),
      ...(registeredIdentity ? {seatIdentity: registeredIdentity} : {}), source, offlineGrace: at !== null && now >= at,
      seatStatus: overLimit ? 'denied' : seatFailure ? 'unavailable' : 'registered'});
  } catch {
    return snapshot(id, null, now, {source: 'unavailable', ...(options.previousSeatRevoked ? {seatRevoked: true, reason: 'seat_revoked'} : {})});
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Suppress the deliberately rejected timeout promise after a successful
    // refresh, while leaving all in-flight transports subject to the deadline.
    aborted.catch(() => {});
  }
}

async function resolveSessionLicense(options) {
  const id = identity(options);
  const now = nowOf(options.now);
  if (!id.key) {
    const free = freeStatus(id, now, options);
    writeStatus(id.file, free);
    return free;
  }
  const existing = readJson(id.file);
  if (!options.forceActivation && matchStatus(existing, id) && existing.source !== 'resolving') return effective(existing, now);
  if (pending.has(id.file)) return pending.get(id.file);
  const work = (async () => {
    fs.mkdirSync(id.directory, {recursive: true, mode: 0o700});
    const claim = `${id.file}.claim`;
    if (options.forceActivation) {
      // Explicit activation is the sole operator-triggered retry in a session.
      try { fs.unlinkSync(claim); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let fd;
    try { fd = fs.openSync(claim, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another startup process owns this session's attempt. A claim survives
      // crashes so a broken startup cannot cause a validation retry storm.
      const until = Date.now() + REFRESH_TIMEOUT_MS + 100;
      while (Date.now() < until) {
        const value = readJson(id.file);
        if (matchStatus(value, id) && value.source !== 'resolving') return effective(value, nowOf(options.now));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return readSessionLicense(options);
    }
    fs.closeSync(fd);
    writeStatus(id.file, existing?.mode === 'shadow' && existing.reason ? {...existing, source: 'resolving', resolvingShadow: true} : snapshot(id, null, now, {source: 'resolving'}));
    const value = await refresh({...options, previousSeatRevoked: existing?.seatRevoked}, id);
    try { writeStatus(id.file, value); } catch { const error = new Error('License state unavailable.'); error.code = value.seatRevoked ? 'seat_revoked' : 'license_unavailable'; throw error; }
    return effective(value, nowOf(options.now));
  })();
  pending.set(id.file, work);
  try { return await work; } finally { pending.delete(id.file); }
}

// Only the detached worker calls this function. Hook-side
// reads remain synchronous and never perform a registration or heartbeat.
async function heartbeatSessionSeat(options) {
  const policy = options.policy || require('./policy-file.cjs').readPolicy(options.data).policy;
  const opts = {...options, policy};
  const id = identity(opts);
  const initial = readJson(id.file);
  if (!id.key || !matchStatus(initial, id) || initial.source === 'resolving'
    || !/^[a-f0-9]{64}$/.test(initial.seatIdentity?.machineFingerprint || '')
    || initial.seatIdentity?.processId !== sessionProcessId(id.sessionFingerprint)) return readSessionLicense(opts);
  if (heartbeatPending.has(id.file)) return heartbeatPending.get(id.file);
  const work = (async () => {
    const now = nowOf(options.now);
    let seat = null, registeredIdentity = initial.seatIdentity;
    const controller = new AbortController();
    let timer;
    const aborted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Seat heartbeat timed out.')), {once: true});
    });
    aborted.catch(() => {});
    timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    const deadline = Date.now() + REFRESH_TIMEOUT_MS;
    try {
      // Startup captured the SDK's anonymous machine fingerprint. Reuse that
      // exact pair without revalidating or rewriting the SDK's license cache.
      registeredIdentity = seatIdentity(id, {}, initial.seatIdentity);
      const memberId = require('./member-id.cjs').memberIdFor(policy, initial.tier);
      seat = await Promise.race([
        Promise.resolve().then(() => (options.postJson || httpPostJson)(SEAT_ENDPOINT,
          seatBody(id, registeredIdentity, options.orgPolicySha256, memberId),
          {signal: controller.signal, deadline})),
        aborted,
      ]);
    } catch { /* Failed licensing observations become shadow, never a tool denial. */ }
    finally { clearTimeout(timer); controller.abort(); aborted.catch(() => {}); }
    const observation = seatFields(seat, now);
    const latest = readJson(id.file);
    // Explicit activation owns entitlement changes. A late heartbeat must not
    // overwrite a new startup or activation result for the same key.
    if (!matchStatus(latest, id) || latest.source === 'resolving' || latest.refreshedAt !== initial.refreshedAt) return readSessionLicense(opts);
    const seatRevoked = seat?.revoked === true || (latest.seatRevoked === true && !(observation.valid && seat?.revoked === false));
    const denied = observation.valid && (!seat.ok || seat.memberStatus === 'over_limit');
    let reason = latest.reason;
    if (seatRevoked) reason = 'seat_revoked';
    else if (!observation.valid) reason = 'seat_unavailable';
    else if (denied) reason = seat?.error === 'license_not_found' ? 'license_required' : 'seat_limit';
    else if (['seat_revoked', 'seat_unavailable'].includes(reason) || (latest.paid && reason === 'seat_limit')) reason = null;
    // The member fields follow each valid answer; an answer without them (no
    // member ID sent, or an older server) clears the last ones.
    const {seatUnit, memberStatus, memberMachines, ...kept} = latest;
    const updated = {...kept, seatRevoked, seatRevocationConfirmed: observation.valid && typeof seat?.revoked === 'boolean' ? seat.revoked : null, mode: reason || !latest.paid ? 'shadow' : 'enforce', reason, seatHeartbeatAt: new Date(now).toISOString(),
      seatStorage: observation.seatStorage, seatsVerified: observation.seatsVerified,
      seatStatus: observation.valid ? (denied ? 'denied' : 'registered') : 'unavailable',
      seatHeartbeatError: observation.valid ? (denied ? 'seat_denied' : null) : 'unavailable',
      ...(registeredIdentity ? {seatIdentity: registeredIdentity} : {}),
      ...(observation.valid ? {seatsUsed: observation.seatsUsed, seatLimit: observation.seatLimit,
        seatRefreshedAt: observation.seatRefreshedAt, ...memberFields(seat)} : {seatUnit, memberStatus, memberMachines})};
    for (const key of ['seatUnit', 'memberStatus', 'memberMachines']) if (updated[key] === undefined) delete updated[key];
    try { writeStatus(id.file, updated); } catch { const error = new Error('Seat state unavailable.'); error.code = seatRevoked ? 'seat_revoked' : 'seat_unavailable'; throw error; }
    return effective(updated, now);
  })();
  heartbeatPending.set(id.file, work);
  try { return await work; } finally { heartbeatPending.delete(id.file); }
}

module.exports = {heartbeatSessionSeat, resolveSessionLicense, readSessionLicense, readLatestLicenseStatus, licenseStatusPath, configuredKey,
  GRACE_MS, REFRESH_TIMEOUT_MS, SEAT_ENDPOINT, PAID_TIERS};
