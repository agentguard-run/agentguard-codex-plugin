'use strict';
// The org policy contract with Team caps: validated at the root only, stripped
// and rehashed for distribution, and never part of a Solo push.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const contract = require('../runtime/org-policy-contract.cjs');
const {validateOrgPolicy, validateEnvelope, hashPolicy, distributedPolicy, distributedEnvelope, teamCapsSha256, canonicalize,
  ROOT_FIELDS, TEAM_CAP_FIELDS, SERVER_HELD_FIELDS, GUARD_RULE_IDS, COMMAND_MATCHES, validateGuardPack, validateCommandRules} = contract;
const {pushPersonalPolicy, ENDPOINT} = require('../runtime/org-policy-refresh.cjs');
const {policyConfig} = require('../runtime/policy-cli.cjs');
const matrix = require('./helper-host-matrix.cjs');
const KEY = 'ag_SYNTHETIC_TEAM_CAPS_CONTRACT_KEY';
const caps = {tokensPerDay: 1000000, tokensPerMonth: 20000000, usdCentsPerDay: 5000, usdCentsPerMonth: 100000};
const envelope = policy => ({version: 4, published_at: '2026-10-28T00:00:00.000Z', sha256: hashPolicy(policy), policy});

test('teamCaps is a root field of optional nonnegative integers and nothing else', () => {
  assert.deepEqual(TEAM_CAP_FIELDS, ['tokensPerDay', 'tokensPerMonth', 'usdCentsPerDay', 'usdCentsPerMonth']);
  assert.deepEqual(SERVER_HELD_FIELDS, ['teamCaps']);
  assert.ok(ROOT_FIELDS.includes('teamCaps'));
  assert.deepEqual(validateOrgPolicy({version: 1, teamCaps: caps}), []);
  assert.deepEqual(validateOrgPolicy({version: 1, teamCaps: {}}), []);
  assert.deepEqual(validateOrgPolicy({version: 1, teamCaps: {tokensPerDay: 0}}), []);
  for (const bad of [{tokensPerDay: -1}, {tokensPerDay: 1.5}, {tokensPerDay: '100'}, {tokensPerDay: null}, {tokensPerDay: Number.MAX_SAFE_INTEGER + 1}, {tokensPerWeek: 1}, {prompt: 'content'}, [], 'caps', 7]) {
    const errors = validateOrgPolicy({version: 1, teamCaps: bad});
    assert.ok(errors.length, JSON.stringify(bad));
    assert.ok(errors.every(error => /policy\.teamCaps/.test(error)), errors.join(' '));
  }
  // Sessions never carry a team cap: the budget is the whole team's.
  assert.match(validateOrgPolicy({version: 1, sessions: {'session-example': {teamCaps: caps}}}).join(' '), /sessions\.session-example\.teamCaps is not an allowed/);
  assert.deepEqual(validateEnvelope(envelope({version: 1, mode: 'enforce', teamCaps: caps})), []);
});

test('the distributed envelope omits teamCaps and is hashed as served; without teamCaps it is the published envelope unchanged', () => {
  const published = {version: 1, mode: 'enforce', deniedTools: ['^Write$'], teamCaps: caps};
  const served = distributedEnvelope(envelope(published));
  assert.deepEqual(served.policy, {version: 1, mode: 'enforce', deniedTools: ['^Write$']});
  assert.equal(served.sha256, hashPolicy(served.policy));
  assert.notEqual(served.sha256, hashPolicy(published));
  assert.deepEqual(Object.keys(served).sort(), ['policy', 'published_at', 'sha256', 'version']);
  assert.deepEqual(validateEnvelope(served), []);
  const plain = envelope({version: 1, mode: 'enforce'});
  assert.equal(distributedEnvelope(plain), plain);
  assert.deepEqual(distributedPolicy({version: 1, teamCaps: caps}), {version: 1});
  assert.equal(distributedPolicy(null), null);
  assert.equal(distributedEnvelope(null), null);
  // The cap source names the published caps alone, in canonical order.
  assert.equal(teamCapsSha256(published), crypto.createHash('sha256').update(canonicalize(caps)).digest('hex'));
  assert.equal(teamCapsSha256({version: 1, teamCaps: {usdCentsPerMonth: 100000, usdCentsPerDay: 5000, tokensPerMonth: 20000000, tokensPerDay: 1000000}}), teamCapsSha256(published));
  assert.equal(teamCapsSha256({version: 1}), null);
  assert.equal(teamCapsSha256(null), null);
});

test('the plugin copy keeps its superset of the site copy: GP015 to GP020 with ask, pageGuard, allowOnce and the newer command matches', () => {
  assert.deepEqual(GUARD_RULE_IDS.slice(14, 20), ['GP015', 'GP016', 'GP017', 'GP018', 'GP019', 'GP020']);
  assert.ok(GUARD_RULE_IDS.includes('inbox-reset-codes'));
  assert.deepEqual(validateGuardPack({rules: {GP020: 'ask', GP015: 'warn'}, pageGuard: {internalLinkThreshold: 2}}), []);
  assert.ok(validateGuardPack({rules: {GP001: 'ask'}}).length);
  assert.deepEqual(validateCommandRules([{id: 'deploy-once', match: 'deploy', action: 'block', allowOnce: true}]), []);
  for (const match of ['website-publish', 'page-delete', 'payment']) assert.ok(COMMAND_MATCHES.includes(match), match);
  assert.equal(contract.guardDefault('GP020'), 'off');
  assert.equal(contract.guardDefault('GP015'), 'stop');
});

test('a Solo push never carries teamCaps, whatever the local file says', async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-team-caps-push-'));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  matrix.environment(process.env, data); process.env.AGENTGUARD_LICENSE_KEY = ''; process.env.AGENTGUARD_PLUGIN_POLICY = ''; process.env.AGENTGUARD_HOME = path.join(data, 'burn');
  t.after(() => { for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value; fs.rmSync(data, {recursive: true, force: true}); });
  const local = {version: 1, mode: 'enforce', licenseKey: KEY, caps: [{window: 'per_day', amountCents: 1500}], teamCaps: caps, memberId: 'agm_' + 'ab'.repeat(16)};
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(local));
  assert.deepEqual(Object.keys(policyConfig(local)).sort(), ['caps', 'mode', 'version']);
  let sent;
  const result = await pushPersonalPolicy({data, sessionId: 'solo-session', resolveLicense: async () => ({paid: true, tier: 'solo', mode: 'enforce', reason: null}),
    put: async (url, request) => { assert.equal(url, ENDPOINT); sent = request.policy; return {status: 200, body: envelope(request.policy)}; }});
  assert.ok(result.sha256);
  assert.deepEqual(Object.keys(sent).sort(), ['caps', 'mode', 'version']);
  assert.equal(Object.hasOwn(sent, 'teamCaps'), false);
  assert.equal(JSON.stringify(sent).includes('agm_'), false);
  // The local diff output of the CLI never names the server-held field either.
  const shown = await require('../runtime/policy-cli.cjs').run(['set-cap', '12', 'per_day'], {data, sessionId: 'solo-session', licenseReader: () => ({paid: true, tier: 'solo', mode: 'enforce', reason: null})});
  assert.doesNotMatch(shown, /teamCaps|agm_/);
});
