'use strict';
// The ledger readers stopped working above 64 MB or 100,000 rows through 0.7.0: status, work receipts, verification,
// export and attestation all failed while the hooks kept signing. They now read the ledger in one bounded pass.
//
// Guarantees held here:
//   R1  Every row is read, in order, exactly once, whatever the block size and wherever a row is cut by a block.
//   R2  A line that cannot be decoded, or that is longer than a row can be, fails the read. Nothing is skipped.
//   R3  A read is a snapshot taken at open: a row appended during the read is not in it and is not an error;
//       a file cut or replaced during the read is an error; a strict read fails on any change at all.
//   R4  The row by row chain check gives the same answer as the signing library's whole-chain check, for every chain.
//   R5  The read-only server answers above the old 64 MB and 100,000 row limits.
//   R6  A reader failure is named to the caller; anything else stays behind the general message.
//   R7  The status band's read takes the newest rows from the end of the file: the same rows a whole read would
//       end with, at a cost that does not grow with the ledger (0.7.2; through 0.7.1 it read the whole ledger five
//       times per redraw).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {generateKeyPairSync, createHash} = require('node:crypto');
const fc = require('fast-check');
const sdk = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/spend');
const {scanLedger, scanLedgerSync, readLedgerTail, createChainCheck, LedgerReadError} = require('../runtime/ledger-scan.cjs');
const {createReader, handleRpc} = require('../runtime/mcp.cjs');

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-ledger-scan-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
const code = async promise => { try { await promise; return null; } catch (error) { return error instanceof LedgerReadError ? error.code : `other:${error.message}`; } };
const collect = async (file, options) => { const seen = []; const read = await scanLedger(file, text => { seen.push(text); }, options); return {seen, read}; };
// What the old whole-file reader saw: every line that is not blank, in order.
const reference = bytes => bytes.toString('utf8').split('\n').filter(line => line.trim());

test('R1: 1,000 generated ledgers read the same rows as a whole-file read, at every block size, with and without waiting', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  const line = fc.oneof(
    fc.string({minLength: 1, maxLength: 40}).map(text => JSON.stringify({text})),
    fc.constantFrom('', ' ', '\t', '{"snow":"☃☃"}', '{"long":"' + 'x'.repeat(200) + '"}', '{"emoji":"😀"}'));
  await fc.assert(fc.asyncProperty(fc.array(line, {maxLength: 30}), fc.integer({min: 1, max: 64}), fc.boolean(), async (rows, chunkBytes, finalNewline) => {
    const bytes = Buffer.from(rows.join('\n') + (finalNewline && rows.length ? '\n' : ''));
    fs.writeFileSync(file, bytes);
    const want = reference(bytes);
    const {seen, read} = await collect(file, {chunkBytes});
    assert.deepEqual(seen, want);
    assert.equal(read.rows, want.length); assert.equal(read.bytes, bytes.length); assert.equal(read.missing, false);
    const seenSync = []; const readSync = scanLedgerSync(file, text => { seenSync.push(text); }, {chunkBytes});
    assert.deepEqual(seenSync, want); assert.equal(readSync.rows, want.length);
    // A reader that refuses blank lines fails exactly when the old attestation reader failed: any line that is blank
    // once the single newline at the very end is set aside.
    const text = bytes.toString('utf8'), strictLines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    const hasBlank = strictLines.some(item => !item.trim());
    assert.equal(await code(scanLedger(file, () => {}, {chunkBytes, blankLines: 'error'})), hasBlank ? 'invalid_text' : null);
  }), {numRuns: 1000, seed: 20261125});
});

test('R1: a row cut by a block at every possible place is still one row', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  const rows = ['{"a":"' + 'é'.repeat(9) + '"}', '{"b":2}', '{"c":"' + 'z'.repeat(31) + '"}'];
  fs.writeFileSync(file, rows.join('\n') + '\n');
  for (let chunkBytes = 1; chunkBytes <= 80; chunkBytes++) assert.deepEqual((await collect(file, {chunkBytes})).seen, rows, `block of ${chunkBytes}`);
});

test('R2: undecodable text and an oversized line fail the read, and a missing file is reported as missing', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  assert.deepEqual({...(await scanLedger(file, () => assert.fail('no rows'))), unchanged: undefined}, {missing: true, rows: 0, bytes: 0, stat: null, unchanged: undefined});
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"ok":1}\n'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), Buffer.from('\n{"ok":2}\n')]));
  const seen = [];
  assert.equal(await code(scanLedger(file, text => { seen.push(text); })), 'invalid_text');
  assert.deepEqual(seen, ['{"ok":1}'], 'the read stops at the bad line; the caller never gets a shortened ledger back');
  fs.writeFileSync(file, '{"ok":1}\n' + 'y'.repeat(65) + '\n');
  assert.equal(await code(scanLedger(file, () => {}, {maxRowBytes: 64, chunkBytes: 16})), 'row_too_large');
  assert.equal(await code(scanLedger(file, () => {}, {maxRowBytes: 65, chunkBytes: 16})), null);
  fs.writeFileSync(file, '{"ok":1}\n' + 'y'.repeat(70));
  assert.equal(await code(scanLedger(file, () => {}, {maxRowBytes: 64, chunkBytes: 16})), 'row_too_large', 'a last line with no newline is held to the same limit');
  fs.rmSync(file); fs.mkdirSync(file);
  assert.equal(await code(scanLedger(file, () => {})), 'unreadable');
  // A caller's own failure passes through untouched.
  fs.rmdirSync(file); fs.writeFileSync(file, 'not json\n');
  assert.equal(await code(scanLedger(file, text => { JSON.parse(text); })).then(value => value.startsWith('other:')), true);
});

test('R3: a read is the snapshot taken at open', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  const rows = Array.from({length: 50}, (_, i) => JSON.stringify({i}));
  const reset = () => fs.writeFileSync(file, rows.join('\n') + '\n');
  // Appended during the read: not in the read, and not an error.
  reset();
  const seen = [];
  const read = await scanLedger(file, text => { seen.push(text); if (seen.length === 1) fs.appendFileSync(file, '{"late":true}\n'); }, {chunkBytes: 32});
  assert.deepEqual(seen, rows); assert.equal(read.rows, 50);
  read.unchanged();
  // The same append under a strict read is a change.
  reset();
  let first = true;
  assert.equal(await code(scanLedger(file, () => { if (first) { first = false; fs.appendFileSync(file, '{"late":true}\n'); } }, {chunkBytes: 32, strict: true})), 'changed');
  // Cut during the read.
  reset(); first = true;
  assert.equal(await code(scanLedger(file, () => { if (first) { first = false; fs.truncateSync(file, 40); } }, {chunkBytes: 32})), 'changed');
  // Replaced by another file during the read.
  reset(); first = true;
  assert.equal(await code(scanLedger(file, () => { if (first) { first = false; fs.writeFileSync(file + '.new', rows.join('\n') + '\n'); fs.renameSync(file + '.new', file); } }, {chunkBytes: 32})), 'changed');
  // Changed after the read: the handle the reader returned says so. A strict one objects to a plain append too.
  reset();
  const plain = await scanLedger(file, () => {}), strict = await scanLedger(file, () => {}, {strict: true});
  plain.unchanged(); strict.unchanged();
  fs.appendFileSync(file, '{"late":true}\n');
  plain.unchanged();
  assert.throws(() => strict.unchanged(), error => error.code === 'changed');
  fs.truncateSync(file, 10);
  assert.throws(() => plain.unchanged(), error => error.code === 'changed');
  // Two passes standing for one snapshot: the second must open the very file the first one saw.
  reset();
  const one = scanLedgerSync(file, () => {});
  assert.equal(await code(scanLedger(file, () => {}, {expect: one.stat, strict: true})), null);
  fs.appendFileSync(file, '{"late":true}\n');
  assert.equal(await code(scanLedger(file, () => {}, {expect: one.stat, strict: true})), 'changed');
  fs.rmSync(file);
  assert.equal(await code(scanLedger(file, () => {}, {expect: one.stat})), 'changed');
});

async function signedChain(length) {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32);
  const publicKey = keys.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  const entries = [];
  for (let sequence = 0; sequence < length; sequence++) {
    entries.push(await sdk.signDecision({sequence, previousHash: entries.at(-1)?.entryHash ?? sdk.GENESIS_PREVIOUS_HASH, privateKey, publicKey,
      decision: {decisionId: `d-${sequence}`, timestamp: new Date(Date.UTC(2026, 10, 25, 0, 0, sequence)).toISOString(), action: 'allow', projectedCents: sequence}}));
  }
  return {entries, publicKey, privateKey};
}
async function streamed(entries, publicKey) {
  const check = createChainCheck(sdk, publicKey);
  for (const entry of entries) await check.push(entry);
  return check.result();
}

test('R4: the row by row chain check agrees with the library on 1,000 damaged, reordered and cut chains', async () => {
  const {entries, publicKey} = await signedChain(24), other = await signedChain(4);
  assert.deepEqual(await streamed(entries, publicKey), {ok: true});
  assert.deepEqual(await streamed([], publicKey), await sdk.verifyChain([], publicKey));
  const hex = fc.constantFrom('0', 'f', 'a');
  const mutation = fc.oneof(
    fc.record({kind: fc.constant('drop'), at: fc.nat(23)}),
    fc.record({kind: fc.constant('duplicate'), at: fc.nat(23)}),
    fc.record({kind: fc.constant('swap'), at: fc.nat(22)}),
    fc.record({kind: fc.constant('cut'), at: fc.nat(24)}),
    fc.record({kind: fc.constant('skipStart'), at: fc.integer({min: 1, max: 23})}),
    fc.record({kind: fc.constant('field'), at: fc.nat(23), field: fc.constantFrom('sequence', 'previousHash', 'entryHash', 'signature', 'signerFingerprint', 'cents', 'action', 'id'), value: hex}),
    fc.record({kind: fc.constant('foreign'), at: fc.nat(23), from: fc.nat(3)}),
    fc.record({kind: fc.constant('hole'), at: fc.nat(23), value: fc.constantFrom(null, {}, {sequence: 3})}));
  const apply = (chain, m) => {
    if (m.kind === 'drop') chain.splice(m.at, 1);
    else if (m.kind === 'duplicate') chain.splice(m.at, 0, chain[m.at]);
    else if (m.kind === 'swap') [chain[m.at], chain[m.at + 1]] = [chain[m.at + 1], chain[m.at]];
    else if (m.kind === 'cut') chain.length = Math.min(chain.length, m.at);
    else if (m.kind === 'skipStart') chain.splice(0, Math.min(m.at, chain.length));
    else if (m.kind === 'foreign') { if (chain[m.at]) chain[m.at] = other.entries[m.from]; }
    else if (m.kind === 'hole') { if (m.at < chain.length) chain[m.at] = m.value; }
    else if (chain[m.at]) {
      const entry = JSON.parse(JSON.stringify(chain[m.at]));
      if (m.field === 'sequence') entry.sequence += m.value === '0' ? 1 : m.value === 'f' ? -1 : 100;
      else if (m.field === 'cents') entry.decision.projectedCents += 1;
      else if (m.field === 'action') entry.decision.action = 'block';
      else if (m.field === 'id') entry.decision.decisionId += m.value;
      else entry[m.field] = m.value + entry[m.field].slice(1);
      chain[m.at] = entry;
    }
  };
  let differing = 0, broken = 0;
  await fc.assert(fc.asyncProperty(fc.array(mutation, {minLength: 0, maxLength: 3}), async mutations => {
    const chain = [...entries];
    for (const m of mutations) apply(chain, m);
    let want, threw = false;
    // A hole after the first row makes the library read a field of nothing only when an earlier check has not
    // already failed; the row by row check must then fail too, and never report such a chain as valid.
    try { want = await sdk.verifyChain(chain, publicKey); } catch { threw = true; }
    const got = await streamed(chain, publicKey);
    if (threw) { assert.equal(got.ok, false); differing++; return; }
    assert.deepEqual(got, want);
    if (!want.ok) broken++;
  }), {numRuns: 1000, seed: 20261125});
  assert.ok(broken > 500, `most generated chains are broken ones (${broken})`);
  assert.ok(differing < 50, `cases where the library itself throws are rare (${differing})`);
});

// A schema-valid row with a made-up signature. Listing and status do not check signatures, so a large ledger can be
// written in a second. Chain verification on it fails at the first row, which is a result, not a read failure.
function unsignedRow(sequence, publicKeyHex, timestamp, signerFingerprint) {
  const hash = sequence.toString(16).padStart(64, '0');
  return JSON.stringify({sequence, previousHash: (sequence ? sequence - 1 : 0).toString(16).padStart(64, '0'), entryHash: hash, signature: 'ab'.repeat(64),
    signerFingerprint, publicKeyHex,
    decision: {decisionId: `synthetic-decision-${sequence}`, timestamp, action: sequence % 10 === 0 ? 'block' : 'allow', triggeredCap: null, triggeredScopeKey: null,
      projectedCents: 2, windowSpendBefore: 0, windowSpendAfter: 0, provider: 'imanage', modelRequested: 'save_document', modelResolved: 'save_document',
      policyId: 'synthetic-policy', policyVersion: 1, enforcementMode: 'enforce', reasons: ['Synthetic fixture decision.'],
      actor: {agentId: 'synthetic-agent', sessionId: 'synthetic-session'},
      plugin: {schema: 'agentguard.codex.v1', event: 'decision', toolName: 'mcp__imanage__save_document', inputSha256: '0'.repeat(64), inputBytes: 21, gate: 'spend',
        host: 'codex', sessionId: 'synthetic-session', toolUseId: `call-${sequence}`}}});
}

test('R5: the read-only server answers on a ledger above the old 64 MB and 100,000 row limits', async t => {
  const dataDir = scratch(t), file = path.join(dataDir, 'ledger', 'decisions.ndjson');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  // Dated two days back: the health reader works through every row of the last hour, and that is not what is measured here.
  const publicKeyHex = 'ef'.repeat(32), now = new Date(Date.now() - 2 * 86400000).toISOString(), ROWS = 110000;
  // The rows name the right signer, so the chain check reaches the signature itself and fails there.
  const fingerprint = createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKeyHex);
  const fd = fs.openSync(file, 'w');
  for (let start = 0; start < ROWS; start += 5000) {
    let block = '';
    for (let sequence = start; sequence < Math.min(ROWS, start + 5000); sequence++) block += unsignedRow(sequence, publicKeyHex, now, fingerprint) + '\n';
    fs.writeSync(fd, block);
  }
  fs.closeSync(fd);
  const size = fs.statSync(file).size;
  assert.ok(size > 64 * 1024 * 1024, `the ledger is above the old byte limit (${size})`);
  const reader = createReader({dataDir, workerStatus: async () => { throw new Error('no worker'); }});
  const first = await reader.call('list_decisions', {limit: 3});
  assert.equal(first.totalEntries, ROWS);
  assert.deepEqual(first.entries.map(entry => entry.sequence), [0, 1, 2]); assert.equal(first.nextSequence, 3);
  const last = await reader.call('list_decisions', {fromSequence: ROWS - 2, limit: 200});
  assert.deepEqual(last.entries.map(entry => entry.sequence), [ROWS - 2, ROWS - 1]); assert.equal(last.nextSequence, null);
  const exact = await reader.call('list_decisions', {fromSequence: ROWS - 200, limit: 200});
  assert.equal(exact.entries.length, 200); assert.equal(exact.nextSequence, null, 'a page that ends on the last row has no next page');
  const status = await reader.call('get_status', {day: now.slice(0, 10), sessionId: 'synthetic-session'});
  assert.equal(status.totalEntries, ROWS); assert.equal(status.decisions, ROWS);
  assert.equal(status.blocks, ROWS / 10); assert.equal(status.spendCents, (ROWS - ROWS / 10) * 2);
  assert.deepEqual({...status.hosts}, {codex: ROWS}); assert.equal(status.host, 'codex');
  // The chain check runs over the whole file and reports the first bad row, here the very first one.
  const verification = await reader.call('verify_chain', {});
  assert.equal(verification.ok, false); assert.equal(verification.sequence, 0); assert.equal(verification.entries, ROWS);
  assert.equal(verification.lastEntryHash, (ROWS - 1).toString(16).padStart(64, '0'));
  assert.equal((await reader.latestWorkReceipt('synthetic-session')), null);
  // Memory: the whole ledger was read several times and none of it is held.
  if (global.gc) global.gc();
  assert.ok(process.memoryUsage().heapUsed < 400 * 1024 * 1024);
});

test('R5: a signed ledger verifies row by row, and one changed row anywhere is found', async t => {
  const dataDir = scratch(t), file = path.join(dataDir, 'ledger', 'decisions.ndjson');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const {entries, publicKey} = await signedChain(600), publicKeyHex = publicKey.toString('hex');
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKeyHex);
  const rows = entries.map(entry => JSON.stringify({...entry, publicKeyHex}));
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const reader = createReader({dataDir});
  assert.deepEqual(await reader.call('verify_chain', {}), {ok: true, entries: 600, publicKeyHex, lastEntryHash: entries.at(-1).entryHash});
  for (const at of [0, 299, 599]) {
    const damaged = [...rows]; damaged[at] = damaged[at].replace(`"projectedCents":${at}`, `"projectedCents":${at + 1}`);
    assert.notEqual(damaged[at], rows[at]);
    fs.writeFileSync(file, damaged.join('\n') + '\n');
    const result = await reader.call('verify_chain', {});
    assert.deepEqual([result.ok, result.sequence, result.entries], [false, at, 600], `row ${at}`);
  }
  fs.writeFileSync(file, [...rows.slice(0, 100), ...rows.slice(101)].join('\n') + '\n');
  assert.deepEqual((r => [r.ok, r.sequence, r.entries])(await reader.call('verify_chain', {})), [false, 101, 599]);
  // A row from another signer is an error, as it always was, wherever it sits.
  const foreign = await signedChain(1);
  fs.writeFileSync(file, [...rows, JSON.stringify(foreign.entries[0])].join('\n') + '\n');
  await assert.rejects(reader.call('verify_chain', {}), /Ledger signer does not match/);
  // No key file: the key is the first row's, and an empty ledger with no key is valid and empty.
  fs.rmSync(path.join(dataDir, 'public-key.hex')); fs.writeFileSync(file, rows.join('\n') + '\n');
  assert.equal((await reader.call('verify_chain', {})).ok, true);
  fs.writeFileSync(file, '');
  assert.deepEqual(await reader.call('verify_chain', {}), {ok: true, entries: 0, publicKeyHex: null, lastEntryHash: null});
  fs.rmSync(file);
  assert.deepEqual(await reader.call('verify_chain', {}), {ok: true, entries: 0, publicKeyHex: null, lastEntryHash: null});
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), 'not a key');
  await assert.rejects(reader.call('verify_chain', {}), /Public verification key is missing or invalid/);
});

test('R6: a reader failure is named to the caller, and nothing else is', async t => {
  const dataDir = scratch(t), file = path.join(dataDir, 'ledger', 'decisions.ndjson');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const reader = createReader({dataDir});
  const ask = async name => (await handleRpc({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name}}, reader)).result;
  fs.writeFileSync(file, '{"sequence":0,"private":"fixture-secret-value"\n');
  let result = await ask('list_decisions');
  assert.equal(result.isError, true); assert.equal(result.content[0].text, 'Request failed: Ledger contains malformed JSON.');
  fs.writeFileSync(file, JSON.stringify({sequence: 0, surprise: 'fixture-secret-value'}) + '\n');
  result = await ask('verify_chain');
  assert.equal(result.content[0].text, 'Request failed: Ledger entry schema is invalid.');
  fs.writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
  assert.equal((await ask('get_status')).content[0].text, 'Request failed: Ledger contains malformed JSON.');
  for (const reply of [result, await ask('get_status')]) assert.ok(!JSON.stringify(reply).includes('fixture-secret-value'), 'no file content reaches the caller');
  // An error that is not one of the reader's own stays behind the general message.
  const broken = {call: async () => { throw new Error('ENOENT: /private/path/fixture-secret-value'); }};
  const hidden = (await handleRpc({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'verify_chain'}}, broken)).result;
  assert.equal(hidden.content[0].text, 'Request failed: check the tool arguments, ledger integrity, and the public verification key locally.');
});

// Found by an independent review of the streaming reader, each reproduced here before it was fixed.
test('R2: a byte-order mark in front of a row is not quietly removed', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"a":1}\n'), bom, Buffer.from('{"b":2}\n')]));
  const seen = [];
  await scanLedger(file, text => { seen.push(text); });
  assert.deepEqual(seen, ['{"a":1}', '﻿{"b":2}'], 'the mark stays in the text, so the row does not parse');
  assert.throws(() => JSON.parse(seen[1]));
  // Through the reader: a correctly signed row with a mark in front of it fails the read, as it did before.
  const dataDir = scratch(t), ledger = path.join(dataDir, 'ledger', 'decisions.ndjson');
  fs.mkdirSync(path.dirname(ledger), {recursive: true});
  const {entries, publicKey} = await signedChain(3), publicKeyHex = publicKey.toString('hex');
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKeyHex);
  const rows = entries.map(entry => Buffer.from(JSON.stringify({...entry, publicKeyHex}) + '\n'));
  fs.writeFileSync(ledger, Buffer.concat([rows[0], bom, rows[1], rows[2]]));
  await assert.rejects(createReader({dataDir}).call('verify_chain', {}), /Ledger contains malformed JSON/);
  fs.writeFileSync(ledger, Buffer.concat([bom, ...rows]));
  await assert.rejects(createReader({dataDir}).call('list_decisions', {}), /Ledger contains malformed JSON/);
});

test('R4: rows out of their order in the file do not verify, whatever their sequence numbers say', async t => {
  const dataDir = scratch(t), file = path.join(dataDir, 'ledger', 'decisions.ndjson');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const {entries, publicKey} = await signedChain(4), publicKeyHex = publicKey.toString('hex');
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKeyHex);
  const rows = entries.map(entry => JSON.stringify({...entry, publicKeyHex}));
  // Every row is genuine and every sequence number is present; only the order on disk is wrong. Through 0.7.0 the
  // read-only server sorted rows by sequence first and called this valid. The file is the record, so it is not.
  fs.writeFileSync(file, [rows[0], rows[2], rows[1], rows[3]].join('\n') + '\n');
  const result = await createReader({dataDir}).call('verify_chain', {});
  assert.deepEqual([result.ok, result.sequence, result.entries], [false, 2, 4]);
});

test('R3: a work receipt is only reported with the chain it is a row of', async t => {
  const dataDir = scratch(t), file = path.join(dataDir, 'ledger', 'decisions.ndjson');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32), publicKey = keys.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  const publicKeyHex = publicKey.toString('hex');
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKeyHex);
  const {RECEIPT_EVENT} = require('../runtime/work-receipt.cjs');
  const base = {timestamp: new Date().toISOString(), action: 'allow', triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0,
    provider: 'codex', modelRequested: 'm', modelResolved: 'm', policyId: 'p', policyVersion: 1, enforcementMode: 'enforce', reasons: ['r'], actor: {agentId: 'a', sessionId: 's-1'}};
  const chain = async decisions => {
    const out = [];
    for (const decision of decisions) out.push(JSON.stringify({...await sdk.signDecision({sequence: out.length, previousHash: out.length ? JSON.parse(out.at(-1)).entryHash : sdk.GENESIS_PREVIOUS_HASH, decision, privateKey, publicKey}), publicKeyHex}));
    return out.join('\n') + '\n';
  };
  const plain = n => ({...base, decisionId: `d-${n}`, plugin: {schema: 'agentguard.codex.v1', event: 'decision', toolName: 'Read', gate: 'spend', host: 'codex', sessionId: 's-1', toolUseId: `c-${n}`}});
  // The real ledger has a work receipt for session s-1. The replacement is a valid chain by the same signer with none.
  const reader = createReader({dataDir});
  const built = require('../runtime/work-receipt.cjs');
  const receipt = built.buildReceipt({counts: new built.SessionTally().counts('s-1'), cursor: null, view: null, burnPolicyMode: 'enforce', pluginVersion: '0.7.1'});
  const withReceipt = await chain([plain(0), {...base, decisionId: 'receipt-1', plugin: {schema: 'agentguard.codex.v1', event: RECEIPT_EVENT, gate: 'control', host: 'codex', sessionId: 's-1', toolUseId: 'receipt-1', receipt}}]);
  const without = await chain([plain(0), plain(1), plain(2)]);
  fs.writeFileSync(file, withReceipt);
  const found = await reader.call('get_work_receipt', {sessionId: 's-1'});
  assert.equal(found.found, true); assert.equal(found.chain.verified, true);
  // Swap the file between the reader's first open (which finds the receipt) and its second (which checks the chain).
  const realOpen = fs.openSync; let opens = 0;
  fs.openSync = (target, ...rest) => {
    if (target === file && ++opens === 2) fs.writeFileSync(file, without);
    return realOpen(target, ...rest);
  };
  try { await assert.rejects(reader.call('get_work_receipt', {sessionId: 's-1'}), /Ledger changed while reading; retry/); }
  finally { fs.openSync = realOpen; }
  assert.equal(opens, 2);
});

// What a whole read ends with: the lines that are not blank, without a last line the writer has not finished.
const finished = bytes => {
  const text = bytes.toString('utf8');
  return reference(Buffer.from(text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1)));
};

test('R7: 1,000 generated ledgers: the tail is what a whole read ends with, at every block size and row limit', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  const line = fc.oneof(
    fc.string({minLength: 1, maxLength: 40}).map(text => JSON.stringify({text})),
    fc.constantFrom('', ' ', '{"snow":"☃☃"}', '{"long":"' + 'x'.repeat(200) + '"}', '{"keep":true}', '{"keep":true,"n":2}'));
  fc.assert(fc.property(fc.array(line, {maxLength: 30}), fc.integer({min: 1, max: 64}), fc.integer({min: 1, max: 12}), fc.boolean(), fc.boolean(), (rows, chunkBytes, maxRows, finalNewline, filter) => {
    const bytes = Buffer.from(rows.join('\n') + (finalNewline && rows.length ? '\n' : ''));
    fs.writeFileSync(file, bytes);
    const match = filter ? text => text.includes('"keep"') : null;
    const all = finished(bytes).filter(text => !match || match(text));
    const read = readLedgerTail(file, {maxRows, chunkBytes, match});
    assert.deepEqual(read.lines, all.slice(-maxRows));
    // reachedStart is only claimed when nothing before the returned rows was left unread.
    if (read.reachedStart) assert.equal(read.lines.length, all.length);
    if (all.length > maxRows) assert.equal(read.reachedStart, false);
    assert.ok(read.bytes <= bytes.length);
  }), {numRuns: 1000, seed: 20261125});
});

test('R7: the tail of a ledger above the old limits costs a few blocks, not the file', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  const fd = fs.openSync(file, 'w');
  for (let start = 0; start < 110000; start += 5000) {
    let block = '';
    for (let sequence = start; sequence < start + 5000; sequence++) block += unsignedRow(sequence, 'ef'.repeat(32), '2026-11-25T00:00:00.000Z', 'cd'.repeat(8)) + '\n';
    fs.writeSync(fd, block);
  }
  fs.closeSync(fd);
  const size = fs.statSync(file).size;
  assert.ok(size > 64 * 1024 * 1024);
  const read = readLedgerTail(file, {maxRows: 400});
  assert.equal(read.lines.length, 400);
  assert.deepEqual([JSON.parse(read.lines[0]).sequence, JSON.parse(read.lines[399]).sequence], [109600, 109999]);
  assert.equal(read.reachedStart, false);
  assert.ok(read.bytes <= 2 * 1024 * 1024, `read ${read.bytes} of ${size} bytes`);
  // A row the writer is in the middle of is left out, and is not damage.
  fs.appendFileSync(file, '{"sequence":110000,"half":');
  const during = readLedgerTail(file, {maxRows: 3});
  assert.deepEqual(during.lines.map(text => JSON.parse(text).sequence), [109997, 109998, 109999]);
  // A search stops after maxBytes and says it did not reach the start.
  const none = readLedgerTail(file, {maxRows: 1, maxBytes: 3 * 1024 * 1024, match: text => text.includes('"no-such-row"')});
  assert.deepEqual([none.lines, none.reachedStart], [[], false]);
  assert.ok(none.bytes <= 4 * 1024 * 1024);
  // Through the reader: the band's numbers, with no pass over the file.
  const dataDir = scratch(t);
  fs.mkdirSync(path.join(dataDir, 'ledger')); fs.truncateSync(file, size); fs.renameSync(file, path.join(dataDir, 'ledger', 'decisions.ndjson'));
  const newest = createReader({dataDir}).tail(400);
  assert.deepEqual([newest.totalEntries, newest.entries.length, newest.entries.at(-1).sequence, newest.complete], [110000, 400, 109999, false]);
});

test('R7: undecodable text, an oversized line and a missing file in the tail', async t => {
  const directory = scratch(t), file = path.join(directory, 'decisions.ndjson');
  assert.deepEqual(readLedgerTail(file), {missing: true, lines: [], reachedStart: true, bytes: 0});
  fs.writeFileSync(file, '');
  assert.deepEqual(readLedgerTail(file), {missing: false, lines: [], reachedStart: true, bytes: 0});
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"ok":1}\n'), Buffer.from([0x7b, 0xff, 0x7d]), Buffer.from('\n{"ok":2}\n')]));
  assert.deepEqual(readLedgerTail(file, {maxRows: 1}).lines, ['{"ok":2}'], 'rows that are not asked for are not read');
  assert.throws(() => readLedgerTail(file, {maxRows: 2}), error => error.code === 'invalid_text');
  fs.writeFileSync(file, '{"ok":1}\n' + 'y'.repeat(200) + '\n{"ok":2}\n');
  assert.throws(() => readLedgerTail(file, {maxRows: 3, maxRowBytes: 64, chunkBytes: 16}), error => error.code === 'row_too_large');
  assert.deepEqual(readLedgerTail(file, {maxRows: 3, maxRowBytes: 200, chunkBytes: 16}).lines.length, 3);
  // A byte-order mark stays in the text, as in the full read.
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":1}\n')]));
  assert.throws(() => JSON.parse(readLedgerTail(file).lines[0]));
  const dataDir = scratch(t); fs.mkdirSync(path.join(dataDir, 'ledger')); fs.writeFileSync(path.join(dataDir, 'ledger', 'decisions.ndjson'), '{"not":"a row"}\n');
  assert.throws(() => createReader({dataDir}).tail(5), /Ledger entry schema is invalid/);
  fs.writeFileSync(path.join(dataDir, 'ledger', 'decisions.ndjson'), 'not json\n');
  assert.throws(() => createReader({dataDir}).tail(5), /Ledger contains malformed JSON/);
  fs.rmSync(path.join(dataDir, 'ledger', 'decisions.ndjson'));
  assert.deepEqual(createReader({dataDir}).tail(5), {entries: [], last: null, totalEntries: 0, complete: true});
});
