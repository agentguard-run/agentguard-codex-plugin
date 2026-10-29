'use strict';
// Team caps: one budget per team per UTC day and month, for tokens and for
// priced tool calls in US cents, shared by every seat's machines and agents.
// The owner publishes the caps in the dashboard. This client reserves an
// allowance block from agentguard.run, gates the worker's own calls against
// the cached block, and releases what it did not use.
// Contract: docs/TEAM_CAPS_CONTRACT.md.
//
// Only the detached worker constructs this client. Hooks never reach it: they
// wait on the worker's reply, and the worker answers a gate from the cache in
// memory and on disk, never from the network. Every request here has a two
// second deadline and runs in the background, outside a gate decision. The
// bodies carry numbers and identifiers only: the license key, the member ID or
// seat ID, a kind, an amount and the UTC windows. No prompt, tool name,
// argument or content. Importing this module opens no socket.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {SCHEMA, KINDS, count, hex64, isoTime, validWindows, validKind, validState, available, reachedAt, readTeamCapsStatus} = require('./team-caps-status.cjs');
const RESERVE_ENDPOINT = 'https://agentguard.run/api/team/reserve';
const RELEASE_ENDPOINT = 'https://agentguard.run/api/team/release';
const DEADLINE_MS = 2000;
// An unavailable endpoint is asked again at most once a minute. A kind with no
// team cap is asked about again after this long, so caps the owner publishes
// later are picked up without a restart.
const RETRY_MS = 60000;
const PROBE_MS = 15 * 60 * 1000;
// After a 409 the server's windows are kept for this long before the local
// clock may roll them again, so a clock that is behind cannot churn releases.
const ADOPTED_MS = 5 * 60 * 1000;
const HOLDER_TTL_MS = 30000;
const MAX_MARKS = 64;
// Refusals that end reserving until the next session start: licensing or the
// holder itself was refused, or the request was malformed (a worker bug).
const STOP_STATUSES = new Set([400, 401, 403, 413]);
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const iso = ms => new Date(ms).toISOString();

function windowsAt(now) {
  const day = iso(now).slice(0, 10);
  return {day, month: day.slice(0, 7)};
}
function emptyKind() {
  return {capped: null, grants: [], overdraft: 0, block: null, remaining: null, window_resets_at: null, reached_until: null, fetched_at: null, probe_at: null, fail_open: false};
}
function emptyState(fingerprint) {
  return {schema: SCHEMA, license_fingerprint: fingerprint, holder: null, windows: null, adopted_until: null, cap_source: null,
    kinds: {tokens: emptyKind(), usd_cents: emptyKind()}, unavailable: null, stopped: null, token_marks: {}};
}

// The production transport. Status, body and Retry-After come back as values so
// the caller can tell a refusal from an outage; a thrown error is an outage.
async function httpPostJson(url, body, {signal}) {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal, redirect: 'error'});
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  const retry = Number(response.headers?.get?.('retry-after'));
  return {status: response.status, body: json, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null};
}

class TeamCapsClient {
  constructor({data, postJson = httpPostJson, now = Date.now, licenseReader, readPolicy, onEvent = () => {}} = {}) {
    this.data = data; this.postJson = postJson; this.now = now; this.onEvent = onEvent;
    this.licenseReader = licenseReader ?? require('./license.cjs').readSessionLicense;
    this.readPolicy = readPolicy ?? (() => require('./policy-file.cjs').readPolicy(this.data));
    this.file = path.join(data, 'team-caps.json');
    this.state = null; this.inflight = new Map(); this.holders = new Map(); this.lastHolder = null;
  }
  // Who reserves: the person by member ID when one is entered, otherwise this
  // machine by its registration ID. Nothing for Free, Solo, an unpaid or an
  // unregistered session. Read from local files only, cached briefly.
  holderFor(sessionId) {
    const cached = this.holders.get(sessionId), now = this.now();
    if (cached && now - cached.at < HOLDER_TTL_MS) return cached.holder;
    let holder = null;
    try {
      const {policy} = this.readPolicy();
      const key = require('./license.cjs').configuredKey(policy);
      const {memberIdFor, TEAM_TIERS} = require('./member-id.cjs');
      const license = key ? this.licenseReader({data: this.data, sessionId, policy, now}) : null;
      if (key && license?.paid === true && TEAM_TIERS.test(license.tier ?? '')) {
        const memberId = memberIdFor(policy, license.tier);
        const fingerprint = license.seatIdentity?.machineFingerprint;
        if (memberId) holder = {key, type: 'member', body: {member_id: memberId}};
        else if (hex64(fingerprint)) holder = {key, type: 'seat', body: {seat_id: sha256(`${key}\0${fingerprint}`)}};
      }
    } catch { holder = null; }
    this.holders.set(sessionId, {holder, at: now});
    if (this.holders.size > 256) this.holders.delete(this.holders.keys().next().value);
    if (holder) { this.lastHolder = holder; this.load(holder); }
    return holder;
  }
  load(holder) {
    const fingerprint = sha256(holder.key);
    if (this.state?.license_fingerprint === fingerprint) { this.state.holder = holder.type; return this.state; }
    let value = null;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { value = null; }
    this.state = validState(value, fingerprint) ? value : emptyState(fingerprint);
    this.state.holder = holder.type;
    return this.state;
  }
  // The cache the gates read: written whole, atomically, private to this user.
  // It names the holder kind and the key's fingerprint, never the member ID.
  save() {
    if (!this.state) return;
    try {
      fs.mkdirSync(this.data, {recursive: true, mode: 0o700});
      const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}`;
      try { fs.writeFileSync(temporary, JSON.stringify(this.state) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, this.file); }
      finally { try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ } }
    } catch { /* The allowance stays in this worker's memory. */ }
  }
  // A cached grant from an earlier window is never used in a new one: when the
  // UTC day or month changes, the old grants go back and the kinds start over.
  // Returns the release promise, or null when nothing rolled.
  roll(holder, now = this.now()) {
    const state = this.state, current = windowsAt(now);
    if (state.windows && state.windows.day === current.day && state.windows.month === current.month) return null;
    if (state.windows && state.adopted_until && Date.parse(state.adopted_until) > now) return null;
    if (state.windows && current.day < state.windows.day) return null;
    const dropped = this.dropGrants(now);
    state.windows = current; state.adopted_until = null;
    this.save();
    return this.releaseGrants(holder, dropped);
  }
  // Removes every grant from the cache and returns them for release. What the
  // kinds learned about the caps stays: capped or not, the block size, a
  // reached month that has not reset yet, and whether the kind is failing
  // open. Debits no grant covered yet belong to the window: a cap change or a
  // worker stop keeps them for the next grant, a new window starts clean.
  dropGrants(now = this.now(), kinds = KINDS, keepOverdraft = false) {
    const dropped = [];
    for (const kind of kinds) {
      const k = this.state.kinds[kind];
      for (const grant of k.grants) dropped.push({kind, grant});
      this.state.kinds[kind] = {...emptyKind(), capped: k.capped, block: k.block, probe_at: k.probe_at, fail_open: k.fail_open === true,
        reached_until: reachedAt(k, now) ? k.reached_until : null, overdraft: keepOverdraft && count(k.overdraft) ? k.overdraft : 0};
    }
    return dropped;
  }
  // The decision a gate takes for one call, from the cache alone. It never
  // waits on the network and never throws. amount is what this call needs now.
  gate(kind, amount, sessionId) {
    try {
      if (!KINDS.includes(kind) || !count(amount)) return {kind, action: 'none'};
      const holder = this.holderFor(sessionId);
      if (!holder) return {kind, action: 'none'};
      const state = this.state, now = this.now();
      void this.roll(holder, now)?.catch(() => {});
      if (state.stopped) return {kind, action: 'none', reason: state.stopped.reason};
      const k = state.kinds[kind];
      if (k.capped === false) {
        if (k.probe_at && Date.parse(k.probe_at) <= now) void this.reserveAhead(kind, Math.max(1, amount), sessionId, holder);
        return {kind, action: 'none'};
      }
      const left = available(k), reached = reachedAt(k, now);
      // At the cap: the server has nothing more to grant until the window
      // resets. What this machine still holds is spent first.
      if (reached && left < amount) return {kind, action: 'block', reason: 'team_cap_reached', windowResetsAt: k.reached_until};
      if (!reached && (left < amount || (k.block !== null && left - amount < Math.ceil(k.block / 2)))) void this.reserveAhead(kind, Math.max(1, amount), sessionId, holder);
      if (left >= amount) return {kind, action: 'allow'};
      if (state.unavailable) {
        // The allowance is used up and the endpoint is unavailable: this kind
        // stops gating, recorded once per outage. Local caps stay in force.
        const first = !state.unavailable.fail_open;
        if (first || !k.fail_open) { state.unavailable.fail_open = true; k.fail_open = true; this.save(); }
        if (first) this.onEvent({event: 'team_caps_unavailable', kind, sessionId, failOpen: true});
        return {kind, action: 'allow', failOpen: true, reason: 'team_caps_unavailable'};
      }
      // No answer yet: the first block is on its way. The call runs and draws
      // on the grant when it lands.
      return {kind, action: 'allow', pending: true};
    } catch { return {kind, action: 'none'}; }
  }
  // Draws on the cached allowance: the oldest grant first, then an overdraft the
  // next grant pays. Reserves the next block in the background when the rest
  // runs low. Never throws.
  debit(kind, amount, sessionId) {
    try {
      if (!KINDS.includes(kind) || !count(amount) || amount === 0) return;
      const holder = this.holderFor(sessionId);
      if (!holder) return;
      const now = this.now();
      void this.roll(holder, now)?.catch(() => {});
      const k = this.state.kinds[kind];
      // A kind that is failing open is not gated: what runs meanwhile is not
      // held against the first grant that restores gating.
      if (k.capped === false || this.state.stopped || k.fail_open) return;
      let left = amount;
      for (const grant of k.grants) {
        const take = Math.min(left, grant.granted - grant.spent);
        grant.spent += take; left -= take;
        if (!left) break;
      }
      k.overdraft += left;
      this.save();
      const rest = available(k);
      if (!reachedAt(k, now) && (k.block === null || rest < Math.ceil(k.block / 2))) void this.reserveAhead(kind, Math.max(1, amount), sessionId, holder);
    } catch { /* A debit that cannot be recorded never changes the call's outcome. */ }
  }
  // Tokens are debited as the host reports them: the increase since the last
  // total recorded for the session. A total below the last one is a session
  // whose record started over; it becomes the new mark.
  observeTokens(sessionId, total) {
    try {
      if (!count(total)) return;
      const holder = this.holderFor(sessionId);
      if (!holder) return;
      const marks = this.state.token_marks, mark = sha256(`agentguard-team-caps-mark\0${sessionId}`).slice(0, 32);
      const previous = count(marks[mark]) ? marks[mark] : 0;
      if (total === previous) return;
      marks[mark] = total;
      const names = Object.keys(marks);
      if (names.length > MAX_MARKS) for (const name of names.slice(0, names.length - MAX_MARKS)) delete marks[name];
      if (total > previous) this.debit('tokens', total - previous, sessionId); else this.save();
    } catch { /* Counting never changes a decision. */ }
  }
  // One reserve per kind at a time, and none while the endpoint is resting or
  // refused this holder. Resolves to the server's answer or null.
  reserveAhead(kind, amount, sessionId, holder = this.holderFor(sessionId)) {
    if (!holder || !this.state) return Promise.resolve(null);
    if (this.inflight.has(kind)) return this.inflight.get(kind);
    const state = this.state, now = this.now();
    if (state.stopped) return Promise.resolve(null);
    if (state.unavailable && Date.parse(state.unavailable.retry_at) > now) return Promise.resolve(null);
    const work = this.reserve(kind, Math.max(1, amount), holder, sessionId).catch(() => null);
    this.inflight.set(kind, work);
    work.finally(() => { if (this.inflight.get(kind) === work) this.inflight.delete(kind); }).catch(() => {});
    return work;
  }
  async reserve(kind, amount, holder, sessionId, retried = false) {
    const state = this.state;
    const windows = state.windows ?? windowsAt(this.now());
    const result = await this.post(RESERVE_ENDPOINT, {license_key: holder.key, ...holder.body, kind, amount, windows: {day: windows.day, month: windows.month}});
    if (this.state !== state) return null;
    const response = result.body;
    if (result.status === 200 && response && typeof response === 'object' && !Array.isArray(response)) {
      const now = this.now();
      this.restore(sessionId);
      await this.applyCapSource(response.cap_source_sha256, holder, kind);
      // Read the kind after the cap source check: changed caps replace every
      // kind while the old grants are returned, and this grant belongs to the new one.
      const k = state.kinds[kind];
      k.fetched_at = iso(now);
      if (response.capped === false) {
        // A kind with no team cap needs no reservation; a block still held goes back.
        const dropped = this.dropGrants(now, [kind]);
        Object.assign(state.kinds[kind], {capped: false, fetched_at: iso(now), probe_at: iso(now + PROBE_MS), reached_until: null});
        this.save();
        await this.releaseGrants(holder, dropped);
        return response;
      }
      k.capped = true; k.probe_at = null;
      if (count(response.block) && response.block > 0) k.block = response.block;
      k.remaining = count(response.remaining) ? response.remaining : null;
      k.window_resets_at = isoTime(response.window_resets_at) ? response.window_resets_at : null;
      if (response.ok === true && count(response.granted) && response.granted > 0 && typeof response.grant_id === 'string' && response.grant_id.length <= 64) {
        // Debits made before the grant arrived draw on it first.
        const spent = Math.min(k.overdraft, response.granted);
        k.overdraft -= spent;
        k.grants.push({grant_id: response.grant_id, granted: response.granted, spent});
        k.reached_until = null; k.fail_open = false;
      } else if (response.ok === false && response.reason === 'team_cap_reached') {
        const already = reachedAt(k, now);
        k.reached_until = k.window_resets_at;
        if (!already && k.reached_until) this.onEvent({event: 'team_cap_reached', kind, sessionId, windowResetsAt: k.reached_until});
      }
      this.save();
      return response;
    }
    if (result.status === 409 && response?.error === 'window_mismatch' && validWindows(response.windows) && !retried) {
      // The worker's clock disagrees at a window boundary: adopt the server's
      // windows, return what was held under the old ones, and retry once.
      const dropped = this.dropGrants(this.now());
      state.windows = {day: response.windows.day, month: response.windows.month};
      state.adopted_until = iso(this.now() + ADOPTED_MS);
      this.save();
      await this.releaseGrants(holder, dropped);
      return this.reserve(kind, amount, holder, sessionId, true);
    }
    if (STOP_STATUSES.has(result.status)) {
      const reason = typeof response?.error === 'string' && /^[a-z_]{1,40}$/.test(response.error) ? response.error : result.status === 400 || result.status === 413 ? 'request_invalid' : 'refused';
      state.stopped = {status: result.status, reason, at: iso(this.now())};
      this.save();
      return null;
    }
    // 429, a 5xx, a timeout or a network error: unavailable. The fail-open rule applies.
    const wait = result.status === 429 ? Math.max(RETRY_MS, (result.retryAfter ?? 0) * 1000) : RETRY_MS;
    this.markUnavailable(result.status, wait);
    return null;
  }
  // When the published caps change, every held grant belongs to the old caps:
  // all of it goes back and every kind is asked again.
  async applyCapSource(value, holder, kind) {
    const state = this.state, source = hex64(value) ? value : null;
    if (state.cap_source !== null && state.cap_source.sha256 === source) return;
    const changed = state.cap_source !== null;
    state.cap_source = {sha256: source};
    if (!changed) { this.save(); return; }
    const dropped = this.dropGrants(this.now(), KINDS, true);
    for (const name of KINDS) Object.assign(state.kinds[name], {capped: null, block: null, probe_at: null, reached_until: null, remaining: null, window_resets_at: null});
    this.save();
    await this.releaseGrants(holder, dropped);
    this.onEvent({event: 'team_caps_changed', kind, capSource: source});
  }
  markUnavailable(status, wait) {
    const state = this.state, now = this.now();
    state.unavailable = {since: state.unavailable?.since ?? iso(now), status: status === null || status === undefined ? 'network' : String(status),
      retry_at: iso(now + wait), fail_open: state.unavailable?.fail_open === true};
    this.save();
  }
  // The first successful reserve after an outage restores team-cap gating.
  restore(sessionId) {
    const state = this.state;
    if (!state.unavailable) return;
    const wasFailingOpen = state.unavailable.fail_open === true;
    state.unavailable = null;
    this.save();
    if (wasFailingOpen) this.onEvent({event: 'team_caps_restored', sessionId});
  }
  // Returns each dropped grant's unused part. A grant the server has already
  // closed answers 404; either way the grant is gone from here.
  async releaseGrants(holder, dropped) {
    for (const {grant} of dropped) {
      const unused = Math.max(0, grant.granted - grant.spent);
      await this.post(RELEASE_ENDPOINT, {license_key: holder.key, ...holder.body, grant_id: grant.grant_id, unused});
    }
    return dropped.length;
  }
  // Session end and worker stop: every grant goes back.
  async releaseAll() {
    const holder = this.lastHolder;
    if (!holder || !this.state) return 0;
    const dropped = this.dropGrants(this.now(), KINDS, true);
    this.save();
    return this.releaseGrants(holder, dropped);
  }
  // A new session resolved its license again: a refusal from before no longer
  // stands, and the first blocks are fetched ahead of the first call.
  sessionStarted(sessionId) {
    try {
      const holder = this.holderFor(sessionId);
      if (!holder) return;
      if (this.state.stopped) { this.state.stopped = null; this.save(); }
      void this.roll(holder)?.catch(() => {});
      for (const kind of KINDS) {
        const k = this.state.kinds[kind];
        if (k.capped !== false && !k.grants.length && !reachedAt(k, this.now())) void this.reserveAhead(kind, 1, sessionId, holder);
      }
    } catch { /* The first gate reserves instead. */ }
  }
  // The worker's timer: at a UTC day change, yesterday's grants go back and the
  // new day's first blocks are reserved for the live sessions.
  tick(sessionIds = []) {
    try {
      const sessionId = sessionIds[0];
      const holder = sessionId ? this.holderFor(sessionId) : this.lastHolder;
      if (!holder || !this.state) return;
      const released = this.roll(holder);
      if (!released || !sessionId) return;
      void released.catch(() => {}).then(() => { for (const kind of KINDS) if (this.state.kinds[kind].capped !== false) void this.reserveAhead(kind, 1, sessionId, holder); });
    } catch { /* The next gate rolls the windows instead. */ }
  }
  async post(url, body) {
    const controller = new AbortController();
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('team_caps_timeout')), {once: true}));
    aborted.catch(() => {});
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
      const result = await Promise.race([Promise.resolve().then(() => this.postJson(url, body, {signal: controller.signal, deadline: Date.now() + DEADLINE_MS})), aborted]);
      return result && typeof result === 'object' ? result : {status: null, body: null};
    } catch { return {status: null, body: null}; }
    finally { clearTimeout(timer); controller.abort(); }
  }
}

module.exports = {TeamCapsClient, readTeamCapsStatus, windowsAt, RESERVE_ENDPOINT, RELEASE_ENDPOINT, KINDS, DEADLINE_MS, RETRY_MS, PROBE_MS, SCHEMA};
