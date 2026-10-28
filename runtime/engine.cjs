'use strict';
// Gate decisions are offline. Session startup and seat renewal own licensing I/O.
process.env.AGENTGUARD_NO_BEACON = '1';
process.env.AGENTGUARD_TELEMETRY = '0';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
const burn = require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
const { OwnedLogStore } = require('./owned-log.cjs');
const {readSessionLicense} = require('./license.cjs');
const {guardResult} = require('./guard-pack.cjs');
const {notifyStop} = require('./notify-stop.cjs');
const { locations, allow, deny, stopDeny, SPAWN, hostContext, runBurnHook, matchingExternalBurn, outcomeFlow, minimumCapability, identifier, claudeUsage, claudeCursorFile, readsSubagents } = require('./common.cjs');
const workReceipt = require('./work-receipt.cjs');
const origin = require('./untrusted-origin.cjs');
// Facts a hook computes for one decision that are never signed into a row:
// action category names and untrusted-origin evidence (booleans, times and keyed digests).
const TRANSIENT = ['actionCategories', 'originEvidence'];
const withoutTransient = meta => { const copy = {...meta}; for (const key of TRANSIENT) delete copy[key]; return copy; };
const tiers = ['read_only', 'data_write', 'payment_initiate', 'payment_execute'];
const durations = { per_minute: 60000, per_hour: 3600000, per_day: 86400000, per_month: 2592000000 };
const startWindow = (window, now = Date.now()) => Math.floor(now / durations[window]) * durations[window];
const offline = async () => { throw new Error('offline_license_refresh_required'); };
const basePolicy = { id: 'agentguard-codex', name: 'AgentGuard tool policy', scope: { tenantId: 'local' }, version: 1, mode: 'enforce', caps: [] };
const callKey = meta => JSON.stringify([meta.sessionId, meta.toolUseId]);
const governs = meta => meta.gate === 'spend' ? !SPAWN.has(meta.toolName) : meta.gate === 'burn' && SPAWN.has(meta.toolName);
const matches = (patterns, name) => (patterns ?? []).some(pattern => new RegExp(pattern, 'i').test(name));
const CHARGE_FOLD = 2048;
const BUILT_IN = {plugin_state: 'AgentGuard protects its own policy, approval and worker files.', policy_cli: 'Policy changes and approvals belong to the operator, in the operator\'s own terminal.'};
const burnHome = () => process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard');
// What the agent is told when it tries to lift a Burn STOP itself. Claude Code
// gets Burn's own words (a command typed with ! runs in the person's shell and
// never reaches a hook); Codex has no such prefix, so the person uses a terminal.
function overrideRefusal(host) {
  return host === 'claude-code' ? burn.AGENT_OVERRIDE_REASON
    : `AgentGuard: overrides come from the person, not the agent. Ask them to run it themselves in a terminal:\n${burn.OVERRIDE_COMMAND}`;
}
// Burn has no policy override parameter. Its gateway and hook helpers read the
// loadPolicy export of Burn's policy module (policy.js in 0.3.x) at call time,
// so the engine adapts that one writable export for the length of a call.
function burnPolicyModule() {
  return Object.values(require.cache).find(module => {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports ?? {}, 'loadPolicy');
    return descriptor?.writable === true && descriptor.value === burn.loadPolicy;
  });
}

const {validatePolicy} = require('./policy-schema.cjs');

class Engine {
  constructor(options = {}) {
    this.licenseReader = options.licenseReader ?? readSessionLicense;
    this.stopNotifier = options.stopNotifier ?? notifyStop;
    this.logOptions = options.logOptions ?? {};
    this.loc = locations(); this.spendStore = new sdk.InMemorySpendStore(); this.pending = new Map(); this.completed = new Map(); this.failures = new Set(); this.computedBlocks = new Map();
    this.outcomes = new sdk.SpendGuard({ policy: basePolicy, spendStore: this.spendStore, licensePostJson: offline });
    this.sessionCharges = new Map(); this.guards = new Map(); this.orgPolicyDigests = new Map(); this.sessionFailures = new Map();
    // Each session's calls by result, for its work receipt.
    this.tally = new workReceipt.SessionTally();
    // Sessions another agent's message has entered, by session id.
    this.origins = new Map();
    // Per session: the keyed digest of the agent that last messaged it, and the
    // prompt that carried a marker. Memory only.
    this.lastPeers = new Map(); this.markerPrompts = new Map();
  }
  // Session charges are folded per session so a long session cannot grow the
  // worker without bound or slow every later cap check.
  addCharge(actor, cents) {
    const list = this.sessionCharges.get(actor.sessionId) ?? [];
    list.push({actor, cents});
    if (list.length > CHARGE_FOLD) {
      const folded = new Map();
      for (const charge of list) { const key = JSON.stringify(charge.actor); folded.set(key, {actor: charge.actor, cents: (folded.get(key)?.cents ?? 0) + charge.cents}); }
      list.length = 0; list.push(...folded.values());
    }
    this.sessionCharges.set(actor.sessionId, list);
  }
  chargeCount(sessionId) { return this.sessionCharges.get(sessionId)?.length ?? 0; }
  charges(sessionId) { return this.sessionCharges.get(sessionId) ?? []; }
  // Requests from other agents. A session's mark lives in memory and in one
  // small file, read back once after a worker restart.
  originState(sessionId) {
    let state = this.origins.get(sessionId);
    if (!state) { state = origin.readState(this.loc.data, sessionId); this.origins.set(sessionId, state); }
    return state;
  }
  // What every decision row written while the session is marked carries.
  originFields(sessionId) {
    const state = this.originState(sessionId);
    return state.tainted ? {origin: origin.ORIGIN, delegation_entry_hash: state.delegationEntryHash ?? null} : {};
  }
  // The configured categories this call falls in while the session is marked,
  // or null when the mark, the setting or the call leaves nothing to hold.
  originCheck(meta, config, call) {
    const current = origin.settings(config);
    if (current.action === 'off' || !this.originState(meta.sessionId).tainted) return null;
    const categories = origin.matched(current, call);
    return categories.length ? {action: current.action, categories} : null;
  }
  // The mark starts with one signed, chained delegation row: what brought the
  // message in, a keyed digest of the requester when one is known, and the
  // session and agent it reached. No message content.
  async taint(meta, originTool, requester) {
    const row = this.basic({toolName: 'delegation', sessionId: meta.sessionId, toolUseId: crypto.randomUUID(), gate: 'control',
      ...(meta.agentId ? {agentId: meta.agentId} : {})}, 'allow', 'delegation');
    row.plugin = {...row.plugin, event: 'delegation', originTool, requester: typeof requester === 'string' && /^[a-f0-9]{64}$/.test(requester) ? requester : null, agentId: row.actor.agentId};
    let delegationEntryHash = null;
    try { await this.append(row); delegationEntryHash = this.previousHash; }
    catch { this.keepAside(row); }
    const state = {tainted: true, since: row.timestamp, originTool, delegationEntryHash};
    // Memory first: a file that cannot be written still marks the session here.
    this.origins.set(meta.sessionId, state);
    try { origin.writeState(this.loc.data, meta.sessionId, state); } catch { /* Kept in this worker's memory. */ }
    return state;
  }
  // The owner is back: their own prompt, their approval of a held call, or
  // their clear-origin command. The cleared state keeps its time, so evidence
  // from before it never marks the session again. A state file that cannot be
  // written keeps the mark.
  async clearTaint(meta, clearedBy) {
    const state = {tainted: false, since: new Date().toISOString(), originTool: null, delegationEntryHash: null};
    try { origin.writeState(this.loc.data, meta.sessionId, state); } catch { return false; }
    this.origins.set(meta.sessionId, state); this.markerPrompts.delete(meta.sessionId);
    const row = this.basic({toolName: 'origin_cleared', sessionId: meta.sessionId, toolUseId: crypto.randomUUID(), gate: 'control'}, 'allow', 'origin_cleared');
    row.plugin = {...row.plugin, event: 'origin_cleared', clearedBy};
    try { await this.append(row); } catch { this.keepAside(row); }
    return true;
  }
  // Evidence a hook sent with its request, applied before any decision. Only
  // booleans, times, prompt ids and keyed digests arrive here. Never throws.
  async applyEvidence(meta, evidence, config) {
    if (!evidence) return null;
    try {
      if (origin.settings(config).action === 'off') return null;
      if (evidence.peer) { this.lastPeers.set(meta.sessionId, evidence.peer); if (this.lastPeers.size > 4096) this.lastPeers.delete(this.lastPeers.keys().next().value); }
      const step = origin.change(this.originState(meta.sessionId), evidence, this.markerPrompts.get(meta.sessionId) ?? null);
      if (step === 'taint') {
        const tool = evidence.promptMatch ? origin.PROMPT_TOOL : evidence.inbound || evidence.inboundPath || evidence.marker ? meta.toolName
          : evidence.transcriptKind === 'peer' ? origin.PEER_TOOL : origin.TRANSCRIPT_TOOL;
        await this.taint(meta, tool, evidence.requester ?? evidence.peer ?? null);
        if (evidence.promptMatch && evidence.promptId) this.markerPrompts.set(meta.sessionId, evidence.promptId);
      } else if (step === 'clear') await this.clearTaint(meta, 'human_prompt');
      return step;
    } catch { return null; }
  }
  // After a tool returns: an inbound messaging tool or a file another agent
  // sent marks the session when the call ran; a marker in its result marks it
  // either way. Never throws.
  async observeInbound(meta, evidence) {
    try {
      let config = {};
      try { ({config} = this.context(meta)); } catch { /* The defaults decide what is inbound. */ }
      const ran = meta.success !== false;
      await this.applyEvidence(meta, {...(evidence ?? {}), inbound: ran && origin.inboundTool(origin.settings(config), meta.toolName),
        inboundPath: ran && evidence?.inboundPath === true}, config);
    } catch { /* The call's own outcome is already recorded. */ }
  }
  // UserPromptSubmit. Never throws; an error keeps the current state.
  async prompt(meta, evidence) {
    try {
      let config = {};
      try { ({config} = this.context(meta)); } catch { /* The defaults apply. */ }
      const step = await this.applyEvidence(meta, evidence, config);
      return {output: {}, origin: step === 'clear' ? 'cleared' : this.originState(meta.sessionId).tainted ? 'tainted' : 'untainted'};
    } catch { return {output: {}, origin: 'unchanged'}; }
  }
  // The owner's own command: one session, or every session on this machine.
  async clearOrigins(sessionId) {
    const ids = new Set(sessionId === 'all' ? [...this.origins].filter(([, state]) => state.tainted).map(([id]) => id) : [sessionId]);
    let cleared = 0;
    for (const id of ids) if (this.originState(id).tainted && await this.clearTaint({sessionId: id}, 'owner_command')) cleared++;
    // Marks of sessions this worker has not read yet are cleared in their files.
    if (sessionId === 'all') cleared += origin.clearFiles(this.loc.data);
    return {cleared};
  }
  // A worker-side policy sync failure for a Solo license is written to the
  // status file so the hook and the worker read one state; Team failures stay
  // in memory, where a stale ready file must never override them.
  recordOrgFailure(sessionId, reason) {
    this.setSessionFailure(sessionId, 'org', reason);
    try {
      const source = require('./policy-file.cjs').readPolicy(this.loc.data);
      const license = this.licenseReader({data: this.loc.data, sessionId, policy: source.policy, personalPolicy: source.personal});
      if (require('./org-policy.cjs').soloEnabled(license)) require('./org-policy-refresh.cjs').recordSyncFailure(this.loc.data, source.policy, reason);
    } catch { /* The in-memory failure still applies to this worker. */ }
  }
  decorate(output, license) {
    // A display-only upgrade moment can never turn a deny into an allow.
    try { return require('./upgrade-moments.cjs').stopMoment(output, license); } catch { return output; }
  }
  async init() {
    fs.mkdirSync(this.loc.data, { recursive: true, mode: 0o700 });
    require('./upgrade-moments.cjs').registerLedger(this.loc.data);
    // The keyed digest secret. Hooks create it on first use when this cannot.
    try { require('./digest-key.cjs').digestKey(this.loc.data); } catch { /* Created by the first hook that needs it. */ }
    const keyFile = path.join(this.loc.data, 'signing-key.hex');
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const seed = fs.readFileSync(keyFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error('invalid_signing_key');
    this.privateKey = Buffer.from(seed, 'hex');
    const privateObject = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), this.privateKey]), type: 'pkcs8', format: 'der' });
    this.publicKey = crypto.createPublicKey(privateObject).export({ type: 'spki', format: 'der' }).subarray(-32);
    // The SDK lazily imports its signer. Finish that cold work before accepting
    // hooks, including workers whose first requests are observation-only.
    await sdk.signDecision({ sequence: 0, previousHash: sdk.GENESIS_PREVIOUS_HASH,
      decision: this.basic({ toolName: 'signer-warmup', sessionId: 'local', toolUseId: 'warmup', gate: 'spend' }, 'allow', 'signer_warmup'),
      privateKey: this.privateKey, publicKey: this.publicKey });
    fs.writeFileSync(path.join(this.loc.data, 'public-key.hex'), this.publicKey.toString('hex') + '\n', { mode: 0o600 });
    this.logStore = new OwnedLogStore('ledger', { ...this.logOptions, home: this.loc.data, publicKeyHex: this.publicKey.toString('hex') });
    const {entries, integrity} = await this.logStore.recover(this.publicKey.toString('hex'));
    this.sequence = entries.length; this.previousHash = entries.at(-1)?.entryHash ?? sdk.GENESIS_PREVIOUS_HASH;
    if (process.env.AGENTGUARD_RECEIPT_FORMAT === 'v1') {
      // The optional journal module is not part of the published package. A
      // flag set where it is absent must never stop the worker from starting.
      let journal = null;
      try { journal = require('./receipt-format/index.cjs'); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
      if (journal) this.v1Journal = journal.openJournal({
        directory: path.join(this.loc.data, 'receipts-v1'), seed: this.privateKey,
        secondProof: process.env.AGENTGUARD_RECEIPT_SECOND_PROOF === '1',
      });
    }
    for (const entry of entries) {
      const decision = entry.decision, meta = decision.plugin;
      this.tally.observe(decision);
      if (!meta) continue;
      if (meta.event === 'decision') {
        if (meta.gate === 'spend' && decision.action !== 'block' && meta.chargedCents) this.addCharge(decision.actor, meta.chargedCents);
        this.completed.set(`${meta.gate}:${callKey(meta)}`, decision);
        // A launch held for the person's answer runs if they say yes, so its outcome links here.
        if (decision.action !== 'block' || meta.asked === true) this.pending.set(callKey(meta), decision);
        for (const window of decision.action === 'block' ? [] : meta.chargedWindows ?? []) {
          if (window.windowStart === startWindow(window.window)) await this.spendStore.incrementWindowSpend(window.scopeKey, window.window, meta.chargedCents ?? 0);
        }
      } else if (meta.event === 'fail_open') {
        this.failures.add(`${meta.gate}:${callKey(meta)}`);
        if (governs(meta)) { this.pending.set(callKey(meta), decision); this.completed.set(`${meta.gate}:${callKey(meta)}`, decision); }
      }
      else if (meta.event === 'outcome') this.pending.delete(callKey(meta));
    }
    if (integrity) {
      const decision = this.basic({toolName: 'ledger_integrity', sessionId: 'worker', toolUseId: crypto.randomUUID(), gate: 'spend'}, 'allow', integrity.reason);
      decision.enforcementMode = 'shadow';
      decision.plugin.event = 'integrity';
      decision.plugin.integrity = integrity;
      await this.append(decision);
      this.logStore.clearRecoveredFailureAfter(this.sequence - 1);
    }
    // Import deferred events only after validating the existing chain.
    await this.drainSpool();
    // Receipts for sessions that ended while no worker could take them. A
    // receipt can never stop the worker from starting.
    try { await this.drainReceiptSpool(); } catch { /* Read again at the next request or start. */ }
  }
  setSessionFailure(sessionId, source, reason) {
    const existing = this.sessionFailures.get(sessionId);
    const failures = existing instanceof Map ? existing : new Map(existing ? [['legacy', existing]] : []);
    failures.set(source, reason);
    this.sessionFailures.set(sessionId, failures);
  }
  clearSessionFailure(sessionId, source) {
    const failures = this.sessionFailures.get(sessionId);
    if (!(failures instanceof Map)) return;
    failures.delete(source);
    if (!failures.size) this.sessionFailures.delete(sessionId);
  }
  preferredSessionFailure(sessionId) {
    const failures = this.sessionFailures.get(sessionId);
    if (!(failures instanceof Map)) return failures;
    const reasons = [...failures.values()];
    return reasons.includes('seat_revoked') ? 'seat_revoked' : reasons.at(-1);
  }
  context(meta) {
    this.orgPolicyDigests.set(meta.sessionId, null);
    const failures = this.sessionFailures.get(meta.sessionId);
    const state = require('./policy-state.cjs').policyState(this.loc.data, meta.sessionId, {licenseReader: this.licenseReader});
    let {config: selected, license} = state;
    const org = state.orgPolicy ? {envelope: state.orgPolicy} : null;
    // A Guard Pack scan the hook could not finish keeps enforce mode: raw-text
    // matches still stop, and command rules, caps and the built-in stops apply.
    // A branch the hook could not read warns only for the branch-dependent
    // history rules (GP003, GP004); nothing else is softened silently.
    if (meta.guardScanReason && !['guard_branch_unknown', 'guard_scan_incomplete'].includes(meta.guardScanReason)) throw new Error('guard_scan_reason_invalid');
    const text = JSON.stringify(selected);
    if (text !== this.policyText) { this.policyValue = validatePolicy(selected); this.policyText = text; this.guards.clear(); }
    if (org?.envelope) this.orgPolicyDigests.set(meta.sessionId, org.envelope.sha256);
    // The worker can retain a failure even when disk writes themselves fail.
    // A stale ready file must never override the most recent failed refresh.
    let failure = this.preferredSessionFailure(meta.sessionId);
    if (require('./org-policy.cjs').soloEnabled(license) && failures instanceof Map) {
      const reasons = [...failures].filter(([source]) => source !== 'org').map(([, reason]) => reason);
      failure = reasons.includes('seat_revoked') ? 'seat_revoked' : reasons.at(-1);
    }
    if (failure) license = {...license, mode: 'shadow', reason: license.reason === 'seat_revoked' ? 'seat_revoked' : failure,
      ...((failure === 'seat_revoked' || license.reason === 'seat_revoked') ? {seatRevoked: true} : {})};
    const mode = (license.paid || license.mode === 'enforce') && license.mode !== 'shadow' ? (this.policyValue.mode ?? 'enforce') : 'shadow';
    return {config: this.policyValue, license, orgPolicy: org?.envelope ?? null, mode};
  }
  licenseMetadata(decision, license, mode) {
    const reason = license.reason || null;
    decision.enforcementMode = mode;
    decision.plugin.license = {paid: license.paid === true, tier: license.tier ?? 'free',
      seatsUsed: license.seatsUsed ?? null, seatLimit: license.seatLimit ?? null,
      expiresAt: license.expiresAt ?? null, mode, reason, offlineGrace: license.offlineGrace === true};
    if (reason) {
      decision.reasons = [reason, ...decision.reasons.filter(value => value !== reason)];
      if (decision.plugin.reasonCode && decision.plugin.reasonCode !== reason) decision.plugin.policyReasonCode = decision.plugin.reasonCode;
      decision.plugin.reasonCode = reason;
    }
    return decision;
  }
  failureLicense(decision, meta) {
    try { const {license, mode} = this.context(meta); this.licenseMetadata(decision, license, mode); }
    catch (error) {
      // A policy file that fails validation is recorded as exactly that, so a
      // fail-open row never reads as a licensing problem.
      const reason = /policy|pattern|rule|quantif|ENOENT|EACCES|EISDIR|readable/i.test(error?.message ?? '') ? 'policy_invalid' : 'license_required';
      this.licenseMetadata(decision, {paid: false, reason, tier: 'free'}, 'shadow');
    }
    return decision;
  }
  basic(meta, action, reasonCode, actor = { tenantId: 'local', sessionId: meta.sessionId, agentId: meta.agentId ?? meta.sessionId }) {
    return { decisionId: crypto.randomUUID(), timestamp: new Date().toISOString(), action, actor,
      triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0,
      provider: meta.host ?? hostContext().host, modelRequested: meta.toolName, modelResolved: meta.toolName, policyId: basePolicy.id,
      policyVersion: 1, enforcementMode: 'enforce', reasons: [reasonCode], plugin: { host: hostContext().host, ...meta, event: 'decision', reasonCode } };
  }
  // Operator consent for a benchmark run: one signed ledger row, and a small
  // file naming that row so the benchmark hook can find and verify it. A later
  // row with granted false revokes it. Only the daemon writes here.
  async benchmarkConsent(runId, granted = true) {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(runId)) throw new Error('benchmark_run_id_invalid');
    const decision = this.basic({toolName: 'benchmark', sessionId: 'operator', toolUseId: runId, gate: 'control'}, 'allow', granted ? 'benchmark_consent' : 'benchmark_consent_revoked');
    decision.plugin = {...decision.plugin, event: 'benchmark_consent', runId, granted: granted === true};
    const sequence = this.sequence;
    await this.append(decision);
    const file = path.join(this.loc.data, 'benchmark-consent.json');
    if (granted) {
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({version: 1, run_id: runId, sequence, entry_hash: this.previousHash, issued_at: decision.timestamp}) + '\n', {flag: 'wx', mode: 0o600});
      fs.renameSync(temporary, file);
    } else { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return {sequence, entryHash: this.previousHash, granted: granted === true};
  }
  async append(decision) {
    const entry = await sdk.signDecision({ sequence: this.sequence, decision, previousHash: this.previousHash, privateKey: this.privateKey, publicKey: this.publicKey });
    await this.logStore.append(entry); this.sequence++; this.previousHash = entry.entryHash;
    if (this.v1Journal) {
      // Another agent's message entered the session: the open format's own kind,
      // with the requester (already a keyed digest here) and the receiving agent salted.
      if (decision.plugin?.event === 'delegation') await this.v1Journal.writer.recordDelegation({requester: decision.plugin.requester ?? null, delegate: decision.actor.agentId}, {legacyEntry: entry});
      else await this.v1Journal.writer.recordDecision(decision, {legacyEntry: entry, provider: 'plugin'});
    }
    this.tally.observe(decision);
    return decision;
  }
  // A fresh cumulative closing receipt after each period of activity.
  // Repeated endings without changes are idempotent. Deferred events are recorded
  // first, so the receipt counts every call this plugin decided.
  async sessionReceipt({sessionId, transcriptPath} = {}) {
    try { await this.drainSpool(); } catch { /* The receipt counts the rows already signed. */ }
    let result;
    try { result = await this.writeReceipt({sessionId, transcriptPath}); }
    catch { result = {receipt: 'failed'}; }
    // Older requests that waited for a worker come after this one, which knows more.
    try { await this.drainReceiptSpool(); } catch { /* Read again at the next request or start. */ }
    return result;
  }
  async writeReceipt({sessionId, transcriptPath}) {
    const id = identifier(sessionId, null);
    if (!id) return {receipt: 'invalid'};
    await this.reconcileExternal(id);
    const {cursor, view} = this.burnFacts(id, transcriptPath);
    const receipt = workReceipt.buildReceipt({counts: this.tally.counts(id), cursor, view,
      burnPolicyMode: this.burnPolicyMode(), pluginVersion: require('../package.json').version});
    const previous = this.tally.receipts.get(id);
    if (this.tally.receipted.has(id) && JSON.stringify(previous?.plugin.receipt) === JSON.stringify(receipt)) return {receipt: 'duplicate'};
    const row = this.basic({toolName: workReceipt.RECEIPT_EVENT, sessionId: id, toolUseId: crypto.randomUUID(), gate: 'control'}, 'allow', workReceipt.RECEIPT_EVENT);
    row.plugin = {...row.plugin, event: workReceipt.RECEIPT_EVENT, receipt,
      ...(previous ? {previousReceiptId: previous.decisionId} : {})};
    await this.append(row);
    return {receipt: 'appended', sequence: this.sequence - 1, entryHash: this.previousHash};
  }
  // Requests that waited for a worker get receipts from the ledger alone: the
  // transcript locator is never stored, so Burn's counts are left out. A
  // request that fails waits again for the next request or start.
  async drainReceiptSpool() {
    for (const request of workReceipt.takeSpool(this.loc.data)) {
      try { await this.writeReceipt({sessionId: request.sessionId}); }
      catch { workReceipt.spoolRequest(this.loc.data, request.sessionId, request.endedAt); }
    }
    workReceipt.finishSpool(this.loc.data);
  }
  // Burn's reader for a Claude Code session, advanced to the end of its
  // transcripts the way the burn gate advances it on each tool call: the
  // cursor (sub-agents) and Burn's record of the session (tokens). Nothing
  // when the host is not Claude Code, the transcript cannot be read, Burn has
  // no sub-agent reader, or a session never read here is too large to read now.
  burnFacts(sessionId, transcriptPath) {
    if (hostContext().host === 'codex' && workReceipt.transcriptLocator(transcriptPath)) {
      const gateway = this.gateway ?? (this.receiptGateway ??= new burn.Gateway(burnHome(), {sign: false}));
      require('./launch-policy.cjs').observeCodexUsage(burn, gateway, {sessionId}, transcriptPath);
      return {view: gateway.peek(sessionId)};
    }
    if (hostContext().host !== 'claude-code' || !workReceipt.transcriptLocator(transcriptPath) || !readsSubagents(burn)) return {};
    try {
      if (!fs.statSync(transcriptPath).isFile()) return {};
      if (!fs.existsSync(claudeCursorFile(sessionId, transcriptPath).file) && workReceipt.transcriptBytes(transcriptPath) > workReceipt.UNREAD_LIMIT_BYTES) return {};
      // The burn gate's own gateway when it has one; otherwise one that reads
      // and records usage without creating Burn's signing key.
      const gateway = this.gateway ?? (this.receiptGateway ??= new burn.Gateway(burnHome(), {sign: false}));
      const cursor = claudeUsage(burn, gateway, {sessionId}, transcriptPath);
      return {cursor, view: gateway.peek(sessionId)};
    } catch { return {}; }
  }
  // The mode in Burn's policy file, as Burn loads it, when the file exists.
  burnPolicyMode() {
    const home = burnHome();
    if (!fs.existsSync(path.join(home, 'burn-policy.json'))) return undefined;
    try { return burn.loadPolicy(home, {notice: false}).mode; } catch { return undefined; }
  }
  afterReply() { this.logStore.afterReply(); }
  async flush() { return this.logStore.flush(); }
  async close() { try { await this.v1Journal?.close(); } finally { await this.logStore.close(); } }
  // summary is one plain sentence from the rule that stopped the call (a Burn finding, the guard pack message
  // or the cap), so the notification can say why in words; it never carries tool input.
  notifyStop(config, decision, ruleIds, summary) {
    try { this.stopNotifier({mode: decision.enforcementMode, stopped: decision.action === 'block', ruleIds, notifyOnStop: config.notifyOnStop ?? true, summary, dataDir: this.loc.data}); }
    catch { /* Desktop notification failure must never change a signed decision. */ }
  }
  async failure(meta, reasonCode) {
    const key = `${meta.gate}:${callKey(meta)}`;
    // A policy the worker could not read or validate, or a scan it could not
    // run, falls back to the built-in guard pack at its defaults in enforce:
    // a definite STOP match still stops, everything else is allowed with the
    // failure recorded. Unknown branch evidence softens only the history rules.
    let guard;
    try { guard = guardResult(meta.guardRuleIds ?? [], {}, meta.gate === 'receipt' ? 'shadow' : 'enforce', meta.guardScanReason === 'guard_branch_unknown' ? ['GP003', 'GP004'] : []); } catch { guard = {matches: [], warning: false, stop: false}; }
    const output = meta.gate === 'receipt' ? {} : guard.stop ? deny(guard.message) : {...allow(), ...(guard.warning ? {systemMessage: guard.message} : {})};
    if (this.failures.has(key)) return { output, warning: true, cause: reasonCode };
    const decision = this.basic(meta, guard.stop ? 'block' : 'allow', reasonCode);
    decision.plugin.event = guard.stop ? 'fail_closed' : 'fail_open';
    if (meta.gate !== 'receipt') { try { Object.assign(decision.plugin, this.originFields(meta.sessionId)); } catch { /* The failure row is still written. */ } }
    if (guard.stop) decision.reasons = [reasonCode, guard.message];
    if (guard.matches.length) { decision.plugin.guardPack = guard.matches; decision.plugin.guardPackMessage = guard.message; }
    this.failureLicense(decision, meta);
    await this.append(decision);
    this.failures.add(key);
    if (governs(meta)) { this.pending.set(callKey(meta), decision); this.completed.set(key, decision); }
    return { output, warning: true, cause: reasonCode };
  }
  async drainSpool() {
    const batch = this.loc.spool + '.recovering';
    // Recover an interrupted batch before handing off a fresh one. Rename BEFORE
    // reading so a concurrent client's append cannot be discarded unseen.
    if (!fs.existsSync(batch)) {
      try { fs.renameSync(this.loc.spool, batch); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    }
    const text = fs.readFileSync(batch, 'utf8');
    for (const line of text.split('\n').filter(Boolean)) await this.failure(withoutTransient(JSON.parse(line)), 'deferred_fail_open');
    fs.unlinkSync(batch);
  }
  async handle(message) {
    const meta = {host: hostContext().host, ...message.meta};
    const transient = {categories: meta.actionCategories, evidence: origin.cleanEvidence(meta.originEvidence)};
    for (const key of TRANSIENT) delete meta[key];
    // A prompt only marks or clears the session; it never writes a failure row.
    if (meta.gate === 'prompt') return this.prompt(meta, transient.evidence);
    try {
      await this.drainSpool();
      if (meta.gate === 'receipt') {
        try { return await this.receipt(meta); }
        finally { await this.observeInbound(meta, transient.evidence); }
      }
      if (meta.gate === 'spend' && SPAWN.has(meta.toolName)) return { output: allow() };
      // A command scan the hook could not run at all is recorded as exactly that.
      if (meta.commandScanFailed) return await this.failure(meta, 'scan_incomplete');
      const previous = this.completed.get(`${meta.gate}:${callKey(meta)}`);
      // A launch held for the person's answer is evaluated again, never replayed as a denial.
      const launchRecheck = previous?.plugin.launch && (previous.plugin.launch.maxDepth !== null || previous.plugin.launch.modelDecision !== 'off');
      if (previous && !launchRecheck && !meta.pageGuard && !previous.plugin.approvalNeeded && previous.plugin.asked !== true) {
        if (previous.action !== 'block') return {output: {...(previous.plugin.approvalRuleId ? {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: previous.plugin.approvalRuleId === origin.REASON ? origin.ASK_TEXT : `AgentGuard ${previous.plugin.approvalRuleId} requires your approval for this call. Allow this one call in the permission prompt.`}} : allow()), ...(previous.plugin.guardPackMessage ? {systemMessage: previous.plugin.guardPackMessage} : {})}};
        // A prior denial must not survive a switch to shadow mode.
        const {mode} = this.context(meta);
        if (mode === 'enforce') return {output: /^burn_override:/.test(previous.plugin.reasonCode ?? '') ? stopDeny(overrideRefusal(meta.host)) : deny(previous.reasons.join('; '))};
      }
      if (meta.gate === 'burn') return await this.burn(meta, message.transcriptPath, message.workingDirectory, transient);
      return await this.spend(meta, transient);
    } catch {
      // A block the worker had already decided is returned as that block even
      // when the ledger append that followed it failed; the row is kept aside.
      const computed = this.computedBlocks.get(`${meta.gate}:${callKey(meta)}`);
      if (computed) { this.computedBlocks.delete(`${meta.gate}:${callKey(meta)}`); this.keepAside(computed.decision); return {output: this.decorate(computed.output, computed.license), warning: true, cause: 'ledger_append_failed'}; }
      return await this.failure(meta, 'policy_or_runtime_error');
    }
  }
  // Rows the ledger refused (a full disk, a file changed outside the worker)
  // are kept beside it so the audit trail shows the gap; they carry no
  // signature because the chain could not take them.
  keepAside(decision) {
    try {
      const file = path.join(this.loc.data, 'ledger', 'unrecorded.ndjson');
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      fs.appendFileSync(file, JSON.stringify({keptAsideAt: new Date().toISOString(), decision}) + '\n', {mode: 0o600});
    } catch { /* Nothing else can be done for this row. */ }
  }
  async burn(meta, transcriptPath, workingDirectory, transient = {}) {
    const {config, license, mode} = this.context(meta);
    // What the hook saw of other agents' messages, before this launch is decided.
    await this.applyEvidence(meta, transient.evidence, config);
    const guard = guardResult(meta.guardRuleIds ?? [], config.guardPack, mode, meta.guardScanReason === 'guard_branch_unknown' ? ['GP003', 'GP004'] : []);
    if (guard.stop) {
      const blocked = this.basic(meta, 'block', 'guard_pack'); blocked.reasons = [guard.message];
      blocked.plugin.guardPack = guard.matches; blocked.plugin.guardPackMessage = guard.message;
      Object.assign(blocked.plugin, this.originFields(meta.sessionId));
      this.licenseMetadata(blocked, license, mode);
      this.computedBlocks.set(`burn:${callKey(meta)}`, {decision: blocked, output: deny(guard.message), license: {...license, mode}});
      await this.append(blocked); this.computedBlocks.delete(`burn:${callKey(meta)}`);
      this.completed.set(`burn:${callKey(meta)}`, blocked);
      this.notifyStop(config, blocked, guard.matches.filter(rule => rule.action === 'stop').map(rule => rule.id), guard.message);
      return {output: this.decorate(deny(guard.message), {...license, mode})};
    }
    if (matchingExternalBurn(meta, workingDirectory)) {
      if (SPAWN.has(meta.toolName)) {
        const mirror = this.basic(meta, 'shadow', 'burn_external_hook');
        if (guard.matches.length) { mirror.plugin.guardPack = guard.matches; mirror.plugin.guardPackMessage = guard.message; }
        Object.assign(mirror.plugin, this.originFields(meta.sessionId));
        this.licenseMetadata(mirror, license, mode);
        const result = await this.launchAdmission(meta, config, mode, mirror, {...allow(), ...(guard.warning ? {systemMessage: guard.message} : {})}, require('./launch-policy.cjs').observedTokens(this.burnFacts(meta.sessionId, transcriptPath).view));
        await this.append(mirror); this.completed.set(`burn:${callKey(meta)}`, mirror);
        if (mirror.action !== 'block' || mirror.plugin.asked) this.pending.set(callKey(meta), mirror);
        return result;
      }
      return {output: {...allow(), ...(guard.warning ? {systemMessage: guard.message} : {})}};
    }
    // Fresh installs enforce: Burn's policy is written, once, before the first
    // spawn this plugin gates in enforce mode.
    if (mode === 'enforce' && SPAWN.has(meta.toolName)) await this.seedBurnPolicy(meta);
    if (!this.gateway) this.gateway = new burn.Gateway(burnHome());
    let decision;
    const original = this.gateway.beforeSpawn;
    let output, observationFailed = false;
    // Burn's synchronous gateway reads its policy through loadPolicy before
    // reserving or signing. Adapting that one read for this call keeps Burn's
    // real home, ledger and receipt semantics without rewriting the policy
    // file: shadow is forced while this plugin is in shadow, and Burn's
    // once-per-home notice about missing fields stays off stderr, where any
    // write here means a failed observation.
    const policyModule = burnPolicyModule();
    if (mode === 'shadow' && !policyModule) throw new Error('burn_policy_adapter_unavailable');
    const loadPolicy = policyModule?.exports.loadPolicy;
    this.gateway.beforeSpawn = (...args) => { decision = original.apply(this.gateway, args); return decision; };
    if (policyModule) policyModule.exports.loadPolicy = (home, options) => {
      const policy = loadPolicy(home, {...options, notice: false});
      return mode === 'shadow' ? {...policy, mode: 'shadow'} : policy;
    };
    const stderrWrite = process.stderr.write;
    process.stderr.write = () => { observationFailed = true; return true; };
    try { output = runBurnHook(burn, this.gateway, meta, transcriptPath); }
    finally { this.gateway.beforeSpawn = original; process.stderr.write = stderrWrite; if (policyModule) policyModule.exports.loadPolicy = loadPolicy; }
    if (decision?.failedClosed || observationFailed) throw new Error('burn_internal_error');
    const verdict = output.hookSpecificOutput?.permissionDecision;
    // Held behind Claude Code's own permission prompt: the person answers.
    const asked = verdict === 'ask' && decision?.blocked === true;
    if (decision) {
      const mirror = this.basic(meta, mode === 'shadow' && !license.paid ? 'shadow' : (decision.blocked ? 'block' : decision.wouldBlock ? 'shadow' : 'allow'), `burn_${decision.verdict.toLowerCase()}`);
      mirror.enforcementMode = decision.mode;
      mirror.plugin.burnReceiptId = decision.receipt?.receiptId ?? decision.decisionId;
      if (asked) mirror.plugin.asked = true;
      if (guard.matches.length) { mirror.plugin.guardPack = guard.matches; mirror.plugin.guardPackMessage = guard.message; }
      Object.assign(mirror.plugin, this.originFields(meta.sessionId));
      this.licenseMetadata(mirror, license, decision.mode);
      const admission = await this.launchAdmission(meta, config, mode, mirror, {...output, ...(guard.warning ? {systemMessage: [output.systemMessage, guard.message].filter(Boolean).join('\n')} : {})}, require('./launch-policy.cjs').observedTokens(this.gateway.peek(meta.sessionId)));
      await this.append(mirror); this.completed.set(`burn:${callKey(meta)}`, mirror);
      // The person is already looking at the prompt for an asked launch.
      if (decision.verdict === 'STOP' && decision.blocked && !asked) {
        const stops = decision.report.findings.filter(finding => finding.verdict === 'STOP');
        this.notifyStop(config, mirror, stops.map(finding => finding.detector), stops.map(finding => finding.summary).filter(Boolean).join(' '));
      }
      if (mirror.action !== 'block' || mirror.plugin.asked) this.pending.set(callKey(meta), mirror);
      if (admission.changed) return admission;
    }
    if (asked) return {output: {hookSpecificOutput: output.hookSpecificOutput}};
    // The STOP box is Burn's own text and keeps its lines.
    if (verdict === 'deny') return { output: this.decorate(stopDeny(output.hookSpecificOutput.permissionDecisionReason), {...license, mode}) };
    const messages = [output.systemMessage, guard.warning ? guard.message : null].filter(Boolean);
    return { output: { ...allow(), ...(messages.length ? { systemMessage: messages.join(' ').replace(/[\r\n]+/g, ' ') } : {}) } };
  }
  async launchAdmission(meta, config, mode, mirror, output, sessionTokens) {
    if (!SPAWN.has(meta.toolName)) return {output};
    const session = config.sessions?.[meta.sessionId] ?? {};
    const limits = [config.max_depth, session.max_depth].filter(value => value != null);
    const maxDepth = limits.length ? Math.min(...limits) : null;
    const launch = {...(meta.launch ?? {depth: null, source: 'unavailable', callerId: null}), maxDepth,
      depthDecision: maxDepth === null ? 'off' : meta.launch?.depth == null ? 'lineage_unavailable' : meta.launch.depth > maxDepth ? 'over_limit' : 'within_limit',
      modelDecision: 'off', toModel: null, tokenBudget: null, sessionTokens};
    mirror.plugin.launch = launch;
    const routing = session.helper_models ?? config.helper_models;
    let routed;
    if (routing?.enabled && !meta.launch?.resumed) {
      if (sdk.HELPER_MODEL_ROUTING_VERSION !== 1) throw new Error('helper_routing_sdk_unavailable');
      routed = await sdk.evaluatePolicy({...basePolicy, mode, requiredCapability: 'read_only',
        helperModelRouting: {enabled: true, tokenBudget: routing.token_budget, helperTypes: routing.helper_types, keepTypes: [...new Set([...(config.helper_models?.keep_types ?? []), ...(routing.keep_types ?? [])])], downgradeTo: routing.model}},
      {scope: mirror.actor, provider: meta.host === 'claude-code' ? 'anthropic' : 'openai', model: meta.launch?.fromModel ?? 'inherit',
        inputTokens: 0, outputTokens: 0, capabilityClaim: 'read_only',
        helperLaunch: {kind: 'helper', agentType: meta.launch?.agentType ?? '', sessionTokens}}, this.spendStore);
      launch.tokenBudget = routing.token_budget;
      launch.modelDecision = 'unchanged';
      launch.reason = 'helper_policy_unchanged';
      if (routed.modelResolved !== routed.modelRequested) {
        launch.toModel = routed.modelResolved;
        launch.reason = 'helper_token_budget';
        launch.modelDecision = mode !== 'enforce' ? 'shadow' : meta.launch?.modelRewriteSupported ? 'rewrite' : 'suggestion';
      }
    }
    const reasons = [];
    if (launch.depthDecision === 'over_limit') reasons.push(`AgentGuard: a ${launch.callerType ?? 'helper'} agent (${launch.callerId ?? 'unknown'}) tried to launch another agent at depth ${launch.depth}. Your depth limit is ${maxDepth}.`);
    if (launch.modelDecision === 'suggestion') reasons.push(`AgentGuard: Helper ${meta.launch?.agentType} passed your ${launch.tokenBudget} token budget (${sessionTokens} recorded). Choose ${launch.toModel} for this helper. This host has no verified per-launch model override.`);
    const initial = output.hookSpecificOutput?.permissionDecision;
    // A launch asked for by another agent's message waits for the owner.
    const untrusted = this.originCheck(meta, config, {launch: true});
    if (untrusted) mirror.plugin.originCategories = untrusted.categories;
    if (untrusted?.action === 'block' && mode === 'enforce' && initial !== 'deny') {
      mirror.action = 'block'; mirror.reasons.push(origin.REASON);
      return {output: deny(origin.BLOCK_TEXT), changed: true};
    }
    if (untrusted?.action === 'ask') reasons.push(origin.ASK_TEXT);
    let held = false;
    if (reasons.length && mode === 'enforce' && initial !== 'deny') {
      const why = reasons.join(' ');
      if (meta.host === 'claude-code' && ['default', 'manual', 'acceptEdits', 'auto', 'plan'].includes(meta.permissionMode)) {
        output = {...output, ...require('./common.cjs').ask([output.hookSpecificOutput?.permissionDecisionReason, why, 'Allow this one launch? If you say no, nothing starts.'].filter(Boolean).join('\n'))};
        mirror.plugin.asked = true; held = true;
      } else if (!require('./policy-approval.cjs').consume(this.loc.data, meta, config)) {
        require('./policy-approval.cjs').requestApproval(this.loc.data, meta, config, Date.now(), launch.depthDecision === 'over_limit' ? 'max_depth' : untrusted ? origin.REASON : 'helper_model');
        output = deny(`${why} The launch is paused until you allow it. In your own terminal, run node runtime/policy-cli.cjs pending, approve the exact call, then retry.`);
        mirror.plugin.approvalNeeded = true; held = true;
      } else if (untrusted) mirror.plugin.approved_by = 'owner';
      if (held) mirror.action = 'block';
      if (launch.depthDecision === 'over_limit' || launch.modelDecision === 'suggestion') mirror.reasons.push(launch.depthDecision === 'over_limit' ? 'launch_depth_limit' : 'helper_model_suggestion');
      if (untrusted) mirror.reasons.push(origin.REASON);
    } else if (untrusted) {
      // Shadow mode records what it would have asked.
      mirror.reasons.push(origin.REASON);
      if (mirror.action === 'allow') mirror.action = 'shadow';
    }
    let modelPatch;
    if (launch.modelDecision === 'rewrite' && output.hookSpecificOutput?.permissionDecision !== 'deny') {
      modelPatch = launch.toModel;
      mirror.modelRequested = routed.modelRequested; mirror.modelResolved = routed.modelResolved;
      if (!held && mirror.action !== 'block') mirror.action = 'downgrade';
      mirror.reasons.push(...routed.reasons);
    } else if (launch.modelDecision === 'rewrite') launch.modelDecision = 'unchanged';
    if (launch.depthDecision === 'lineage_unavailable' && mode === 'enforce') output = {...output, systemMessage: [output.systemMessage, 'AgentGuard cannot verify launch depth here. The existing count limit still applies.'].filter(Boolean).join('\n')};
    const missingUsage = routing?.enabled && sessionTokens === null;
    if (missingUsage) output = {...output, systemMessage: [output.systemMessage, 'AgentGuard cannot read session token usage here. The helper model stays unchanged.'].filter(Boolean).join('\n')};
    return {output, ...(modelPatch ? {modelPatch} : {}), changed: held || !!modelPatch || launch.depthDecision === 'lineage_unavailable' || missingUsage};
  }
  // Fresh installs enforce. Burn's own first-run default is shadow, so a
  // machine with no Burn policy file recorded every STOP and refused none.
  // While this plugin enforces, it writes Burn's shipped policy in enforce mode
  // once. An existing file is never replaced: a person who chose shadow keeps
  // shadow. The link is atomic and fails if a file appeared meanwhile.
  async seedBurnPolicy(meta) {
    const home = burnHome(), file = path.join(home, 'burn-policy.json');
    if (fs.existsSync(file)) return false;
    const text = JSON.stringify({...burn.DEFAULT_POLICY, mode: 'enforce'}, null, 2) + '\n';
    let created = false;
    try {
      fs.mkdirSync(home, {recursive: true, mode: 0o700});
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, text, {flag: 'wx', mode: 0o600});
      try {
        try { fs.linkSync(temporary, file); created = true; }
        catch (error) {
          if (error.code === 'EEXIST') return false;
          // A volume without hard links still never overwrites an existing file.
          fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL); created = true;
        }
      } finally { try { fs.unlinkSync(temporary); } catch { /* Already gone. */ } }
    } catch { return false; } // An unwritable home leaves Burn's own behavior in place.
    if (!created) return false;
    const row = this.basic({toolName: 'burn_policy', sessionId: meta.sessionId, toolUseId: crypto.randomUUID(), gate: 'control'}, 'allow', 'burn_policy_seeded');
    row.plugin = {...row.plugin, event: 'burn_policy_seeded', burnPolicyMode: 'enforce', burnPolicySha256: crypto.createHash('sha256').update(text).digest('hex')};
    // A ledger that refuses the row keeps it beside the chain; the spawn is still gated.
    try { await this.append(row); } catch { this.keepAside(row); }
    return true;
  }
  // The Burn gate enforces when this plugin enforces and Burn's policy is in
  // enforce mode. With no policy file yet, the first gated spawn writes one in
  // enforce mode, so the gate is already enforcing.
  burnEnforcing(mode) {
    if (mode !== 'enforce') return false;
    const home = burnHome();
    if (!fs.existsSync(path.join(home, 'burn-policy.json'))) return true;
    return burn.loadPolicy(home, {notice: false}).mode === 'enforce';
  }
  async spend(meta, transient = {}) {
    const {config, license, mode} = this.context(meta), session = config.sessions?.[meta.sessionId] ?? {};
    // What the hook saw of other agents' messages, before this call is decided.
    await this.applyEvidence(meta, transient.evidence, config);
    require('./page-guard.cjs').validate(meta.pageGuard, config.guardPack);
    const guard = guardResult(meta.guardRuleIds ?? [], config.guardPack, mode, meta.guardScanReason === 'guard_branch_unknown' ? ['GP003', 'GP004'] : []);
    if (meta.builtInStop !== undefined && !Object.hasOwn(BUILT_IN, meta.builtInStop)) throw new Error('built_in_stop_invalid');
    if (meta.burnOverride !== undefined && !['command', 'file'].includes(meta.burnOverride)) throw new Error('burn_override_invalid');
    // The agent cannot lift a Burn STOP itself while the Burn gate enforces:
    // running resume, shadow or calibrate, or writing Burn's override or policy
    // file, is refused and the agent is told to ask the person.
    const overrideAttempt = meta.burnOverride !== undefined && this.burnEnforcing(mode) ? `burn_override:${meta.burnOverride}` : undefined;
    const match = /^mcp__(.+?)__(.+)$/.exec(meta.toolName);
    const provider = match?.[1] ?? meta.host ?? hostContext().host, model = match?.[2] ?? meta.toolName;
    const actor = { tenantId: config.tenantId ?? 'local', sessionId: meta.sessionId, agentId: meta.agentId ?? session.agentId ?? meta.sessionId,
      ...((session.matterId ?? config.defaultMatterId) ? { taskId: session.matterId ?? config.defaultMatterId } : {}), provider };
    let capability = minimumCapability(meta.toolName);
    const payment = new RegExp(config.paymentPattern ?? require('./policy-schema.cjs').DEFAULT_PAYMENT_PATTERN, 'i').test(`${provider} ${model}`);
    if (payment) capability = 'payment_initiate';
    const minimumClassification = capability;
    let unitCostCents = 0, requiredCapability;
    for (const rule of config.toolRules ?? []) if (new RegExp(rule.pattern, 'i').test(meta.toolName)) {
      capability = rule.capability ?? capability; unitCostCents = rule.unitCostCents ?? unitCostCents;
      requiredCapability = rule.requiredCapability ?? requiredCapability;
    }
    if (tiers.indexOf(capability) < tiers.indexOf(minimumClassification)) capability = minimumClassification;
    const command = require('./command-policy.cjs').commandResult(config, meta);
    // The built-in stop is not a configurable rule: no layer can turn it off.
    let reason = guard.stop ? guard.message : overrideAttempt ?? (meta.builtInStop ? `built_in:${meta.builtInStop}` : command?.action === 'block' ? `command_rule:${command.id}` : undefined);
    for (const scope of [config, session]) {
      const allowlists = scope.allowedToolGroups ?? (scope.allowedTools === undefined ? [] : [scope.allowedTools]);
      if (allowlists.some(patterns => !matches(patterns, meta.toolName))) reason = 'tool_not_allowlisted';
      if (matches(scope.deniedTools, meta.toolName)) reason = 'tool_denied';
      if (matches(scope.ethicalWall, meta.toolName)) reason = 'ethical_wall';
      if (scope.maxCapability && tiers.indexOf(capability) > tiers.indexOf(scope.maxCapability)) reason = 'capability_tier_exceeded';
    }
    // A request from another agent's message, in a configured category: held
    // for the owner (ask) or refused (block), decided before caps.
    let untrusted = this.originCheck(meta, config, {categories: transient.categories, capability});
    // An agent network's own send: a plain reply to the agent that last
    // messaged this session runs; files, a notification or another recipient
    // wait for the owner, marked or not. Only key names reach this point.
    const send = transient.evidence?.send && origin.settings(config).action !== 'off' ? transient.evidence.send : null;
    const reply = Boolean(send && !send.extras.length && send.recipient && send.recipient === this.lastPeers.get(meta.sessionId));
    if (reply) untrusted = null;
    const sendHold = Boolean(send && !reply);
    if ((untrusted?.action === 'block' || sendHold && this.originState(meta.sessionId).tainted && origin.settings(config).action === 'block') && mode === 'enforce') reason ||= origin.REASON;
    let decision;
    const caps = [...(config.caps ?? []), ...(session.caps ?? []).map(cap => ({ ...cap, selector: { ...cap.selector, sessionId: meta.sessionId } }))]
      .map(cap => ({ ...cap, action: cap.action ?? 'block' }));
    const sessionCap = caps.find(cap => cap.window === 'per_session' && cap.action !== 'allow'
      && !Object.entries(cap.selector ?? {}).some(([key, value]) => actor[key] !== value)
      && this.charges(meta.sessionId).filter(charge => charge.actor.tenantId === actor.tenantId
        && Object.entries(cap.selector ?? {}).every(([key, value]) => charge.actor[key] === value)).reduce((sum, charge) => sum + charge.cents, 0) + unitCostCents > cap.amountCents);
    if (sessionCap && sessionCap.action === 'block') reason ||= 'cap:per_session';
    let approvalOutput, commandHeld = false, approvedOnce = false;
    const once = 'To allow once, the operator runs node runtime/policy-cli.cjs pending, then node runtime/policy-cli.cjs approve <token> in their own terminal. Retry the exact call within five minutes.';
    if (command?.action === 'block' && command.allowOnce && reason === `command_rule:${command.id}` && mode === 'enforce') {
      approvedOnce = require('./policy-approval.cjs').consume(this.loc.data, meta, config);
      if (approvedOnce) reason = undefined;
      else { require('./policy-approval.cjs').requestApproval(this.loc.data, meta, config, Date.now(), command.id); commandHeld = true; }
    }
    const askRule = guard.ask ? 'GP020' : command?.action === 'ask' ? command.id : null;
    const originAsk = untrusted?.action === 'ask', sendAsk = sendHold && reason !== origin.REASON;
    const approvalRule = askRule ?? (originAsk ? origin.REASON : sendAsk ? origin.SEND_REASON : null);
    let approvedByOwner = false;
    if (!reason && approvalRule && mode === 'enforce' && !approvedOnce) {
      if (meta.host === 'claude-code') approvalOutput = {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason:
        [askRule ? `AgentGuard ${askRule} requires your approval for this call. Allow this one call in the permission prompt.` : null, originAsk ? origin.ASK_TEXT : null, sendAsk ? origin.SEND_TEXT : null].filter(Boolean).join(' ')}};
      else if (!require('./policy-approval.cjs').consume(this.loc.data, meta, config)) {
        // The token never reaches the model or the ledger. The operator lists
        // held calls with `policy-cli pending` in their own terminal.
        require('./policy-approval.cjs').requestApproval(this.loc.data, meta, config, Date.now(), approvalRule);
        const message = [askRule ? `AgentGuard ${askRule} requires operator confirmation.` : null, originAsk ? origin.ASK_TEXT : null, sendAsk ? origin.SEND_TEXT : null, once].filter(Boolean).join(' ');
        const held = this.basic(meta, 'block', `approval_required:${approvalRule}`, actor); held.plugin.approvalNeeded = true;
        if (guard.matches.length) { held.plugin.guardPack = guard.matches; held.plugin.guardPackMessage = guard.message; }
        Object.assign(held.plugin, this.originFields(meta.sessionId), untrusted ? {originCategories: untrusted.categories} : {}, send ? {agentSend: {reply, extras: send.extras}} : {});
        if (originAsk && askRule) held.reasons.push(origin.REASON);
        if (sendAsk && approvalRule !== origin.SEND_REASON) held.reasons.push(origin.SEND_REASON);
        if (meta.guardScanReason) held.reasons.push(`guard_scan:${meta.guardScanReason}`);
        this.licenseMetadata(held, license, mode); await this.append(held); this.completed.set(`spend:${callKey(meta)}`, held);
        return {output: deny(message)};
      } else if (originAsk || sendAsk) approvedByOwner = true;
    }
    const policy = { ...basePolicy, scope: { tenantId: actor.tenantId }, mode, caps: caps.filter(cap => cap.window !== 'per_session'), ...(requiredCapability ? { requiredCapability } : {}) };
    const call = {scope: actor, provider, model, inputTokens: 1000, outputTokens: 0, capabilityClaim: capability};
    if (reason && mode === 'enforce') decision = this.basic(meta, 'block', reason, actor);
    else {
      sdk.setCostOverride(model, {inputCentsPerKtok: unitCostCents, outputCentsPerKtok: 0});
      // The public policy evaluator is local and already handles scoped caps.
      // Session startup owns license resolution; no SDK license request belongs
      // inside this hook's decision path.
      decision = await sdk.evaluatePolicy(policy, call, this.spendStore);
      const basis = sdk.costBasisFor(decision.modelResolved);
      if (basis) decision.costBasis = basis;
      decision.reasons = [reason ?? (decision.action === 'block' ? 'spend_or_capability_policy_blocked' : decision.action === 'shadow' ? 'shadow_policy_would_block' : 'tool_policy_allowed')];
      if (mode === 'shadow' && decision.action === 'block') {
        // Capability gates normally fail closed even in the SDK's shadow mode.
        // The shadow fallback observes every tool, including these calls, and keeps
        // their actual configured unit cost in its shared window accounting.
        await sdk.adjustPolicyWindowSpend(policy, this.spendStore, unitCostCents, call);
        decision.projectedCents = unitCostCents;
        decision.action = 'shadow';
      }
      if (mode === 'shadow' && (!license.paid || reason)) decision.action = 'shadow';
      if ((guard.warning || sessionCap) && decision.action === 'allow') decision.action = 'shadow';
      // Shadow mode records what the untrusted-origin check would have held.
      if ((untrusted || sendHold) && mode !== 'enforce' && decision.action === 'allow') decision.action = 'shadow';
    }
    const windows = new Map();
    if (decision.action !== 'block') for (const cap of caps) {
      if (['per_call', 'per_session'].includes(cap.window) || Object.entries(cap.selector ?? {}).some(([key, value]) => actor[key] !== value)) continue;
      const scopeKey = sdk.buildScopeKey({ ...policy.scope, ...cap.selector });
      windows.set(`${scopeKey}:${cap.window}`, { scopeKey, window: cap.window, windowStart: startWindow(cap.window) });
    }
    decision.plugin = { ...meta, event: 'decision', capabilityTier: capability, unitCostCents,
      chargedCents: decision.action === 'block' ? 0 : unitCostCents, chargedWindows: [...windows.values()],
      ...(reason ? { reasonCode: reason } : {}), ...this.originFields(meta.sessionId),
      ...(untrusted ? {originCategories: untrusted.categories} : {}), ...(send ? {agentSend: {reply, extras: send.extras}} : {}),
      ...(approvedByOwner ? {approved_by: 'owner'} : {}) };
    if (untrusted && reason !== origin.REASON) decision.reasons.push(origin.REASON);
    if (sendHold && reason !== origin.REASON) decision.reasons.push(origin.SEND_REASON);
    if (guard.matches.length) { decision.plugin.guardPack = guard.matches; decision.plugin.guardPackMessage = guard.message; decision.reasons.push(...guard.matches.filter(item => item.action !== 'off').map(item => `guard_pack:${item.id}:${item.action}`)); }
    if (sessionCap) decision.reasons.push('cap:per_session');
    if (meta.guardScanReason) decision.reasons.push(`guard_scan:${meta.guardScanReason}`);
    if (meta.commandScanIncomplete) decision.reasons.push('scan_incomplete');
    if (meta.pageGuard?.errors) decision.reasons.push('page_guard:fail_open');
    if (meta.pageGuard?.skippedFiles) decision.reasons.push('page_guard:over_size_limit');
    if (commandHeld) decision.plugin.approvalNeeded = true;
    if (approvalOutput && decision.action !== 'block') decision.plugin.approvalRuleId = approvalRule;
    this.licenseMetadata(decision, license, mode);
    const explanation = meta.builtInStop && reason === `built_in:${meta.builtInStop}` ? ` ${BUILT_IN[meta.builtInStop]}` : reason === origin.REASON ? ` ${origin.BLOCK_TEXT}` : '';
    // An override attempt is answered in Burn's words, which tell the agent to ask the person.
    const refusedOverride = overrideAttempt !== undefined && reason === overrideAttempt;
    const refusal = () => refusedOverride ? stopDeny(overrideRefusal(meta.host)) : deny(decision.reasons.join('; ') + explanation + (commandHeld ? ' ' + once : ''));
    if (decision.action === 'block') this.computedBlocks.set(`spend:${callKey(meta)}`, {decision, output: refusal(), license: {...license, mode}});
    await this.append(decision); this.computedBlocks.delete(`spend:${callKey(meta)}`);
    if (decision.action !== 'block' && unitCostCents) this.addCharge(actor, unitCostCents);
    this.completed.set(`spend:${callKey(meta)}`, decision);
    if (decision.action === 'block' && mode === 'enforce' && !refusedOverride) {
      const ids = guard.matches.filter(rule => rule.action === 'stop').map(rule => rule.id);
      this.notifyStop(config, decision, ids.length ? ids : [decision.triggeredCap ? `cap:${decision.triggeredCap.window}` : reason || 'tool_policy'], ids.length ? guard.message : decision.reasons?.join('; '));
    }
    if (decision.action !== 'block') this.pending.set(callKey(meta), decision);
    return { output: decision.action === 'block' ? this.decorate(refusal(), {...license, mode}) : {...(approvalOutput ?? allow()), ...(guard.warning ? {systemMessage: guard.message} : {})} };
  }
  async receipt(meta) {
    await this.reconcileExternal(meta.sessionId, meta.toolUseId);
    const original = this.pending.get(callKey(meta));
    if (!original) return this.failure(meta, 'outcome_without_decision');
    const durationMs = meta.durationMs ?? Math.max(0, Date.now() - Date.parse(original.timestamp));
    const { decision } = await this.outcomes.recordOutcomeReceipt({ flow: outcomeFlow(meta), decisionId: original.decisionId,
      status: meta.success === null ? 'unknown' : meta.success ? 'completed' : 'failed', durationMs, outputBytes: meta.outputBytes,
      totalCostCents: original.plugin.unitCostCents ?? 0 });
    decision.originalDecisionId = original.decisionId; decision.actor = original.actor;
    decision.plugin = { ...meta, ...(original.plugin.launch ? {launch: original.plugin.launch} : {}), event: 'outcome', decisionId: original.decisionId, durationMs, durationSource: meta.durationSource ?? 'elapsed_since_decision' };
    // A call that came from another agent's message keeps that link, and one
    // held for the owner (by AgentGuard's own prompt or approval ticket, never
    // by a tool's answer text) that then ran says who approved it.
    const marked = original.plugin.origin === origin.ORIGIN;
    const ownerYes = original.plugin.asked === true || typeof original.plugin.approvalRuleId === 'string' || original.plugin.approved_by === 'owner';
    if (marked) Object.assign(decision.plugin, {origin: origin.ORIGIN, delegation_entry_hash: original.plugin.delegation_entry_hash ?? null});
    if ((marked || original.plugin.agentSend) && ownerYes) decision.plugin.approved_by = 'owner';
    this.failureLicense(decision, meta);
    await this.append(decision); this.pending.delete(callKey(meta));
    // The owner approved a call held because of another agent's message, and
    // it ran: the owner is back, so the mark clears.
    if (marked && ownerYes && (Array.isArray(original.plugin.originCategories) || original.plugin.agentSend)) await this.clearTaint(meta, 'owner_approval');
    return { output: {} };
  }
  // Claude runs separate hooks concurrently. Its standalone Burn hook alone
  // reserves the count; import the signed verdict after hooks finish, before
  // linking a host outcome or closing the session. Old or unverifiable Burn
  // receipts leave an explicit gap, never an invented allow or approval.
  async reconcileExternal(sessionId, toolUseId) {
    if (typeof burn.readSpawnAdmission !== 'function') return;
    for (const [key, original] of this.completed) {
      const m = original.plugin;
      if (m.sessionId !== sessionId || (toolUseId && m.toolUseId !== toolUseId) ||
          ![m.reasonCode, m.policyReasonCode].includes('burn_external_hook')) continue;
      let external;
      try { external = burn.readSpawnAdmission(burnHome(), sessionId, m.toolUseId); }
      catch { continue; }
      if (!external) continue;
      const row = structuredClone(original), payload = external.payload;
      row.decisionId = crypto.randomUUID(); row.timestamp = new Date().toISOString();
      for (const field of ['reasonCode', 'policyReasonCode']) if (row.plugin[field] === 'burn_external_hook') row.plugin[field] = 'burn_external_verified';
      row.reasons = row.reasons.filter(reason => reason !== 'burn_external_hook');
      row.reasons.push('burn_external_verified');
      row.plugin.externalReceiptHash = burn.receiptDigest(external);
      row.plugin.externalDecisionId = payload.decisionId;
      if (payload.blocked) {
        row.action = 'block';
        if (payload.reasons.includes('decision:ask')) row.plugin.asked = true;
        else delete row.plugin.asked;
      } else if (row.action === 'shadow') {
        row.action = payload.policy.mode === 'shadow' && payload.verdict === 'STOP' ? 'shadow' : 'allow';
      }
      await this.append(row); this.completed.set(key, row);
      if (row.action !== 'block' || row.plugin.asked) this.pending.set(callKey(m), row);
      else this.pending.delete(callKey(m));
    }
  }
}
module.exports = { Engine, validatePolicy };
