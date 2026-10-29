'use strict';
// One person, one seat: the member ID is stored beside the license key, sent in
// Team heartbeats only, and never written anywhere a person could read it back
// from a record. Every server here is a fake transport; no network is used.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {configuredMemberId, memberIdFor, writeMemberId, isMemberId} = require('../runtime/member-id.cjs');
const {setMember, activate} = require('../runtime/activate.cjs');
const {resolveSessionLicense, heartbeatSessionSeat, readSessionLicense, licenseStatusPath, SEAT_ENDPOINT} = require('../runtime/license.cjs');
const {HEARTBEAT_MS} = require('../runtime/seat-heartbeat.cjs');
const {readPolicy} = require('../runtime/policy-file.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const {createReader} = require('../runtime/mcp.cjs');

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const KEY = 'ag_SYNTHETIC_MEMBER_SEAT_KEY';
// A canary that could never be mistaken for anything else in a file.
const MEMBER = 'agm_' + 'cafe'.repeat(8);
const OTHER = 'agm_' + 'beef'.repeat(8);
const INSTALL_ID = 'SYNTHETIC_INSTALLATION_NOT_A_CUSTOMER';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const paidStatus = tier => ({valid: true, tier, seats: tier === 'solo' ? 3 : 5, expiresAt: new Date(NOW + 86400000).toISOString(), features: {maxActiveSeats: tier === 'solo' ? 3 : 5}});
const seatResponse = (overrides = {}) => ({ok: true, activeSeats: 1, maxActiveSeats: 5, storage: 'kv', revoked: false, ...overrides});
const ENV = ['AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_LICENSE_ENDPOINT', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_MEMBER_ID', 'CLAUDE_PLUGIN_OPTION_MEMBER_ID', 'CLAUDE_PLUGIN_OPTION_LICENSE_KEY', 'PLUGIN_DATA'];

function fixture(t, {tier = 'startup', memberId = MEMBER, seat = () => seatResponse()} = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-member-seat-'));
  const original = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  process.env.AGENTGUARD_HOME = path.join(data, 'sdk');
  process.env.PLUGIN_DATA = data;
  fs.mkdirSync(process.env.AGENTGUARD_HOME);
  fs.writeFileSync(path.join(process.env.AGENTGUARD_HOME, 'install.json'), JSON.stringify({anonymous_install_id: INSTALL_ID}));
  const policy = {version: 1, mode: 'enforce', licenseKey: KEY, ...(memberId ? {memberId} : {})};
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
  // A Team tier with no published org policy: the worker has recorded a 204.
  fs.writeFileSync(path.join(data, 'org-policy-status.json'), JSON.stringify({license_fingerprint: hash(KEY), status: 'none', reason: null, org_policy_sha256: null, updated_at: new Date(NOW).toISOString()}));
  t.after(() => {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(data, {recursive: true, force: true});
  });
  const calls = [];
  const options = {data, sessionId: 'session-SYNTHETIC-member', policy, now: NOW,
    postJson: async (url, body) => { calls.push({url, body: structuredClone(body)}); return url.endsWith('/validate') ? paidStatus(tier) : seat(body); }};
  return {data, options, calls, policy};
}
// Every file under the data directory and the SDK home, as text.
function everything(data) {
  const out = [];
  const walk = directory => { for (const entry of fs.readdirSync(directory, {withFileTypes: true})) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else out.push([path.relative(data, file), fs.readFileSync(file, 'utf8')]); } };
  walk(data);
  return out;
}

test('the member ID is saved beside the key, read with the documented precedence, and refused when malformed', t => {
  const f = fixture(t, {memberId: null});
  assert.equal(configuredMemberId(f.policy), null);
  assert.equal(writeMemberId(f.data, MEMBER).configured, true);
  const saved = JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8'));
  assert.equal(saved.memberId, MEMBER);
  assert.equal(saved.licenseKey, KEY);
  assert.equal(saved.mode, 'enforce');
  assert.equal(fs.statSync(path.join(f.data, 'policy.json')).mode & 0o777, 0o600);
  assert.equal(configuredMemberId(readPolicy(f.data).policy), MEMBER);
  // The environment wins over the saved field, and the Claude Code option over both.
  process.env.AGENTGUARD_MEMBER_ID = OTHER;
  assert.equal(configuredMemberId(readPolicy(f.data).policy), OTHER);
  process.env.CLAUDE_PLUGIN_OPTION_MEMBER_ID = MEMBER;
  assert.equal(configuredMemberId(readPolicy(f.data).policy), MEMBER);
  delete process.env.CLAUDE_PLUGIN_OPTION_MEMBER_ID; delete process.env.AGENTGUARD_MEMBER_ID;
  // Only a Team tier has a roster.
  for (const tier of ['startup', 'startup_pro', 'growth', 'growth_pro']) assert.equal(memberIdFor(readPolicy(f.data).policy, tier), MEMBER);
  for (const tier of ['solo', 'solo_pro', 'free', undefined, null]) assert.equal(memberIdFor(readPolicy(f.data).policy, tier), null);
  for (const bad of ['agm_' + 'g'.repeat(32), 'agm_' + 'a'.repeat(31), 'AGM_' + 'a'.repeat(32), 'cafe'.repeat(8), '', 'agm_']) {
    assert.equal(isMemberId(bad), false);
    assert.throws(() => writeMemberId(f.data, bad), /format is invalid/);
  }
  assert.equal(configuredMemberId({memberId: 'agm_' + 'g'.repeat(32)}), null);
  // Removing it keeps everything else.
  assert.equal(writeMemberId(f.data, null).configured, false);
  const cleared = JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8'));
  assert.equal(cleared.memberId, undefined);
  assert.equal(cleared.licenseKey, KEY);
});

test('the member ID survives a team policy file merge and an org policy merge like the key, as this machine\'s own', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.data, 'team.json'), JSON.stringify({version: 1, mode: 'enforce', memberId: OTHER, licenseKey: 'ag_TEAM_FILE_KEY_NOT_MINE', deniedTools: ['^Write$']}));
  fs.writeFileSync(path.join(f.data, 'policy.json'), JSON.stringify({...f.policy, teamPolicyFile: 'team.json'}));
  const merged = readPolicy(f.data);
  assert.equal(merged.team, true);
  assert.equal(merged.policy.memberId, MEMBER);
  assert.equal(merged.policy.licenseKey, KEY);
  assert.deepEqual(merged.policy.deniedTools, ['^Write$']);
  const org = require('../runtime/org-policy.cjs').mergeOrgPolicy(merged.personal, merged.shared, {version: 1, mode: 'enforce'});
  assert.equal(org.memberId, MEMBER);
  assert.equal(org.licenseKey, KEY);
});

test('the activation helper saves the member ID from standard input, keeps the key, asks for a refresh and never prints the ID', async t => {
  const f = fixture(t, {memberId: null});
  const requests = [];
  const request = async message => { requests.push(message); return {license: {paid: true, tier: 'startup', mode: 'enforce', reason: null, seatsUsed: 2, seatLimit: 5, seatUnit: 'member', memberStatus: 'active', memberMachines: 2}}; };
  const result = await setMember(`  ${MEMBER}\n`, {data: f.data, sessionId: f.options.sessionId, request});
  assert.deepEqual(result, {memberConfigured: true, tier: 'startup', mode: 'enforce', reason: null, seatsUsed: 2, seatLimit: 5, seatUnit: 'member', memberStatus: 'active', memberMachines: 2});
  assert.equal(JSON.stringify(result).includes(MEMBER), false);
  assert.deepEqual(requests.map(message => message.control), ['license-refresh']);
  assert.equal(JSON.stringify(requests).includes(MEMBER), false, 'the IPC message carries no member ID');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8')).memberId, MEMBER);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8')).licenseKey, KEY);
  // Activating a key afterwards keeps the member ID.
  const activated = await activate('ag_SYNTHETIC_SECOND_KEY', {data: f.data, sessionId: f.options.sessionId, request: async () => ({license: {paid: true, tier: 'startup', mode: 'enforce', reason: null}})});
  assert.equal(activated.seatUnit, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8')).memberId, MEMBER);
  assert.equal(JSON.stringify(activated).includes(MEMBER), false);
  // off removes it; a malformed value is refused before anything is written.
  await assert.rejects(setMember('agm_not-hex', {data: f.data, request}), /format is invalid/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8')).memberId, MEMBER);
  const off = await setMember('off', {data: f.data, sessionId: f.options.sessionId, request});
  assert.equal(off.memberConfigured, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8')).memberId, undefined);
});

test('a Team startup and heartbeat carry the member ID and record what the server said about the seat', async t => {
  const f = fixture(t, {seat: () => seatResponse({activeSeats: 3, seatUnit: 'member', memberStatus: 'active', memberMachines: 2})});
  const first = await resolveSessionLicense(f.options);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, SEAT_ENDPOINT);
  assert.deepEqual(Object.keys(f.calls[1].body).sort(), ['license_key', 'machine_fingerprint', 'member_id', 'org_policy_sha256', 'process_id']);
  assert.equal(f.calls[1].body.member_id, MEMBER);
  assert.equal(first.mode, 'enforce');
  assert.equal(first.paid, true);
  assert.equal(first.seatUnit, 'member');
  assert.equal(first.memberStatus, 'active');
  assert.equal(first.memberMachines, 2);
  assert.equal(first.seatsUsed, 3);
  const beat = await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS});
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].body.member_id, MEMBER);
  assert.deepEqual(f.calls[2].body, f.calls[1].body);
  assert.equal(beat.seatUnit, 'member');
  assert.equal(beat.memberStatus, 'active');
  // The snapshot on disk names the seat unit and status, never the person.
  const stored = fs.readFileSync(licenseStatusPath(f.options), 'utf8');
  assert.equal(stored.includes(MEMBER), false);
  assert.equal(stored.includes(KEY), false);
  assert.match(stored, /"memberStatus":"active"/);
});

test('a Solo key never sends a member ID, even when one is configured, and its responses are unchanged', async t => {
  const f = fixture(t, {tier: 'solo', seat: () => ({ok: true, activeSeats: 1, maxActiveSeats: 3, storage: 'kv'})});
  const first = await resolveSessionLicense(f.options);
  assert.equal(first.paid, true);
  assert.deepEqual(Object.keys(f.calls[1].body).sort(), ['license_key', 'machine_fingerprint', 'org_policy_sha256', 'process_id']);
  await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS});
  assert.equal(Object.hasOwn(f.calls[2].body, 'member_id'), false);
  assert.equal(first.seatUnit, undefined);
  assert.equal(first.memberStatus, undefined);
  assert.equal(JSON.stringify(f.calls).includes(MEMBER), false);
});

test('a Team heartbeat without a configured member ID keeps the four-field body', async t => {
  const f = fixture(t, {memberId: null});
  await resolveSessionLicense(f.options);
  await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS});
  for (const call of f.calls.slice(1)) assert.deepEqual(Object.keys(call.body).sort(), ['license_key', 'machine_fingerprint', 'org_policy_sha256', 'process_id']);
});

test('over_limit selects shadow with seat_limit at startup and at a heartbeat, and a freed seat is tried again', async t => {
  let seats = 5;
  const f = fixture(t, {seat: () => seats >= 5 ? seatResponse({ok: false, activeSeats: 5, error: 'seat_limit', seatUnit: 'member', memberStatus: 'over_limit'})
    : seatResponse({activeSeats: seats + 1, seatUnit: 'member', memberStatus: 'active', memberMachines: 1})});
  const refused = await resolveSessionLicense(f.options);
  assert.equal(refused.mode, 'shadow');
  assert.equal(refused.reason, 'seat_limit');
  assert.equal(refused.memberStatus, 'over_limit');
  assert.equal(refused.seatUnit, 'member');
  assert.equal(refused.seatStatus, 'denied');
  assert.equal(refused.seatsUsed, 5);
  // A later heartbeat on a session that was registered and then refused.
  seats = 4;
  const registered = await resolveSessionLicense({...f.options, sessionId: 'second-SYNTHETIC-member', now: NOW});
  assert.equal(registered.mode, 'enforce');
  seats = 5;
  const beat = await heartbeatSessionSeat({...f.options, sessionId: 'second-SYNTHETIC-member', now: NOW + HEARTBEAT_MS});
  assert.equal(beat.mode, 'shadow');
  assert.equal(beat.reason, 'seat_limit');
  assert.equal(beat.memberStatus, 'over_limit');
  assert.equal(beat.seatHeartbeatError, 'seat_denied');
  assert.equal(readSessionLicense({...f.options, sessionId: 'second-SYNTHETIC-member'}).reason, 'seat_limit');
  seats = 4;
  const again = await heartbeatSessionSeat({...f.options, sessionId: 'second-SYNTHETIC-member', now: NOW + 2 * HEARTBEAT_MS});
  assert.equal(again.mode, 'enforce');
  assert.equal(again.reason, null);
  assert.equal(again.memberStatus, 'active');
});

test('an unrecognized member ID keeps the normal mode and is shown as unknown, counted as a session', async t => {
  const f = fixture(t, {seat: () => seatResponse({activeSeats: 2, seatUnit: 'session', memberStatus: 'unknown'})});
  const first = await resolveSessionLicense(f.options);
  assert.equal(first.mode, 'enforce');
  assert.equal(first.reason, null);
  assert.equal(first.seatUnit, 'session');
  assert.equal(first.memberStatus, 'unknown');
  assert.equal(first.memberMachines, undefined);
  const beat = await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS});
  assert.equal(beat.mode, 'enforce');
  assert.equal(beat.memberStatus, 'unknown');
  // Malformed member fields from a server are dropped, not stored.
  const odd = await heartbeatSessionSeat({...f.options, now: NOW + 2 * HEARTBEAT_MS, postJson: async () => seatResponse({seatUnit: 'person', memberStatus: 'maybe', memberMachines: -1})});
  assert.equal(odd.seatUnit, undefined);
  assert.equal(odd.memberStatus, undefined);
  assert.equal(odd.memberMachines, undefined);
});

test('status shows the seat unit and member status without the member ID', async t => {
  const f = fixture(t, {seat: () => seatResponse({activeSeats: 3, seatUnit: 'member', memberStatus: 'active', memberMachines: 2})});
  await resolveSessionLicense(f.options);
  const engine = new Engine({licenseReader: options => readSessionLicense({...options, now: NOW})});
  const reader = createReader({dataDir: f.data, workerStatus: async ({sessionId}) => { const current = engine.context({sessionId}); return {license: {...current.license, mode: current.mode}}; }});
  const status = await reader.call('get_status', {sessionId: f.options.sessionId});
  assert.equal(status.license.seatUnit, 'member');
  assert.equal(status.license.memberStatus, 'active');
  assert.equal(status.license.memberMachines, 2);
  assert.equal(status.license.mode, 'enforce');
  assert.equal(JSON.stringify(status).includes(MEMBER), false);
  assert.equal(JSON.stringify(status).includes(KEY), false);
});

test('canary: the member ID reaches the seat request only, never the ledger, receipts, status files or command output', async t => {
  const f = fixture(t, {seat: () => seatResponse({seatUnit: 'member', memberStatus: 'active', memberMachines: 1})});
  await resolveSessionLicense(f.options);
  const engine = new Engine({licenseReader: options => readSessionLicense({...options, now: NOW})});
  await engine.init();
  t.after(() => engine.close());
  const raw = {session_id: f.options.sessionId, tool_name: 'Read', tool_use_id: 'canary-call', tool_input: {path: 'x'}, tool_response: {ok: true}, duration_ms: 1};
  const decided = await engine.handle({meta: metadata(raw, 'spend')});
  assert.notEqual(decided.output.hookSpecificOutput?.permissionDecision, 'deny');
  await engine.handle({meta: metadata(raw, 'receipt')});
  const receipt = await engine.sessionReceipt({sessionId: f.options.sessionId});
  assert.equal(receipt.receipt, 'appended');
  await engine.flush();
  const shown = await require('../runtime/policy-cli.cjs').run(['show'], {data: f.data, sessionId: f.options.sessionId, licenseReader: options => readSessionLicense({...options, now: NOW})});
  assert.equal(shown.includes(MEMBER), false);
  const reader = createReader({dataDir: f.data, workerStatus: async ({sessionId}) => { const current = engine.context({sessionId}); return {license: {...current.license, mode: current.mode}}; }});
  const status = await reader.call('get_status', {sessionId: f.options.sessionId});
  assert.equal(JSON.stringify(status).includes(MEMBER), false);
  const work = await reader.call('get_work_receipt', {sessionId: f.options.sessionId});
  assert.equal(work.found, true);
  assert.equal(JSON.stringify(work).includes(MEMBER), false);
  const rows = await reader.call('list_decisions', {fromSequence: 0, limit: 200});
  assert.ok(rows.entries.length >= 3);
  assert.equal(JSON.stringify(rows).includes(MEMBER), false);
  // The only file naming the person is the policy file it was entered in.
  const carriers = everything(f.data).filter(([, text]) => text.includes(MEMBER)).map(([name]) => name);
  assert.deepEqual(carriers, ['policy.json']);
  // And the only request carrying it is the seat heartbeat.
  assert.deepEqual(f.calls.filter(call => JSON.stringify(call.body).includes(MEMBER)).map(call => call.url), [SEAT_ENDPOINT]);
});
