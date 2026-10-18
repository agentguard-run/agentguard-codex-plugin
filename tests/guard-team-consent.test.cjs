'use strict';
// The person's sharing and telemetry choices are theirs alone. An agent must not
// flip them through the counts-sync CLI, Burn's telemetry command or the files
// that store them, the same way it cannot change the policy.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {scanCommands} = require('../runtime/command-policy.cjs');

function harness(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-consent-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const data = path.join(temporary, 'data'), workspace = path.join(temporary, 'workspace'), plugin = path.join(temporary, 'plugin');
  fs.mkdirSync(data); fs.mkdirSync(workspace); fs.mkdirSync(path.join(plugin, 'runtime'), {recursive: true});
  const config = {version: 1, mode: 'enforce'};
  const scan = (command, cwd = workspace) => scanCommands(config, 'Bash', {command}, {cwd, data, workspace});
  return {data, workspace, plugin, scan};
}

test('the counts-sync CLI and Burn telemetry switches are operator commands', t => {
  const {plugin, scan} = harness(t);
  for (const command of [
    'node runtime/counts-sync.cjs waste seat',
    'node ./runtime/counts-sync.cjs on',
    `node ${plugin}/runtime/counts-sync.cjs waste totals`,
    'cd plugin && node runtime/counts-sync.cjs off',
    "node -e \"require('./runtime/counts-sync.cjs')\"",
    'npx agentguard-burn telemetry on',
    'npx -y agentguard-burn@latest telemetry on',
    'agentguard-burn telemetry off',
    'npm test; agentguard-burn telemetry on',
  ]) assert.equal(scan(command).builtInStop, 'policy_cli', command);
});

test('the files that store the choices are plugin state, by path or by bare name inside the data folder', t => {
  const {data, scan} = harness(t);
  for (const command of [
    `printf '{"share":"seat"}' > ${data}/team-waste.json`,
    `cp /tmp/x ${data}/team-counts.json`,
    `rm ${data}/waste-share.json`,
  ]) assert.equal(scan(command).builtInStop, 'plugin_state', command);
  for (const command of ["printf '{}' > team-waste.json", 'rm waste-share.json', 'echo on > team-counts.json'])
    assert.equal(scan(command, data).builtInStop, 'plugin_state', command);
});

test('ordinary Burn use and reading about the feature stay allowed', t => {
  const {scan} = harness(t);
  for (const command of [
    'npx agentguard-burn why', 'agentguard-burn week', 'npx agentguard-burn compact-replay', 'npx agentguard-burn telemetry-free-name',
    'grep -n team-waste README.md', 'cat docs/TEAM_EFFICIENCY.md', "node -e \"console.log('counts')\"", 'ls runtime',
  ]) assert.equal(scan(command).builtInStop, undefined, command);
});
