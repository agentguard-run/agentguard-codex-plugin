'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {validateOrgPolicy, canonicalize, hashPolicy, validateEnvelope, ROOT_FIELDS} = require('../runtime/org-policy-contract.cjs');
const {mergeOrgPolicy, readCachedOrgPolicy} = require('../runtime/org-policy.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const burn = require('@agentguard-run/burn');
const ORG_KEY = 'synthetic-org-key';
const FINGERPRINT = crypto.createHash('sha256').update(ORG_KEY).digest('hex');
const orgStatus = {paid: true, mode: 'enforce', reason: null, tier: 'startup'};
const envelope = policy => ({version: 2, published_at: '2026-09-20T12:00:00.000Z', sha256: hashPolicy(policy), policy});
function fixture(t, local = {}, org = {version: 1}, shared = null) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-org-engine-'));
  const prior = {AGENTGUARD_HOME: process.env.AGENTGUARD_HOME, PLUGIN_DATA: process.env.PLUGIN_DATA, AGENTGUARD_PLUGIN_POLICY: process.env.AGENTGUARD_PLUGIN_POLICY, AGENTGUARD_LICENSE_KEY: process.env.AGENTGUARD_LICENSE_KEY};
  process.env.AGENTGUARD_HOME = path.join(data, 'burn'); fs.mkdirSync(process.env.AGENTGUARD_HOME);
  process.env.PLUGIN_DATA = data; process.env.AGENTGUARD_PLUGIN_POLICY = ''; process.env.AGENTGUARD_LICENSE_KEY = '';
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, licenseKey: ORG_KEY, ...local, ...(shared ? {teamPolicyFile: 'team.json'} : {})}));
  if (shared) fs.writeFileSync(path.join(data, 'team.json'), JSON.stringify(shared));
  if (org) {
    const value = envelope(org);
    fs.writeFileSync(path.join(data, 'org-policy.json'), JSON.stringify({...value, license_fingerprint: FINGERPRINT}));
    fs.writeFileSync(path.join(data, 'org-policy-status.json'), JSON.stringify({license_fingerprint: FINGERPRINT, status: 'ready', reason: null, org_policy_sha256: value.sha256}));
  }
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(data, {recursive: true, force: true}); });
  return data;
}
async function start(t, status = orgStatus) { const engine = new Engine({licenseReader: () => status}); await engine.init(); t.after(() => engine.close()); return engine; }
const meta = (tool, id = 'call') => metadata({session_id: 'session-example', tool_name: tool, tool_use_id: id, tool_input: {must_stay_local: true}}, 'spend');
const permission = result => result.output.hookSpecificOutput.permissionDecision;
const rows = engine => fs.readFileSync(engine.logStore.filePath, 'utf8').trim().split('\n').map(JSON.parse);

test('org contract allows exactly documented nonlocal root and nested fields', () => {
  const policy = {version: 1, guardPack: {rules: {}}, commandRules: [], tenantId: 'tenant/example', mode: 'enforce', hookBudgetMs: 250, defaultMatterId: 'matter-1', maxCapability: 'payment_execute',
    allowedTools: ['^Read$'], deniedTools: ['^Write$'], ethicalWall: ['^mcp__conflict__'], paymentPattern: 'payment|charge',
    toolRules: [{pattern: '^Read$', capability: 'read_only', requiredCapability: 'read_only', unitCostCents: 1}],
    caps: [{window: 'per_day', amountCents: 10, action: 'block', reason: 'daily_limit', selector: {tenantId: 'tenant/example', agentId: 'agent-1', taskId: 'matter-1', sessionId: 'session-example', provider: 'codex', userId: 'user-1', teamId: 'team-1'}}],
    sessions: {'session-example': {matterId: 'matter-2', agentId: 'agent-2', maxCapability: 'read_only', allowedTools: [], deniedTools: [], ethicalWall: [], caps: []}},
    teamCaps: {tokensPerDay: 1000000, tokensPerMonth: 20000000, usdCentsPerDay: 5000, usdCentsPerMonth: 100000}};
  assert.deepEqual(validateOrgPolicy(policy), []);
  assert.deepEqual(Object.keys(policy).sort(), ROOT_FIELDS.toSorted());
  assert.deepEqual(validateEnvelope(envelope(policy)), []);
});

test('org contract rejects content, credentials, paths and unknown fields at every level', () => {
  for (const policy of [
    {version: 1, prompt: 'content'}, {version: 1, licenseKey: 'secret'}, {version: 1, teamPolicyFile: 'local.json'},
    {version: 1, tenantId: 'words in a prompt'}, {version: 1, caps: [{window: 'per_day', amountCents: 1, description: 'content'}]},
    {version: 1, caps: [{window: 'per_day', amountCents: 1, selector: {unknown: 'id'}}]},
    {version: 1, toolRules: [{pattern: '.*', content: 'not permitted'}]},
    {version: 1, sessions: {'session-example': {output: 'no'}}},
    JSON.parse('{"version":1,"__proto__":{"x":true}}'), JSON.parse('{"version":1,"sessions":{"constructor":{}}}'),
    {version: 1, allowedTools: ['[']}, {version: 1, paymentPattern: '('}, {version: 1, toolRules: [{pattern: 'x', unitCostCents: -1}]},
    {version: 1, caps: [{window: 'per_day', amountCents: 1, action: 'downgrade'}]},
    {version: 1, sessions: {'session-example': {mode: 'shadow'}}}, {version: 1, hookBudgetMs: 0}, {version: 1, hookBudgetMs: 249}, {version: 1, hookBudgetMs: 1}, {version: 2},
  ]) assert.ok(validateOrgPolicy(policy).length, JSON.stringify(policy));
});

test('canonical SHA256 ignores object insertion order and preserves array order', () => {
  const a = {version: 1, caps: [{window: 'per_day', amountCents: 5, selector: {taskId: 'matter', tenantId: 'tenant'}}]};
  const b = {caps: [{selector: {tenantId: 'tenant', taskId: 'matter'}, amountCents: 5, window: 'per_day'}], version: 1};
  assert.equal(canonicalize(a), canonicalize(b)); assert.equal(hashPolicy(a), hashPolicy(b));
  assert.notEqual(hashPolicy({version: 1, deniedTools: ['a', 'b']}), hashPolicy({version: 1, deniedTools: ['b', 'a']}));
  assert.ok(validateEnvelope({...envelope(a), sha256: '0'.repeat(64)}).length);
  assert.ok(validateEnvelope({...envelope(a), published_at: '2026-02-31T12:00:00Z'}).length);
});

test('org merge preserves every layer constraint and fixes root identities and classifications', () => {
  const org = {version: 1, mode: 'enforce', tenantId: 'org', defaultMatterId: 'org-matter', maxCapability: 'read_only', allowedTools: ['^(Read|Write)$'],
    deniedTools: ['^Delete$'], ethicalWall: ['^mcp__wall__'], caps: [{window: 'per_call', amountCents: 2}], paymentPattern: '^org_payment$',
    toolRules: [{pattern: '^Read$', capability: 'data_write', requiredCapability: 'payment_execute', unitCostCents: 9}],
    sessions: {'session-example': {agentId: 'org-agent', allowedTools: ['^Read$'], deniedTools: ['^Write$'], ethicalWall: ['^Secret$'], maxCapability: 'read_only', caps: [{window: 'per_day', amountCents: 2}]}}};
  const local = {version: 1, mode: 'shadow', tenantId: 'escape', defaultMatterId: 'escape', maxCapability: 'payment_execute', allowedTools: ['.*'], deniedTools: [], ethicalWall: [], caps: [], paymentPattern: '(?!)',
    toolRules: [{pattern: '.*', capability: 'read_only', requiredCapability: 'read_only', unitCostCents: 0}],
    sessions: {'session-example': {matterId: 'escape', agentId: 'escape', allowedTools: ['.*'], deniedTools: [], ethicalWall: [], maxCapability: 'payment_execute', caps: []}}};
  const result = mergeOrgPolicy(local, {version: 1, allowedTools: ['^Read$'], caps: [{window: 'per_hour', amountCents: 3}]}, org);
  assert.equal(result.mode, 'enforce'); assert.equal(result.tenantId, 'org'); assert.equal(result.defaultMatterId, 'org-matter'); assert.equal(result.paymentPattern, '^org_payment$');
  assert.equal(result.maxCapability, 'read_only'); assert.deepEqual(result.deniedTools, ['^Delete$']); assert.deepEqual(result.ethicalWall, ['^mcp__wall__']);
  assert.equal(result.caps.length, 2); assert.equal(result.allowedToolGroups.length, 3); assert.deepEqual(result.toolRules.at(-1), org.toolRules[0]);
  const session = result.sessions['session-example'];
  assert.equal(session.agentId, 'org-agent'); assert.equal(session.matterId, 'org-matter'); assert.equal(session.maxCapability, 'read_only');
  assert.deepEqual(session.deniedTools, ['^Write$']); assert.deepEqual(session.ethicalWall, ['^Secret$']); assert.equal(session.caps.length, 1); assert.equal(session.allowedToolGroups.length, 2);
  assert.equal(mergeOrgPolicy({version: 1, mode: 'shadow'}, null, {version: 1}).mode, 'enforce');
});

for (const [name, local, org, tool] of [
  ['allowed regex intersection', {allowedTools: ['^Read$']}, {allowedTools: ['^(Read|Write)$']}, 'Write'],
  ['org allowed regex', {allowedTools: ['.*']}, {allowedTools: ['^Read$']}, 'Write'],
  ['omitted local allowlist', {}, {allowedTools: ['^Read$']}, 'Write'],
  ['empty allowlist', {allowedTools: ['.*']}, {allowedTools: []}, 'Read'],
  ['denied union', {deniedTools: []}, {deniedTools: ['^Read$']}, 'Read'],
  ['ethical wall union', {ethicalWall: []}, {ethicalWall: ['^Read$']}, 'Read'],
  ['capability minimum', {maxCapability: 'payment_execute'}, {maxCapability: 'read_only'}, 'Write'],
  ['appended caps with authoritative price', {caps: [], toolRules: [{pattern: '.*', unitCostCents: 0}]}, {toolRules: [{pattern: '.*', unitCostCents: 4}], caps: [{window: 'per_call', amountCents: 3}]}, 'Read'],
  ['permissive local cap cannot override org block', {caps: [{window: 'per_call', amountCents: 0, action: 'allow'}]}, {toolRules: [{pattern: '.*', unitCostCents: 4}], caps: [{window: 'per_call', amountCents: 3, action: 'block'}]}, 'Read'],
  ['org tenant and matter prevent local selector escape', {tenantId: 'escape', sessions: {'session-example': {matterId: 'escape'}}}, {tenantId: 'org', defaultMatterId: 'matter', toolRules: [{pattern: '.*', unitCostCents: 4}], caps: [{window: 'per_call', amountCents: 3, selector: {tenantId: 'org', taskId: 'matter'}}]}, 'Read'],
  ['session allowlist intersection', {sessions: {'session-example': {allowedTools: ['.*']}}}, {sessions: {'session-example': {allowedTools: ['^Write$']}}}, 'Read'],
]) test(`engine prevents local loosening: ${name}`, async t => {
  fixture(t, {mode: 'shadow', ...local}, {version: 1, ...org}); const engine = await start(t);
  assert.equal(permission(await engine.handle({meta: meta(tool)})), 'deny');
  assert.equal(rows(engine)[0].decision.enforcementMode, 'enforce');
  assert.equal(engine.orgPolicyDigests.get('session-example'), hashPolicy({version: 1, ...org}));
});

test('regex intersection preserves independent expression semantics and case-insensitive repeated calls', async t => {
  fixture(t, {allowedTools: ['^(Read|Write)$']}, {version: 1, allowedTools: ['^read$']}); const engine = await start(t);
  for (let index = 0; index < 3; index++) assert.equal(permission(await engine.handle({meta: meta('READ', String(index))})), 'allow');
  assert.equal(permission(await engine.handle({meta: meta('Write', 'write')})), 'deny');
});

test('failed refresh retains cached constraints but forces a reasoned shadow result', async t => {
  const data = fixture(t, {}, {version: 1, deniedTools: ['.*']});
  const file = path.join(data, 'org-policy.json'), before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(data, 'org-policy-status.json'), JSON.stringify({license_fingerprint: FINGERPRINT, status: 'shadow', reason: 'org_policy_unavailable', org_policy_sha256: envelope({version: 1, deniedTools: ['.*']}).sha256}));
  const engine = await start(t); assert.equal(permission(await engine.handle({meta: meta('Read')})), 'allow');
  const decision = rows(engine)[0].decision;
  assert.equal(decision.enforcementMode, 'shadow'); assert.equal(decision.plugin.reasonCode, 'org_policy_unavailable');
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.ok(readCachedOrgPolicy(data, {keyFingerprint: FINGERPRINT}).envelope);
});

for (const reason of ['seat_revoked', 'seat_unavailable', 'license_unavailable']) test(`${reason} never denies even with cached enforce policy`, async t => {
  fixture(t, {}, {version: 1, deniedTools: ['.*']}); const engine = await start(t, {...orgStatus, mode: 'shadow', reason});
  assert.equal(permission(await engine.handle({meta: meta('Read')})), 'allow');
  assert.equal(rows(engine)[0].decision.plugin.reasonCode, reason); assert.equal(rows(engine)[0].decision.enforcementMode, 'shadow');
});

test('missing org state shadows Team; Solo ignores an org cache; 204 none permits personal paid policy', async t => {
  const data = fixture(t, {deniedTools: ['.*']}, null); const team = await start(t);
  assert.equal(permission(await team.handle({meta: meta('Read')})), 'allow'); assert.equal(rows(team)[0].decision.plugin.reasonCode, 'org_policy_unavailable');
  fs.writeFileSync(path.join(data, 'org-policy-status.json'), JSON.stringify({license_fingerprint: FINGERPRINT, status: 'none', reason: null, org_policy_sha256: null}));
  assert.equal(permission(await team.handle({meta: meta('Read', 'none')})), 'deny');
  const solo = await start(t, {...orgStatus, tier: 'solo'});
  assert.equal(solo.context(meta('Read')).orgPolicy, null);
});

test('cache is bound to license identity and rejects tampering', t => {
  const data = fixture(t); assert.ok(readCachedOrgPolicy(data, {keyFingerprint: FINGERPRINT}).envelope);
  assert.equal(readCachedOrgPolicy(data, {keyFingerprint: 'other'}).envelope, null);
  const file = path.join(data, 'org-policy.json'), value = JSON.parse(fs.readFileSync(file)); value.policy.mode = 'shadow'; fs.writeFileSync(file, JSON.stringify(value));
  assert.equal(readCachedOrgPolicy(data, {keyFingerprint: FINGERPRINT}).reason, 'org_policy_invalid');
});

test('revoked seat observes Burn STOP policy without denying a spawn', async t => {
  fixture(t, {}, {version: 1, mode: 'enforce'});
  const policy = structuredClone(burn.DEFAULT_POLICY);
  policy.mode = 'enforce'; policy.thresholds.fanout = {warn: 1, stop: 1, maxDepth: 2};
  fs.writeFileSync(path.join(process.env.AGENTGUARD_HOME, 'burn-policy.json'), JSON.stringify(policy));
  const engine = await start(t, {...orgStatus, mode: 'shadow', reason: 'seat_revoked'});
  for (let i = 0; i < 3; i++) {
    const message = metadata({session_id: 'session-example', tool_name: 'spawn_agent', tool_use_id: `revoked-spawn-${i}`, tool_input: {}}, 'burn');
    const result = await engine.handle({meta: message});
    assert.equal(permission(result), 'allow'); assert.equal(result.warning, undefined);
  }
  assert.ok(rows(engine).every(row => row.decision.enforcementMode === 'shadow' && row.decision.plugin.reasonCode === 'seat_revoked'));
});

test('worker failure latch shadows a valid cached policy until a confirmed successful refresh', async t => {
  fixture(t, {}, {version: 1, deniedTools: ['.*']}); const engine = await start(t);
  engine.sessionFailures.set('session-example', 'org_policy_unavailable');
  assert.equal(permission(await engine.handle({meta: meta('Read', 'failed-disk-status')})), 'allow');
  assert.equal(rows(engine).at(-1).decision.plugin.reasonCode, 'org_policy_unavailable');
  assert.equal(engine.orgPolicyDigests.get('session-example'), hashPolicy({version: 1, deniedTools: ['.*']}));
  engine.sessionFailures.delete('session-example');
  assert.equal(permission(await engine.handle({meta: meta('Read', 'confirmed-refresh')})), 'deny');
});

test('known seat revocation takes priority over a worker failure latch', async t => {
  fixture(t, {}, {version: 1, deniedTools: ['.*']}); const engine = await start(t, {...orgStatus, mode: 'shadow', reason: 'seat_revoked'});
  engine.sessionFailures.set('session-example', 'org_policy_unavailable');
  assert.equal(permission(await engine.handle({meta: meta('Read')})), 'allow');
  assert.equal(rows(engine).at(-1).decision.plugin.reasonCode, 'seat_revoked');
});

test('successful seat refresh cannot clear a separate failed org refresh', async t => {
  fixture(t, {}, {version: 1, deniedTools: ['.*']}); const engine = await start(t);
  engine.setSessionFailure('session-example', 'org', 'org_policy_unavailable');
  engine.setSessionFailure('session-example', 'seat', 'seat_unavailable');
  engine.clearSessionFailure('session-example', 'seat');
  assert.equal(permission(await engine.handle({meta: meta('Read', 'org-still-failed')})), 'allow');
  assert.equal(rows(engine).at(-1).decision.plugin.reasonCode, 'org_policy_unavailable');
  engine.setSessionFailure('session-example', 'seat', 'seat_revoked');
  assert.equal(engine.preferredSessionFailure('session-example'), 'seat_revoked');
  assert.equal(engine.context({sessionId: 'session-example'}).license.seatRevoked, true);
  engine.clearSessionFailure('session-example', 'org');
  assert.equal(permission(await engine.handle({meta: meta('Read', 'seat-still-revoked')})), 'allow');
  assert.equal(rows(engine).at(-1).decision.plugin.reasonCode, 'seat_revoked');
  engine.clearSessionFailure('session-example', 'seat');
  assert.equal(permission(await engine.handle({meta: meta('Read', 'all-refreshed')})), 'deny');
});
