'use strict';
// One pass over the signed ledger with bounded memory, and the chain check to go with it.
//
// Through 0.7.0 every reader loaded the whole ledger and refused a file above 64 MB or 100,000 rows. The hooks kept
// signing past that point, so a busy machine lost status, work receipts, verification, export and attestation for
// good. Nothing here holds more than one row at a time, so there is no size at which a reader stops working.
//
// The ledger is append-only and has one writer. A reader takes the size at open as its snapshot and reads exactly
// that many bytes: a row appended after the open is not part of this read. No row is skipped. A line that cannot be
// decoded fails the whole read, and so does one the caller cannot parse, so a damaged ledger is never reported as a
// shorter valid one.
const fs = require('node:fs');

const CHUNK_BYTES = 1024 * 1024;
// One row is about a kilobyte. A line this long is not a ledger row, and it must not become a memory problem.
const MAX_ROW_BYTES = 8 * 1024 * 1024;
const STRICT_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];

class LedgerReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new LedgerReadError(code); };

// Opens the ledger and fixes the snapshot. Returns null when there is no file.
//   expect: the stat an earlier read returned. This read fails as 'changed' unless it opens that same unchanged file,
//   so two passes can stand for one snapshot.
function open(file, {expect = null} = {}) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch (error) {
    if (error.code !== 'ENOENT') fail('unreadable');
    if (expect) fail('changed');
    return null;
  }
  try {
    const before = fs.fstatSync(fd, {bigint: true});
    if (!before.isFile() || !Number.isSafeInteger(Number(before.size))) fail('unreadable');
    if (expect && !STRICT_FIELDS.every(field => before[field] === expect[field])) fail('changed');
    return {fd, before, size: Number(before.size)};
  } catch (error) { fs.closeSync(fd); throw error; }
}

// Every line of the snapshot, in file order, one at a time.
//   blankLines 'skip' drops a line that is empty or only spaces (the read-only server always has).
//   blankLines 'error' fails on one (the attestation reader always has).
// A last line with no newline is still a line: a complete row is read, an incomplete one will not parse.
function* lines({fd, size}, {blankLines = 'skip', chunkBytes = CHUNK_BYTES, maxRowBytes = MAX_ROW_BYTES} = {}) {
  // ignoreBOM keeps a byte-order mark in the text. Without it the decoder removes one from the front of every line,
  // and a row with three extra bytes in front of it would read as an untouched row.
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let position = 0, held = [], heldBytes = 0;
  const text = tail => {
    // The limit is on the whole line, however it happened to be cut into blocks.
    if (heldBytes + tail.length > maxRowBytes) fail('row_too_large');
    const bytes = heldBytes ? Buffer.concat([...held, tail], heldBytes + tail.length) : tail;
    held = []; heldBytes = 0;
    let decoded;
    try { decoded = decoder.decode(bytes); } catch { fail('invalid_text'); }
    if (decoded.trim()) return decoded;
    if (blankLines === 'error') fail('invalid_text');
    return null;
  };
  while (position < size) {
    let got;
    try { got = fs.readSync(fd, buffer, 0, Math.min(chunkBytes, size - position), position); }
    catch { fail('unreadable'); }
    // The file is shorter than it was at open: it was cut or replaced under this read.
    if (!got) fail('changed');
    position += got;
    let start = 0;
    for (;;) {
      const newline = buffer.subarray(0, got).indexOf(10, start);
      if (newline < 0) break;
      const line = text(buffer.subarray(start, newline));
      start = newline + 1;
      if (line !== null) yield line;
    }
    if (start < got) {
      heldBytes += got - start;
      if (heldBytes > maxRowBytes) fail('row_too_large');
      // The read buffer is reused, so the unfinished line is copied out of it.
      held.push(Buffer.from(buffer.subarray(start, got)));
    }
  }
  if (heldBytes) { const line = text(Buffer.alloc(0)); if (line !== null) yield line; }
}

// What a finished read hands back. unchanged() throws 'changed' once the file is another file or a shorter one;
// with strict it throws on any difference at all. Rows added after the open are outside the read, and without
// strict they are not a change to it.
function finished(file, snapshot, rows, strict) {
  const {before, size} = snapshot;
  const unchanged = () => {
    let now;
    try { now = fs.statSync(file, {bigint: true}); } catch { fail('changed'); }
    if (now.dev !== before.dev || now.ino !== before.ino || now.size < before.size) fail('changed');
    if (strict && !STRICT_FIELDS.every(field => now[field] === before[field])) fail('changed');
  };
  unchanged();
  return {missing: false, rows, bytes: size, stat: before, unchanged};
}
const MISSING = Object.freeze({missing: true, rows: 0, bytes: 0, stat: null, unchanged() {}});

// Reads `file` row by row and awaits `visit(text)` for each line.
// Options: blankLines, strict (the file must be byte for byte the same file when the read ends), expect, and for the
// tests chunkBytes and maxRowBytes.
// Resolves {missing, rows, bytes, stat, unchanged()}.
// Rejects with a LedgerReadError whose code is unreadable, changed, row_too_large or invalid_text.
async function scanLedger(file, visit, options = {}) {
  const snapshot = open(file, options);
  if (!snapshot) return MISSING;
  try {
    let rows = 0;
    for (const line of lines(snapshot, options)) { rows++; await visit(line); }
    return finished(file, snapshot, rows, options.strict === true);
  } finally { fs.closeSync(snapshot.fd); }
}
// The same read without giving up the thread, for a caller that must not be interleaved with anything else.
function scanLedgerSync(file, visit, options = {}) {
  const snapshot = open(file, options);
  if (!snapshot) return MISSING;
  try {
    let rows = 0;
    for (const line of lines(snapshot, options)) { rows++; visit(line); }
    return finished(file, snapshot, rows, options.strict === true);
  } finally { fs.closeSync(snapshot.fd); }
}

// The same three checks as the signing library's verifyChain, in the same order and with the same answers, taken one
// row at a time: the sequence continues, the row names the hash before it, and the row's own hash and signature hold.
// After the first failure nothing more is checked; rows are still counted by the caller.
function createChainCheck(sdk, publicKey) {
  let index = 0, expected = 0, previous = sdk.GENESIS_PREVIOUS_HASH, failure = null;
  return {
    async push(entry) {
      if (failure) return;
      const first = index === 0, at = index++;
      if (first && entry?.sequence !== 0) {
        failure = {ok: false, sequence: entry?.sequence ?? -1, reason: `Chain must start at sequence 0, got ${entry?.sequence ?? 'missing'}`};
      } else if (!entry) {
        failure = {ok: false, sequence: at, reason: 'Missing entry at index ' + at};
      } else if (entry.sequence !== expected) {
        failure = {ok: false, sequence: entry.sequence, reason: `Sequence gap: expected ${expected}, got ${entry.sequence}`};
      } else if (entry.previousHash !== previous) {
        failure = {ok: false, sequence: entry.sequence, reason: `previousHash mismatch at sequence ${entry.sequence}: expected ${previous}, got ${entry.previousHash}`};
      } else if (!(await sdk.verifyEntry(entry, publicKey))) {
        failure = {ok: false, sequence: entry.sequence, reason: `Signature or hash invalid at sequence ${entry.sequence}`};
      }
      if (failure) return;
      expected = entry.sequence + 1; previous = entry.entryHash;
    },
    result() { return failure ?? {ok: true}; },
  };
}

module.exports = {scanLedger, scanLedgerSync, createChainCheck, LedgerReadError, CHUNK_BYTES, MAX_ROW_BYTES};
