'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const sdk = require('@agentguard-run/spend');
const {Engine, validatePolicy} = require('../runtime/engine.cjs');
const {createReader, handleRpc, TOOLS} = require('../runtime/mcp.cjs');
const {licenseStatusPath} = require('../runtime/license.cjs');
const {activate} = require('./helper-worker-license.cjs');
const catalog = require('../docs/DIRECTORY_FIXTURES.json');
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const SESSION = catalog.identifiers.sessionId;
const READ = 'mcp__synthetic_docs__get_document';
const WRITE = 'mcp__synthetic_docs__save_document';
const review = id => catalog.cases.find(item => item.id === id).fixtureData;
const licenseStatus = data => ({...structuredClone(data.license.status), expiresAt: new Date(Date.now() + data.license.expiresAfterMs).toISOString()});

function safeSnapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, {recursive: true}).sort().filter(name => fs.statSync(path.join(directory, name)).isFile()).map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
}

async function setup(t, {paid = true, patch = {}, fixtureData} = {}) {
  paid = fixtureData?.license.initialPaid ?? paid;
  patch = fixtureData?.policyOverrides ?? patch;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-directory-review-'));
  const names = ['PLUGIN_DATA', 'AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'CODEX_THREAD_ID'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.PLUGIN_DATA = data;
  process.env.AGENTGUARD_HOME = path.join(data, 'sdk');
  delete process.env.AGENTGUARD_LICENSE_KEY;
  delete process.env.AGENTGUARD_PLUGIN_POLICY;
  delete process.env.CODEX_THREAD_ID;
  const key = fixtureData?.license.syntheticKey || LICENSE_KEY;
  const policy = {...structuredClone(catalog.fixturePolicy), ...(paid ? {licenseKey: key} : {}), ...patch};
  validatePolicy(policy);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
  if (paid) {
    seedPaidLicense(process.env.AGENTGUARD_HOME, key, data);
    if (fixtureData) fs.writeFileSync(path.join(process.env.AGENTGUARD_HOME, `license-${crypto.createHash('sha256').update(key).digest('hex')}.json`), JSON.stringify({fetchedAt: Date.now(), status: licenseStatus(fixtureData)}));
    const file = licenseStatusPath({data, sessionId: SESSION, policy});
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const now = new Date().toISOString();
    const seat = fixtureData?.seatResponse || {activeSeats: 3, maxActiveSeats: 5, storage: 'kv'};
    fs.writeFileSync(file, JSON.stringify({schema: 'agentguard.plugin.license.v1', sessionFingerprint: crypto.createHash('sha256').update(SESSION).digest('hex'), keyFingerprint: crypto.createHash('sha256').update(key).digest('hex'), paid: true, mode: 'enforce', reason: null, tier: fixtureData?.license.status.tier || 'startup', seatsUsed: seat.activeSeats, seatLimit: seat.maxActiveSeats, seatStorage: seat.storage, seatsVerified: seat.storage === 'kv', seatRefreshedAt: now, expiresAt: new Date(Date.now() + (fixtureData?.license.expiresAfterMs || 86400000)).toISOString(), refreshedAt: now, source: 'fixture'}));
  }
  const oldConnect = net.Socket.prototype.connect, oldFetch = global.fetch;
  let networkAttempts = 0;
  net.Socket.prototype.connect = () => { networkAttempts++; throw new Error('Network is forbidden in review fixtures.'); };
  global.fetch = () => { networkAttempts++; throw new Error('Network is forbidden in review fixtures.'); };
  const engine = new Engine();
  t.after(async () => {
    try { await engine.close(); }
    finally {
      net.Socket.prototype.connect = oldConnect; global.fetch = oldFetch;
      for (const [name, value] of Object.entries(prior)) value === undefined ? delete process.env[name] : process.env[name] = value;
      fs.rmSync(data, {recursive: true, force: true});
    }
    assert.equal(networkAttempts, 0, 'Review fixture execution must stay offline.');
  });
  await engine.init();
  const reader = createReader({dataDir: data, workerStatus: async ({sessionId}) => {
    const current = engine.context({sessionId});
    return {license: {...current.license, mode: current.mode}};
  }});
  let sequence = 0;
  const meta = (name, gate = 'spend', extra = {}) => ({schema: 'agentguard.codex.v1', requestId: crypto.randomUUID(), gate, toolName: name, toolUseId: `call_SYNTHETIC_review_${sequence++}`, sessionId: SESSION, agentId: catalog.identifiers.agentId, inputSha256: crypto.createHash('sha256').update('{}').digest('hex'), inputBytes: 2, inputKeys: 0, startedAt: new Date().toISOString(), ...extra});
  const gate = async metadata => {
    const result = await engine.handle({meta: metadata});
    assert.equal(result.warning, undefined, 'A normal review decision must not fail open.');
    await engine.flush();
    return result.output.hookSpecificOutput?.permissionDecision;
  };
  const rows = () => fs.readFileSync(reader.filePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const caseMeta = (index = 0) => {
    const event = fixtureData.toolEvents[index];
    return meta(event.toolName, event.gate, event);
  };
  const signedPair = async () => {
    const pre = fixtureData ? caseMeta(0) : meta(READ);
    assert.equal(await gate(pre), 'allow');
    await gate({...pre, requestId: crypto.randomUUID(), ...(fixtureData ? fixtureData.toolEvents[1] : {gate: 'receipt', outputBytes: 2, durationMs: 4, durationSource: 'host', success: true})});
  };
  const rpc = (name, args = {}) => handleRpc({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}, reader);
  return {data, policy, engine, reader, meta, caseMeta, gate, rows, signedPair, rpc};
}

test('directory catalog supplies five positive and three negative cases plus six starter candidates across all skills', () => {
  assert.equal(catalog.version, require('../package.json').version);
  assert.equal(catalog.cases.filter(item => item.kind === 'positive').length, 5);
  assert.equal(catalog.cases.filter(item => item.kind === 'negative').length, 3);
  assert.equal(catalog.starterCandidates.length, 6);
  const selected = catalog.starterCandidates.filter(item => item.selected);
  const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DIRECTORY_SUBMISSION.md'), 'utf8');
  assert.ok(documentation.includes('docs/DIRECTORY_FIXTURES.json'));
  assert.ok(require('../package.json').files.includes('docs'), 'The reviewer catalog must ship in npm packs.');
  assert.equal(selected.length, 3);
  assert.deepEqual(new Set(selected.map(item => item.skill)), new Set(['agentguard-policy', 'agentguard-status', 'agentguard-verify']));
  for (const item of catalog.starterCandidates) {
    assert.ok(item.prompt.length <= 128);
    assert.doesNotMatch(item.prompt, /[@\r\n]/);
  }
  for (const item of catalog.cases) {
    assert.ok(item.prompt && item.expected && item.fixture && Object.keys(item.resultShape).length);
    const fixture = item.fixtureData;
    assert.ok(documentation.includes(JSON.stringify(fixture, null, 2)), `${item.id} has matching inline fixture data.`);
    assert.ok(fixture && Object.hasOwn(fixture, 'policyOverrides'));
    validatePolicy({...catalog.fixturePolicy, ...fixture.policyOverrides});
    assert.equal(typeof fixture.license.initialPaid, 'boolean');
    assert.ok(fixture.toolEvents.length >= 1);
    for (const event of fixture.toolEvents) {
      assert.match(event.toolName, /^mcp__synthetic_/);
      assert.equal(event.sessionId, SESSION);
      assert.equal(event.agentId, catalog.identifiers.agentId);
      assert.equal(event.inputSha256, crypto.createHash('sha256').update('{}').digest('hex'));
      assert.equal(event.inputBytes, 2);
      assert.equal(event.inputKeys, 0);
      assert.ok(['spend', 'receipt'].includes(event.gate));
    }
    if (fixture.license.syntheticKey) {
      assert.equal(fixture.license.syntheticKey, LICENSE_KEY);
      assert.equal(fixture.license.status.valid, true);
      assert.equal(fixture.license.expiresAfterMs, 86400000);
      assert.equal(fixture.seatResponse.maxActiveSeats, fixture.license.status.features.maxActiveSeats);
    } else {
      assert.equal(fixture.license.status, null);
      assert.equal(fixture.seatResponse, null);
    }
    if (item.kind === 'negative') assert.ok(item.whyNot);
  }
  assert.doesNotMatch(JSON.stringify(catalog), /[\u2013\u2014\u00ae\u2122]|--|Agent Guard/);
});

test('P1: provisioned plugin has registry dependencies and records a Free enforce decision', async t => {
  const manifest = require('../plugin.json');
  const pack = require('../package.json');
  assert.equal(manifest.name, 'agentguard');
  assert.equal(manifest.version, catalog.version);
  assert.equal(pack.dependencies['@agentguard-run/spend'], '^0.22.0');
  assert.equal(pack.dependencies['@agentguard-run/burn'], '^0.6.1');
  assert.equal(typeof sdk.verifyChain, 'function');
  assert.ok(require('@agentguard-run/burn'));
  for (const component of ['hooks/spend-gate.cjs', 'hooks/burn-gate.cjs', 'hooks/receipt.cjs', 'runtime/mcp.cjs']) assert.ok(fs.existsSync(path.join(__dirname, '..', component)));
  const f = await setup(t, {fixtureData: review('P1')});
  assert.equal(await f.gate(f.caseMeta()), 'allow');
  const row = f.rows()[0];
  assert.equal(row.decision.action, 'allow');
  assert.equal(row.decision.enforcementMode, 'enforce');
  assert.equal(row.decision.plugin.license.reason, null);
  const verification = await f.reader.call('verify_chain');
  assert.equal(verification.ok, true);
  assert.equal(verification.entries, 1);
});

test('P3: activation stores the synthetic key locally and resolves paid mode outside hooks', async t => {
  const data = review('P3');
  const key = data.license.syntheticKey;
  const f = await setup(t, {fixtureData: data});
  const calls = [];
  const result = await activate(key, {data: f.data, sessionId: SESSION, postJson: async (url, payload) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    assert.equal(payload.license_key, key);
    if (pathname === '/api/license/validate') return licenseStatus(data);
    assert.equal(pathname, '/api/license/seats');
    return structuredClone(data.seatResponse);
  }});
  const expected = catalog.cases.find(item => item.id === 'P3').resultShape;
  for (const [key, value] of Object.entries(expected)) if (key !== 'keyInLedger') assert.deepEqual(result[key], value);
  assert.deepEqual(calls, ['/api/license/validate', '/api/license/seats']);
  const stored = JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8'));
  assert.equal(stored.licenseKey, key);
  assert.equal(stored.tenantId, catalog.fixturePolicy.tenantId);
  assert.equal(await f.gate(f.caseMeta()), 'allow');
  assert.equal(f.rows()[0].decision.enforcementMode, 'enforce');
  assert.doesNotMatch(JSON.stringify(f.rows()), new RegExp(key));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  assert.equal((await f.reader.call('verify_chain')).ok, true);
});

test('N1: a payment tool above the session capability tier is denied and signed', async t => {
  const f = await setup(t, {fixtureData: review('N1')});
  assert.equal(await f.gate(f.caseMeta()), 'deny');
  const decision = f.rows()[0].decision;
  assert.equal(decision.action, 'block');
  assert.equal(decision.plugin.reasonCode, 'capability_tier_exceeded');
  assert.equal(decision.plugin.capabilityTier, 'payment_initiate');
  assert.equal((await f.reader.call('verify_chain')).ok, true);
});

test('N2: a policy-denied tool stays denied without changing the policy', async t => {
  const f = await setup(t, {fixtureData: review('N2')});
  const before = fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8');
  assert.equal(await f.gate(f.caseMeta()), 'deny');
  assert.equal(f.rows()[0].decision.action, 'block');
  assert.equal(f.rows()[0].decision.plugin.reasonCode, 'tool_denied');
  assert.equal((await f.reader.call('verify_chain')).ok, true);
  assert.equal(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8'), before);
});

test('N3: corrupt policy fails open with a signed event and no malformed content', async t => {
  const f = await setup(t, {fixtureData: review('N3')});
  const marker = review('N3').corruptPolicyText;
  fs.writeFileSync(path.join(f.data, 'policy.json'), marker);
  const result = await f.engine.handle({meta: f.caseMeta()});
  await f.engine.flush();
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(result.warning, true);
  assert.equal(result.cause, 'policy_or_runtime_error');
  const decision = f.rows()[0].decision;
  assert.equal(decision.plugin.event, 'fail_open');
  // License failure takes the public reason field; the runtime cause remains
  // recorded separately and matches the one-line warning metadata.
  assert.equal(decision.plugin.policyReasonCode, 'policy_or_runtime_error');
  assert.equal(decision.plugin.reasonCode, 'license_required');
  assert.equal((await f.reader.call('verify_chain')).ok, true);
  assert.doesNotMatch(JSON.stringify(f.rows()), new RegExp(marker));
});

test('MCP license status omits worker identity fields and unknown nested metadata', async t => {
  const f = await setup(t);
  const file = licenseStatusPath({data: f.data, sessionId: SESSION, policy: f.policy});
  const status = JSON.parse(fs.readFileSync(file, 'utf8'));
  status.seatIdentity = {machineFingerprint: 'a'.repeat(64), processId: 'process-SYNTHETIC-private'};
  status.futureInternalData = {sensitive: 'SYNTHETIC_INTERNAL_DO_NOT_RETURN'};
  fs.writeFileSync(file, JSON.stringify(status));
  const before = safeSnapshot(f.data);
  const result = (await f.reader.call('get_status', {sessionId: SESSION})).license;
  for (const field of ['schema', 'keyFingerprint', 'sessionFingerprint', 'seatIdentity', 'futureInternalData']) assert.equal(Object.hasOwn(result, field), false);
  assert.equal(result.paid, true);
  assert.equal(result.mode, 'enforce');
  assert.equal(result.seatsUsed, 3);
  assert.equal(result.seatLimit, 5);
  assert.equal(result.seatStorage, 'kv');
  assert.equal(result.seatsVerified, true);
  assert.ok(result.expiresAt);
  assert.ok(result.seatRefreshedAt);
  assert.equal(JSON.stringify(result).includes(status.keyFingerprint), false);
  assert.equal(JSON.stringify(result).includes(status.sessionFingerprint), false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_INTERNAL|SYNTHETIC-private/);
  assert.deepEqual(safeSnapshot(f.data), before);
});

test('supplemental S1: per-matter policy admits one configured unit charge and blocks the next with a valid chain', async t => {
  const f = await setup(t, {patch: {defaultMatterId: catalog.identifiers.matterId, caps: [{window: 'per_day', amountCents: 2, action: 'block', selector: {taskId: catalog.identifiers.matterId}}]}});
  assert.deepEqual([await f.gate(f.meta(WRITE)), await f.gate(f.meta(WRITE))], ['allow', 'deny']);
  const rows = f.rows();
  assert.deepEqual(rows.map(row => row.decision.action), ['allow', 'block']);
  assert.deepEqual(rows.map(row => row.decision.projectedCents), [2, 2]);
  for (const row of rows) assert.equal(row.decision.actor.taskId, catalog.identifiers.matterId);
  assert.equal((await f.reader.call('verify_chain')).ok, true);
});

test('P4: status returns fixture KV seat provenance, effective mode and exact decision totals', async t => {
  const f = await setup(t, {fixtureData: review('P4')});
  await f.gate(f.caseMeta());
  const result = await f.reader.call('get_status', {sessionId: SESSION});
  const expected = catalog.cases.find(item => item.id === 'P4').resultShape;
  for (const [key, value] of Object.entries(expected.license)) assert.deepEqual(result.license[key], value);
  for (const key of ['decisions', 'blocks', 'totalEntries']) assert.equal(result[key], expected[key]);
  assert.equal(typeof result.health.lastHour.failOpenCount, 'number');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(LICENSE_KEY));
});

test('supplemental S2: paged summaries link a content-free outcome to its decision', async t => {
  const f = await setup(t);
  await f.signedPair();
  const first = await f.reader.call('list_decisions', {limit: 1});
  const second = await f.reader.call('list_decisions', {limit: 1, fromSequence: first.nextSequence});
  assert.deepEqual([first.entries.length, second.entries.length], [1, 1]);
  assert.deepEqual([first.nextSequence, second.nextSequence], [1, null]);
  assert.deepEqual([first.entries[0].entryType, second.entries[0].entryType], ['decision', 'outcome']);
  assert.equal(second.entries[0].originalDecisionId, first.entries[0].decisionId);
  assert.equal(second.totalEntries, 2);
  assert.equal(f.rows()[1].decision.plugin.durationMs, 4);
  assert.equal(f.rows()[1].decision.plugin.outputBytes, 2);
  assert.doesNotMatch(JSON.stringify(f.rows()), /"(?:tool_input|tool_output|tool_response|prompt|content|privateKey|licenseKey)"/);
});

test('supplemental S3: free sessions can verify the signed decision chain', async t => {
  const f = await setup(t, {paid: false});
  await f.gate(f.meta(READ));
  const result = await f.reader.call('verify_chain');
  assert.equal(result.ok, true);
  assert.equal(result.entries, 1);
  assert.match(result.publicKeyHex, /^[a-f0-9]{64}$/);
  assert.match(result.lastEntryHash, /^[a-f0-9]{64}$/);
});

test('P5: paid export returns the exact verified bundle without writes, private keys or network', async t => {
  const f = await setup(t, {fixtureData: review('P5')});
  await f.signedPair();
  const before = safeSnapshot(f.data);
  assert.equal((await f.reader.call('verify_chain')).ok, true);
  const result = await f.reader.call('export_receipts', {sessionId: SESSION});
  for (const [key, value] of Object.entries(catalog.cases.find(item => item.id === 'P5').resultShape)) assert.equal(result[key], value);
  assert.deepEqual(result.entries, f.rows());
  assert.equal((await sdk.verifyChain(result.entries, Buffer.from(result.publicKeyHex, 'hex'))).ok, true);
  assert.doesNotMatch(JSON.stringify(result), /"(?:privateKey|signingKey|licenseKey|tool_input|tool_response)"/);
  assert.deepEqual(safeSnapshot(f.data), before);
});

test('P2: an ethical-wall denial remains signed and does not rewrite the policy', async t => {
  const f = await setup(t, {fixtureData: review('P2')});
  const before = fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8');
  assert.equal(await f.gate(f.caseMeta()), 'deny');
  const row = f.rows()[0];
  assert.equal(row.decision.action, 'block');
  assert.equal(row.decision.plugin.reasonCode, 'ethical_wall');
  assert.equal((await f.reader.call('verify_chain')).ok, true);
  assert.equal(fs.readFileSync(path.join(f.data, 'policy.json'), 'utf8'), before);
});

test('supplemental S4: free export is refused while verification and local enforcement remain available', async t => {
  const f = await setup(t, {paid: false, patch: {ethicalWall: ['^mcp__synthetic_docs__save_document$']}});
  assert.equal(await f.gate(f.meta(WRITE)), 'deny');
  const result = await f.rpc('export_receipts', {sessionId: SESSION});
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /^license_required:/);
  assert.equal((await f.reader.call('verify_chain')).ok, true);
  assert.equal((await f.reader.call('get_status', {sessionId: SESSION})).license.mode, 'enforce');
  assert.equal(f.rows()[0].decision.plugin.reasonCode, 'ethical_wall');
});

test('supplemental S5: actor tampering fails verification and export without rewriting the altered record', async t => {
  const f = await setup(t);
  await f.gate(f.meta(READ));
  const rows = f.rows();
  rows[0].decision.actor.agentId = 'agent-SYNTHETIC-tampered';
  fs.writeFileSync(f.reader.filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = safeSnapshot(f.data);
  assert.equal((await f.reader.call('verify_chain')).ok, false);
  assert.equal((await f.rpc('export_receipts', {sessionId: SESSION})).result.isError, true);
  assert.deepEqual(safeSnapshot(f.data), before);
});

test('all seven MCP annotations match their behavior and reject open-ended targets', async t => {
  const f = await setup(t);
  await f.signedPair();
  const before = safeSnapshot(f.data);
  assert.deepEqual(TOOLS.map(tool => tool.name), ['get_status', 'list_decisions', 'verify_chain', 'export_receipts', 'get_work_receipt', 'agent_score_questions', 'agent_score']);
  for (const tool of TOOLS) {
    assert.deepEqual(tool.annotations, tool.name === 'agent_score' ? {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true} : {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
    // agent_score without consent refuses offline; that is the bounded call for this loop.
    await f.reader.call(tool.name, ['get_status', 'export_receipts'].includes(tool.name) ? {sessionId: SESSION} : tool.name === 'agent_score' ? {answers: {}, consent: false} : {});
    await assert.rejects(f.reader.call(tool.name, {url: 'https://invalid.example/'}), /Unexpected argument/);
    await assert.rejects(f.reader.call(tool.name, {path: 'outside-workspace.json'}), /Unexpected argument/);
  }
  assert.deepEqual(safeSnapshot(f.data), before);
});
