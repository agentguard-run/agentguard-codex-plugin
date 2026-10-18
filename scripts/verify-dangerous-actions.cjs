#!/usr/bin/env node
'use strict';
// Replay the original synthetic corpus, or the separate Jev fresh cases, through
// the actual Free engine. Tool inputs are data only and are NEVER executed.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {randomUUID} = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length && args[0] !== '--fresh') throw Error('Expected no argument or --fresh');
  const fresh = args[0] === '--fresh';
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-dangerous-replay-'));
  const data = path.join(temporary, 'data'), workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(workspace, '.git'), {recursive: true});
  fs.writeFileSync(path.join(workspace, '.git/HEAD'), 'ref: refs/heads/synthetic-fixture\n');
  Object.assign(process.env, {PLUGIN_ROOT: root, PLUGIN_DATA: data, CLAUDE_PLUGIN_DATA: '',
    AGENTGUARD_HOME: path.join(data, 'burn'), CLAUDE_CONFIG_DIR: path.join(data, 'claude'),
    CODEX_HOME: path.join(data, 'codex'), CLAUDE_PROJECT_DIR: workspace, AGENTGUARD_PLUGIN_POLICY: '',
    AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0'});
  fs.copyFileSync(path.join(root, 'config/default-policy.json'), path.join(data, 'policy.json'));
  const {Engine} = require('../runtime/engine.cjs');
  const {metadata, SPAWN} = require('../runtime/common.cjs');
  const file = fresh ? 'decision-model-fresh.jsonl' : 'decision-model-test.jsonl';
  const rows = fs.readFileSync(path.join(root, 'tests/fixtures', file), 'utf8').trim().split('\n').map(JSON.parse)
    .map(row => fresh ? {...row, id: `fresh-${row.id}`, label: row.want === 'STOP' ? 'DENY' : row.want} : row);
  const engine = new Engine({stopNotifier: () => {}}), results = [];
  try {
    await engine.init();
    for (const row of rows) {
      const gate = SPAWN.has(row.action.tool_name) ? 'burn' : 'spend';
      const raw = {...row.action, cwd: workspace, session_id: randomUUID(), tool_use_id: randomUUID()};
      delete raw.transcript_path;
      const meta = metadata(raw, gate), context = engine.context(meta);
      if (context.mode !== 'enforce' || context.license.tier !== 'free') throw Error('Unexpected replay policy');
      const result = await engine.handle({meta, workingDirectory: workspace});
      const key = `${gate}:${JSON.stringify([meta.sessionId, meta.toolUseId])}`;
      if (engine.failures.has(key) || result.cause || !engine.completed.get(key) && gate === 'spend') throw Error('Replay failed: ' + row.id);
      results.push({id: row.id, label: row.label, decision: (result.output.hookSpecificOutput?.permissionDecision ?? 'allow').toUpperCase(), rules: meta.guardRuleIds ?? []});
    }
    console.log(JSON.stringify({source: fresh ? 'jev/data/fresh.jsonl' : '937a220:research/decision-model/data/test.jsonl', cases: results.length,
      denyCases: results.filter(row => row.label === 'DENY').length,
      allowedDeny: results.filter(row => row.label === 'DENY' && row.decision === 'ALLOW').map(row => row.id),
      allowCases: results.filter(row => row.label === 'ALLOW').length,
      falseStops: results.filter(row => row.label === 'ALLOW' && row.decision !== 'ALLOW').map(row => row.id), results}, null, 2));
  } finally { await engine.close(); fs.rmSync(temporary, {recursive: true, force: true}); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
