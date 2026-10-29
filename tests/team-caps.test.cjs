'use strict';
// Team caps: the worker reserves allowance blocks from a fake of the server,
// gates and debits against its cache, releases on every documented trigger,
// and fails open on an outage. Hooks never reach the network. No real network.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('./helper-test-env.cjs');
const matrix = require('./helper-host-matrix.cjs');
const {TeamCapsClient, readTeamCapsStatus, RESERVE_ENDPOINT, RELEASE_ENDPOINT, RETRY_MS, PROBE_MS, DEADLINE_MS, SCHEMA, KINDS} = require('../runtime/team-caps.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const {createReader} = require('../runtime/mcp.cjs');
const {seedPaidLicense} = require('./helper-paid-license.cjs');
const root = path.resolve(__dirname, '..');

const KEY = 'ag_SYNTHETIC_TEAM_CAPS_KEY';
const MEMBER = 'agm_' + 'feed'.repeat(8);
const FINGERPRINT = 'a'.repeat(64);
const SESSION = 'session-SYNTHETIC-team-caps';
const START = Date.parse('2026-10-28T12:00:00.000Z');
const DAY_MS = 86400000;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const ENV = ['PLUGIN_DATA', 'AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_MEMBER_ID', 'CLAUDE_PLUGIN_OPTION_MEMBER_ID', 'CLAUDE_PLUGIN_OPTION_LICENSE_KEY'];

// The server's allowance ledger, as docs/TEAM_CAPS_CONTRACT.md describes it.
class FakeTeamServer {
  constructor({caps = {}, members = [MEMBER], seats = []} = {}) {
    this.caps = caps; this.members = new Set(members); this.seats = new Set(seats);
    this.ledgers = new Map(); this.calls = []; this.released = [];
    this.down = false; this.rateLimited = false; this.throwing = false; this.hang = false;
    this.now = () => START; this.skew = 0;
  }
  capSource() { return Object.keys(this.caps).length ? sha(canonical(this.caps)) : null; }
  windows() {
    const date = new Date(this.now() + this.skew), day = date.toISOString().slice(0, 10);
    return {day, month: day.slice(0, 7), dayResetsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString(),
      monthResetsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString()};
  }
  ledger(kind, month) {
    const id = `${kind}:${month}`;
    if (!this.ledgers.has(id)) this.ledgers.set(id, {used: 0, days: {}, grants: {}});
    return this.ledgers.get(id);
  }
  use(kind, amount) { const w = this.windows(), ledger = this.ledger(kind, w.month); ledger.used += amount; ledger.days[w.day] = (ledger.days[w.day] ?? 0) + amount; }
  reserves() { return this.calls.filter(call => call.url === RESERVE_ENDPOINT); }
  releases() { return this.calls.filter(call => call.url === RELEASE_ENDPOINT); }
  async postJson(url, body, context) {
    this.calls.push({url, body: structuredClone(body), at: this.now(), context: {signal: context?.signal instanceof AbortSignal, deadline: typeof context?.deadline === 'number'}});
    if (this.hang) return new Promise(() => {});
    if (this.throwing) throw new Error('ECONNREFUSED');
    if (this.down) return {status: 503, body: {error: 'team_caps_unavailable'}};
    if (this.rateLimited) return {status: 429, body: {error: 'rate_limited'}, retryAfter: 90};
    const allowed = ['license_key', 'member_id', 'seat_id', ...(url === RESERVE_ENDPOINT ? ['kind', 'amount', 'windows'] : ['grant_id', 'unused'])];
    if (Object.keys(body).some(key => !allowed.includes(key))) return {status: 400, body: {errors: ['Unknown field.']}};
    if (body.license_key !== KEY) return {status: 401, body: {error: 'license_not_found'}};
    if (body.member_id !== undefined ? !this.members.has(body.member_id) : !this.seats.has(body.seat_id)) return {status: 403, body: {error: body.member_id !== undefined ? 'member_unknown' : 'seat_unknown'}};
    const holder = body.member_id !== undefined ? `m:${sha(body.member_id).slice(0, 16)}` : `s:${body.seat_id.slice(0, 16)}`;
    return url === RESERVE_ENDPOINT ? this.reserve(body, holder) : url === RELEASE_ENDPOINT ? this.release(body, holder) : {status: 404, body: null};
  }
  reserve(body, holder) {
    const w = this.windows();
    if (body.windows.day !== w.day || body.windows.month !== w.month) return {status: 409, body: {error: 'window_mismatch', windows: {day: w.day, month: w.month}, window_resets_at: w.dayResetsAt}};
    const fields = body.kind === 'tokens' ? ['tokensPerDay', 'tokensPerMonth'] : ['usdCentsPerDay', 'usdCentsPerMonth'];
    const caps = {day: this.caps[fields[0]] ?? null, month: this.caps[fields[1]] ?? null};
    if (caps.day === null && caps.month === null) return {status: 200, body: {ok: true, capped: false, kind: body.kind, granted: 0, remaining: null, window_resets_at: null, cap_source_sha256: this.capSource()}};
    const ledger = this.ledger(body.kind, w.month);
    const view = () => ({day: {id: w.day, cap: caps.day, used: ledger.days[w.day] ?? 0, remaining: caps.day === null ? null : Math.max(0, caps.day - (ledger.days[w.day] ?? 0)), resets_at: w.dayResetsAt},
      month: {id: w.month, cap: caps.month, used: ledger.used, remaining: caps.month === null ? null : Math.max(0, caps.month - ledger.used), resets_at: w.monthResetsAt}});
    const binding = windows => [windows.month, windows.day].filter(item => item.cap !== null).reduce((best, item) => item.remaining < best.remaining ? item : best);
    const block = Math.max(1, Math.ceil(Math.min(...[caps.day, caps.month].filter(value => value !== null)) / 20));
    const before = view(), limit = binding(before);
    if (limit.remaining <= 0) return {status: 200, body: {ok: false, capped: true, kind: body.kind, granted: 0, reason: 'team_cap_reached', remaining: 0, window_resets_at: limit.resets_at, cap_source_sha256: this.capSource(), windows: before, block}};
    const standard = Math.max(1, Math.min(block, Math.ceil(limit.remaining / 4)));
    const granted = Math.min(Math.max(body.amount, standard), block * 4, limit.remaining);
    ledger.used += granted; ledger.days[w.day] = (ledger.days[w.day] ?? 0) + granted;
    const grant_id = `tg_${body.kind === 'tokens' ? 't' : 'u'}_${w.day.replace(/-/g, '')}_${crypto.randomBytes(8).toString('hex')}`;
    ledger.grants[grant_id] = {h: holder, d: w.day, a: granted, r: 0};
    const after = view(), next = binding(after);
    return {status: 200, body: {ok: true, capped: true, kind: body.kind, granted, grant_id, remaining: next.remaining, window_resets_at: next.resets_at, cap_source_sha256: this.capSource(), windows: after, block}};
  }
  release(body, holder) {
    const match = /^tg_([tu])_(\d{4})(\d{2})(\d{2})_[a-f0-9]{16}$/.exec(body.grant_id ?? '');
    if (!match) return {status: 404, body: {error: 'grant_not_found'}};
    const kind = match[1] === 't' ? 'tokens' : 'usd_cents', ledger = this.ledgers.get(`${kind}:${match[2]}-${match[3]}`), grant = ledger?.grants[body.grant_id];
    if (!grant) return {status: 404, body: {error: 'grant_not_found'}};
    if (grant.h !== holder) return {status: 403, body: {error: 'grant_holder_mismatch'}};
    const released = Math.min(body.unused, grant.a - grant.r);
    grant.r += released; grant.releases = (grant.releases ?? 0) + 1; ledger.used -= released; ledger.days[grant.d] -= released;
    this.released.push({grant_id: body.grant_id, kind, released});
    return {status: 200, body: {ok: true, grant_id: body.grant_id, kind, released, held: grant.a - grant.r}};
  }
}

function fixture(t, {caps = {}, memberId = MEMBER, tier = 'startup', paid = true, mode = 'enforce', server} = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-team-caps-'));
  const original = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  process.env.PLUGIN_DATA = data; process.env.AGENTGUARD_HOME = path.join(data, 'burn'); process.env.AGENTGUARD_LICENSE_KEY = ''; process.env.AGENTGUARD_PLUGIN_POLICY = '';
  fs.mkdirSync(process.env.AGENTGUARD_HOME);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode, licenseKey: KEY, ...(memberId ? {memberId} : {}),
    toolRules: [{pattern: '^mcp__priced__', unitCostCents: 10}]}));
  fs.writeFileSync(path.join(data, 'org-policy-status.json'), JSON.stringify({license_fingerprint: sha(KEY), status: 'none', reason: null, org_policy_sha256: null, updated_at: new Date(START).toISOString()}));
  t.after(() => { for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } fs.rmSync(data, {recursive: true, force: true}); });
  const clock = {now: START}, now = () => clock.now;
  const srv = server ?? new FakeTeamServer({caps, seats: [sha(`${KEY}\0${FINGERPRINT}`)]});
  srv.now = now;
  const license = {paid, tier, mode: 'enforce', reason: null, seatsUsed: 1, seatLimit: 5, seatStatus: 'registered', seatIdentity: {machineFingerprint: FINGERPRINT, processId: 'synthetic'}};
  const events = [];
  const client = new TeamCapsClient({data, postJson: (...args) => srv.postJson(...args), now, licenseReader: () => license, onEvent: event => events.push(event)});
  return {data, clock, server: srv, client, events, license, licenseReader: () => license, file: path.join(data, 'team-caps.json')};
}
// Background reserves and releases finish before the next assertion.
async function settle(client) {
  for (let round = 0; round < 6; round++) { await Promise.all([...client.inflight.values()]); await new Promise(resolve => setTimeout(resolve, 0)); }
}
async function start(f) {
  const engine = new Engine({licenseReader: f.licenseReader});
  await engine.init();
  engine.attachTeamCaps(f.client);
  return engine;
}
const rows = engine => fs.readFileSync(engine.logStore.filePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).decision);
const permission = result => result.output.hookSpecificOutput?.permissionDecision ?? 'allow';
let calls = 0;
const priced = id => metadata({session_id: SESSION, tool_name: 'mcp__priced__call', tool_use_id: `priced-${id ?? ++calls}`, tool_input: {q: 'PRIVATE'}}, 'spend');
const plain = id => metadata({session_id: SESSION, tool_name: 'Read', tool_use_id: `plain-${id ?? ++calls}`, tool_input: {path: 'PRIVATE'}}, 'spend');
const cache = f => JSON.parse(fs.readFileSync(f.file, 'utf8'));
// Every grant the server issued is either still in the cache or was released
// (with whatever was unused, possibly nothing): the client never holds
// allowance it does not know about.
function leaked(f) {
  const held = new Set(KINDS.flatMap(kind => cache(f).kinds[kind].grants.map(grant => grant.grant_id)));
  return [...f.server.ledgers.values()].flatMap(ledger => Object.entries(ledger.grants)).filter(([id, grant]) => !grant.releases && !held.has(id)).map(([id]) => id);
}

test('a grant is reserved ahead in the background, cached atomically without the member ID, debited, and topped up when the rest runs low', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400, tokensPerDay: 2000}});
  const first = f.client.gate('usd_cents', 10, SESSION);
  assert.deepEqual(first, {kind: 'usd_cents', action: 'allow', pending: true});
  assert.equal(f.client.inflight.has('usd_cents'), true, 'the block is fetched in the background');
  await settle(f.client);
  const reserve = f.server.reserves()[0];
  assert.equal(reserve.body.license_key, KEY);
  assert.deepEqual(Object.keys(reserve.body).sort(), ['amount', 'kind', 'license_key', 'member_id', 'windows']);
  assert.deepEqual(reserve.body.windows, {day: '2026-10-28', month: '2026-10'});
  assert.equal(reserve.body.amount, 10);
  assert.deepEqual(reserve.context, {signal: true, deadline: true});
  let state = cache(f);
  assert.equal(state.schema, SCHEMA);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(state.kinds.usd_cents.grants.length, 1);
  assert.equal(state.kinds.usd_cents.grants[0].granted, 20, 'a standard block is one twentieth of the cap');
  assert.equal(state.kinds.usd_cents.block, 20);
  assert.equal(state.kinds.usd_cents.capped, true);
  assert.equal(state.holder, 'member');
  const text = fs.readFileSync(f.file, 'utf8');
  assert.equal(text.includes(MEMBER), false, 'the cache never names the person');
  assert.equal(text.includes(KEY), false, 'the cache never holds the key');
  assert.deepEqual(f.client.gate('usd_cents', 10, SESSION), {kind: 'usd_cents', action: 'allow'});
  f.client.debit('usd_cents', 10, SESSION);
  assert.equal(cache(f).kinds.usd_cents.grants[0].spent, 10);
  assert.equal(f.server.reserves().length, 1, 'half a block left does not reserve yet');
  f.client.debit('usd_cents', 10, SESSION);
  await settle(f.client);
  assert.equal(f.server.reserves().length, 2, 'an empty allowance reserves the next block');
  state = cache(f);
  assert.equal(state.kinds.usd_cents.grants.length, 2);
  assert.equal(state.kinds.usd_cents.grants[1].spent, 0);
  assert.equal(readTeamCapsStatus(f.data, START).kinds.usd_cents.available, 20);
  // The tokens kind was never asked for: nothing is reserved for it until a call needs it.
  assert.equal(f.server.reserves().every(call => call.body.kind === 'usd_cents'), true);
  assert.equal(f.events.length, 0);
  assert.deepEqual(leaked(f), []);
});

test('without a member ID the machine reserves by its registration ID; Free, Solo and unpaid sessions reserve nothing', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400}, memberId: null});
  f.client.gate('usd_cents', 10, SESSION);
  await settle(f.client);
  const body = f.server.reserves()[0].body;
  assert.equal(body.seat_id, sha(`${KEY}\0${FINGERPRINT}`));
  assert.equal(Object.hasOwn(body, 'member_id'), false);
  assert.equal(cache(f).holder, 'seat');
  for (const license of [{...f.license, tier: 'solo'}, {...f.license, tier: 'free', paid: false}, {...f.license, paid: false, mode: 'shadow', reason: 'seat_limit'}]) {
    const other = new TeamCapsClient({data: f.data, postJson: () => { throw new Error('must not be called'); }, now: () => f.clock.now, licenseReader: () => license});
    assert.deepEqual(other.gate('usd_cents', 10, SESSION), {kind: 'usd_cents', action: 'none'});
    assert.deepEqual(other.gate('tokens', 1, SESSION), {kind: 'tokens', action: 'none'});
    other.debit('usd_cents', 10, SESSION);
    other.observeTokens(SESSION, 500);
  }
  assert.equal(f.server.reserves().length, 1);
});

test('a reached cap blocks priced calls with team_cap_reached until the window resets; shadow records it; the new day reserves again', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 30}});
  f.server.use('usd_cents', 30);
  const engine = await start(f);
  t.after(() => engine.close());
  // The first call runs while the first block is still on its way.
  const first = await engine.handle({meta: priced()});
  assert.equal(permission(first), 'allow');
  await settle(f.client);
  assert.equal(f.server.reserves().at(-1).body.kind, 'usd_cents');
  assert.equal(cache(f).kinds.usd_cents.reached_until, '2026-10-29T00:00:00.000Z');
  const blocked = await engine.handle({meta: priced()});
  assert.equal(permission(blocked), 'deny');
  assert.match(blocked.output.hookSpecificOutput.permissionDecisionReason, /team_cap_reached.*shared cap on priced tool calls is reached until 2026-10-29T00:00:00\.000Z/);
  const decision = rows(engine).find(row => row.plugin?.toolUseId === blocked.output && false) ?? rows(engine).filter(row => row.plugin?.event === 'decision').at(-1);
  assert.equal(decision.action, 'block');
  assert.equal(decision.plugin.reasonCode, 'team_cap_reached');
  assert.deepEqual(decision.plugin.teamCap, {kind: 'usd_cents', windowResetsAt: '2026-10-29T00:00:00.000Z'});
  assert.equal(decision.plugin.chargedCents, 0);
  const reached = rows(engine).find(row => row.plugin?.event === 'team_caps');
  assert.equal(reached.plugin.reasonCode, 'team_cap_reached');
  assert.equal(reached.plugin.kind, 'usd_cents');
  // An unpriced call draws no cents, so it runs; the tokens kind was asked for and is uncapped.
  assert.equal(permission(await engine.handle({meta: plain()})), 'allow');
  await settle(f.client);
  assert.equal(cache(f).kinds.tokens.capped, false);
  // The server is not asked again while the cap is reached.
  const before = f.server.reserves().length;
  assert.equal(permission(await engine.handle({meta: priced()})), 'deny');
  assert.equal(f.server.reserves().length, before);
  // The next UTC day: yesterday's state goes, and the new day's block is reserved.
  f.clock.now = Date.parse('2026-10-29T00:00:01.000Z');
  f.client.tick([SESSION]);
  await settle(f.client);
  const state = cache(f);
  assert.deepEqual(state.windows, {day: '2026-10-29', month: '2026-10'});
  assert.equal(state.kinds.usd_cents.reached_until, null);
  assert.equal(state.kinds.usd_cents.grants.length, 1);
  assert.equal(permission(await engine.handle({meta: priced()})), 'allow');
  const status = readTeamCapsStatus(f.data, f.clock.now);
  assert.equal(status.kinds.usd_cents.reached, false);
  assert.equal(status.windows.day, '2026-10-29');
  await settle(f.client);
  assert.deepEqual(leaked(f), []);
});

test('in shadow mode a reached cap is recorded, not blocked', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 30}, mode: 'shadow'});
  f.server.use('usd_cents', 30);
  const engine = await start(f);
  t.after(() => engine.close());
  await engine.handle({meta: priced()});
  await settle(f.client);
  const result = await engine.handle({meta: priced()});
  assert.equal(permission(result), 'allow');
  const decision = rows(engine).filter(row => row.plugin?.event === 'decision').at(-1);
  assert.equal(decision.action, 'shadow');
  assert.equal(decision.enforcementMode, 'shadow');
  assert.ok(decision.reasons.includes('team_cap_reached'), decision.reasons.join(' '));
});

test('tokens are debited as the host records them, and a reached token cap stops launches and calls', async t => {
  const f = fixture(t, {caps: {tokensPerDay: 1000}});
  const engine = await start(f);
  t.after(() => engine.close());
  engine.observeTeamTokens({sessionId: SESSION}, {usage: {authoritative: 1}, state: {totalTokens: 300}});
  await settle(f.client);
  let state = cache(f);
  assert.equal(f.server.reserves()[0].body.amount, 300);
  assert.equal(state.kinds.tokens.grants[0].granted, 200, 'at most four blocks of fifty');
  assert.equal(state.kinds.tokens.grants[0].spent, 200, 'debits made before the grant arrived draw on it first');
  assert.equal(state.kinds.tokens.overdraft, 100);
  // The same total again is nothing new; a higher total is its difference.
  engine.observeTeamTokens({sessionId: SESSION}, {usage: {authoritative: 1}, state: {totalTokens: 300}});
  engine.observeTeamTokens({sessionId: SESSION}, {usage: {authoritative: 1}, state: {totalTokens: 320}});
  await settle(f.client);
  state = cache(f);
  assert.equal(state.kinds.tokens.overdraft + state.kinds.tokens.grants.reduce((sum, grant) => sum + grant.spent, 0), 320);
  assert.equal(Object.values(state.token_marks)[0], 320);
  assert.equal(JSON.stringify(state.token_marks).includes(SESSION), false, 'marks are keyed by a digest, never the session id');
  // Another seat uses the rest of the team's day.
  f.server.use('tokens', 1000);
  f.client.gate('tokens', 1, SESSION);
  await settle(f.client);
  assert.ok(cache(f).kinds.tokens.reached_until);
  const call = await engine.handle({meta: plain()});
  assert.equal(permission(call), 'deny');
  assert.match(call.output.hookSpecificOutput.permissionDecisionReason, /shared cap on tokens is reached/);
  const launch = await engine.handle({meta: metadata({session_id: SESSION, tool_name: matrix.spawnTool, tool_use_id: 'launch-1', tool_input: {prompt: 'PRIVATE'}}, 'burn')});
  assert.equal(launch.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(launch.output.hookSpecificOutput.permissionDecisionReason, /shared cap on tokens is reached/);
  const decision = rows(engine).filter(row => row.plugin?.gate === 'burn').at(-1);
  assert.equal(decision.action, 'block');
  assert.equal(decision.plugin.reasonCode, 'team_cap_reached');
  assert.deepEqual(decision.reasons, ['team_cap_reached']);
});

test('grants go back at session end, at a UTC day change (release first, then reserve), when the caps change, and when a kind loses its cap', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400, tokensPerDay: 2000}});
  f.client.gate('usd_cents', 10, SESSION); f.client.gate('tokens', 1, SESSION);
  await settle(f.client);
  f.client.debit('usd_cents', 5, SESSION);
  const [cents, tokens] = ['usd_cents', 'tokens'].map(kind => cache(f).kinds[kind].grants[0]);
  // Session end: every grant goes back with what was not used.
  const serverUsed = f.server.ledger('usd_cents', '2026-10').used;
  assert.equal(await f.client.releaseAll(), 2);
  assert.deepEqual(f.server.released.map(item => [item.grant_id, item.released]).sort(), [[cents.grant_id, 15], [tokens.grant_id, tokens.granted]].sort());
  assert.equal(f.server.ledger('usd_cents', '2026-10').used, serverUsed - 15);
  assert.deepEqual(cache(f).kinds.usd_cents.grants, []);
  assert.equal(f.server.releases().length, 2, 'each grant is released once and then forgotten');
  // Day change: the old grant is released before the new day's block is reserved.
  f.client.gate('usd_cents', 10, SESSION);
  await settle(f.client);
  const held = cache(f).kinds.usd_cents.grants[0];
  f.server.released.length = 0;
  f.clock.now = START + DAY_MS;
  const callsBefore = f.server.calls.length;
  f.client.tick([SESSION]);
  await settle(f.client);
  const after = f.server.calls.slice(callsBefore);
  assert.equal(after[0].url, RELEASE_ENDPOINT);
  assert.equal(after[0].body.grant_id, held.grant_id);
  assert.ok(after.slice(1).some(call => call.url === RESERVE_ENDPOINT && call.body.windows.day === '2026-10-29'));
  assert.ok(after.findIndex(call => call.url === RESERVE_ENDPOINT) > 0, 'release first, then reserve');
  assert.notEqual(cache(f).kinds.usd_cents.grants[0]?.grant_id, held.grant_id);
  // The owner changes the caps: everything held under the old caps goes back.
  const old = cache(f).kinds.usd_cents.grants.map(grant => grant.grant_id);
  f.server.caps = {usdCentsPerDay: 800, tokensPerDay: 2000};
  f.server.released.length = 0;
  const reservesBefore = f.server.reserves().length;
  for (let step = 0; step < 4; step++) f.client.debit('usd_cents', 10, SESSION);
  await settle(f.client);
  assert.ok(f.server.released.some(item => old.includes(item.grant_id)), 'the old grant was released');
  assert.equal(cache(f).cap_source.sha256, f.server.capSource());
  assert.ok(f.events.some(event => event.event === 'team_caps_changed'));
  // The grant that arrived with the new cap source is the one now held, and nothing issued is unaccounted for.
  assert.equal(f.server.reserves().length, reservesBefore + 1);
  assert.equal(cache(f).kinds.usd_cents.grants.length, 1);
  assert.equal(cache(f).kinds.usd_cents.grants[0].spent, 20, 'the debits made while it was on its way draw on it');
  assert.deepEqual(leaked(f), []);
  // A kind that loses its cap returns what it held and is asked about again later.
  f.client.gate('tokens', 1, SESSION);
  await settle(f.client);
  const tokenGrant = cache(f).kinds.tokens.grants[0];
  assert.ok(tokenGrant);
  f.server.caps = {usdCentsPerDay: 800};
  f.server.released.length = 0;
  f.client.debit('usd_cents', 10, SESSION);
  await settle(f.client);
  f.client.gate('tokens', 1, SESSION);
  await settle(f.client);
  assert.equal(cache(f).kinds.tokens.capped, false);
  assert.deepEqual(cache(f).kinds.tokens.grants, []);
  assert.ok(f.server.released.some(item => item.grant_id === tokenGrant.grant_id) || f.server.released.length > 0);
  const probes = f.server.reserves().filter(call => call.body.kind === 'tokens').length;
  assert.deepEqual(f.client.gate('tokens', 1, SESSION), {kind: 'tokens', action: 'none'});
  await settle(f.client);
  assert.equal(f.server.reserves().filter(call => call.body.kind === 'tokens').length, probes, 'an uncapped kind is not asked again at once');
  f.clock.now += PROBE_MS;
  f.client.gate('tokens', 1, SESSION);
  await settle(f.client);
  assert.equal(f.server.reserves().filter(call => call.body.kind === 'tokens').length, probes + 1, 'and is asked again after the probe interval');
  assert.deepEqual(leaked(f), []);
});

test('a window mismatch adopts the server windows and retries exactly once', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400}});
  f.server.skew = DAY_MS;
  f.client.gate('usd_cents', 10, SESSION);
  await settle(f.client);
  const reserves = f.server.reserves();
  assert.equal(reserves.length, 2);
  assert.deepEqual(reserves[0].body.windows, {day: '2026-10-28', month: '2026-10'});
  assert.deepEqual(reserves[1].body.windows, {day: '2026-10-29', month: '2026-10'});
  const state = cache(f);
  assert.deepEqual(state.windows, {day: '2026-10-29', month: '2026-10'});
  assert.equal(state.kinds.usd_cents.grants.length, 1);
  assert.equal(state.unavailable, null);
  // The local clock, still a day behind, does not roll the adopted windows back.
  assert.deepEqual(f.client.gate('usd_cents', 10, SESSION), {kind: 'usd_cents', action: 'allow'});
  assert.deepEqual(cache(f).windows, {day: '2026-10-29', month: '2026-10'});
  // A server that still disagrees after the retry is treated as unavailable, not asked a third time.
  const g = fixture(t, {caps: {usdCentsPerDay: 400}});
  g.server.reserve = function (body) { return {status: 409, body: {error: 'window_mismatch', windows: {day: body.windows.day === '2026-10-28' ? '2026-10-29' : '2026-10-30', month: '2026-10'}}}; };
  g.client.gate('usd_cents', 10, SESSION);
  await settle(g.client);
  assert.equal(g.server.reserves().length, 2);
  assert.equal(cache(g).unavailable.status, '409');
});

test('on 503, a network error or a timeout the last allowance keeps gating; used up, the kind fails open once in the ledger and asks again at most once a minute; the first grant restores gating', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400}});
  const engine = await start(f);
  t.after(() => engine.close());
  assert.equal(permission(await engine.handle({meta: priced()})), 'allow');
  await settle(f.client);
  assert.equal(cache(f).kinds.usd_cents.grants[0].granted, 20);
  assert.equal(cache(f).kinds.usd_cents.grants[0].spent, 10, 'the first call drew on the grant when it landed');
  f.server.down = true;
  // The cached allowance covers this call; the empty rest asks the server, which is down.
  assert.equal(permission(await engine.handle({meta: priced()})), 'allow');
  await settle(f.client);
  const outage = f.server.reserves().length;
  assert.equal(cache(f).unavailable.status, '503');
  assert.equal(cache(f).unavailable.fail_open, false);
  assert.equal(rows(engine).some(row => row.plugin?.event === 'team_caps'), false, 'an outage with allowance left is not yet a fail-open');
  // Used up and still down: the kind fails open, recorded once.
  const failOpen = await engine.handle({meta: priced()});
  assert.equal(permission(failOpen), 'allow');
  const decision = rows(engine).filter(row => row.plugin?.event === 'decision').at(-1);
  assert.ok(decision.reasons.includes('team_caps_unavailable'), decision.reasons.join(' '));
  assert.equal(decision.action, 'allow');
  const events = rows(engine).filter(row => row.plugin?.event === 'team_caps');
  assert.equal(events.length, 1);
  assert.equal(events[0].plugin.reasonCode, 'team_caps_unavailable');
  assert.equal(events[0].plugin.failOpen, true);
  assert.equal(events[0].plugin.kind, 'usd_cents');
  assert.equal(events[0].plugin.gate, 'control');
  assert.equal(JSON.stringify(events[0]).includes('PRIVATE'), false);
  assert.equal(cache(f).unavailable.fail_open, true);
  assert.equal(cache(f).kinds.usd_cents.fail_open, true);
  for (let step = 0; step < 5; step++) assert.equal(permission(await engine.handle({meta: priced()})), 'allow');
  await settle(f.client);
  assert.equal(f.server.reserves().length, outage, 'no second attempt within the minute');
  assert.equal(rows(engine).filter(row => row.plugin?.event === 'team_caps').length, 1, 'one row per outage');
  assert.equal(cache(f).kinds.usd_cents.overdraft, 0, 'what ran while failing open is not held against the next grant');
  assert.equal(readTeamCapsStatus(f.data, f.clock.now).kinds.usd_cents.failOpen, true);
  f.clock.now += RETRY_MS + 1;
  assert.equal(permission(await engine.handle({meta: priced()})), 'allow');
  await settle(f.client);
  assert.equal(f.server.reserves().length, outage + 1, 'one attempt after a minute');
  assert.equal(readTeamCapsStatus(f.data, f.clock.now).unavailable.failOpen, true);
  // A network error and a 429 with Retry-After are outages too.
  f.server.down = false; f.server.throwing = true; f.clock.now += RETRY_MS + 1;
  await engine.handle({meta: priced()}); await settle(f.client);
  assert.equal(cache(f).unavailable.status, 'network');
  f.server.throwing = false; f.server.rateLimited = true; f.clock.now += RETRY_MS + 1;
  await engine.handle({meta: priced()}); await settle(f.client);
  assert.equal(cache(f).unavailable.status, '429');
  assert.equal(Date.parse(cache(f).unavailable.retry_at) - f.clock.now, 90000, 'Retry-After is honored');
  // The server is back: the first grant restores gating and is recorded.
  f.server.rateLimited = false; f.clock.now += 90001;
  assert.equal(permission(await engine.handle({meta: priced()})), 'allow');
  await settle(f.client);
  assert.equal(cache(f).unavailable, null);
  assert.ok(cache(f).kinds.usd_cents.grants.length >= 1);
  assert.equal(cache(f).kinds.usd_cents.fail_open, false, 'the first grant restores gating for the kind');
  await engine.handle({meta: plain()});
  const restored = rows(engine).filter(row => row.plugin?.event === 'team_caps').at(-1);
  assert.equal(restored.plugin.reasonCode, 'team_caps_restored');
  assert.equal(readTeamCapsStatus(f.data, f.clock.now).unavailable, null);
  // The whole chain still verifies, and nothing issued is unaccounted for.
  const sdk = require('@agentguard-run/spend');
  const entries = fs.readFileSync(engine.logStore.filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal((await sdk.verifyChain(entries, engine.publicKey)).ok, true);
  assert.deepEqual(leaked(f), []);
});

test('a transport that never answers is abandoned at the two second deadline and counts as an outage', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400}});
  f.server.hang = true;
  const started = Date.now();
  f.client.gate('usd_cents', 10, SESSION);
  await Promise.all([...f.client.inflight.values()]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= DEADLINE_MS - 50 && elapsed < DEADLINE_MS + 1500, `deadline honored: ${elapsed} ms`);
  assert.equal(cache(f).unavailable.status, 'network');
  assert.equal(f.server.reserves()[0].context.signal, true);
});

test('a licensing or holder refusal ends reserving until the next session start, and status names it', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400}, memberId: 'agm_' + 'dead'.repeat(8)});
  f.client.gate('usd_cents', 10, SESSION);
  await settle(f.client);
  assert.equal(cache(f).stopped.reason, 'member_unknown');
  assert.deepEqual(f.client.gate('usd_cents', 10, SESSION), {kind: 'usd_cents', action: 'none', reason: 'member_unknown'});
  f.client.debit('usd_cents', 10, SESSION);
  await settle(f.client);
  assert.equal(f.server.reserves().length, 1, 'no further request after a refusal');
  assert.equal(readTeamCapsStatus(f.data, START).stopped, 'member_unknown');
  f.server.members.add('agm_' + 'dead'.repeat(8));
  f.client.sessionStarted(SESSION);
  await settle(f.client);
  assert.equal(cache(f).stopped, null);
  assert.equal(cache(f).kinds.usd_cents.grants.length, 1, 'a new session reserves ahead for the first call');
});

test('status reports the cached allowance from the file alone, and get_status carries it without the member ID', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400, tokensPerMonth: 5000}});
  assert.equal(readTeamCapsStatus(f.data), null);
  f.client.gate('usd_cents', 10, SESSION); f.client.gate('tokens', 1, SESSION);
  await settle(f.client);
  f.client.debit('usd_cents', 7, SESSION);
  const status = readTeamCapsStatus(f.data, START);
  assert.deepEqual(status.kinds.usd_cents, {capped: true, available: 13, remaining: 380, windowResetsAt: '2026-10-29T00:00:00.000Z', reached: false, grants: 1, failOpen: false});
  assert.equal(status.kinds.tokens.capped, true);
  assert.equal(status.kinds.tokens.windowResetsAt, '2026-11-01T00:00:00.000Z');
  assert.equal(status.holder, 'member');
  assert.equal(status.capSource, f.server.capSource());
  assert.equal(status.unavailable, null);
  const engine = await start(f);
  t.after(() => engine.close());
  const reader = createReader({dataDir: f.data, workerStatus: async ({sessionId}) => { const current = engine.context({sessionId}); return {license: {...current.license, mode: current.mode}}; }});
  const full = await reader.call('get_status', {sessionId: SESSION});
  assert.equal(full.teamCaps.kinds.usd_cents.available, 13);
  assert.equal(JSON.stringify(full).includes(MEMBER), false);
  assert.equal(JSON.stringify(full).includes(KEY), false);
  // A cache written for another key is not shown as this key's allowance.
  fs.writeFileSync(path.join(f.data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', licenseKey: 'ag_ANOTHER_KEY', memberId: MEMBER}));
  const other = new TeamCapsClient({data: f.data, postJson: () => ({status: 503}), now: () => START, licenseReader: f.licenseReader});
  other.gate('usd_cents', 1, SESSION);
  assert.deepEqual(other.state.kinds.usd_cents.grants, []);
});

test('the production transport is a fixed JSON POST with the deadline signal and redirects refused', async t => {
  const f = fixture(t, {caps: {usdCentsPerDay: 400}});
  const previous = global.fetch, requests = [];
  global.fetch = async (url, options) => {
    requests.push({url, options});
    return {status: 200, json: async () => ({ok: true, capped: true, kind: 'usd_cents', granted: 20, grant_id: 'tg_u_20261028_0123456789abcdef', remaining: 380,
      window_resets_at: '2026-10-29T00:00:00.000Z', cap_source_sha256: 'f'.repeat(64), windows: {}, block: 20}), headers: {get: () => null}};
  };
  t.after(() => { global.fetch = previous; });
  const client = new TeamCapsClient({data: f.data, now: () => START, licenseReader: f.licenseReader});
  client.gate('usd_cents', 10, SESSION);
  await settle(client);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, RESERVE_ENDPOINT);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(requests[0].options.headers, {'content-type': 'application/json'});
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(JSON.parse(requests[0].options.body)).sort(), ['amount', 'kind', 'license_key', 'member_id', 'windows']);
  assert.equal(client.state.kinds.usd_cents.grants[0].grant_id, 'tg_u_20261028_0123456789abcdef');
});

test('no hook ever loads the team caps client: the static require graph from every hook stops at the worker boundary', () => {
  const seen = new Set(), queue = fs.readdirSync(path.join(root, 'hooks')).filter(name => name.endsWith('.cjs')).map(name => path.join(root, 'hooks', name));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/require\((?:'|")(\.{1,2}\/[^'"]+)(?:'|")\)/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const resolved = fs.existsSync(target) ? target : fs.existsSync(target + '.cjs') ? target + '.cjs' : fs.existsSync(path.join(target, 'index.cjs')) ? path.join(target, 'index.cjs') : null;
      if (resolved && resolved.endsWith('.cjs') && resolved.startsWith(root)) queue.push(resolved);
    }
  }
  const names = [...seen].map(file => path.relative(root, file));
  assert.ok(names.includes('runtime/client.cjs'));
  assert.equal(names.includes('runtime/team-caps.cjs'), false, 'hooks never reach the reserve and release client');
  assert.equal(names.includes('runtime/daemon.cjs'), false, 'hooks start the worker as a process, never require it');
  assert.equal(names.includes('runtime/engine.cjs'), false);
  // The status reader is a pure file read with no request in it, and the client depends on it, never the reverse.
  assert.equal(fs.readFileSync(path.join(root, 'runtime/team-caps-status.cjs'), 'utf8').includes('team-caps.cjs\''), false);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'runtime/team-caps-status.cjs'), 'utf8'), /fetch|require\('node:(?:net|http|https|tls|dns)'\)/);
  const users = fs.readdirSync(path.join(root, 'runtime')).filter(name => name.endsWith('.cjs') && fs.readFileSync(path.join(root, 'runtime', name), 'utf8').includes("require('./team-caps.cjs')"));
  assert.deepEqual(users, ['daemon.cjs'], 'the worker alone constructs the client');
});

test('with a Team key, a member ID and caps configured, the gate hooks still open no socket; only the worker process may', async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-team-caps-hooks-'));
  const tag = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${tag}`);
  const blocker = path.join(data, 'no-network.cjs'), attempts = path.join(data, 'network-attempts'), children = path.join(data, 'children.ndjson');
  fs.writeFileSync(blocker, `
    const fs = require('node:fs'), path = require('node:path');
    const cp = require('node:child_process'), spawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      const child = spawn.call(this, command, args, options);
      if (child.pid && (args || []).some(arg => /runtime[/\\\\](?:session-(?:start|tip)|daemon)\\.cjs$/.test(arg))) fs.appendFileSync(${JSON.stringify(children)}, child.pid + '\\n');
      return child;
    };
    const blocked = () => { fs.appendFileSync(${JSON.stringify(attempts)}, path.basename(process.argv[1] || 'unknown') + '\\n'); throw new Error('socket_forbidden'); };
    const net = require('node:net'); net.connect = blocked; net.createConnection = blocked; net.Socket.prototype.connect = blocked;
    const tls = require('node:tls'); tls.connect = blocked;
    for (const name of ['node:http', 'node:https']) { const module = require(name); module.request = blocked; module.get = blocked; if (module.Agent) module.Agent.prototype.createConnection = blocked; }
    for (const name of ['node:dns', 'node:dns/promises']) { const dns = require(name); for (const key of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(key)) dns[key] = blocked; }
    globalThis.fetch = blocked;
  `, {mode: 0o600});
  const home = path.join(data, 'burn');
  fs.mkdirSync(home);
  seedPaidLicense(home, KEY, data);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', licenseKey: KEY, memberId: MEMBER, toolRules: [{pattern: '^mcp__priced__', unitCostCents: 10}]}), {mode: 0o600});
  const env = {...process.env, PLUGIN_DATA: data, PLUGIN_ROOT: root, AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0', NODE_OPTIONS: `--require=${blocker}`};
  delete env.AGENTGUARD_PLUGIN_POLICY;
  matrix.environment(env, data);
  t.after(async () => {
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const waitForExit = async pids => { const deadline = Date.now() + 10000; while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); };
    const pids = fs.existsSync(children) ? fs.readFileSync(children, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
    const lock = path.join(ipc, 'worker.lock');
    const worker = fs.existsSync(lock) ? Number(fs.readFileSync(lock, 'utf8')) : null;
    spawnSync(process.execPath, ['runtime/control.cjs', 'stop'], {cwd: root, env, timeout: 3000});
    await waitForExit([...pids, ...(Number.isSafeInteger(worker) && worker > 0 ? [worker] : [])]);
    fs.rmSync(ipc, {recursive: true, force: true});
    fs.rmSync(data, {recursive: true, force: true});
  });
  const raw = matrix.payload({hook_event_name: 'PreToolUse', tool_name: 'mcp__priced__call', tool_use_id: 'synthetic-team-caps-call', session_id: 'synthetic-team-caps-session', tool_input: {q: 'PRIVATE_NOT_FOR_LEDGER'}}, 'PreToolUse', 'Bash');
  raw.tool_name = 'mcp__priced__call'; raw.cwd = data; raw.transcript_path = path.join(data, 'absent.jsonl');
  for (const hook of ['session-start', 'burn-gate', 'spend-gate', 'receipt', 'session-end']) {
    const payload = hook === 'receipt' ? {...raw, hook_event_name: 'PostToolUse', tool_response: {ok: true}, duration_ms: 3} : raw;
    const child = spawnSync(process.execPath, [`hooks/${hook}.cjs`], {cwd: root, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 8000});
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '', `${hook} answered from the worker without failing open`);
    if (['burn-gate', 'spend-gate'].includes(hook)) assert.notEqual(JSON.parse(child.stdout).hookSpecificOutput?.permissionDecision, 'deny');
  }
  const sources = fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.deepEqual(sources.filter(name => !/^(?:daemon|session-start|session-tip)\.cjs$/.test(name)), [], `only the worker and its lifecycle helpers may try the network: ${sources.join(', ')}`);
  const ledger = fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8');
  assert.equal(ledger.includes(MEMBER), false);
  assert.equal(ledger.includes('PRIVATE_NOT_FOR_LEDGER'), false);
  t.diagnostic(`Hook processes made no network attempt; ${sources.length} attempt(s) came from ${[...new Set(sources)].join(', ') || 'nothing'}.`);
});
