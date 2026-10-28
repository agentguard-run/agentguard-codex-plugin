'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('./helper-test-env.cjs');
const {canonicalJson, versionForToml, normalizedIdentity, hookKey, trustEntries, installedTrustEntries, renderToml} = require('../scripts/print-trust-state.cjs');
const root = path.join(__dirname, '..');
const command = {type: 'command', command: 'node "${PLUGIN_ROOT}/hooks/burn-gate.cjs"', timeout: 2};
const group = {matcher: '.*', hooks: [command]};
const hash = (event = 'PreToolUse', handler = command, matcherGroup = group, platform = 'darwin') => versionForToml(normalizedIdentity(event, matcherGroup, handler, platform));
// Captured from real Codex 0.154.0 config after normal interactive /hooks trust.
// These four values were independently compared with the installed plugin.
const reviewedHashes = [
  ['pre_tool_use:0:0', '9bde94f6ce219542bc2128c79aa11b8bcadfdb287ee1839c24c4311a5d4dde42'],
  ['pre_tool_use:0:1', '4b1c62f8c89ec8dfa9daa6879ac6ac837473381eeae0ba2e94adcc1604c98ea0'],
  ['post_tool_use:0:0', 'c1185358bb8eb200796cce22e46865761bc6ddaf1ecf1a97039c9b405a1880d5'],
  ['session_start:0:0', '2dc9e51247f007472276c7f3d73cc89fd975d30c6a948767aa5a9152a78e1dbc'],
];

test('The four previously reviewed hook hashes still equal the real Codex 0.154 trust capture', () => {
  const entries = installedTrustEntries(path.join(root, 'compat/codex-0.154/agentguard'));
  // Hooks added after that capture: SessionEnd, and UserPromptSubmit for requests from other agents.
  const later = ['session_end:0:0', 'user_prompt_submit:0:0'];
  assert.deepEqual(entries.filter(entry => !later.some(suffix => entry.key.endsWith(suffix))), reviewedHashes.map(([suffix, hex]) => ({key: `agentguard@agentguard:hooks/hooks.json:${suffix}`, trusted_hash: `sha256:${hex}`})));
  // Adding the prompt hook leaves every earlier hook's key and trusted hash unchanged.
  const prompt = entries.find(entry => entry.key.endsWith('user_prompt_submit:0:0'));
  assert.equal(prompt.trusted_hash, hash('UserPromptSubmit', {type: 'command', command: 'node "${PLUGIN_ROOT}/hooks/prompt-submit.cjs"', timeout: 2}, {}));
});

test('Normalized identity uses unexpanded commands and explicit runtime defaults', () => {
  assert.deepEqual(normalizedIdentity('PreToolUse', group, command, 'darwin'), {
    event_name: 'pre_tool_use', matcher: '.*', hooks: [{type: 'command', command: command.command, timeout: 2, async: false}],
  });
  assert.equal(hash(), hash('PreToolUse', {...command, async: false, additionalContextLimit: 2500}));
  assert.notEqual(hash(), hash('PreToolUse', {...command, command: 'node "/reviewed/plugin/hooks/burn-gate.cjs"'}));
});

test('Hash changes with command, matcher, timeout, async or status definition changes', () => {
  for (const changed of [{command: 'node changed.cjs'}, {timeout: 3}, {async: true}, {statusMessage: 'Checking policy'}]) {
    assert.notEqual(hash(), hash('PreToolUse', {...command, ...changed}));
  }
  assert.notEqual(hash(), hash('PreToolUse', command, {matcher: '^Bash$'}));
});

test('Canonical JSON sorts nested keys with UTF8 ordering and preserves array order', () => {
  assert.equal(canonicalJson({z: [{b: 2, a: 1}], a: false}), '{"a":false,"z":[{"a":1,"b":2}]}');
  assert.equal(canonicalJson({'\u{10000}': 1, '\uE000': 2}), '{"\uE000":2,"\u{10000}":1}');
  assert.equal(versionForToml({a: 1, b: 2}), versionForToml({b: 2, a: 1}));
  assert.notEqual(versionForToml([1, 2]), versionForToml([2, 1]));
  assert.throws(() => canonicalJson({input: null}), /TOML/);
});

test('Hook keys include plugin identity, source and zero-based handler positions', () => {
  assert.equal(hookKey('agentguard@firm', 'hooks/hooks.json', 'PostToolUse', 2, 3), 'agentguard@firm:hooks/hooks.json:post_tool_use:2:3');
  const a = trustEntries({PreToolUse: [group]});
  const b = trustEntries({PreToolUse: [group]}, {pluginId: 'agentguard@firm'});
  assert.notEqual(a[0].key, b[0].key); assert.equal(a[0].trusted_hash, b[0].trusted_hash);
});

test('Timeout normalization matches ordinary, ending and interrupt events', () => {
  const omitted = {type: 'command', command: 'true'};
  assert.equal(normalizedIdentity('PreToolUse', {}, omitted).hooks[0].timeout, 600);
  assert.equal(normalizedIdentity('PreToolUse', {}, {...omitted, timeout: 0}).hooks[0].timeout, 1);
  assert.equal(normalizedIdentity('SessionEnd', {}, omitted).hooks[0].timeout, 1);
  assert.equal(normalizedIdentity('Interrupt', {}, {...omitted, timeout: 20}).hooks[0].timeout, 3);
  assert.equal(normalizedIdentity('SessionEnd', {}, {...omitted, async: true}).hooks[0].async, true);
});

test('Unused matchers and default additional context limits disappear from the trust identity', () => {
  for (const event of ['Stop', 'Interrupt', 'UserPromptSubmit']) assert.equal(normalizedIdentity(event, group, command).matcher, undefined);
  assert.equal(hash('Stop', command, {matcher: 'first'}), hash('Stop', command, {matcher: 'second'}));
  assert.equal(normalizedIdentity('PermissionRequest', group, {...command, additionalContextLimit: 10}).hooks[0].additionalContextLimit, undefined);
  assert.equal(normalizedIdentity('PreToolUse', group, {...command, additionalContextLimit: 0}).hooks[0].additionalContextLimit, 0);
});

test('Windows command selection happens before hashing and omits the alternate field', () => {
  const alternate = {...command, commandWindows: 'node windows.cjs'};
  assert.equal(hash('PreToolUse', alternate, group, 'darwin'), hash());
  assert.equal(normalizedIdentity('PreToolUse', group, alternate, 'win32').hooks[0].command, 'node windows.cjs');
  assert.equal(normalizedIdentity('PreToolUse', group, alternate, 'win32').hooks[0].commandWindows, undefined);
});

test('Changed or unsupported handler types are refused instead of inventing a trust identity', () => {
  for (const handler of [{type: 'mcp_tool', server: 'fixture', tool: 'read'}, {type: 'prompt'}, {type: 'agent'}]) {
    assert.throws(() => normalizedIdentity('PreToolUse', {}, handler), /command hooks only/);
  }
  assert.throws(() => trustEntries({Unknown: []}), /Unsupported/);
});

test('The helper reads definitions only, so changed script bytes alone do not affect trust hashes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-trust-state-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.mkdirSync(path.join(directory, '.codex-plugin')); fs.mkdirSync(path.join(directory, 'hooks'));
  fs.writeFileSync(path.join(directory, '.codex-plugin/plugin.json'), JSON.stringify({name: 'agentguard', hooks: './hooks/hooks.json'}));
  fs.writeFileSync(path.join(directory, 'hooks/hooks.json'), JSON.stringify({hooks: {PreToolUse: [group]}}));
  const script = path.join(directory, 'hooks/burn-gate.cjs'); fs.writeFileSync(script, 'original');
  const before = installedTrustEntries(directory); fs.writeFileSync(script, 'modified');
  assert.deepEqual(installedTrustEntries(directory), before);
  const child = spawnSync(process.execPath, [path.join(root, 'scripts/print-trust-state.cjs'), directory], {encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, renderToml(before));
  assert.equal(fs.existsSync(path.join(directory, 'config.toml')), false);
});

test('The installed helper refuses a hook file outside its plugin root', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-trust-escape-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.mkdirSync(path.join(directory, 'plugin/.codex-plugin'), {recursive: true});
  fs.writeFileSync(path.join(directory, 'outside.json'), JSON.stringify({hooks: {PreToolUse: [group]}}));
  fs.writeFileSync(path.join(directory, 'plugin/.codex-plugin/plugin.json'), JSON.stringify({hooks: '../outside.json'}));
  assert.throws(() => installedTrustEntries(path.join(directory, 'plugin')), /within/);
});
