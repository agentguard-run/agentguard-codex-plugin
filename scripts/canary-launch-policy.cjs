#!/usr/bin/env node
'use strict';
// A bounded, synthetic live probe. Uses the installed host and its existing
// login. All plugin state, receipts and captures go in a new scratch folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const interactive = process.argv[2] === 'claude-interactive';
const host = interactive ? 'claude' : process.argv[2] || 'claude';
if (!['claude', 'codex'].includes(host)) throw new Error('Choose claude, claude-interactive or codex.');
const scratch = process.env.AGENTGUARD_CANARY_ROOT || path.join(os.homedir(), 'dev', 'agentguard-oct5-evidence');
fs.mkdirSync(scratch, {recursive: true});
const base = fs.mkdtempSync(path.join(scratch, `ag-launch-canary-${host}-`));
const plugin = path.join(base, 'plugin'), work = path.join(base, 'work'), data = path.join(base, 'data');
for (const dir of [plugin, work, data]) fs.mkdirSync(dir);
for (const entry of fs.readdirSync(root)) if (!['compat', 'tests', '.git'].includes(entry)) fs.cpSync(path.join(root, entry), path.join(plugin, entry), {recursive: true});
const target = host === 'claude' ? 'haiku' : 'gpt-6-luna';
fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', max_depth: 1,
  helper_models: {enabled: true, token_budget: 1, helper_types: ['search', 'explorer', 'default'], keep_types: ['coordinator', 'worker'], model: target}, notifyOnStop: false}));
fs.writeFileSync(path.join(work, 'fixture.txt'), 'Synthetic canary. The word is amber.\n');
for (const name of ['hooks.json', 'codex-hooks.json']) {
  const file = path.join(plugin, 'hooks', name), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const groups of Object.values(config.hooks)) for (const group of groups) for (const hook of group.hooks) {
    hook.command = `env ${host === 'claude' ? 'CLAUDE_PLUGIN_DATA' : 'PLUGIN_DATA'}='${data}' ${host === 'claude' ? `CLAUDE_CONFIG_DIR='${path.join(base, 'empty-claude-config')}' ` : ''}${hook.command}`;
  }
  fs.writeFileSync(file, JSON.stringify(config));
}
// Wrap the unchanged branch gate, recording only synthetic probe data locally.
fs.renameSync(path.join(plugin, 'hooks/burn-gate.cjs'), path.join(plugin, 'hooks/canary-original.cjs'));
fs.writeFileSync(path.join(plugin, 'hooks/burn-gate.cjs'), `
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const text = fs.readFileSync(0, 'utf8'), raw = JSON.parse(text), base = ${JSON.stringify(base)};
const launches = path.join(base, 'launches.ndjson');
if (require('../node_modules/@agentguard-run/burn/dist/src/tool-names.js').isLaunchTool(raw.tool_name)) {
  fs.appendFileSync(launches, JSON.stringify({tool: raw.tool_name, id: raw.tool_use_id})+'\\n');
  if (fs.readFileSync(launches, 'utf8').trim().split('\\n').length > 6) {
    process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Canary launch limit reached.'}})); process.exit(0);
  }
}
const run = spawnSync(process.execPath,[path.join(__dirname,'canary-original.cjs')],{input:text,encoding:'utf8',env:process.env});
fs.appendFileSync(path.join(base,'hooks.ndjson'),JSON.stringify({event:raw.hook_event_name,tool:raw.tool_name,toolUseId:raw.tool_use_id,agentId:raw.agent_id??null,model:raw.model??null,inputModel:raw.tool_input?.model??null,agentType:raw.tool_input?.subagent_type??raw.tool_input?.agent_type??null,transcript:raw.transcript_path,stdout:run.stdout,stderr:run.stderr})+'\\n');
process.stdout.write(run.stdout); process.stderr.write(run.stderr); process.exitCode=run.status??0;
`);
// Probe SessionEnd visibility separately from the model's final answer. This
// wrapper is scratch-only; the production hook remains short and fail open.
fs.renameSync(path.join(plugin, 'hooks/session-end.cjs'), path.join(plugin, 'hooks/canary-session-end.cjs'));
fs.writeFileSync(path.join(plugin, 'hooks/session-end.cjs'), `
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const text = fs.readFileSync(0, 'utf8'), raw = JSON.parse(text), base = ${JSON.stringify(base)};
const run = spawnSync(process.execPath, [path.join(__dirname, 'canary-session-end.cjs')], {input:text, encoding:'utf8', env:process.env});
(async () => {
  const burn = require('@agentguard-run/burn');
  const tally = await burn.sessionTally(raw.session_id, {data: ${JSON.stringify(data)}});
  const output = ${JSON.stringify(host)} === 'codex' ? JSON.stringify({systemMessage:'AgentGuard tally: ' + burn.renderSessionTally(tally)}) : run.stdout;
  fs.appendFileSync(path.join(base, 'end-hooks.ndjson'), JSON.stringify({sessionId:raw.session_id, transcript:raw.transcript_path, stdout:output, stderr:run.stderr, tally})+'\\n');
  process.stdout.write(output); process.stderr.write(run.stderr); process.exitCode = run.status ?? 0;
})().catch(() => {process.stdout.write(run.stdout); process.exitCode = run.status ?? 0;});
`);
const env = {...process.env, AGENTGUARD_HOME: path.join(base, 'burn'), AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0', AGENTGUARD_NOTIFY_SUPPRESS: '1'};
env.PATH = path.dirname(process.execPath) + path.delimiter + env.PATH;
for (const key of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'AGENTGUARD_PLUGIN_POLICY', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR']) delete env[key];
for (const key of Object.keys(env)) if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') delete env[key];
let executable, args, cleanup;
if (host === 'claude') {
  env.CLAUDE_PLUGIN_DATA = data;
  const agents = {search: {description: 'Synthetic word reader', prompt: 'Read fixture.txt and return its word. Use no agents.', tools: ['Read'], model: 'sonnet'},
    coordinator: {description: 'One nested launch canary', prompt: 'Call Agent exactly once with subagent_type search, model sonnet, run_in_background false and prompt Read fixture.txt. If refused, report the reason and stop. Do no other work.', tools: ['Agent'], model: 'haiku'}};
  executable = 'claude';
  args = ['-p', '--model', 'haiku', '--effort', 'low', '--max-budget-usd', '0.40', '--permission-prompts', 'none', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--plugin-dir', plugin,
    '--tools', 'Agent,Read', '--allowedTools', 'Agent,Read', '--agents', JSON.stringify(agents), '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    'This is a synthetic local hook canary. First call Agent search with model sonnet and run_in_background false to read fixture.txt. Then call Agent coordinator with model haiku and run_in_background false, telling it to call Agent search once. Never retry a refused launch. Do no other work. Report results briefly.'];
  if (interactive) {
    args = ['--model', 'haiku', '--effort', 'low', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--plugin-dir', plugin,
      '--tools', 'Agent,Read', '--allowedTools', 'Agent,Read', '--agents', JSON.stringify(agents),
      'Call Agent coordinator once with model haiku and run_in_background false. Tell it to call Agent search once to read fixture.txt. Never retry a refused launch. Then stop.'];
    process.stdout.write('Approve the nested launch at the depth prompt. Then request one more coordinator launch and decline its nested launch. Exit the session to sign the closing receipt.\n');
  }
} else {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Run the Codex canary with Node 22.');
  const cli = process.env.AGENTGUARD_CODEX_CLI;
  executable = cli ? process.execPath : 'codex';
  const prefix = cli ? [cli] : [];
  const market = 'ag-canary-' + path.basename(base).split('-').at(-1).toLowerCase();
  const pluginId = `agentguard@${market}`;
  // The installed 0.160 CLI uses the legacy directory manifest. The hook
  // bodies are identical to the branch's generated compatibility package.
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), {recursive: true});
  fs.copyFileSync(path.join(root, 'compat/codex-0.154/agentguard/.codex-plugin/plugin.json'), path.join(plugin, '.codex-plugin/plugin.json'));
  fs.renameSync(path.join(plugin, 'plugin.json'), path.join(plugin, 'portable-manifest.saved'));
  fs.copyFileSync(path.join(plugin, 'hooks/codex-hooks.json'), path.join(plugin, 'hooks/hooks.json'));
  fs.mkdirSync(path.join(base, '.agents/plugins'), {recursive: true});
  fs.writeFileSync(path.join(base, '.agents/plugins/marketplace.json'), JSON.stringify({name: market, plugins: [{name: 'agentguard', source: {source: 'local', path: './plugin'}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}}]}));
  const config = ['-c', `marketplaces.${market}.source_type="local"`, '-c', `marketplaces.${market}.source=${JSON.stringify(base)}`];
  const installed = spawnSync(executable, [...prefix, ...config, 'plugin', 'add', pluginId, '--json'], {env, encoding: 'utf8', timeout: 30000});
  fs.writeFileSync(path.join(base, 'install.json'), installed.stdout);
  if (installed.status !== 0) throw new Error(`Local canary plugin install failed: ${installed.stderr}`);
  const listing = spawnSync(executable, [...prefix, ...config, 'plugin', 'list', '--json'], {env, encoding: 'utf8', timeout: 30000});
  fs.writeFileSync(path.join(base, 'plugins.json'), listing.stdout);
  cleanup = () => {
    const removed = spawnSync(executable, [...prefix, 'plugin', 'remove', pluginId], {env, encoding: 'utf8', timeout: 30000});
    fs.writeFileSync(path.join(base, 'cleanup.txt'), removed.stdout + removed.stderr);
  };
  args = [...prefix, '-a', 'never', 'exec', ...config, '-c', `plugins.${JSON.stringify(pluginId)}.enabled=true`,
    '-c', 'plugins."vercel@openai-curated".enabled=false', '-c', 'plugins."github@openai-curated".enabled=false', '-c', 'plugins."supabase@openai-curated".enabled=false',
    '-c', 'features.hooks=true', '-c', 'features.multi_agent_v2=false',
    '-c', 'model_reasoning_effort="low"', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '-s', 'workspace-write', '--model', 'gpt-6-luna', '--json',
    'Synthetic local hook canary, no other work. First read fixture.txt with a shell tool. Make at most two collaboration.spawn_agent calls, sequentially. Use no agent_type parameter: this host has untyped helpers. First launch task_name search with model gpt-6-sol and fork_turns none; tell it to read fixture.txt and return its word, no agents. Wait for it. Second launch task_name search_inherited with fork_turns all and no model override to read fixture.txt, no agents. If a launch is denied report the reason, never retry or run approval commands. Briefly report results.'];
}
process.stdout.write(JSON.stringify({base, plugin, work, data, host}) + '\n');
const out = fs.openSync(path.join(base, 'host.jsonl'), 'w'), err = fs.openSync(path.join(base, 'host.stderr'), 'w');
const result = spawnSync(executable, args, {cwd: work, env, stdio: interactive ? 'inherit' : ['ignore', out, err], timeout: interactive ? 600000 : 180000});
fs.closeSync(out); fs.closeSync(err);
if (cleanup) cleanup();
fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({host, status: result.status, signal: result.signal, error: result.error?.code ?? null}));
process.stdout.write(JSON.stringify({status: result.status, signal: result.signal, error: result.error?.code ?? null}) + '\n');
const captures = fs.existsSync(path.join(base, 'hooks.ndjson')) ? fs.readFileSync(path.join(base, 'hooks.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const launches = captures.filter(row => ['Agent', 'Task', 'spawn_agent', 'collaborationspawn_agent'].includes(row.tool));
const outputs = launches.map(row => {try {return JSON.parse(row.stdout);} catch {return {};}});
const checks = {hostExited: result.status === 0, boundedLaunches: launches.length > 0 && launches.length <= 6,
  modelRewrite: outputs.some(out => out.hookSpecificOutput?.updatedInput?.model === target),
  depth: host === 'claude' ? outputs.some(out => out.hookSpecificOutput?.permissionDecision === 'ask' && /depth 2/.test(out.hookSpecificOutput.permissionDecisionReason))
    : outputs.some(out => /cannot verify launch depth/.test(out.systemMessage))};
fs.writeFileSync(path.join(base, 'checks.json'), JSON.stringify(checks, null, 2)+'\n');
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
