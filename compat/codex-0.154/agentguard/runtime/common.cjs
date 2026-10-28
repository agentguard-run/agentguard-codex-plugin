'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const SPAWN = {has: name => require('./dependencies.cjs').loadDependency('@agentguard-run/burn/tool-names').isLaunchTool(name)};
function hostContext(env = process.env) {
  // Host identity comes from the launch environment, never tool input. Explicit
  // Codex paths win when a Codex process inherits a parent Claude environment.
  const host = env.PLUGIN_ROOT || env.PLUGIN_DATA ? 'codex'
    : env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PLUGIN_DATA ? 'claude-code' : 'codex';
  return { host, root: env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || undefined,
    data: env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || undefined,
    // Claude documents this as a skill substitution. Accept it if an operator
    // explicitly exports it, but hook session_id remains authoritative.
    sessionId: identifier(host === 'claude-code' ? env.CLAUDE_SESSION_ID : env.CODEX_THREAD_ID, null) ?? undefined };
}
function locations(dataOverride) {
  const data = path.resolve(dataOverride || hostContext().data || path.join(os.homedir(), '.agentguard', 'codex-plugin'));
  const tag = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
  // Hook IPC uses files only. The directory is private to this uid.
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${tag}`);
  return { data, ipc, ready: path.join(ipc, 'worker.ready'), socket: path.join(ipc, 'worker.ready'), lock: path.join(ipc, 'worker.lock'),
    spool: path.join(data, 'fail-open-pending.ndjson') };
}
function allow() { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }; }
function writeWorkerPid(lock, pid) {
  const temporary = `${lock}.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, String(pid), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, lock);
}
function deny(reason) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.replace(/[\r\n]+/g, ' ').slice(0, 700) } }; }
// Burn's own words (the STOP box, the override refusal) keep their lines: they
// are rendered by Burn from counts, never from policy or tool text, and the box
// is longer than one ordinary reason. Still bounded.
const STOP_TEXT_LIMIT = 4000;
function stopDeny(text) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(text).replace(/\r/g, '').slice(0, STOP_TEXT_LIMIT) } }; }
// Claude Code shows an ask as its own permission prompt: the person answers,
// and the reason is shown to the person, not to Claude.
function ask(reason) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: String(reason).replace(/\r/g, '').slice(0, STOP_TEXT_LIMIT) } }; }
function identifier(value, fallback = 'unknown') {
  return typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value) ? value : fallback;
}
function outcomeSuccess(raw, toolName) {
  if (hostContext().host === 'claude-code' && raw.hook_event_name === 'PostToolUseFailure') return false;
  const response = raw.tool_response;
  if (raw.is_error || response?.isError || response?.is_error || response?.error
    || (typeof response?.exit_code === 'number' && response.exit_code !== 0)) return false;
  if (raw.is_error === false || response?.isError === false || response?.is_error === false
    || response?.exit_code === 0) return true;
  // Codex 0.154 unified Bash hooks expose raw output only, without exit status.
  // Output text is untrusted: a printed "exit code" must not become audit evidence.
  if (toolName === 'Bash' && typeof response === 'string') return null;
  return true;
}
function metadata(raw, gate) {
  const caller = require('./launch-policy.cjs').lineage(raw, hostContext().host);
  const input = JSON.stringify(raw.tool_input ?? {});
  const response = raw.tool_response;
  // A failure's error text is counted in memory, never retained in metadata.
  const output = JSON.stringify(hostContext().host === 'claude-code' && raw.hook_event_name === 'PostToolUseFailure' ? raw.error ?? null : response ?? null);
  const toolName = identifier(raw.tool_name);
  const guard = gate === 'spend' && !SPAWN.has(toolName) || gate === 'burn' && SPAWN.has(toolName)
    ? require('./guard-pack.cjs').scanGuardPack(toolName, raw.tool_input, {cwd: raw.cwd}) : {ruleIds: []};
  let commands = {}, page, policyConfig;
  if (gate === 'spend' && !SPAWN.has(toolName)) {
    try {
      const sessionId = identifier(raw.session_id, hostContext().sessionId ?? 'unknown');
      const {config} = require('./policy-state.cjs').policyState(locations().data, sessionId);
      policyConfig = config;
      // The session transcript is protected too: it is the record the
      // untrusted-origin check reads to tell the owner's prompts from others'.
      commands = require('./command-policy.cjs').scanCommands(config, toolName, raw.tool_input, {cwd: raw.cwd, workspace: process.env.CLAUDE_PROJECT_DIR, transcriptPath: raw.transcript_path});
      if (config.guardPack?.rules?.GP020 && config.guardPack.rules.GP020 !== 'off') {
        const scanner = require('./page-guard.cjs');
        page = scanner.scan(toolName, raw.tool_input, {cwd: raw.cwd, threshold: config.guardPack.pageGuard?.internalLinkThreshold ?? 3});
        if (page) {
          page.meta.policySha256 = scanner.policyHash(config.guardPack);
          if (page.triggered) guard.ruleIds.push('GP020');
        }
      }
    } catch { commands = {commandScanFailed: true}; }
  }
  // Untrusted-origin evidence: every result, every gated call, and launches.
  const evidence = gate === 'receipt' || (gate === 'spend' ? !SPAWN.has(toolName) : gate === 'burn' && SPAWN.has(toolName)) ? originEvidence(raw, gate, toolName, policyConfig) : {};
  return require('./page-guard.cjs').attach({ ...commands, ...evidence, ...(page ? {pageGuard: page.meta} : {}), schema: 'agentguard.codex.v1', host: hostContext().host, requestId: crypto.randomUUID(), gate, toolName,
    toolUseId: identifier(raw.tool_use_id, crypto.randomUUID()), sessionId: identifier(raw.session_id, hostContext().sessionId ?? 'unknown'),
    ...(raw.agent_id ? { agentId: identifier(raw.agent_id) } : {}),
    agent_id: caller.callerId, agent_type: caller.callerType, depth: caller.depth === null ? null : caller.depth - 1,
    parent_agent_id: caller.parentAgentId,
    ...(SPAWN.has(toolName) ? require('./launch-policy.cjs').metadata(raw, hostContext().host) : {}),
    // A keyed digest of the input, under a local key the agent cannot read: a
    // plain SHA-256 of a short input can be recovered by guessing.
    inputDigest: require('./digest-key.cjs').keyedDigest(locations().data, 'input', input), inputDigestAlg: require('./digest-key.cjs').ALG,
    inputBytes: Buffer.byteLength(input), inputKeys: raw.tool_input && typeof raw.tool_input === 'object' ? Object.keys(raw.tool_input).length : 0,
    ...(guard.ruleIds.length ? {guardRuleIds: guard.ruleIds} : {}),
    ...(guard.reason ? {guardScanReason: guard.reason} : {}),
    startedAt: new Date().toISOString(),
    ...(gate === 'receipt' ? { outputBytes: Buffer.byteLength(output),
      ...(SPAWN.has(toolName) && spawnedAgentId(response) ? {spawned_agent_id: spawnedAgentId(response)} : {}),
      success: outcomeSuccess(raw, toolName),
      ...(Number.isFinite(raw.duration_ms) && raw.duration_ms >= 0 ? { durationMs: raw.duration_ms, durationSource: 'host' } : {}) } : {}) }, page);
}
// What the hook saw of other agents' messages (untrusted origin): booleans,
// times, prompt ids, key names and keyed digests, computed here so no text
// leaves the hook. The worker drops it from every row it signs. Any failure
// leaves it out.
function originEvidence(raw, gate, toolName, config) {
  try {
    const sessionConfig = config ?? require('./policy-state.cjs').policyState(locations().data, identifier(raw.session_id, hostContext().sessionId ?? 'unknown')).config;
    const evidence = require('./untrusted-origin.cjs').hookEvidence(raw, gate, toolName, {data: locations().data, host: hostContext().host, config: sessionConfig});
    return evidence ? {originEvidence: evidence} : {};
  } catch { return {}; }
}
function spawnedAgentId(response) {
  if (typeof response === 'string' && Buffer.byteLength(response) <= 16384) {
    try { response = JSON.parse(response); } catch { return null; }
  }
  return identifier(response?.agent_id ?? response?.agentId, null);
}
function spoolFailure(meta, reasonCode) {
  const { data, spool } = locations();
  try { fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.appendFileSync(spool, JSON.stringify({ ...meta, event: 'fail_open', reasonCode }) + '\n', { mode: 0o600 });
  } catch { /* Storage failure is itself fail-open. Never include payload or filesystem error text. */ }
}
function normalizeHookOutput(output, options = {}) {
  const specific = output?.hookSpecificOutput;
  const nativePermissions = hostContext().host === 'claude-code';
  if ((!nativePermissions && !options.legacyAllow) || specific?.hookEventName !== 'PreToolUse' ||
      specific.permissionDecision !== 'allow' || (!nativePermissions && specific.updatedInput != null)) return output;
  // An ordinary admission must preserve Claude's native permission prompts.
  // Codex 0.154 also accepts an empty response for an unmodified input.
  const normalized = {...output, hookSpecificOutput: {...specific}};
  delete normalized.hookSpecificOutput.permissionDecision;
  delete normalized.hookSpecificOutput.permissionDecisionReason;
  if (Object.keys(normalized.hookSpecificOutput).every(key => key === 'hookEventName')) delete normalized.hookSpecificOutput;
  return normalized;
}
function outcomeFlow(meta) { return meta.host === 'claude-code' ? 'claude-code-tool' : 'codex-tool'; }
function minimumCapability(toolName) {
  return /^(Bash|PowerShell|apply_patch|Edit|MultiEdit|Write|NotebookEdit)$/i.test(toolName) ? 'data_write' : 'read_only';
}
function standaloneBurnCommand(hook) {
  if (hook?.type !== 'command' || typeof hook.command !== 'string') return false;
  let words;
  if (Array.isArray(hook.args)) words = [hook.command, ...hook.args];
  else {
    // Only literal CLI commands are ownership evidence. Reject shell programs,
    // substitutions, comments and pipelines, including incidental echo text.
    if (/[;&|<>`$()#\r\n]/.test(hook.command)) return false;
    const tokens = hook.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    words = tokens.map(token => token.replace(/^(["'])(.*)\1$/, '$2'));
    if (words.some(word => /["']/.test(word))) return false;
  }
  if (words.some(word => typeof word !== 'string')) return false;
  const command = path.basename(words[0] ?? '');
  if (command === 'agentguard-burn') return words.length === 2 && words[1] === 'hook';
  if (command === 'node' || command === 'node.exe') return words.length === 3 && words[2] === 'hook' &&
    /(?:agentguard-burn|@agentguard-run[\\/]burn)[\\/](?:dist[\\/](?:src[\\/])?)?cli\.js$/.test(words[1]);
  if (command === 'npx' || command === 'npx.cmd') {
    const args = words.slice(1).filter(value => value !== '--no-install');
    return args.length === 2 && /^@agentguard-run\/burn(?:@[0-9][A-Za-z0-9.+-]*)?$/.test(args[0]) && args[1] === 'hook';
  }
  return false;
}
function matchingExternalBurn(meta, workingDirectory, env = process.env) {
  if (meta.host !== 'claude-code') return false;
  const configHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const directories = [workingDirectory, env.CLAUDE_PROJECT_DIR].filter(value => typeof value === 'string' && path.isAbsolute(value));
  const files = [...new Set([path.join(configHome, 'settings.json'), ...directories.flatMap(directory =>
    [path.join(directory, '.claude', 'settings.json'), path.join(directory, '.claude', 'settings.local.json')]),
    ...(process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json'] : ['/etc/claude-code/managed-settings.json'])])];
  for (const file of files) {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (settings.disableAllHooks === true) continue;
    const groups = settings.hooks?.PreToolUse;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      let matched = !group.matcher || group.matcher === '*';
      try { matched ||= new RegExp(group.matcher).test(meta.toolName); } catch { continue; }
      if (!matched) continue;
      if (group.hooks.some(standaloneBurnCommand)) return true;
    }
  }
  return false;
}
const claudeReaders = new WeakMap();
// Burn 0.3.21 reads a Claude Code session the way its own hook does: the
// session transcript and each sub-agent transcript beside it, every file from
// the byte offset it reached last time, and it saves, restores and copies that
// cursor itself. Sub-agent usage then counts toward "Session so far" and the
// session limit, as it does in Burn's own hook. With Burn 0.3.20 the session
// transcript alone is read, as before.
const readsSubagents = burn => ['readSessionIncremental', 'saveReaderCursor', 'restoreReaderCursor', 'cloneReaderCursor']
  .every(name => typeof burn[name] === 'function');
// A Burn 0.3 cursor holds two maps: the depth of each transcript line and, per
// model response, the usage already counted (Claude repeats one response's
// usage on every content block). Each attempt works on its own copies, and the
// file keeps both as entry lists. A cursor saved without the usage map (an
// older plugin) resumes with an empty one, which Burn creates on first use; one
// saved without sub-agent cursors reads each sub-agent transcript once, from
// its first byte.
function copyCursor(burn, cursor) {
  if (readsSubagents(burn)) return burn.cloneReaderCursor(cursor);
  return {...cursor, depthByUuid: new Map(cursor.depthByUuid),
    usageByMessage: cursor.usageByMessage instanceof Map ? new Map(cursor.usageByMessage) : undefined};
}
function savedCursor(burn, cursor) {
  if (readsSubagents(burn)) return burn.saveReaderCursor(cursor);
  return {...cursor, depthByUuid: [...cursor.depthByUuid], usageByMessage: cursor.usageByMessage instanceof Map ? [...cursor.usageByMessage] : undefined};
}
function restoredCursor(burn, saved) {
  if (readsSubagents(burn)) return burn.restoreReaderCursor(saved);
  return {...saved, depthByUuid: new Map(saved.depthByUuid),
    usageByMessage: Array.isArray(saved.usageByMessage) ? new Map(saved.usageByMessage) : undefined};
}
// Where the reader cursor of one session transcript is saved: named by a hash
// of the session id and the transcript locator, never by the path itself.
function claudeCursorFile(sessionId, transcriptPath) {
  const key = crypto.createHash('sha256').update(`${sessionId}:${transcriptPath}`).digest('hex');
  return {key, file: path.join(locations().data, 'claude-cursors', key + '.json')};
}
// Returns the cursor it advanced, for the line a STOP prints.
function claudeUsage(burn, gateway, meta, transcriptPath) {
  if (!transcriptPath) return null;
  let readers = claudeReaders.get(gateway);
  if (!readers) { readers = new Map(); claudeReaders.set(gateway, readers); }
  const {key, file} = claudeCursorFile(meta.sessionId, transcriptPath), directory = path.dirname(file);
  let reader = readers.get(key);
  const inode = fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath).ino : null;
  if (!reader) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    reader = saved?.inode === inode && saved.cursor && Array.isArray(saved.cursor.depthByUuid)
      ? {inode, index: saved.index, cursor: restoredCursor(burn, saved.cursor)}
      : {inode, index: 0, cursor: burn.newCursor()};
  }
  if (reader.inode !== inode || fs.existsSync(transcriptPath) && fs.statSync(transcriptPath).size < reader.cursor.offset)
    reader = {inode, index: 0, cursor: burn.newCursor()};
  // Advance the persisted cursor only after the gateway stores the observations.
  const next = {inode, index: reader.index, cursor: copyCursor(burn, reader.cursor)};
  const events = [];
  // Sub-agent records carry no launches or reads (Burn drops them), only usage.
  const read = readsSubagents(burn) ? burn.readSessionIncremental : burn.readIncremental;
  for (const record of read(transcriptPath, next.cursor)) {
    const id = identifier(record.uuid, `line-${next.index++}`);
    const base = {schemaVersion: 1, host: 'claude-code', sessionId: meta.sessionId, at: record.at};
    if (record.tokens) events.push({...base, kind: 'model_usage',
      eventId: `claude:usage:${id}:${record.tokens}:${record.cacheRead}`, callId: `claude:usage:${id}`,
      tokens: record.tokens, cacheRead: record.cacheRead, usageCoverage: 'authoritative'});
    for (const [index, spawn] of record.spawns.entries()) events.push({...base, kind: 'spawn_started',
      eventId: `claude:spawn:${id}:${index}`, spawnId: `claude:spawn:${id}:${index}`, depth: spawn.issuerDepth + 1});
    for (const [index, surface] of record.surfaces.entries()) events.push({...base, kind: 'surface_read',
      eventId: `claude:surface:${id}:${index}`, surfaceDigest: crypto.createHash('sha256').update(surface).digest('hex')});
  }
  gateway.observe(events);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const temporary = file + '.' + crypto.randomUUID();
  fs.writeFileSync(temporary, JSON.stringify({...next, cursor: savedCursor(burn, next.cursor)}), {mode: 0o600});
  fs.renameSync(temporary, file);
  readers.set(key, next);
  return next.cursor;
}
// A warning names what happens at the limit, as Burn 0.3.18's own Claude hook does.
const WARN_CONSEQUENCE = new Set(['spawn_rate', 'fanout', 'sustained_burn']);
function runBurnHook(burn, gateway, meta, transcriptPath) {
  const raw = {session_id: meta.sessionId, tool_name: meta.toolName, tool_use_id: meta.toolUseId,
    hook_event_name: 'PreToolUse', transcript_path: transcriptPath, ...(meta.agentId ? {agent_id: meta.agentId} : {})};
  if (meta.host !== 'claude-code') return burn.handleCodexHook(raw, gateway);
  let observation = {};
  if (!SPAWN.has(meta.toolName)) observation = burn.handlePreToolUse(raw, gateway.dataDirectory);
  else {
    // Burn's public native spawn handler has no policy override or decision
    // callback. Reuse its pinned advisory observer and public Gateway instead.
    // Only counts, tool names and the transcript locator cross this boundary.
    const entry = Object.values(require.cache).find(module => module.exports === burn);
    if (entry) {
      const live = path.join(path.dirname(entry.filename), 'insights', 'live.js');
      if (fs.existsSync(live)) {
        const result = require(live).observeTool(gateway.dataDirectory, raw, 'claude', burn.loadPolicy(gateway.dataDirectory));
        if (result.messages.length) observation.systemMessage = result.messages.join('\n');
      }
    }
  }
  const cursor = claudeUsage(burn, gateway, meta, transcriptPath);
  if (!SPAWN.has(meta.toolName)) return observation;
  const decision = gateway.beforeSpawn({schemaVersion: 1, kind: 'spawn_requested', eventId: `claude:request:${meta.toolUseId}`,
    host: 'claude-code', sessionId: meta.sessionId, at: Date.now(), spawnId: meta.toolUseId,
    proposedDepth: meta.agentId ? 2 : 1, attribution: 'high'});
  // Only the host's permission mode crosses into this decision, never tool input.
  // Claude Code can show its own prompt in default, acceptEdits, auto and plan
  // mode (auto cannot approve it silently); bypassPermissions, dontAsk and
  // print mode cannot, and a policy with "stopStyle": "deny" never asks.
  const asks = burn.asksPerson({permission_mode: meta.permissionMode}, burn.loadPolicy(gateway.dataDirectory));
  if (decision.blocked) {
    // What this session's finished sub-agents averaged, from the cursor just
    // advanced, exactly as Burn's own hook prints it; none with Burn 0.3.20.
    const costLine = cursor && typeof burn.decisionCostLine === 'function'
      ? burn.decisionCostLine(cursor, gateway.dataDirectory, burn.loadPolicy(gateway.dataDirectory)) : null;
    if (asks) return {...observation, ...ask(burn.askReason(decision.report, costLine))};
    // Burn's leading word joiner keeps Claude Code's "Error:" prefix off the box.
    return {...observation, ...stopDeny('\u2060\n' + burn.renderStop(decision.report, {colour: false, host: 'claude-code', costLine}))};
  }
  const warnings = [observation.systemMessage];
  // The line after an override names the limit it passed, not the first finding.
  if (decision.overridden) warnings.push(burn.overriddenLine(decision.report, decision.overridden));
  else if (decision.notify && decision.verdict !== 'OK') {
    const warn = decision.verdict === 'WARN' ? decision.report.findings.find(finding => finding.verdict === 'WARN') : undefined;
    const consequence = decision.mode === 'enforce' && warn && WARN_CONSEQUENCE.has(warn.detector)
      ? (asks ? ' Past the limit, the next launch waits for your yes.' : ' Past the limit, the next launch is refused.') : '';
    warnings.push(`AgentGuard ${decision.verdict}${decision.mode === 'shadow' && decision.wouldBlock ? ' (shadow: would have refused)' : ''}: ${burn.primarySummary(decision.report)}${consequence}`);
  }
  return warnings.some(Boolean) ? {systemMessage: warnings.filter(Boolean).join('\n')} : {};
}
module.exports = { locations, allow, deny, stopDeny, ask, metadata, identifier, spoolFailure, writeWorkerPid, SPAWN,
  hostContext, normalizeHookOutput, outcomeFlow, outcomeSuccess, minimumCapability, matchingExternalBurn, standaloneBurnCommand, runBurnHook,
  claudeUsage, claudeCursorFile, readsSubagents };
