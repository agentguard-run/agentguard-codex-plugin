'use strict';
// Burn 0.3.18 integration: fresh installs enforce, interactive Claude Code asks
// the person, the agent cannot lift a STOP, and the override line names the
// limit it passed. Engine-level, in temporary directories only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const burn = require('@agentguard-run/burn');
const sdk = require('@agentguard-run/spend');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const {scanCommands} = require('../runtime/command-policy.cjs');
const moments = require('../runtime/upgrade-moments.cjs');
const {dependencyInfo, validateModules} = require('../runtime/dependencies.cjs');
const root = path.resolve(__dirname, '..');
const free = {paid: false, tier: 'free', mode: 'enforce', reason: null};
const CODEX_REFUSAL = `AgentGuard: overrides come from the person, not the agent. Ask them to run it themselves in a terminal:\n${burn.OVERRIDE_COMMAND}`;
const readRows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const permission = output => output.hookSpecificOutput?.permissionDecision ?? 'allow';
// Every fixture restores this one snapshot, so several fixtures in one test
// cannot leave each other's variables behind.
const ORIGINAL_ENV = {...process.env};

async function fixture(t, {host = 'claude-code', pluginMode = 'enforce', burnPolicy, tokens = 100} = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-burn-flow-'));
  const home = path.join(data, 'burn');
  // The agent works in its own directory: a relative path from inside the
  // plugin's data directory would itself be plugin state.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-burn-flow-workspace-'));
  for (const key of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY']) delete process.env[key];
  Object.assign(process.env, host === 'claude-code' ? {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: path.join(data, 'claude')} : {PLUGIN_ROOT: root, PLUGIN_DATA: data},
    {AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: pluginMode}));
  if (burnPolicy) { fs.mkdirSync(home, {recursive: true}); fs.writeFileSync(path.join(home, 'burn-policy.json'), burnPolicy); }
  const transcript = path.join(data, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({uuid: 'flow-usage-1', type: 'assistant', timestamp: new Date().toISOString(),
    message: {id: 'msg_flow_1', role: 'assistant', usage: {input_tokens: tokens, output_tokens: 0}, content: []}}) + '\n');
  const engine = new Engine({licenseReader: () => ({...free, mode: pluginMode})});
  await engine.init();
  t.after(async () => {
    if (!engine.testClosed) await engine.close();
    for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
    Object.assign(process.env, ORIGINAL_ENV);
    fs.rmSync(data, {recursive: true, force: true});
    fs.rmSync(cwd, {recursive: true, force: true});
  });
  // A restarted worker reads the same ledger, so the first one closes before it starts.
  const restart = async () => {
    await engine.close(); engine.testClosed = true;
    const next = new Engine({licenseReader: () => ({...free, mode: pluginMode})}); await next.init();
    t.after(() => next.close());
    return next;
  };
  let count = 0;
  const raw = (tool, extra = {}) => ({session_id: 'flow-session', tool_use_id: `toolu_flow_${count++}`, cwd, transcript_path: transcript,
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, ...extra});
  const gate = async (input, name, permissionMode) => {
    const meta = metadata(input, name);
    if (permissionMode) meta.permissionMode = permissionMode;
    return engine.handle({meta, transcriptPath: transcript, workingDirectory: cwd});
  };
  return {data, home, transcript, engine, raw, gate, restart, rows: () => readRows(path.join(data, 'ledger', 'decisions.ndjson')).map(row => row.decision),
    verify: async () => assert.equal((await sdk.verifyChain(readRows(path.join(data, 'ledger', 'decisions.ndjson')), engine.publicKey)).ok, true)};
}
const policyText = (changes = {}) => {
  const policy = structuredClone(burn.DEFAULT_POLICY);
  policy.mode = 'enforce';
  Object.assign(policy.thresholds, changes.thresholds);
  return JSON.stringify({...policy, ...changes, thresholds: policy.thresholds}, null, 2);
};

test('a fresh install writes Burn\'s shipped policy in enforce mode once, privately, and records it once', async t => {
  const f = await fixture(t);
  await f.gate(f.raw('Read'), 'burn');
  assert.equal(fs.existsSync(path.join(f.home, 'burn-policy.json')), false, 'Only a gated spawn writes the policy.');
  const result = await f.gate(f.raw('Agent'), 'burn');
  assert.equal(result.warning, undefined);
  const file = path.join(f.home, 'burn-policy.json'), text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(text), {...burn.DEFAULT_POLICY, mode: 'enforce'});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.home).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(f.home).filter(name => name.includes('burn-policy')), ['burn-policy.json']);
  const seeded = f.rows().filter(row => row.plugin.event === 'burn_policy_seeded');
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].plugin.burnPolicySha256, crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(seeded[0].plugin.burnPolicyMode, 'enforce');
  // A restarted worker, and every later spawn, leaves the file and the ledger alone.
  const restarted = await f.restart();
  assert.equal((await restarted.handle({meta: metadata(f.raw('Agent'), 'burn'), transcriptPath: f.transcript, workingDirectory: f.data})).warning, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(readRows(path.join(f.data, 'ledger', 'decisions.ndjson')).filter(row => row.decision.plugin.event === 'burn_policy_seeded').length, 1);
});

test('a policy the person chose is never replaced, and a plugin in shadow writes nothing', async t => {
  const shadow = JSON.stringify({...burn.DEFAULT_POLICY, mode: 'shadow'});
  const chosen = await fixture(t, {burnPolicy: shadow, tokens: 6_000_000_000});
  const result = await chosen.gate(chosen.raw('Agent'), 'burn', 'default');
  assert.equal(permission(result.output), 'allow');
  assert.match(result.output.systemMessage, /AgentGuard STOP \(shadow: would have refused\): This session has used 6\.00B tokens\. Limit: 5\.00B\./);
  assert.equal(fs.readFileSync(path.join(chosen.home, 'burn-policy.json'), 'utf8'), shadow);
  assert.equal(chosen.rows().some(row => row.plugin.event === 'burn_policy_seeded'), false);
});

test('a plugin in shadow does not write a Burn policy', async t => {
  const f = await fixture(t, {pluginMode: 'shadow'});
  await f.gate(f.raw('Agent'), 'burn', 'default');
  assert.equal(fs.existsSync(path.join(f.home, 'burn-policy.json')), false);
  assert.equal(f.rows().some(row => row.plugin.event === 'burn_policy_seeded'), false);
});

test('an interactive Claude Code STOP asks the person; the answer links its outcome and a retry is asked again', async t => {
  const f = await fixture(t, {burnPolicy: policyText({thresholds: {sustained: {warnTokens: 50, stopTokens: 80}}})});
  const spawn = f.raw('Agent');
  const asked = await f.gate(spawn, 'burn', 'auto');
  assert.deepEqual(asked.output, {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: 'AgentGuard: This session has used 100 tokens. Limit: 80.\nSession so far: 0 sub-agents, 100 tokens.\nAllow this one launch? If you say no, nothing starts.'}});
  const held = f.rows().at(-1);
  assert.equal(held.action, 'block'); assert.equal(held.plugin.asked, true); assert.equal(held.plugin.permissionMode, 'auto');
  // The same call again is evaluated again, never replayed as a denial.
  assert.equal(permission((await f.gate(spawn, 'burn', 'auto')).output), 'ask');
  // The person said yes: the launch ran, and its outcome links to the held decision.
  const outcome = await f.engine.handle({meta: metadata({...spawn, hook_event_name: 'PostToolUse', tool_response: {status: 'completed'}, duration_ms: 5}, 'receipt')});
  assert.equal(outcome.warning, undefined);
  const linked = f.rows().at(-1);
  assert.equal(linked.entryType, 'outcome');
  assert.ok(f.rows().some(row => row.decisionId === linked.originalDecisionId && row.plugin.asked === true));
  await f.verify();
});

test('stopStyle deny, bypassPermissions and a missing permission mode refuse with the box instead of asking', async t => {
  const f = await fixture(t, {burnPolicy: policyText({stopStyle: 'deny', thresholds: {sustained: {warnTokens: 50, stopTokens: 80}}})});
  for (const mode of ['default', undefined]) {
    const refused = await f.gate(f.raw('Agent'), 'burn', mode);
    assert.equal(permission(refused.output), 'deny');
    const box = refused.output.hookSpecificOutput.permissionDecisionReason;
    assert.ok(box.startsWith('\u2060\n┌') && box.includes('This session has used 100 tokens. Limit: 80.') && box.includes(`! ${burn.OVERRIDE_COMMAND}`), box);
    assert.equal(f.rows().at(-1).plugin.asked, undefined);
  }
  const g = await fixture(t, {burnPolicy: policyText({thresholds: {sustained: {warnTokens: 50, stopTokens: 80}}})});
  assert.equal(permission((await g.gate(g.raw('Agent'), 'burn', 'bypassPermissions')).output), 'deny');
});

for (const host of ['claude-code', 'codex']) {
  test(`${host}: the line after a person's override names the STOP it passed, not the first finding`, async t => {
    // Fan-out warns first in Burn's finding list; the sustained-token limit is the STOP.
    const f = await fixture(t, {host, burnPolicy: policyText({thresholds: {fanout: {warn: 1, stop: 40, maxDepth: 2, windowActiveMinutes: 120}, sustained: {warnTokens: 50, stopTokens: 80}}})});
    const tool = host === 'codex' ? 'spawn_agent' : 'Agent';
    const refused = await f.gate(f.raw(tool), 'burn', 'bypassPermissions');
    assert.equal(permission(refused.output), 'deny');
    const [finding] = JSON.parse(fs.readFileSync(path.join(f.home, 'decisions.ndjson'), 'utf8').trim().split('\n').at(-1)).findings;
    assert.equal(finding.detector, 'fanout', 'The first finding is the fan-out warning.');
    burn.writeOverride(f.home, {at: Date.now(), once: true, reason: 'person checked the session'});
    const allowed = await f.gate(f.raw(tool), 'burn', 'bypassPermissions');
    assert.equal(permission(allowed.output), 'allow');
    assert.ok(allowed.output.systemMessage.endsWith('AgentGuard STOP overridden once ("person checked the session"): This session has used 100 tokens. Limit: 80.'), allowed.output.systemMessage);
    assert.doesNotMatch(allowed.output.systemMessage, /Sub-agent|fan-out/i);
  });
}

// Every form Burn's own check flags, plus forms only a parse sees.
const ATTEMPTS = [
  'npx @agentguard-run/burn resume --once --reason x', 'npx -y @agentguard-run/burn@0.3.18 resume --once --reason x',
  'npx agentguard-burn resume --once --reason x', 'npx -y agentguard-burn@latest shadow',
  'npx @agentguard-run/burn "resume" --once --reason x', 'npx @agentguard-run/burn re\\sume --once --reason x',
  'v=resume; npx @agentguard-run/burn $v', 'bash -c "agentguard-burn shadow"', 'agentguard-burn calibrate',
  'node ~/.npm/_npx/abc/node_modules/@agentguard-run/burn/dist/src/cli.js resume --reason y',
  'npx -p @agentguard-run/burn agentguard-burn resume --reason y', 'npm exec --package=@agentguard-run/burn -- agentguard-burn resume --reason z',
  'pnpm dlx @agentguard-run/burn shadow', 'bunx @agentguard-run/burn resume --reason q', 'sudo -u me env AGENTGUARD_HOME=/tmp/x npx @agentguard-run/burn shadow',
  'echo {} > ~/.agentguard/override.json', 'cat ~/.agentguard/burn-policy.json',
  `python3 -c "import os; os.system('npx @agentguard-run/burn resume --once --reason x')"`,
  `node -e "require('@agentguard-run/burn').writeOverride(process.env.HOME, {at: 1, once: true, reason: 'x'})"`,
];
const ALLOWED = ['npx @agentguard-run/burn why', 'npx agentguard-burn why', 'npx agentguard-burn compare', 'npx agentguard-burn models', 'npx agentguard-burn@latest models', 'npx -y agentguard-burn@latest week', 'npx @agentguard-run/burn status', 'npx @agentguard-run/burn enforce --force',
  'agentguard-burn why --json', 'echo resume shadow calibrate', 'ls -la ~/projects', 'npm run resume'];

test('the in-hook scan flags every agent override form Burn flags, and more, while ordinary Burn commands pass', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-burn-scan-'));
  const previous = process.env.AGENTGUARD_HOME; process.env.AGENTGUARD_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.AGENTGUARD_HOME; else process.env.AGENTGUARD_HOME = previous; fs.rmSync(home, {recursive: true, force: true}); });
  const inputs = [...[...ATTEMPTS, `echo {} > ${home}/override.json`, `rm ${home}/burn-policy.json`].map(command => ['Bash', {command}]),
    ['PowerShell', {command: 'npx @agentguard-run/burn resume --once --reason x'}],
    ['Write', {file_path: path.join(home, 'override.json'), content: '{}'}], ['Edit', {file_path: path.join(home, 'burn-policy.json'), old_string: 'enforce', new_string: 'shadow'}],
    ['MultiEdit', {file_path: '~/.agentguard/burn-policy.json', edits: []}], ['apply_patch', {input: `*** Begin Patch\n*** Update File: ${home}/burn-policy.json\n@@\n-a\n+b\n*** End Patch`}]];
  for (const [tool, input] of inputs) {
    const flagged = scanCommands({}, tool, input, {cwd: home}).burnOverride;
    assert.ok(flagged === 'command' || flagged === 'file', `${tool} ${JSON.stringify(input)}`);
    assert.equal(flagged, /^(?:Bash|PowerShell)$/.test(tool) ? 'command' : 'file');
    // Parity: nothing Burn's own check refuses is missed by the plugin.
    const library = burn.agentOverrideAttempt({tool_name: tool, tool_input: input}, home);
    if (library) assert.equal(flagged, library, `${tool} ${JSON.stringify(input)}`);
  }
  for (const command of ALLOWED) {
    assert.equal(scanCommands({}, 'Bash', {command}, {cwd: home}).burnOverride, undefined, command);
    assert.equal(burn.agentOverrideAttempt({tool_name: 'Bash', tool_input: {command}}, home), null, command);
  }
  // The first-session line names the @latest spelling: the scan gives it the same answer as the bare one.
  assert.deepEqual(scanCommands({}, 'Bash', {command: 'npx agentguard-burn@latest models'}, {cwd: home}), scanCommands({}, 'Bash', {command: 'npx agentguard-burn models'}, {cwd: home}));
  assert.equal(scanCommands({}, 'Write', {file_path: path.join(home, 'notes.md'), content: 'resume with override.json'}, {cwd: home}).burnOverride, undefined);
});

for (const host of ['claude-code', 'codex']) {
  test(`${host}: the agent's override attempt is refused while the Burn gate enforces, with the text that sends it to the person`, async t => {
    const f = await fixture(t, {host});
    const expected = host === 'claude-code' ? burn.AGENT_OVERRIDE_REASON : CODEX_REFUSAL;
    const attempt = f.raw('Bash', {tool_input: {command: 'npx @agentguard-run/burn resume --once --reason x'}});
    const refused = await f.gate(attempt, 'spend');
    assert.deepEqual(refused.output.hookSpecificOutput, {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expected});
    assert.equal(f.rows().at(-1).plugin.reasonCode, 'burn_override:command');
    assert.equal(JSON.stringify(f.rows()).includes('--reason x'), false, 'Command text never reaches the ledger.');
    // A host retry of the same call gets the same answer.
    assert.equal((await f.gate(attempt, 'spend')).output.hookSpecificOutput.permissionDecisionReason, expected);
    const write = await f.gate(f.raw(host === 'codex' ? 'apply_patch' : 'Write', {tool_input: host === 'codex'
      ? {input: `*** Begin Patch\n*** Update File: ${f.home}/override.json\n@@\n-a\n+b\n*** End Patch`} : {file_path: path.join(f.home, 'override.json'), content: '{}'}}), 'spend');
    assert.equal(write.output.hookSpecificOutput.permissionDecisionReason, expected);
    assert.equal(f.rows().at(-1).plugin.reasonCode, 'burn_override:file');
    assert.equal(permission((await f.gate(f.raw('Bash', {tool_input: {command: 'npx @agentguard-run/burn why'}}), 'spend')).output), 'allow');
    await f.verify();
  });
}

test('with Burn in shadow the override command passes, and Burn\'s files stay protected as plugin state', async t => {
  const f = await fixture(t, {burnPolicy: JSON.stringify({...burn.DEFAULT_POLICY, mode: 'shadow'})});
  assert.equal(permission((await f.gate(f.raw('Bash', {tool_input: {command: 'npx @agentguard-run/burn resume --once --reason x'}}), 'spend')).output), 'allow');
  const write = await f.gate(f.raw('Write', {tool_input: {file_path: path.join(f.home, 'burn-policy.json'), content: '{}'}}), 'spend');
  assert.equal(permission(write.output), 'deny');
  assert.match(write.output.hookSpecificOutput.permissionDecisionReason, /built_in:plugin_state/);
  const shadowPlugin = await fixture(t, {pluginMode: 'shadow'});
  const observed = await shadowPlugin.gate(shadowPlugin.raw('Bash', {tool_input: {command: 'agentguard-burn shadow'}}), 'spend');
  assert.equal(permission(observed.output), 'allow');
  assert.notEqual(shadowPlugin.rows().at(-1).action, 'block');
});

test('Claude cursors keep Burn 0.3 per-response usage across a worker restart without counting it twice', async t => {
  const f = await fixture(t);
  // Claude records one response's usage on each of its content blocks.
  const row = (uuid, id, input) => JSON.stringify({uuid, type: 'assistant', timestamp: new Date().toISOString(), message: {id, role: 'assistant', usage: {input_tokens: input, output_tokens: 0}, content: []}}) + '\n';
  fs.writeFileSync(f.transcript, row('u1', 'msg_a', 100) + row('u2', 'msg_a', 100));
  assert.equal((await f.gate(f.raw('Read'), 'burn')).warning, undefined);
  assert.equal(f.engine.gateway.sessions()[0].state.totalTokens, 100);
  const cursor = JSON.parse(fs.readFileSync(path.join(f.data, 'claude-cursors', fs.readdirSync(path.join(f.data, 'claude-cursors'))[0]), 'utf8')).cursor;
  assert.ok(Array.isArray(cursor.usageByMessage) && cursor.usageByMessage.length === 1);
  const restarted = await f.restart();
  fs.appendFileSync(f.transcript, row('u3', 'msg_a', 100) + row('u4', 'msg_b', 50));
  const result = await restarted.handle({meta: metadata(f.raw('Read'), 'burn'), transcriptPath: f.transcript, workingDirectory: f.data});
  assert.equal(result.warning, undefined);
  assert.equal(restarted.gateway.sessions()[0].state.totalTokens, 150);
});

test('an optional platform package absent from node_modules is expected; a present one is still checked', () => {
  const info = dependencyInfo(root), modules = path.join(root, 'node_modules');
  assert.ok(info.packages.some(([name, pkg]) => pkg.optional === true && !fs.existsSync(path.join(root, name))), 'The lockfile lists a platform package this machine does not install.');
  assert.doesNotThrow(() => validateModules(modules, {...info, packages: [...info.packages, ['node_modules/@synthetic/absent-platform', {version: '1.0.0', optional: true}]]}));
  const installed = info.packages.find(([name, pkg]) => !pkg.optional && !pkg.dev && fs.existsSync(path.join(root, name)) && !name.includes('@agentguard-run'));
  assert.throws(() => validateModules(modules, {...info, packages: [...info.packages.filter(([name]) => name !== installed[0]), [installed[0], {...installed[1], version: '0.0.0-wrong', optional: true}]]}), /version differs/);
});

test('the preset hint is a command the person can paste, and the first-run line shows once, never in shadow or quiet', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-first-run-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  assert.equal(moments.presetHint({root: '/plugins/agentguard 1', data: '/data/agentguard', host: 'claude-code'}),
    'AgentGuard presets: solo-dev, careful and strict. No key or network is needed. Apply one by typing: ! CLAUDE_PLUGIN_DATA="/data/agentguard" node "/plugins/agentguard 1/runtime/policy-cli.cjs" preset careful');
  assert.match(moments.presetHint({root: '/plugins/a', data: '/data/b', host: 'codex'}), /: ! PLUGIN_DATA="\/data\/b" node "\/plugins\/a\/runtime\/policy-cli\.cjs" preset careful$/);
  assert.match(moments.presetHint({root: "/tmp/it's $HOME", data: '/d', host: 'claude-code'}), / node '\/tmp\/it'\\''s \$HOME\/runtime\/policy-cli\.cjs' preset careful$/);
  assert.equal(moments.firstRun({host: 'claude-code', enforcing: false, home}), null);
  assert.equal(moments.firstRun({host: 'claude-code', home}), moments.FIRST_RUN_LINE, 'A shadow startup does not use up the line.');
  assert.equal(moments.firstRun({host: 'claude-code', home}), null);
  const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-first-run-quiet-'));
  t.after(() => fs.rmSync(quiet, {recursive: true, force: true}));
  moments.dismiss(quiet);
  assert.equal(moments.firstRun({host: 'codex', home: quiet}), null);
  const codex = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-first-run-codex-'));
  t.after(() => fs.rmSync(codex, {recursive: true, force: true}));
  assert.equal(moments.firstRun({host: 'codex', home: codex}), moments.FIRST_RUN_CODEX_LINE);
  for (const line of [moments.FIRST_RUN_LINE, moments.FIRST_RUN_CODEX_LINE]) assert.doesNotMatch(line, /[\u2013\u2014]|--/);
});
