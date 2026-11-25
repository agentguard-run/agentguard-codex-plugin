#!/usr/bin/env node
'use strict';
// Offline, read-only inputs. In particular, never start the worker or create a key.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {SCHEMA, DAY_MS, PRESETS, COUNT_KEYS, canonical, fields, validLabel, validatePayload, validateAttestation, verifyAttestation} = require('./attestation-schema.cjs');
const {locations, hostContext, SPAWN} = require('./common.cjs');
const {ROOT_FIELDS, mergeGuardPack} = require('./org-policy-contract.cjs');
const {scanLedger, scanLedgerSync, createChainCheck, LedgerReadError} = require('./ledger-scan.cjs');
const HASH_FIELDS = [...ROOT_FIELDS, 'max_depth', 'helper_models', 'untrustedOrigin', 'commandRuleGroups', 'allowedToolGroups'];
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
class AttestationError extends Error {}
const fail = message => { throw new AttestationError(message); };

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = {'--days': 'days', '--label': 'label', '--out': 'out'}[args[i]];
    if (!key || Object.hasOwn(options, key) || typeof args[i + 1] !== 'string' || args[i + 1].startsWith('--')) {
      fail('Use days, label or out options, each once with a value.');
    }
    options[key] = args[i + 1];
  }
  if (options.days !== undefined) {
    if (!['7', '30'].includes(options.days)) fail('Days must be 7 or 30.');
    options.days = Number(options.days);
  }
  return checkOptions(options);
}
function checkOptions(options) {
  try { fields(options, [], ['days', 'label', 'out']); } catch { fail('Unknown attestation option.'); }
  const days = Object.hasOwn(options, 'days') ? options.days : 30;
  if (![7, 30].includes(days)) fail('Days must be 7 or 30.');
  if (Object.hasOwn(options, 'label') && !validLabel(options.label)) fail('Label must contain 1 to 60 ASCII letters, digits, spaces or hyphens and cannot be blank.');
  if (Object.hasOwn(options, 'out') && (typeof options.out !== 'string' || !options.out || /[\x00-\x1f\x7f]/.test(options.out))) fail('Output destination is invalid.');
  return {...options, days};
}

// One strict pass over the whole ledger with one row in memory at a time (runtime/ledger-scan.cjs). Every row goes
// through the chain check; only this host's rows inside the period are counted. Through 0.7.0 the ledger was loaded
// whole and a file above 64 MB or 100,000 rows was refused. Nothing is refused for its size now, and it is still
// all or nothing: a row that cannot be read, or any change to the file before the signature, and nothing is signed.
// What the pass finds wrong is recorded here and raised by the caller in the order the checks always ran.
// A first plain pass: the ledger can be read and every line is a record, and which session of this host came last.
// The policy that is attested depends on that session. This pass does not give up the thread, so the policy snapshot
// that follows it is taken before anything else can run, and a policy edit during the chain check is seen. The stat
// is handed to the checking pass, which must open that same unchanged file.
function lastHostSession(data, host) {
  const file = path.join(data, 'ledger', 'decisions.ndjson');
  let sessionId, read;
  try {
    read = scanLedgerSync(file, text => {
      let entry;
      try { entry = JSON.parse(text); } catch { fail('Ledger contains an incomplete or invalid record. Nothing was signed.'); }
      const plugin = entry?.decision?.plugin;
      if (plugin?.host === host) sessionId = plugin.sessionId;
    }, {blankLines: 'error'});
  } catch (error) { ledgerFailure(error); }
  if (read.missing) fail('Local ledger cannot be read. Nothing was signed.');
  return {sessionId, stat: read.stat};
}
function ledgerFailure(error) {
  if (error instanceof AttestationError) throw error;
  if (error instanceof LedgerReadError && error.code === 'changed') fail('Ledger changed during verification. Try again.');
  if (error instanceof LedgerReadError && ['invalid_text', 'row_too_large'].includes(error.code)) fail('Ledger contains an incomplete or invalid record. Nothing was signed.');
  fail('Local ledger cannot be read. Nothing was signed.');
}

async function readLedger(data, sdk, keys, host, start, end, expect) {
  const file = path.join(data, 'ledger', 'decisions.ndjson');
  const check = createChainCheck(sdk, keys.publicKey), counter = createWindowCounter();
  const found = {chainUnusable: false, timestampsInvalid: false, countError: null,
    entries: 0, firstSequence: null, lastSequence: null};
  let read;
  try {
    read = await scanLedger(file, async text => {
      let entry;
      try { entry = JSON.parse(text); } catch { fail('Ledger contains an incomplete or invalid record. Nothing was signed.'); }
      try {
        if (entry.publicKeyHex !== undefined && entry.publicKeyHex.toLowerCase() !== keys.publicKeyHex) found.chainUnusable = true;
        await check.push(entry);
      } catch { found.chainUnusable = true; }
      try {
        const d = entry.decision, at = Date.parse(d.timestamp);
        if (!Number.isFinite(at) || new Date(at).toISOString() !== d.timestamp) { found.timestampsInvalid = true; return; }
        if (!(at >= start && at <= end && d.plugin?.host === host)) return;
        found.entries++;
        if (found.firstSequence === null) found.firstSequence = entry.sequence ?? null;
        found.lastSequence = entry.sequence ?? null;
        try { counter.push(entry); } catch (error) { found.countError ??= error; }
      } catch { found.timestampsInvalid = true; }
    }, {blankLines: 'error', strict: true, expect});
  } catch (error) { ledgerFailure(error); }
  if (read.missing) fail('Local ledger cannot be read. Nothing was signed.');
  const unchanged = () => { try { read.unchanged(); } catch { fail('Ledger changed during verification. Try again.'); } };
  unchanged();
  return {found, unchanged, verification: () => found.chainUnusable ? {ok: false} : check.result(), counts: () => counter.counts()};
}

function signingKey(data) {
  try {
    const seed = fs.readFileSync(path.join(data, 'signing-key.hex'), 'utf8').trim();
    const publicKeyHex = fs.readFileSync(path.join(data, 'public-key.hex'), 'utf8').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/i.test(seed) || !/^[a-f0-9]{64}$/.test(publicKeyHex)) throw new Error();
    const privateKey = crypto.createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]), type: 'pkcs8', format: 'der'});
    const publicKey = crypto.createPublicKey(privateKey).export({type: 'spki', format: 'der'}).subarray(-32);
    if (publicKey.toString('hex') !== publicKeyHex) throw new Error();
    return {privateKey, publicKey, publicKeyHex};
  } catch { fail('Existing signing and public keys are missing, invalid or do not match. Nothing was signed.'); }
}

function policyProjection(config) {
  // Licensing credentials and file locations are not part of the policy digest.
  return Object.fromEntries(HASH_FIELDS.filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]]));
}
function matchingPreset(config) {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/default-policy.json'), 'utf8'));
  const normalized = policy => policyProjection({...defaults, commandRules: [], ...policy});
  const current = canonical(normalized(config));
  return PRESETS.find(name => {
    const policy = {...defaults, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'presets', name + '.json'), 'utf8'))};
    return current === canonical(normalized({...policy, guardPack: mergeGuardPack(policy, null, undefined)}));
  }) ?? null;
}
function limitsSnapshot(data, home, sessionId, burn) {
  try {
    const {config, license} = require('./policy-state.cjs').policyState(data, sessionId);
    const mode = license.mode === 'enforce' ? config.mode ?? 'enforce' : 'shadow';
    const check = burn.checkPolicyFile(home);
    if (check.status === 'ignored') fail('Burn policy is unreadable or invalid. Nothing was signed.');
    const burnPolicy = burn.loadPolicy(home, {notice: false});
    // The plugin seeds an absent Burn policy in enforce mode on the first launch.
    if (check.status === 'missing') burnPolicy.mode = mode;
    const subMode = mode === 'shadow' ? 'shadow' : burnPolicy.mode;
    const t = burnPolicy.thresholds;
    const launchDepths = [config.max_depth, config.sessions?.[sessionId]?.max_depth].filter(value => value != null);
    // Publish amounts and scope categories, never selectors, session names,
    // custom rule IDs, patterns or a digest of potentially private content.
    const capSummary = (cap, scope) => ({window: cap.window, amountCents: cap.amountCents, action: cap.action ?? 'block', scope});
    const caps = [
      ...(config.caps ?? []).map(cap => capSummary(cap, Object.keys(cap.selector ?? {}).length ? 'scoped' : 'global')),
      ...Object.values(config.sessions ?? {}).flatMap(session => (session.caps ?? []).map(cap => capSummary(cap, 'session'))),
    ];
    caps.sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
    const guardRules = Object.entries(config.guardPack.rules).filter(([, action]) => action !== 'off')
      .sort(([a], [b]) => a.localeCompare(b, 'en')).map(([id, action]) => ({id, action}));
    const limits = {mode, preset: matchingPreset(config), caps,
      subAgentLimits: {mode: subMode,
        spawnRate: {count: t.spawnRate.stop - 1, windowActiveMinutes: t.spawnRate.windowActiveMinutes, enforced: subMode === 'enforce' && t.spawnRate.enforce === true},
        fanout: {count: t.fanout.stop, windowActiveMinutes: t.fanout.windowActiveMinutes},
        maxDepth: t.fanout.maxDepth, launchMaxDepth: launchDepths.length ? Math.min(...launchDepths) : null, sessionTokenLimit: t.sustained.stopTokens},
      guardRules};
    // Used only to detect a concurrent policy edit. Never include this hash
    // in the public bundle, even when the edit leaves the summary unchanged.
    return {limits, fingerprint: digest({policy: policyProjection(config), burnPolicy, mode})};
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail('Current policy cannot be read safely. Nothing was signed.');
  }
}

// The counts of one period, kept as rows arrive.
function createWindowCounter() {
  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  const asked = new Set(), completed = new Set();
  return {
    push(entry) {
      const d = entry.decision, m = d.plugin;
      if (m.event === 'outcome' && m.gate === 'receipt') {
        if (typeof d.originalDecisionId === 'string') completed.add(canonical([d.originalDecisionId, m.sessionId ?? null, m.toolUseId ?? null]));
        return;
      }
      if (['outcome', 'settlement'].includes(d.entryType) || !['decision', 'fail_open', 'fail_closed'].includes(m.event)
          || !['spend', 'burn'].includes(m.gate)
          || (m.gate === 'burn' ? !SPAWN.has(m.toolName) : SPAWN.has(m.toolName))
          || [m.reasonCode, m.policyReasonCode].includes('burn_external_hook')) return;
      if (typeof d.decisionId !== 'string' || !['allow', 'shadow', 'block', 'downgrade'].includes(d.action)) fail('Ledger decision cannot be counted safely. Nothing was signed.');
      if (m.event === 'fail_open') counts.failOpen++;
      else if (m.event === 'fail_closed') counts.denied++;
      else if (m.asked === true || m.approvalNeeded === true || typeof m.approvalRuleId === 'string') {
        counts.asked++; asked.add(canonical([d.decisionId, m.sessionId ?? null, m.toolUseId ?? null]));
      } else if (d.action === 'block') counts.denied++;
      else counts.allowed++;
    },
    // Denied means a policy denial, not an inferred human refusal. Approved
    // means the host reported an outcome linked to that exact asked decision.
    counts() { return {...counts, approved: [...asked].filter(id => completed.has(id)).length}; },
  };
}
function windowCounts(entries) {
  const counter = createWindowCounter();
  for (const entry of entries) counter.push(entry);
  return counter.counts();
}

async function attest(rawOptions = {}, context = {}) {
  const options = checkOptions(rawOptions);
  fields(context, [], ['dataDir', 'home', 'host', 'now']);
  const host = context.host ?? hostContext().host;
  if (!['claude-code', 'codex'].includes(host)) fail('Host must be Claude Code or Codex.');
  const data = context.dataDir ?? locations().data;
  const home = context.home ?? process.env.AGENTGUARD_HOME ?? path.join(os.homedir(), '.agentguard');
  const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
  const burn = require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
  const keys = signingKey(data);
  const seen = lastHostSession(data, host);
  const sessionId = hostContext().sessionId ?? seen.sessionId ?? 'attestation';
  const policy = limitsSnapshot(data, home, sessionId, burn);
  const now = context.now === undefined ? Date.now() : context.now;
  if (!Number.isSafeInteger(now)) fail('Attestation time is invalid.');
  const createdAt = new Date(now).toISOString(), start = now - options.days * DAY_MS;
  const ledger = await readLedger(data, sdk, keys, host, start, now, seen.stat);
  const verification = ledger.verification();
  if (verification.ok !== true) fail('Ledger chain verification failed. Nothing was signed.');
  if (ledger.found.timestampsInvalid) fail('Ledger timestamps are invalid. Nothing was signed.');
  if (ledger.found.countError) throw ledger.found.countError;
  const payload = {schema: SCHEMA, pluginVersion: require('../package.json').version,
    createdAt, windowStart: new Date(start).toISOString(), windowEnd: createdAt, host,
    ...(options.label !== undefined ? {label: options.label} : {}),
    limits: policy.limits, counts: ledger.counts(),
    chain: {entries: ledger.found.entries, firstSequence: ledger.found.firstSequence,
      lastSequence: ledger.found.lastSequence, ok: verification.ok},
    publicKeyHex: keys.publicKeyHex, signerFingerprint: sdk.computeSignerFingerprint(keys.publicKey)};
  try { validatePayload(payload); } catch { fail('Policy or ledger cannot be represented by the public attestation schema. Nothing was signed.'); }
  ledger.unchanged();
  if (canonical(policy) !== canonical(limitsSnapshot(data, home, sessionId, burn))) fail('Policy changed during verification. Try again.');
  const signature = crypto.sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('hex');
  ledger.unchanged();
  return validateAttestation({...payload, signature});
}

async function run(args, context = {}) {
  if (args[0] === 'verify') {
    if (args.length !== 2 || !args[1]) fail('Verify requires one attestation file.');
    let bundle, fd;
    try {
      fd = fs.openSync(args[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
      bundle = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch { fail('Attestation file cannot be read as bounded JSON.'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    if (!verifyAttestation(bundle)) fail('Attestation verification failed: invalid schema or signature.');
    return {json: describeAttestation(bundle)};
  }
  const options = parseArgs(args);
  const result = await attest(options, context);
  const json = canonical(result) + '\n';
  if (options.out) {
    try { fs.writeFileSync(options.out, json, {flag: 'wx', mode: 0o600}); }
    catch { fail('Output file could not be created. Choose a new writable destination.'); }
  }
  return {json: options.out ? null : json};
}
function describeAttestation(bundle) {
  const {limits, counts, chain} = bundle, sub = limits.subAgentLimits;
  const windows = {per_call: 'call', per_session: 'session', per_minute: 'minute', per_hour: 'hour', per_day: 'day', per_month: 'month'};
  return [
    'AgentGuard Verified: the bundle schema and signature are valid.',
    ...(bundle.label ? [`Public label: ${bundle.label}.`] : []),
    `Plugin ${bundle.pluginVersion} for ${bundle.host === 'codex' ? 'Codex' : 'Claude Code'}.`,
    `Recorded period: ${bundle.windowStart} to ${bundle.windowEnd}, inclusive, in UTC.`,
    `Created at ${bundle.createdAt}. Signer fingerprint: ${bundle.signerFingerprint}.`,
    `Policy at creation: ${limits.preset ?? 'custom'}, ${limits.mode} mode.`,
    ...limits.caps.map(cap => `Spend cap: ${cap.amountCents} cents per ${windows[cap.window]}, ${cap.scope} scope, ${cap.action} action.`),
    ...(!limits.caps.length ? ['No spend caps configured.'] : []),
    `Sub-agent limits: ${sub.mode} mode; ${sub.spawnRate.count} launches per ${sub.spawnRate.windowActiveMinutes} active minutes (${sub.spawnRate.enforced ? 'enforced' : 'observe only'}); fanout ${sub.fanout.count} per ${sub.fanout.windowActiveMinutes} active minutes; Burn depth ${sub.maxDepth}; extra launch depth ${sub.launchMaxDepth ?? 'off'}; ${sub.sessionTokenLimit} session tokens.`,
    `Guard rules on: ${limits.guardRules.map(rule => `${rule.id} (${rule.action})`).join(', ') || 'none'}.`,
    `Recorded decisions: ${counts.allowed} allowed, ${counts.asked} asked, ${counts.approved} confirmed approvals, ${counts.denied} denied by policy, ${counts.failOpen} failed open. Confirmed approvals are a subset of asks.`,
    `Ledger chain check reported intact: ${chain.entries} entries for this host in the period${chain.entries ? `, sequences ${chain.firstSequence} through ${chain.lastSequence}` : ''}.`,
    'The signer attests that the local record is intact and these limits were in force at creation. This verifier checks the signed summary; the private ledger is not in the bundle.',
    'This does not prove work quality, signer identity, continuous enforcement, complete activity capture or unchanged limits throughout the period.',
  ].join('\n') + '\n';
}
module.exports = {attest, run, parseArgs, windowCounts, verifyAttestation};
if (require.main === module) run(process.argv.slice(2)).then(({json}) => {
  if (json) process.stdout.write(json);
}).catch(error => {
  process.stderr.write((error instanceof AttestationError ? error.message : 'Attestation could not be created. Check the local installation and policy.') + '\n');
  process.exitCode = 1;
});
