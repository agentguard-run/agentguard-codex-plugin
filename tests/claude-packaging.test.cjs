'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const json = name => JSON.parse(read(name));

test('Claude marketplace installs the shared root without renaming the public package', () => {
  const manifest = json('.claude-plugin/plugin.json');
  const portable = json('plugin.json');
  for (const field of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license']) assert.deepEqual(manifest[field], portable[field]);
  // Directory listings show this text: plain words, 160 characters or fewer.
  assert.ok(manifest.description.length <= 160, manifest.description);
  assert.doesNotMatch(manifest.description, /[–—]|--/);
  assert.equal(manifest.author.name, 'AgentGuard');
  // The mod's hooks file is the one additional source; hooks/hooks.json loads by default and is never named again.
  assert.equal(manifest.hooks, './live/agentguard-live.json');
  assert.equal(manifest.icon, './assets/logo.svg');
  assert.deepEqual(manifest.userConfig.license_key, {type: 'string', title: 'AgentGuard license key',
    description: manifest.userConfig.license_key.description, sensitive: true, default: ''});
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'agentguard');
  assert.equal(market.owner.name, 'AgentGuard');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].source, './');
  assert.equal(market.plugins[0].version, manifest.version);
  for (const field of ['description', 'author']) assert.deepEqual(market.plugins[0][field], manifest[field]);
  assert.equal(json('package.json').name, '@agentguard-run/codex-plugin');
  for (const file of ['.claude-plugin', '.mcp.json']) assert.ok(json('package.json').files.includes(file));
  assert.deepEqual(json('.mcp.json').mcpServers.agentguard, {command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/runtime/mcp.cjs'],
    env: {CLAUDE_PLUGIN_OPTION_LICENSE_KEY: '${user_config.license_key}'}});
});

test('the mod and the hooks file naming it sit in a folder nothing else in the plugin points at', () => {
  assert.deepEqual(json('live/agentguard-live.json'), {modules: ['./agentguard-live.mjs']});
  assert.deepEqual(fs.readdirSync(path.join(root, 'live')).sort(), ['agentguard-live.json', 'agentguard-live.mjs', 'generated', 'quick-models.mjs']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'live/generated')).sort(), ['pace.mjs', 'status-fields.mjs', 'status-text.mjs']);
  assert.equal(json('hooks/hooks.json').modules, undefined);
  const configs = ['hooks/hooks.json', 'hooks/codex-hooks.json', '.mcp.json', 'mcp.json', 'plugin.json', '.claude/settings.json', 'package.json',
    ...fs.readdirSync(path.join(root, 'skills')).map(name => `skills/${name}/SKILL.md`),
    ...fs.readdirSync(path.join(root, 'hooks')).filter(name => name.endsWith('.cjs')).map(name => `hooks/${name}`),
    ...fs.readdirSync(path.join(root, 'runtime')).filter(name => name.endsWith('.cjs')).map(name => `runtime/${name}`)];
  for (const name of configs) assert.doesNotMatch(read(name), /(^|[^a-z-])live\/|agentguard-live\.(mjs|json)/, name);
});

test('Claude failure receipts and Codex hooks use the same scripts with host-native roots', () => {
  const claude = json('hooks/hooks.json').hooks;
  const codex = json('hooks/codex-hooks.json').hooks;
  assert.deepEqual(claude.PostToolUseFailure, claude.PostToolUse);
  assert.equal(codex.PostToolUseFailure, undefined);
  for (const [event, groups] of Object.entries(claude)) {
    for (const group of groups) {
      if (event.includes('ToolUse')) assert.equal(group.matcher, '.*');
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        assert.equal(hook.timeout, 2);
        assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
        const script = hook.command.match(/\/hooks\/([a-z-]+\.cjs)/)?.[1];
        assert.ok(script && fs.existsSync(path.join(root, 'hooks', script)));
      }
    }
  }
  assert.deepEqual(Buffer.from(read('hooks/codex-hooks.json')), require('../scripts/build-compat.cjs').codexHooks());
});

test('README gives Claude Code its two install commands first while sharing all four skills', () => {
  const intro = read('README.md').split('\n## Details\n')[0];
  const blocks = [...intro.matchAll(/```sh\n([\s\S]*?)\n```/g)].map(match => match[1].split('\n').filter(line => line && !line.startsWith('#')));
  assert.equal(blocks.length, 2);
  // Claude Code installs the locked dependencies of a marketplace plugin itself;
  // npm ci stays as the fallback, in the folder session start names when they are missing.
  assert.deepEqual(blocks[0], ['claude plugin marketplace add agentguard-run/agentguard-codex-plugin', 'claude plugin install agentguard@agentguard']);
  assert.match(intro, /Claude Code installs the plugin's dependencies by itself\. If AgentGuard says its dependencies are missing, run `npm ci` in the plugin folder it names/);
  for (const skill of ['agentguard-policy', 'agentguard-score', 'agentguard-status', 'agentguard-verify']) {
    const file = `skills/${skill}/SKILL.md`;
    assert.equal(read(file), read(`compat/codex-0.154/agentguard/${file}`));
  }
  assert.match(read('skills/agentguard-status/SKILL.md'), /Report `host`/);
});
