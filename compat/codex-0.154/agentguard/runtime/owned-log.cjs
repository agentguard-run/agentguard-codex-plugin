'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { NdjsonDecisionLogStore, SequenceConflictError, GENESIS_PREVIOUS_HASH, computeSignerFingerprint, computeEntryHash, verifyEntry, verifyChain } = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
const sameFile = (left, right) => ['ino', 'dev', 'size', 'mtimeNs'].every(field => left[field] === right[field]);
const syncFd = fd => new Promise((resolve, reject) => fs.fdatasync(fd, error => error ? reject(error) : resolve()));

// How an existing ledger is checked when a worker starts.
//
// Before the worker is ready, every row's hash is worked out again from its
// content and every link to the row before it is followed, and the signatures
// of the newest rows are checked. A row whose content was changed no longer
// matches its own hash; a hash changed to match no longer matches the link in
// the next row; and so on to the newest row, whose signature cannot be made
// without the key. So changed content never gets past the start, at about a
// hundredth of the cost of checking every signature (11 against 735
// microseconds a row, measured Nov 25 2026: a 434,000 row ledger starts in
// 9 seconds, where checking every signature first left every call unchecked
// for about six minutes).
//
// Every signature is still checked, with the signing library's own check, in
// the background straight after the start (checkSignatures). A bad one stops
// the worker, and a note beside the ledger holds every later start on the
// full check, which refuses that ledger as it always did.
const HEAD_SIGNATURES = 32;   // newest rows whose signatures are checked before the worker is ready
const SLICE_MS = 8;           // background checking gives way to waiting calls this often
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function verifyLinks(entries, publicKey, headSignatures = HEAD_SIGNATURES) {
  const fingerprint = computeSignerFingerprint(publicKey);
  let previous = GENESIS_PREVIOUS_HASH;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {ok: false, sequence: index};
    if (entry.sequence !== index || entry.previousHash !== previous || !hex64(entry.entryHash)) return {ok: false, sequence: index};
    let matches = false;
    // A row with a builder code is left to the library's own check below.
    if (entry.builderCode === undefined && entry.signerFingerprint === fingerprint) {
      try {
        const base = {sequence: entry.sequence, decision: entry.decision, previousHash: entry.previousHash};
        matches = computeEntryHash({...base, signerFingerprint: entry.signerFingerprint}) === entry.entryHash || computeEntryHash(base) === entry.entryHash;
      } catch { matches = false; }
    }
    // Anything this quick comparison does not accept gets the library's whole
    // check, so a row the library accepts is never refused here.
    if (!matches && !(await verifyEntry(entry, publicKey))) return {ok: false, sequence: index};
    previous = entry.entryHash;
  }
  // At least the newest row: its signature is what ties every hash before it to the key.
  const head = Number.isSafeInteger(headSignatures) && headSignatures > 0 ? headSignatures : HEAD_SIGNATURES;
  for (let index = Math.max(0, entries.length - head); index < entries.length; index++) {
    if (!(await verifyEntry(entries[index], publicKey))) return {ok: false, sequence: index};
  }
  return {ok: true};
}

// The worker lease provides one writer. A response acknowledges a complete
// write to the OS, while an asynchronous tail confirms a conservative head.
// The SDK's signed NDJSON format stays unchanged.
class OwnedLogStore extends NdjsonDecisionLogStore {
  constructor(name, options = {}) {
    super(name, options);
    this.syncFd = options.syncFd ?? syncFd;
    this.checkpointPath = this.filePath + '.durable-head.json';
    this.failurePath = this.filePath + '.sync-error.json';
    this.signaturePath = this.filePath + '.signature-check.json';
    this.unchecked = null;          // rows whose signatures the background check has still to read
    this.signatureFailure = null;   // {sequence} once a signature failed: nothing more is appended
    this.sliceMs = options.signatureSliceMs ?? SLICE_MS;
    this.headSignatures = options.headSignatures;
    this.syncing = null;
    this.closed = false;
  }
  async recover(publicKeyHex) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let checkpoint, failure = false, bytes = Buffer.alloc(0);
    try {
      checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new Error('invalid_durable_checkpoint');
    }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_durable_checkpoint'); }
    try { failure = JSON.parse(fs.readFileSync(this.failurePath, 'utf8')).reason === 'durability_sync_failed'; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_sync_failure_marker'); }
    try { bytes = fs.readFileSync(this.filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entries = [], ends = [];
    let offset = 0, incomplete = 0, missingNewline = false;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      const line = bytes.subarray(offset, end).toString('utf8');
      if (!line.trim()) throw new Error('invalid_existing_chain');
      let entry;
      try { entry = JSON.parse(line); }
      catch {
        if (newline >= 0) throw new Error('invalid_existing_chain');
        incomplete = bytes.length - offset;
        break;
      }
      entries.push(entry); ends.push(newline < 0 ? end : end + 1);
      if (newline < 0) missingNewline = true;
      offset = newline < 0 ? end : end + 1;
    }
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    let held = false;
    try { held = fs.lstatSync(this.signaturePath).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_signature_check_marker'); }
    if (held) {
      // An earlier background check found a bad signature: this start checks
      // every signature first, and goes on only if the ledger now passes.
      if (!(await verifyChain(entries, publicKey)).ok) throw new Error('invalid_existing_chain');
    } else {
      if (!(await verifyLinks(entries, publicKey, this.headSignatures)).ok) throw new Error('invalid_existing_chain');
      this.unchecked = {entries, publicKey};
    }
    const fingerprint = computeSignerFingerprint(Buffer.from(publicKeyHex, 'hex'));
    if (checkpoint) {
      const index = checkpoint.sequence;
      if (checkpoint.version !== 1 || !Number.isSafeInteger(index) || index < -1 || index >= entries.length ||
          checkpoint.signerFingerprint !== fingerprint ||
          checkpoint.entryHash !== (index < 0 ? GENESIS_PREVIOUS_HASH : entries[index]?.entryHash) ||
          checkpoint.byteLength !== (index < 0 ? 0 : ends[index])) throw new Error('invalid_durable_checkpoint');
    }
    const confirmedBytes = checkpoint?.byteLength ?? 0;
    if (incomplete && bytes.length - incomplete < confirmedBytes) throw new Error('confirmed_ledger_tail_incomplete');
    // No modification is permitted until both the complete signed chain and
    // the checkpoint have verified. Only the final incomplete row is removed.
    const fd = fs.openSync(this.filePath, 'a+', 0o600);
    try {
      if (incomplete) fs.ftruncateSync(fd, bytes.length - incomplete);
      if (missingNewline) fs.writeSync(fd, '\n');
    } finally { fs.closeSync(fd); }
    this.initializeHead(entries, publicKeyHex, checkpoint);
    if (held) fs.unlinkSync(this.signaturePath);
    const recoveredRows = entries.length - ((checkpoint?.sequence ?? -1) + 1);
    const integrity = recoveredRows || incomplete || failure ? {
      reason: failure ? 'durability_sync_failed' : incomplete ? 'incomplete_tail_discarded' : 'unconfirmed_tail_recovered',
      confirmedSequence: checkpoint?.sequence ?? -1,
      confirmedHash: checkpoint?.entryHash ?? GENESIS_PREVIOUS_HASH,
      recoveredHeadHash: entries.at(-1)?.entryHash ?? GENESIS_PREVIOUS_HASH,
      recoveredRows,
      truncatedBytes: incomplete,
      checkpointMissing: !checkpoint,
    } : null;
    return { entries, integrity };
  }
  initializeHead(entries, publicKeyHex, checkpoint = null) {
    this.head = entries.at(-1) ?? null;
    this.publicKeyHex = publicKeyHex;
    this.fingerprint = computeSignerFingerprint(Buffer.from(publicKeyHex, 'hex'));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(this.filePath, 'a', 0o600);
    this.observed = fs.fstatSync(this.fd, { bigint: true });
    this.confirmed = checkpoint;
  }
  // Every signature the start did not check, read with the signing library's
  // own check, a slice at a time so waiting calls are answered in between.
  // Resolves {ok: true, rows}, or {ok: false, sequence} after writing the note
  // that holds the next start on the full check, or {ok: null} when the worker
  // closed first (the next start begins again). Never rejects.
  async checkSignatures() {
    const work = this.unchecked;
    if (!work) return {ok: true, rows: 0};
    try {
      let slice = Date.now();
      for (let index = 0; index < work.entries.length; index++) {
        if (this.closed) return {ok: null};
        if (!(await verifyEntry(work.entries[index], work.publicKey))) {
          this.signatureFailure = {sequence: index};
          try { fs.writeFileSync(this.signaturePath, JSON.stringify({reason: 'signature_invalid', sequence: index}) + '\n', {mode: 0o600}); } catch { /* This worker still stops. */ }
          return {ok: false, sequence: index};
        }
        if (Date.now() - slice >= this.sliceMs) { await new Promise(resolve => setImmediate(resolve)); slice = Date.now(); }
      }
      return {ok: true, rows: work.entries.length};
    } catch {
      this.signatureFailure = {sequence: -1};
      try { fs.writeFileSync(this.signaturePath, JSON.stringify({reason: 'signature_check_failed', sequence: -1}) + '\n', {mode: 0o600}); } catch { /* This worker still stops. */ }
      return {ok: false, sequence: -1};
    } finally { if (this.unchecked === work) this.unchecked = null; }
  }
  async append(entry) {
    if (this.closed) throw new Error('ledger_closed');
    if (this.signatureFailure) throw new Error('invalid_existing_chain');
    if (entry.sequence !== (this.head?.sequence ?? -1) + 1) throw new SequenceConflictError(entry.signerFingerprint, entry.sequence);
    if (entry.signerFingerprint !== this.fingerprint || (!this.head && entry.previousHash !== GENESIS_PREVIOUS_HASH)) throw new Error('invalid_chain_genesis');
    if (this.head && (entry.previousHash !== this.head.entryHash || entry.signerFingerprint !== this.head.signerFingerprint)) throw new Error('chain_head_changed');
    this.assertUnchanged();
    const row = Buffer.from(JSON.stringify({ ...entry, publicKeyHex: this.publicKeyHex }) + '\n');
    let offset = 0;
    while (offset < row.length) {
      const written = fs.writeSync(this.fd, row, offset, row.length - offset);
      if (!written) throw new Error('partial_ledger_write');
      offset += written;
    }
    this.observed = fs.fstatSync(this.fd, { bigint: true }); this.head = entry;
  }
  assertUnchanged() {
    if (!sameFile(fs.statSync(this.filePath, { bigint: true }), this.observed) ||
        !sameFile(fs.fstatSync(this.fd, { bigint: true }), this.observed)) throw new Error('ledger_changed_outside_worker');
  }
  snapshot() {
    return {version: 1, sequence: this.head?.sequence ?? -1, entryHash: this.head?.entryHash ?? GENESIS_PREVIOUS_HASH,
      byteLength: Number(this.observed.size), signerFingerprint: this.fingerprint};
  }
  dirty() {
    return !this.confirmed || this.confirmed.sequence !== (this.head?.sequence ?? -1);
  }
  afterReply() {
    if (this.closed || this.syncing || !this.dirty()) return;
    // Deferral makes the call safe directly after the response is published.
    // All expensive flush work uses asynchronous filesystem operations.
    let succeeded = false;
    this.syncing = new Promise(resolve => setImmediate(resolve)).then(async () => {
      this.assertUnchanged();
      const snapshot = this.snapshot();
      await this.syncFd(this.fd);
      this.assertUnchanged();
      await this.writeCheckpoint(snapshot);
      this.confirmed = snapshot;
      if (this.clearFailureAt !== undefined && snapshot.sequence >= this.clearFailureAt) {
        try { await fs.promises.unlink(this.failurePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.clearFailureAt = undefined;
      }
      // A previous failure remains visible until a new worker has recorded its
      // integrity event. Successful retries in this worker do not erase it.
      succeeded = true;
      return true;
    }).catch(() => {
      try { fs.writeFileSync(this.failurePath, JSON.stringify({reason: 'durability_sync_failed'}) + '\n', {mode: 0o600}); } catch {}
      return false;
    }).finally(() => {
      this.syncing = null;
      if (succeeded && this.dirty()) this.afterReply();
    });
  }
  async writeCheckpoint(snapshot) {
    const temporary = this.checkpointPath + `.${process.pid}.tmp`;
    const file = await fs.promises.open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(snapshot) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await fs.promises.rename(temporary, this.checkpointPath);
    const directory = await fs.promises.open(path.dirname(this.checkpointPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async flush() {
    if (this.closed) return true;
    while (this.syncing || this.dirty()) {
      this.afterReply();
      if (!(await this.syncing)) return false;
    }
    return true;
  }
  async close() {
    const flushed = await this.flush();
    this.closed = true;
    fs.closeSync(this.fd);
    return flushed;
  }
  clearRecoveredFailureAfter(sequence) { this.clearFailureAt = sequence; }
}
module.exports = { OwnedLogStore, verifyLinks, HEAD_SIGNATURES };
