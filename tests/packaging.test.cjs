const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = file => JSON.parse(read(file));

test('portable plugin manifest resolves the hook, MCP and presentation components', () => {
  const manifest = json('plugin.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'agentguard');
  for (const field of ['version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) assert.ok(manifest[field]);
  const extension = manifest.extensions['com.openai'];
  assert.deepEqual(json(extension.apps), {apps: {}});
  assert.ok(fs.existsSync(path.join(root, extension.hooks)));
  assert.equal(extension.interface.category, 'Productivity');
  for (const field of ['composerIcon', 'logo']) assert.ok(fs.existsSync(path.join(root, extension.interface[field])));
  const mcp = json('mcp.json');
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.equal(mcp.mcpServers.agentguard.type, 'stdio');
  assert.deepEqual(mcp.mcpServers.agentguard.args, ['${PLUGIN_ROOT}/runtime/mcp.cjs']);
});

test('hook manifest installs exactly two catch-all pre hooks and one post hook', () => {
  const hooks = json('hooks/hooks.json').hooks;
  for (const [event, expected] of [['PreToolUse', ['burn-gate', 'spend-gate']], ['PostToolUse', ['receipt']]]) {
    const entries = hooks[event];
    assert.ok(entries.every(entry => entry.matcher === '.*'));
    const commands = entries.flatMap(entry => entry.hooks);
    assert.equal(commands.length, expected.length);
    expected.forEach((name, index) => {
      assert.equal(commands[index].type, 'command');
      assert.match(commands[index].command, new RegExp(`/hooks/${name}\\.cjs`));
      assert.ok(fs.existsSync(path.join(root, 'hooks', `${name}.cjs`)));
    });
  }
});

test('policy examples parse and validate against the current runtime schema', () => {
  const {validatePolicy} = require('../runtime/engine.cjs');
  const readme = read('README.md');
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(blocks.length);
  for (const [, block] of blocks) validatePolicy(JSON.parse(block));
  for (const name of ['agentguard-policy', 'agentguard-score', 'agentguard-status', 'agentguard-verify']) {
    const skill = read(`skills/${name}/SKILL.md`);
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(skill, /description: .+/);
    for (const [, block] of skill.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      validatePolicy({version: 1, tenantId: 'example', mode: 'enforce', ...JSON.parse(block)});
    }
  }
});

test('raster assets retain the packaged logo and have their documented dimensions', () => {
  assert.equal(createHash('sha256').update(read('assets/logo.svg')).digest('hex'), '4508badfe7e3a32bc0792ce7a1796efc16a6035f74d8044deea9594e28952bce');
  // The directory listing icon is a plain SVG: no DOCTYPE, script, style or external reference.
  assert.doesNotMatch(read('assets/logo.svg'), /<!DOCTYPE|<script|<style|style=|href=|url\(/i);
  for (const [name, size] of [['icon-32.png', 32], ['icon-128.png', 128], ['logo-256.png', 256], ['logo-512.png', 512]]) {
    const bytes = fs.readFileSync(path.join(root, 'assets', name));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});

test('package-local marketplace selects the compatibility plugin and dependencies use registry ranges', () => {
  const marketplace = json('.agents/plugins/marketplace.json');
  assert.equal(marketplace.name, 'agentguard');
  const entry = marketplace.plugins.find(plugin => plugin.name === 'agentguard');
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.source.path, './compat/codex-0.154/agentguard');
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(entry.policy.authentication, 'ON_INSTALL');
  assert.equal(entry.category, 'Productivity');
  assert.ok(fs.existsSync(path.join(root, entry.source.path, '.codex-plugin/plugin.json')));
  const pkg = json('package.json');
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.repository, {type: 'git', url: 'https://github.com/agentguard-run/agentguard-codex-plugin.git'});
  assert.equal(json('plugin.json').repository, 'https://github.com/agentguard-run/agentguard-codex-plugin');
  assert.deepEqual(pkg.dependencies, {'@agentguard-run/spend': '^0.22.0', '@agentguard-run/burn': '^0.6.1'});
  assert.equal(pkg.license, json('plugin.json').license);
  const lock = json('package-lock.json');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  for (const name of Object.keys(pkg.dependencies)) assert.match(lock.packages[`node_modules/${name}`].resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.equal(lock.packages['node_modules/@agentguard-run/spend'].version, '0.22.0');
  assert.equal(lock.packages['node_modules/@agentguard-run/burn'].version, '0.6.1');
  assert.equal(lock.packages['node_modules/@agentguard-run/burn'].dependencies['@agentguard-run/spend'], '0.22.0');
  // One Spend copy serves the plugin and Burn: no nested copy under Burn.
  assert.equal(lock.packages['node_modules/@agentguard-run/burn/node_modules/@agentguard-run/spend'], undefined);
});

test('public README opens with install commands for each host, links the hosted clip and keeps details below them', () => {
  const text = read('README.md');
  const intro = text.split('\n## Details\n')[0];
  const blocks = [...intro.matchAll(/```sh\n([\s\S]*?)\n```/g)].map(match => match[1].split('\n').filter(line => line && !line.startsWith('#')));
  // Codex and ChatGPT Work do not install Node dependencies, so their block keeps npm ci.
  assert.ok(blocks.some(commands => JSON.stringify(commands) === JSON.stringify([
    'codex plugin marketplace add agentguard-run/agentguard-codex-plugin',
    'codex plugin add agentguard@agentguard',
    'npm ci',
  ])), 'the Codex install block keeps its three commands');
  assert.match(intro, /installed plugin root reported by Codex/);
  // The clip lives on the site. Claude's directory holds any non-image binary
  // for manual review, so the package ships images and text only.
  assert.match(intro, /\]\(https:\/\/agentguard\.run\/burn\)/);
  assert.doesNotMatch(intro, /\.mp4\b/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets')).filter(name => name !== '.DS_Store' && !/\.(?:png|svg|md)$/.test(name)), []);
  for (const heading of ['Coverage and limits', 'Free and paid features', 'Install', 'Configure policy', 'Publishing']) {
    assert.ok(text.indexOf(`### ${heading}`) > text.indexOf('\n## Details\n'), heading);
  }
  assert.match(text, /docs\/ENTERPRISE_INSTALL\.md/);
  for (const file of ['README.md', 'CHANGELOG.md', 'assets/README.md']) {
    assert.doesNotMatch(read(file), /\u2014|\u2013|--|\u2122|\u00ae|Agent Guard|(?<![A-Za-z0-9])\/(?:Users|absolute|enterprise)\//, file);
  }
});


test('Codex 0.154 compatibility installation stays equivalent to the portable sources', () => {
  const {check, destination} = require('../scripts/build-compat.cjs');
  assert.ok(check() > 0);
  assert.equal(fs.existsSync(path.join(destination, 'plugin.json')), false);
  assert.equal(fs.existsSync(path.join(destination, 'mcp.json')), false);
  const legacy = JSON.parse(fs.readFileSync(path.join(destination, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(legacy.name, 'agentguard');
  assert.equal(legacy.hooks, './hooks/hooks.json');
  assert.equal(legacy.mcpServers, './.mcp.json');
  assert.equal(legacy.skills, './skills/');
  const legacyPackage = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
  assert.deepEqual(legacyPackage.dependencies, json('package.json').dependencies);
  assert.equal(legacyPackage.scripts['build:compat'], undefined);
  assert.equal(legacyPackage.files.includes('compat'), false);
});

test('legacy MCP resolves the same hook data directory without an implicit home fallback', () => {
  const {legacyDataDirectory} = require('../runtime/mcp-legacy.cjs');
  const syntheticHome = path.resolve('synthetic-plugin-home');
  assert.equal(legacyDataDirectory(path.join(syntheticHome, 'plugins/cache/agentguard/agentguard/0.1.0')),
    path.join(syntheticHome, 'plugins/data/agentguard-agentguard'));
  for (const suffix of ['source/agentguard', 'plugins/cache/market/other/0.1.0',
    'plugins/cache/invalid market/agentguard/0.1.0']) assert.throws(() => legacyDataDirectory(path.join(syntheticHome, suffix)));
  const legacyMcp = json('compat/codex-0.154/agentguard/.mcp.json');
  assert.deepEqual(legacyMcp.mcpServers.agentguard, {command: 'node', args: ['runtime/mcp-legacy.cjs'], cwd: '.'});
});
