'use strict';
// The person's telemetry choice is theirs alone. An agent must not flip it
// through Burn's telemetry command, the same way it cannot change the policy.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {scanCommands} = require('../runtime/command-policy.cjs');

function harness(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-consent-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const data = path.join(temporary, 'data'), workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(data); fs.mkdirSync(workspace);
  const config = {version: 1, mode: 'enforce'};
  const scan = (command, cwd = workspace) => scanCommands(config, 'Bash', {command}, {cwd, data, workspace});
  return {data, workspace, scan};
}

test('the Burn telemetry switches are operator commands', t => {
  const {scan} = harness(t);
  for (const command of [
    'npx agentguard-burn telemetry on',
    'npx -y agentguard-burn@latest telemetry on',
    'agentguard-burn telemetry off',
    'npm test; agentguard-burn telemetry on',
  ]) assert.equal(scan(command).builtInStop, 'policy_cli', command);
});

test('ordinary Burn use and the local week view stay allowed', t => {
  const {scan} = harness(t);
  for (const command of [
    'npx agentguard-burn why', 'agentguard-burn week', 'npx agentguard-burn compact-replay', 'npx agentguard-burn telemetry-free-name',
    'node runtime/week.cjs', 'node runtime/week.cjs 2026-09-28', "node -e \"console.log('counts')\"", 'ls runtime',
  ]) assert.equal(scan(command).builtInStop, undefined, command);
});
