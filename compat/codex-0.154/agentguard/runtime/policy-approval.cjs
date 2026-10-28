'use strict';
// Held Codex calls wait for the operator. A ticket is bound to the exact session,
// tool, input hash and policy, and it is approved only from the operator's own
// terminal. The token is never shown to the model: the deny message tells the
// model that the operator decides, and `policy-cli pending` lists the tokens.
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {hashPolicy} = require('./org-policy-contract.cjs');
// New hooks send a keyed input digest; a request from an older hook, or one
// spooled before an upgrade, still binds by its unkeyed SHA-256.
const inputBinding = meta => meta.inputDigest ? {inputDigest: meta.inputDigest} : {inputSha256: meta.inputSha256};
const binding = (meta, config) => hashPolicy({sessionId: meta.sessionId, toolName: meta.toolName, ...inputBinding(meta),
  ...(meta.pageGuard ? {pageBeforeSha256: meta.pageGuard.beforeSha256} : {}),
  ...(meta.launch ? {callerId: meta.launch.callerId, depth: meta.launch.depth} : {}), policy: config});
function directory(data) { return path.join(data, 'policy-approvals'); }
function ticketFile(data, token) {
  if (!/^[a-f0-9]{32}$/.test(token ?? '')) throw new Error('Invalid approval token.');
  return path.join(directory(data), token + '.json');
}
function read(file) { return JSON.parse(require('./client.cjs').readPrivate(file, 2048)); }
function requestApproval(data, meta, config, now = Date.now(), ruleId = null) {
  fs.mkdirSync(directory(data), {recursive: true, mode: 0o700});
  const digest = binding(meta, config);
  // Repeated holds for the same exact call share one pending ticket. This keeps
  // retries from filling the directory and slowing every subsequent approval.
  for (const name of fs.readdirSync(directory(data))) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    try {
      const value = read(path.join(directory(data), name));
      if (value.expires >= now && !value.approved && value.binding === digest && value.ruleId === ruleId) return name.slice(0, 32);
    } catch { /* A corrupt ticket cannot supply approval. */ }
  }
  const token = randomBytes(16).toString('hex');
  // Content-free description for the operator's listing: no arguments, only the
  // tool name, session, rule and input digest the approval is bound to.
  fs.writeFileSync(ticketFile(data, token), JSON.stringify({binding: digest, expires: now + 300000, approved: false, created: now,
    toolName: meta.toolName, sessionId: meta.sessionId, ...inputBinding(meta), ruleId}), {flag: 'wx', mode: 0o600});
  return token;
}
function approve(data, token, now = Date.now()) {
  const file = ticketFile(data, token), value = read(file);
  if (value.expires < now || value.approved) throw new Error('Approval expired or already granted.');
  require('./client.cjs').writeMessage(file, {...value, approved: true});
}
function pending(data, now = Date.now()) {
  let files;
  try { files = fs.readdirSync(directory(data)); } catch { return []; }
  const list = [];
  for (const name of files.sort()) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    try {
      const value = read(path.join(directory(data), name));
      if (value.expires < now || value.approved) continue;
      list.push({token: name.slice(0, 32), ruleId: value.ruleId ?? null, toolName: value.toolName ?? null, sessionId: value.sessionId ?? null,
        inputDigest: value.inputDigest ?? value.inputSha256 ?? null, expiresInSeconds: Math.max(0, Math.round((value.expires - now) / 1000))});
    } catch { /* Unreadable tickets are not listed and cannot grant permission. */ }
  }
  return list;
}
function consume(data, meta, config, now = Date.now()) {
  let files;
  try { files = fs.readdirSync(directory(data)); } catch { return false; }
  for (const name of files) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    const file = path.join(directory(data), name);
    try {
      const value = read(file);
      if (value.expires < now) { fs.unlinkSync(file); continue; }
      if (!value.approved || value.binding !== binding(meta, config)) continue;
      // Only the one worker consumes tickets. Retire before admitting the call.
      fs.unlinkSync(file); return true;
    } catch { /* Invalid tickets cannot grant permission. */ }
  }
  return false;
}
module.exports = {requestApproval, approve, consume, pending};
