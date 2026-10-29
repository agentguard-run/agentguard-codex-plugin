#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {locations, hostContext} = require('./common.cjs');
const {validatePolicy} = require('./policy-schema.cjs');
const {validateOrgPolicy, ROOT_FIELDS, SERVER_HELD_FIELDS} = require('./org-policy-contract.cjs');
const UPSELL = 'Policy sync is part of Solo: your policy on up to three machines. agentguard.run/pricing';
const PRESETS = ['solo-dev', 'careful', 'strict', 'website', 'copies-ask'];
// Team caps (teamCaps) are published by the owner in the dashboard and held by
// the server: a Solo push never carries them, whatever a local file says.
const SHARED_FIELDS = ROOT_FIELDS.filter(key => !SERVER_HELD_FIELDS.includes(key));
const LOCAL_FIELDS = [...SHARED_FIELDS, 'max_depth', 'helper_models', 'untrustedOrigin'];
function localPolicy(data) {
  try { return require('./policy-file.cjs').stripMergeFields(JSON.parse(fs.readFileSync(path.join(data, 'policy.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Local policy is not readable JSON.'); return JSON.parse(fs.readFileSync(path.join(__dirname, '../config/default-policy.json'), 'utf8')); }
}
function policyConfig(value) {
  validatePolicy(value);
  const policy = Object.fromEntries(SHARED_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  // Launch settings are local at both scopes until the shared contract grows
  // these fields. Project copies so an upload never alters the local policy.
  if (policy.sessions) policy.sessions = Object.fromEntries(Object.entries(policy.sessions).map(([id, session]) =>
    [id, Object.fromEntries(Object.entries(session).filter(([key]) => !['max_depth', 'helper_models'].includes(key)))]));
  const error = validateOrgPolicy(policy)[0];
  if (error) throw new Error(error);
  if (Buffer.byteLength(JSON.stringify({policy})) > 65536) throw new Error('Policy exceeds 64 KB.');
  return policy;
}
function writePolicy(data, before, after) {
  policyConfig(after);
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, 'policy.json'), temporary = file + '.' + randomUUID();
  try { fs.writeFileSync(temporary, JSON.stringify(after, null, 2) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
  const diff = LOCAL_FIELDS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .flatMap(key => [`Before ${key}: ${JSON.stringify(before[key] ?? null)}`, `After ${key}: ${JSON.stringify(after[key] ?? null)}`]);
  return diff.length ? diff.join('\n') : 'Policy unchanged.';
}
function describe(state) {
  const {config, license, orgPolicy} = state;
  const lines = [`Mode: ${license.mode === 'shadow' && license.reason ? 'shadow fallback (' + license.reason + ')' : config.mode ?? 'enforce'}.`,
    orgPolicy ? `Synced policy version ${orgPolicy.version}, SHA256 ${orgPolicy.sha256}.` : 'Using the local policy on this machine.'];
  for (const cap of config.caps ?? []) lines.push(`Cap: $${(cap.amountCents / 100).toFixed(2)} ${cap.window.replaceAll('_', ' ')}; ${cap.action ?? 'block'} before exceeding the limit.`);
  if (!(config.caps ?? []).length) lines.push('No spend cap configured.');
  lines.push('Caps count configured tool unit prices, not provider bills. Unpriced tools count as zero.');
  for (const group of config.commandRuleGroups ?? [config.commandRules ?? []]) for (const rule of group) lines.push(`${rule.id}: ${rule.action} ${rule.match?.replaceAll('-', ' ') ?? `shell commands matching ${JSON.stringify(rule.pattern)}`}.`);
  for (const [id, mode] of Object.entries(config.guardPack?.rules ?? {})) lines.push(`${id}: ${mode}. ${require('./guard-pack.cjs').RULES.find(rule => rule.id === id)?.reason ?? ''}`);
  lines.push(`Page guard GP020 internal link threshold: ${config.guardPack?.pageGuard?.internalLinkThreshold ?? 3}. Checks edit and write tools, not shell rewrites.`);
  for (const field of ['allowedTools', 'deniedTools', 'ethicalWall']) if (config[field]?.length) lines.push(`${field}: ${config[field].join(', ')}.`);
  if (config.maxCapability) lines.push(`Maximum capability: ${config.maxCapability.replaceAll('_', ' ')}.`);
  lines.push(config.max_depth == null ? 'Launch depth limit: off.' : `Launch depth limit: ${config.max_depth}. Main-session launches are depth 1. Missing lineage uses the existing count limit.`);
  lines.push(config.helper_models?.enabled ? `Helper model: ${config.helper_models.model} after ${config.helper_models.token_budget} session tokens. Helper types: ${config.helper_models.helper_types.join(', ')}. Keep types: ${config.helper_models.keep_types.join(', ') || 'none'}.` : 'Helper model routing: off.');
  if ([config, ...Object.values(config.sessions ?? {})].some(scope => scope.max_depth != null || scope.helper_models?.enabled)) lines.push('Launch depth and helper model settings apply only on this machine. Policy sync does not include them.');
  const origin = require('./untrusted-origin.cjs').settings(config);
  lines.push(origin.action === 'off' ? 'Requests from other agents: off.'
    : `Requests from other agents: once another agent's message enters a session, ${origin.action === 'block' ? 'refuse' : 'ask before'} ${[...origin.categories].map(name => name.replaceAll('-', ' ')).join(', ') || 'no'} calls until you send your own message. This setting applies only on this machine.`);
  for (const rule of config.toolRules ?? []) lines.push(`Tools matching ${JSON.stringify(rule.pattern)}: ${rule.unitCostCents === undefined ? 'price unchanged' : '$' + (rule.unitCostCents / 100).toFixed(2) + ' per call'}${rule.capability ? ', capability ' + rule.capability.replaceAll('_', ' ') : ''}.`);
  for (const [id, session] of Object.entries(config.sessions ?? {})) {
    lines.push(`Session ${id}:`);
    for (const cap of session.caps ?? []) lines.push(`  Cap $${(cap.amountCents / 100).toFixed(2)} ${cap.window.replaceAll('_', ' ')}; ${cap.action ?? 'block'}.`);
    for (const field of ['allowedTools', 'deniedTools', 'ethicalWall']) if (session[field]) lines.push(`  ${field}: ${session[field].join(', ') || 'empty list'}.`);
    if (session.maxCapability) lines.push(`  Maximum capability: ${session.maxCapability.replaceAll('_', ' ')}.`);
    if (session.max_depth != null) lines.push(`  Launch depth limit: ${session.max_depth}; a stricter global depth still applies.`);
    if (session.helper_models) lines.push(session.helper_models.enabled ? `  Helper model: ${session.helper_models.model} after ${session.helper_models.token_budget} tokens. Helper types: ${session.helper_models.helper_types.join(', ')}. Keep types: ${session.helper_models.keep_types.join(', ') || 'none'}; global keep types still apply.` : '  Helper model routing: off for this session.');
  }
  if ((config.commandRuleGroups ?? [config.commandRules ?? []]).flat().some(rule => rule.match === 'network')) lines.push('Strict approval includes every shell and connector call because those tools can open network connections.');
  if (state.syncReason) lines.push(license.mode === 'shadow' ? 'Team policy unavailable. Enforcement is in shadow until it can be read again.' : 'Policy sync unavailable. Local policy applies.');
  return lines.join('\n');
}
async function run(argv, options = {}) {
  const data = options.data ?? locations().data, sessionId = options.sessionId ?? hostContext().sessionId ?? 'policy-cli';
  const [command, ...args] = argv;
  if (command === 'quiet' && args.length === 1 && args[0] === 'on') {
    require('./upgrade-moments.cjs').dismiss();
    return 'Quiet is on. STOP upgrade lines, monthly Burn summaries and version announcements are dismissed permanently on this machine.';
  }
  const before = localPolicy(data);
  if (command === 'show' && !args.length) return describe(require('./policy-state.cjs').policyState(data, sessionId, options));
  if (command === 'explain' && args.length === 1) {
    const state = require('./policy-state.cjs').policyState(data, sessionId, options);
    const builtIn = require('./guard-pack.cjs').RULES.find(rule => rule.id === (args[0] === 'page-guard' ? 'GP020' : args[0]));
    if (builtIn) return `${builtIn.id}: ${builtIn.reason} Effective action: ${state.config.guardPack.rules[builtIn.id]}.`
      + (builtIn.id === 'GP020' ? ` Internal link threshold: ${state.config.guardPack.pageGuard?.internalLinkThreshold ?? 3}. Checks edit and write tools; shell rewrites are not parsed. Files over 2 MB are skipped with a notice. Scan errors fail open with a recorded event. Claude Code asks in its permission prompt; Codex holds until the operator runs pending and approve <token> in their own terminal.` : '');
    const rule = (state.config.commandRuleGroups ?? [state.config.commandRules ?? []]).flat().find(rule => rule.id === args[0]);
    if (rule) return `${rule.id}: ${rule.action} ${rule.match?.replaceAll('-', ' ') ?? `shell commands matching ${JSON.stringify(rule.pattern)}`}. Last match wins within a policy layer; Team constraints still apply.`;
    throw new Error('Unknown rule ID.');
  }
  if (command === 'push' && !args.length) {
    if (!require('./license.cjs').configuredKey(before)) return UPSELL;
    // Validate and project here and again inside the detached worker. No policy
    // body or key is put into IPC, and this process opens no network socket.
    policyConfig(before);
    const result = await (options.request ?? require('./client.cjs').request)({control: 'policy-push', sessionId}, {data, timeoutMs: 8000});
    if (result.error) throw new Error(result.error);
    if (!result.sha256) throw new Error('Policy sync unavailable. Local policy is unchanged.');
    return `Policy synced. Version ${result.version}, SHA256 ${result.sha256}. Other machines load it at session start or the next policy refresh.`;
  }
  if (command === 'benchmark' && args.length === 2 && ['on', 'off'].includes(args[0])) {
    // Consent lives in the signed ledger, written by the worker; this process
    // sends only the run id and opens no socket.
    const result = await (options.request ?? require('./client.cjs').request)({control: 'benchmark-consent', runId: args[1], granted: args[0] === 'on'}, {data, timeoutMs: 8000});
    if (result.error) throw new Error(result.error);
    if (!Number.isSafeInteger(result.sequence)) throw new Error('Benchmark consent unavailable. Enforcement is unchanged.');
    return args[0] === 'on'
      ? `Benchmark consent for run ${args[1]} recorded as signed ledger row ${result.sequence}. With AGENTGUARD_BENCHMARK=1 and AGENTGUARD_BENCH_RUN_ID=${args[1]}, hooks on this machine measure instead of enforce until you run: node runtime/policy-cli.cjs benchmark off ${args[1]}`
      : `Benchmark consent for run ${args[1]} revoked in signed ledger row ${result.sequence}. Hooks enforce normally.`;
  }
  if (command === 'clear-origin' && args.length === 1) {
    // Another agent's message marked a session; the owner says they are back.
    const id = args[0] === 'all' ? 'all' : require('./common.cjs').identifier(args[0], null);
    if (!id) throw new Error('Use clear-origin <session-id> or clear-origin all. pending shows the session id of a held call.');
    const origin = require('./untrusted-origin.cjs');
    if (!require('./client.cjs').workerReady(require('./common.cjs').locations(data)) && !options.request) {
      // No worker is running: clear the files it reads when it starts.
      let cleared = 0;
      if (id === 'all') cleared = origin.clearFiles(data);
      else if (origin.readState(data, id).tainted) { origin.writeState(data, id, {tainted: false, since: new Date().toISOString()}); cleared = 1; }
      return cleared ? `Cleared ${cleared} marked session${cleared === 1 ? '' : 's'}. Calls run as usual until another agent's message arrives.` : 'No marked session to clear.';
    }
    const result = await (options.request ?? require('./client.cjs').request)({control: 'origin-clear', sessionId: id}, {data, startWorker: false, timeoutMs: 4000});
    if (result.error || typeof result.cleared !== 'number') throw new Error(result.error ?? 'Clear unavailable. The mark is unchanged.');
    return result.cleared ? `Cleared ${result.cleared} marked session${result.cleared === 1 ? '' : 's'}. Calls run as usual until another agent's message arrives.` : 'No marked session to clear.';
  }
  if (command === 'approve' && args.length === 1) {
    require('./policy-approval.cjs').approve(data, args[0]);
    return 'Approved once for the exact pending call. Retry before the five-minute approval expires.';
  }
  if (command === 'pending' && !args.length) {
    const list = require('./policy-approval.cjs').pending(data);
    if (!list.length) return 'No held calls are waiting for approval.';
    return list.map(item => `${item.token}  rule ${item.ruleId ?? 'unknown'}  tool ${item.toolName ?? 'unknown'}  session ${item.sessionId ?? 'unknown'}  input digest ${(item.inputDigest ?? '').slice(0, 12)}  expires in ${item.expiresInSeconds}s`)
      .concat('Approve one exact call with: node runtime/policy-cli.cjs approve <token>. Confirm the call with the person driving the agent first.').join('\n');
  }
  let after = {...before};
  if (command === 'preset' && args.length === 1) {
    if (!PRESETS.includes(args[0])) throw new Error('Choose solo-dev, careful, strict, website or copies-ask (Copies ask before launching copies).');
    after = {...before, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'presets', args[0] + '.json'), 'utf8'))};
  } else if (command === 'set-depth' && args.length === 1) {
    if (args[0] !== 'off' && !/^[1-9][0-9]*$/.test(args[0])) throw new Error('Use a positive depth or off.');
    after.max_depth = args[0] === 'off' ? null : Number(args[0]);
  } else if (command === 'helper-model' && args.length === 1 && args[0] === 'off') {
    after.helper_models = {enabled: false};
  } else if (command === 'helper-model' && args.length === 4) {
    if (!/^(0|[1-9][0-9]*)$/.test(args[0])) throw new Error('Use a nonnegative whole token budget.');
    after.helper_models = {enabled: true, token_budget: Number(args[0]), model: args[1], helper_types: args[2].split(','), keep_types: args[3] === 'none' ? [] : args[3].split(',')};
  } else if (command === 'set-cap' && args.length === 2) {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(args[0]) || !['per_day', 'per_session'].includes(args[1])) throw new Error('Use a nonnegative dollar amount with at most two decimals and per_day or per_session.');
    const amountCents = Math.round(Number(args[0]) * 100);
    if (!Number.isSafeInteger(amountCents)) throw new Error('Cap amount is too large.');
    after.caps = [...(before.caps ?? []).filter(cap => cap.window !== args[1] || Object.keys(cap.selector ?? {}).length), {window: args[1], amountCents, action: 'block'}];
  } else if (['block', 'allow'].includes(command) && args.length === 1) {
    const pattern = args[0], id = 'command-' + createHash('sha256').update(pattern).digest('hex').slice(0, 16);
    after.commandRules = [...(before.commandRules ?? []).filter(rule => rule.id !== id), {id, pattern, action: command}];
  } else throw new Error('Use show, preset <name>, set-depth <number|off>, helper-model <tokens> <model> <types> <keep-types|none>, helper-model off, set-cap <dollars> <per_day|per_session>, block <pattern>, allow <pattern>, explain <rule-id>, push, pending, approve <token>, clear-origin <session-id|all>, benchmark on|off <run-id> or quiet on.');
  const diff = writePolicy(data, before, after);
  return diff + (['set-depth', 'helper-model'].includes(command) || (command === 'preset' && args[0] === 'copies-ask') ? '\nLaunch settings apply only on this machine.' : require('./license.cjs').configuredKey(before) ? '\nLocal policy updated. Run policy-cli push to sync a Solo policy.' : '');
}
if (require.main === module) run(process.argv.slice(2)).then(message => process.stdout.write(message + '\n')).catch(error => {
  process.stderr.write(String(error.message || 'Policy command failed.').replace(/[\r\n]+/g, ' ') + '\n'); process.exitCode = 1;
});
module.exports = {run, localPolicy, policyConfig, writePolicy, describe, UPSELL};
