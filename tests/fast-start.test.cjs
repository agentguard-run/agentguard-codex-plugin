'use strict';
// Guarantee S (0.7.4). What a worker checks before it is ready, and what it checks straight after.
//
// Until 0.7.4 a worker checked every signature of the ledger before it answered its first call. That costs about
// 0.75 ms a row: on a 434,000 row ledger a worker took about five and a half minutes to start, and every call made
// in that time was allowed unchecked. Even at 2,000 rows the first call of a session was allowed unchecked.
//
//   S1  A ledger the signing library accepts is never refused, at the start or by the background check.
//   S2  A ledger the signing library refuses never survives: the start refuses it, or the background check does.
//   S3  Changed content never gets past the start. Only a row whose signature alone is wrong (its content, hash
//       and links intact) can reach the background check, and that check then refuses it.
//   S4  After the background check refuses, nothing more is appended, and every later start runs the full check
//       first: it refuses that ledger as before 0.7.4, and accepts it again once the ledger is put right.
//   S5  The newest row's signature is always checked before the worker is ready.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fc = require('fast-check');
require('./helper-test-env.cjs');
const sdk = require('@agentguard-run/spend');
const {OwnedLogStore, verifyLinks, HEAD_SIGNATURES} = require('../runtime/owned-log.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');

const seed = crypto.randomBytes(32);
const privateObject = crypto.createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), type: 'pkcs8', format: 'der'});
const publicKey = crypto.createPublicKey(privateObject).export({type: 'spki', format: 'der'}).subarray(-32);
const publicKeyHex = publicKey.toString('hex');
const decision = index => ({decisionId: 'd-' + index, action: index % 3 ? 'allow' : 'block', reasons: ['synthetic'], timestamp: new Date(1700000000000 + index * 1000).toISOString(),
  actor: {agentId: 'agent', sessionId: 's-' + (index % 4)}, plugin: {event: 'decision', gate: 'spend', toolName: 'Read', toolUseId: 'u-' + index}});
let base = null, other = null;
async function build(make) {
  const rows = [];
  let previousHash = sdk.GENESIS_PREVIOUS_HASH;
  for (let sequence = 0; sequence < 24; sequence++) {
    const entry = await sdk.signDecision({sequence, decision: make(sequence), previousHash, privateKey: seed, publicKey});
    rows.push({...entry, publicKeyHex}); previousHash = entry.entryHash;
  }
  return rows;
}
async function chain(length) {
  if (!base) {
    base = await build(decision);
    // A second ledger signed by the same key: each of its rows is valid by itself.
    other = await build(index => ({...decision(index), decisionId: 'other-' + index}));
  }
  return structuredClone(base.slice(0, length));
}
const flip = hex => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);

// One change to a chain. `content` says whether it touches what a hash or a link covers.
const MUTATIONS = {
  none: {content: false, apply: () => {}},
  action: {content: true, apply: (rows, i) => { rows[i].decision.action = rows[i].decision.action === 'allow' ? 'block' : 'allow'; }},
  toolName: {content: true, apply: (rows, i) => { rows[i].decision.plugin.toolName = 'Write'; }},
  addedField: {content: true, apply: (rows, i) => { rows[i].decision.note = 'added'; }},
  removedField: {content: true, apply: (rows, i) => { delete rows[i].decision.reasons; }},
  sequence: {content: true, apply: (rows, i) => { rows[i].sequence += 1; }},
  previousHash: {content: true, apply: (rows, i) => { rows[i].previousHash = flip(rows[i].previousHash); }},
  entryHash: {content: true, apply: (rows, i) => { rows[i].entryHash = flip(rows[i].entryHash); }},
  entryHashShape: {content: true, apply: (rows, i) => { rows[i].entryHash = rows[i].entryHash.toUpperCase() + 'zz'; }},
  fingerprint: {content: true, apply: (rows, i) => { rows[i].signerFingerprint = flip(rows[i].signerFingerprint); }},
  noFingerprint: {content: true, apply: (rows, i) => { delete rows[i].signerFingerprint; }},
  builderCode: {content: true, apply: (rows, i) => { rows[i].builderCode = 'partner-1'; }},
  removeRow: {content: true, apply: (rows, i) => { if (i < rows.length - 1) rows.splice(i, 1); else rows[i].sequence += 1; }},
  duplicateRow: {content: true, apply: (rows, i) => { rows.splice(i, 0, structuredClone(rows[i])); }},
  swapRows: {content: true, apply: (rows, i) => { const j = i ? i - 1 : 1; if (rows.length < 2) rows[0].sequence = 5; else [rows[i], rows[j]] = [rows[j], rows[i]]; }},
  notARow: {content: true, apply: (rows, i) => { rows[i] = i % 2 ? null : ['row']; }},
  // A validly signed row of another ledger put in this one's place: only the links give it away.
  graft: {content: true, apply: (rows, i) => { rows[i] = structuredClone(other[i]); }},
  signature: {content: false, apply: (rows, i) => { rows[i].signature = flip(rows[i].signature); }},
  signatureOfAnotherRow: {content: false, apply: (rows, i) => { rows[i].signature = rows[i ? i - 1 : rows.length - 1].signature; if (rows.length === 1) rows[i].signature = flip(rows[i].signature); }},
  signatureShape: {content: false, apply: (rows, i) => { rows[i].signature = 'not hex'; }},
  recordedKey: {content: false, apply: (rows, i) => { rows[i].publicKeyHex = flip(rows[i].publicKeyHex); }},
};

function store(t, rows, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fast-start-'));
  const log = new OwnedLogStore('ledger', {home, publicKeyHex, ...options});
  fs.mkdirSync(path.dirname(log.filePath), {recursive: true});
  fs.writeFileSync(log.filePath, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const cleanup = () => { if (log.fd !== undefined && !log.closed) { log.closed = true; try { fs.closeSync(log.fd); } catch {} } fs.rmSync(home, {recursive: true, force: true}); };
  if (t) t.after(cleanup);
  return {log, home, cleanup};
}
// What the worker does with a ledger: 'start' (refused before ready), 'background' (refused straight after), 'accepted'.
async function verdict(rows, options) {
  const s = store(null, rows, options);
  try {
    try { await s.log.recover(publicKeyHex); } catch (error) { assert.match(error.message, /invalid_existing_chain/); return 'start'; }
    const check = await s.log.checkSignatures();
    if (check.ok === false) { assert.equal(fs.existsSync(s.log.signaturePath), true, 'a refusal leaves the note that holds the next start'); return 'background'; }
    assert.equal(check.ok, true); assert.equal(fs.existsSync(s.log.signaturePath), false);
    return 'accepted';
  } finally { s.cleanup(); }
}

test('S1 to S3: 1,000 generated ledgers, each with at most two changes, against the signing library', async () => {
  const names = Object.keys(MUTATIONS);
  const seen = {start: 0, background: 0, accepted: 0};
  await fc.assert(fc.asyncProperty(
    fc.integer({min: 1, max: 24}), fc.array(fc.tuple(fc.constantFrom(...names), fc.nat()), {minLength: 1, maxLength: 2}), fc.constantFrom(1, 2, 4, 8),
    async (length, changes, headSignatures) => {
      const rows = await chain(length);
      let content = false;
      for (const [name, at] of changes) {
        if (!rows.length) break;
        const index = at % rows.length, before = JSON.stringify(rows);
        // A second change aimed at a row the first one replaced with something that is not a row changes nothing.
        try { MUTATIONS[name].apply(rows, index); } catch (error) { if (!(error instanceof TypeError)) throw error; }
        if (MUTATIONS[name].content && JSON.stringify(rows) !== before) content = true;
      }
      const library = (await sdk.verifyChain(rows, publicKey)).ok === true;
      const ours = await verdict(rows, {headSignatures});
      seen[ours]++;
      // S1 and S2: the worker and the signing library agree on every ledger.
      assert.equal(ours === 'accepted', library, `library says ${library}, worker says ${ours}`);
      // S3: changed content is refused before the worker is ready.
      if (content && !library) assert.equal(ours, 'start', 'changed content reached a ready worker');
      // S5: a wrong newest signature never reaches a ready worker.
      if (rows.length && rows.at(-1) && typeof rows.at(-1) === 'object' && !(await sdk.verifyEntry(rows.at(-1), publicKey).catch(() => false))) assert.equal(ours, 'start');
    }), {numRuns: 1000});
  // The run has to reach all three outcomes, or it proved less than it says.
  for (const [outcome, count] of Object.entries(seen)) assert.ok(count >= 20, `${outcome} was reached only ${count} times`);
});

test('S3: every single change to content, at every position of a ledger longer than the default head, is refused at the start', async () => {
  const length = 24;
  assert.ok(HEAD_SIGNATURES >= 1);
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    if (!mutation.content) continue;
    for (let index = 0; index < length; index++) {
      const rows = await chain(length), before = JSON.stringify(rows);
      mutation.apply(rows, index);
      if (JSON.stringify(rows) === before) continue;
      assert.equal(await verdict(rows, {headSignatures: 2}), 'start', `${name} at row ${index}`);
    }
  }
});

test('S2 and S5: a wrong signature is refused at the start among the newest rows and by the background check before them', async () => {
  const length = 24, head = 4;
  for (const name of ['signature', 'signatureOfAnotherRow', 'signatureShape']) {
    for (let index = 0; index < length; index++) {
      const rows = await chain(length);
      MUTATIONS[name].apply(rows, index);
      assert.equal(await verdict(rows, {headSignatures: head}), index >= length - head ? 'start' : 'background', `${name} at row ${index}`);
    }
  }
  // The default never leaves the newest row unchecked, whatever is asked for.
  for (const asked of [0, -3, 1.5, 'many', null]) {
    const rows = await chain(24);
    MUTATIONS.signature.apply(rows, 23);
    assert.equal((await verifyLinks(rows, publicKey, asked)).ok, false, `head of ${asked}`);
  }
});

test('S1: the quick comparison never refuses a row the signing library accepts (legacy hash, builder code)', async () => {
  // A row hashed the older way, without the signer's fingerprint, and a row with a builder code: both valid.
  let previousHash = sdk.GENESIS_PREVIOUS_HASH;
  const rows = [];
  for (let sequence = 0; sequence < 6; sequence++) {
    let entry;
    if (sequence === 2) {
      const entryHash = sdk.computeEntryHash({sequence, decision: decision(sequence), previousHash});
      entry = {sequence, decision: decision(sequence), previousHash, entryHash, signerFingerprint: sdk.computeSignerFingerprint(publicKey),
        signature: crypto.sign(null, Buffer.from(entryHash, 'hex'), privateObject).toString('hex')};
    } else entry = await sdk.signDecision({sequence, decision: decision(sequence), previousHash, privateKey: seed, publicKey, ...(sequence === 4 ? {builderCode: 'partner-1'} : {})});
    rows.push({...entry, publicKeyHex}); previousHash = entry.entryHash;
  }
  assert.equal((await sdk.verifyChain(rows, publicKey)).ok, true);
  assert.equal(await verdict(rows, {headSignatures: 1}), 'accepted');
  // The same two rows with their content changed are refused at the start.
  for (const index of [2, 4]) {
    const changed = structuredClone(rows); changed[index].decision.action = 'block-changed';
    assert.equal(await verdict(changed, {headSignatures: 1}), 'start');
  }
  // The older way of hashing does not cover the signer's fingerprint or a builder code. A change to either on
  // such a row is refused at the start all the same, as the signing library refuses it.
  for (const change of [row => { row.signerFingerprint = flip(row.signerFingerprint); }, row => { row.builderCode = 'partner-1'; }, row => { delete row.signerFingerprint; }]) {
    const changed = structuredClone(rows); change(changed[2]);
    assert.equal((await sdk.verifyChain(changed, publicKey)).ok, false);
    assert.equal(await verdict(changed, {headSignatures: 1}), 'start');
  }
});

test('S4: after a refusal nothing is appended, later starts run the full check, and a ledger put right is accepted again', async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fast-start-engine-'));
  const previous = {PLUGIN_DATA: process.env.PLUGIN_DATA, AGENTGUARD_PLUGIN_POLICY: process.env.AGENTGUARD_PLUGIN_POLICY};
  process.env.PLUGIN_DATA = data; delete process.env.AGENTGUARD_PLUGIN_POLICY;
  const engines = [];
  t.after(() => {
    for (const engine of engines) if (engine.logStore && engine.logStore.fd !== undefined && !engine.logStore.closed) { engine.logStore.closed = true; fs.closeSync(engine.logStore.fd); }
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true});
  });
  const start = async () => { const engine = new Engine({logOptions: {headSignatures: 2}}); engines.push(engine); await engine.init(); return engine; };
  let n = 0;
  const call = engine => engine.handle({meta: metadata({tool_name: 'Read', session_id: 'fast-start', tool_use_id: 'call-' + n++, tool_input: {file_path: '/synthetic'}}, 'spend')});
  const first = await start();
  assert.deepEqual(await first.signatureCheck, {ok: true, rows: 0});
  for (let i = 0; i < 12; i++) await call(first);
  await first.flush(); first.logStore.closed = true; fs.closeSync(first.logStore.fd);
  const file = first.logStore.filePath, note = first.logStore.signaturePath, original = fs.readFileSync(file, 'utf8');
  const lines = original.trim().split('\n');
  assert.ok(lines.length >= 12);

  // A clean restart: ready at once, every signature confirmed straight after, and it appends.
  const clean = await start();
  assert.deepEqual(await clean.signatureCheck, {ok: true, rows: lines.length});
  await call(clean); await clean.flush(); clean.logStore.closed = true; fs.closeSync(clean.logStore.fd);
  const good = fs.readFileSync(file, 'utf8'), goodLines = good.trim().split('\n');
  assert.equal(goodLines.length, lines.length + 1);

  // One early signature damaged, content intact.
  const damaged = goodLines.map((line, index) => { if (index !== 3) return line; const row = JSON.parse(line); row.signature = flip(row.signature); return JSON.stringify(row); }).join('\n') + '\n';
  fs.writeFileSync(file, damaged); fs.rmSync(file + '.durable-head.json', {force: true});
  const bad = await start();
  assert.deepEqual(await bad.signatureCheck, {ok: false, sequence: 3});
  assert.deepEqual(JSON.parse(fs.readFileSync(note, 'utf8')), {reason: 'signature_invalid', sequence: 3});
  const before = fs.readFileSync(file, 'utf8');
  await call(bad).catch(() => {});
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after.filter(row => row.decision?.plugin?.toolUseId === 'call-' + (n - 1)).length, 0, 'a call was signed onto a ledger with a bad signature');
  assert.equal(fs.readFileSync(file, 'utf8').startsWith(before.slice(0, damaged.length)), true);
  bad.logStore.closed = true; fs.closeSync(bad.logStore.fd);

  // Every later start refuses it, as a start did before 0.7.4, and changes nothing.
  fs.writeFileSync(file, damaged);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(start(), /invalid_existing_chain/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
    assert.equal(fs.existsSync(note), true);
  }
  // Put right, it starts again and the note is gone.
  fs.writeFileSync(file, good); fs.rmSync(file + '.durable-head.json', {force: true});
  const repaired = await start();
  assert.equal(fs.existsSync(note), false);
  assert.deepEqual(await repaired.signatureCheck, {ok: true, rows: 0});
  await call(repaired); await repaired.flush();
  assert.equal((await sdk.verifyChain(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse), repaired.publicKey)).ok, true);
});

test('the background check gives way to waiting work and stops quietly when the worker closes', async t => {
  const rows = await chain(24);
  const s = store(t, rows, {headSignatures: 1, signatureSliceMs: 0});
  await s.log.recover(publicKeyHex);
  let turns = 0, running = true;
  const other = (async () => { while (running) { await new Promise(resolve => setImmediate(resolve)); turns++; } })();
  const check = await s.log.checkSignatures();
  running = false; await other;
  assert.deepEqual(check, {ok: true, rows: 24});
  assert.ok(turns >= 12, `other work ran only ${turns} times during the check`);
  const closing = store(t, await chain(24), {headSignatures: 1, signatureSliceMs: 0});
  await closing.log.recover(publicKeyHex);
  const pending = closing.log.checkSignatures();
  closing.log.closed = true; fs.closeSync(closing.log.fd);
  assert.deepEqual(await pending, {ok: null});
  assert.equal(fs.existsSync(closing.log.signaturePath), false);
});

test('a real worker: a bad signature found after the start stops it, and the next start refuses that ledger', async t => {
  const matrix = require('./helper-host-matrix.cjs');
  const common = require('../runtime/common.cjs');
  const client = require('../runtime/client.cjs');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fast-start-worker-'));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data);
  Object.assign(process.env, {AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_PLUGIN_POLICY: '', AGENTGUARD_HOME: path.join(data, 'burn')});
  const loc = common.locations(data);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (probe, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (probe()) return true; await sleep(10); } return probe(); };
  const lockPid = () => { try { return Number(fs.readFileSync(loc.lock, 'utf8')); } catch { return null; } };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const seenPids = new Set();
  t.after(async () => {
    for (const pid of [...seenPids, lockPid()]) if (pid && pid !== process.pid && alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await sleep(300);
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true}); fs.rmSync(loc.ipc, {recursive: true, force: true});
  });
  // A ledger longer than the rows checked before the start, written by a real engine.
  const engine = new Engine(); await engine.init();
  for (let i = 0; i < HEAD_SIGNATURES + 8; i++) await engine.handle({meta: metadata({tool_name: 'Read', session_id: 'fast-start-worker', tool_use_id: 'seed-' + i, tool_input: {file_path: '/synthetic'}}, 'spend')});
  await engine.flush(); engine.logStore.closed = true; fs.closeSync(engine.logStore.fd);
  const file = engine.logStore.filePath, note = engine.logStore.signaturePath;
  const good = fs.readFileSync(file, 'utf8');
  const damaged = good.trim().split('\n').map((line, index) => { if (index !== 3) return line; const row = JSON.parse(line); row.signature = flip(row.signature); return JSON.stringify(row); }).join('\n') + '\n';
  fs.writeFileSync(file, damaged); fs.rmSync(file + '.durable-head.json', {force: true});
  const call = id => client.request({meta: metadata({tool_name: 'Read', session_id: 'fast-start-worker', tool_use_id: id, tool_input: {file_path: '/synthetic'}, hook_event_name: 'PreToolUse'}, 'spend')}, {data, timeoutMs: 10000});

  // The worker starts (content, hashes and links are intact), then finds the bad signature and stops itself.
  await call('first').catch(() => {});
  const started = lockPid(); if (started) seenPids.add(started);
  assert.equal(await until(() => fs.existsSync(note)), true, 'the background check left no note');
  assert.deepEqual(JSON.parse(fs.readFileSync(note, 'utf8')), {reason: 'signature_invalid', sequence: 3});
  assert.equal(await until(() => lockPid() === null && (!started || !alive(started))), true, 'the worker kept running on a ledger with a bad signature');
  // Every later start refuses it: no worker becomes ready, the call is not answered, the ledger is not touched.
  const after = fs.readFileSync(file, 'utf8');
  await assert.rejects(client.request({meta: metadata({tool_name: 'Read', session_id: 'fast-start-worker', tool_use_id: 'second', tool_input: {file_path: '/synthetic'}, hook_event_name: 'PreToolUse'}, 'spend')}, {data, timeoutMs: 4000}), /worker_timeout/);
  const second = lockPid(); if (second) seenPids.add(second);
  await until(() => !second || !alive(second), 10000);
  assert.equal(client.workerReady(loc), false);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.equal(fs.existsSync(note), true);
  // With the ledger put right, a worker starts, answers, and the note is gone.
  try { fs.unlinkSync(loc.lock); } catch {}
  fs.writeFileSync(file, good); fs.rmSync(file + '.durable-head.json', {force: true});
  const answer = await call('third');
  assert.ok(answer && typeof answer === 'object');
  const third = lockPid(); if (third) seenPids.add(third);
  assert.equal(fs.existsSync(note), false);
  assert.equal(client.workerReady(loc), true);
  await client.request({control: 'stop'}, {data, startWorker: false, timeoutMs: 4000, noSwitch: true}).catch(() => {});
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.decision?.plugin?.toolUseId === 'third'));
  assert.equal((await sdk.verifyChain(rows, Buffer.from(rows[0].publicKeyHex, 'hex'))).ok, true);
});
