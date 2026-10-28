'use strict';
// The local secret behind keyed digests. A plain SHA-256 of a short tool input
// or an agent name can be recovered by guessing; an HMAC under a key that never
// leaves this machine cannot. The key is a separate file, not derived from the
// signing seed, because hooks compute these digests and a hook process must
// never read the signing key. It lives beside the signing key, 0600, in the
// plugin's data folder, where the built-in plugin-state stop keeps the agent out.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const KEY_FILE = 'digest-key.hex';
const ALG = 'hmac-sha256';
const cache = new Map();

function readKey(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 || (process.getuid && stat.uid !== process.getuid())) throw new Error('digest_key_invalid');
    const text = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('digest_key_invalid');
    return Buffer.from(text, 'hex');
  } finally { fs.closeSync(fd); }
}
// Created once, atomically: a complete key is linked into place, so a reader
// sees either no file or the whole key, and two first writers agree on one.
function digestKey(data) {
  const file = path.join(path.resolve(data), KEY_FILE);
  const cached = cache.get(file);
  if (cached) return cached;
  let key;
  try { key = readKey(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, crypto.randomBytes(32).toString('hex') + '\n', {flag: 'wx', mode: 0o600});
    try { fs.linkSync(temporary, file); }
    catch (linkError) {
      if (linkError.code !== 'EEXIST') {
        try { fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL); }
        catch (copyError) { if (copyError.code !== 'EEXIST') throw copyError; }
      }
    } finally { try { fs.unlinkSync(temporary); } catch { /* Already gone. */ } }
    key = readKey(file);
  }
  cache.set(file, key);
  return key;
}
// HMAC-SHA-256 over domain, U+0000 and the value, as the open receipt format
// salts its identifiers. Lowercase hexadecimal.
function keyedDigest(data, domain, value) {
  return crypto.createHmac('sha256', digestKey(data)).update(`${domain}\0${value}`).digest('hex');
}
module.exports = {KEY_FILE, ALG, digestKey, keyedDigest};
