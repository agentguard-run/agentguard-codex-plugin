'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync, execFileSync} = require('./helper-test-env.cjs');
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-public-sync-test-'));
  const source = path.join(temporary, 'source package');
  const destination = path.join(temporary, 'public checkout');
  fs.cpSync(root, source, {recursive: true, filter: filename => !['node_modules', '.git', '.DS_Store'].includes(path.basename(filename))});
  fs.mkdirSync(destination);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', destination]);
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  return {temporary, source, destination};
}
function sync(f, destination = f.destination) {
  return spawnSync('bash', [path.join(f.source, 'scripts', 'sync-public.sh'), destination], {encoding: 'utf8', timeout: 30000});
}
function files(directory, prefix = '') {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  });
}
function snapshot(directory) {
  return Object.fromEntries(files(directory).sort().map(relative => [relative, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, relative))).digest('hex')]));
}

test('public sync copies an explicit distribution, preserves Git, removes owned stale files, and is idempotent', t => {
  const f = fixture(t);
  const marker = crypto.randomUUID();
  for (const relative of ['.env.secret', 'scratch/private.txt', 'node_modules/private.txt', 'scripts/public-evals-deps/node_modules/private.txt', 'tests/private-notes.json', 'runtime/scratch-secret.cjs', 'compat/codex-0.154/agentguard/runtime/scratch-secret.cjs', '.git/private.txt']) {
    const filename = path.join(f.source, relative);
    fs.mkdirSync(path.dirname(filename), {recursive: true});
    fs.writeFileSync(filename, marker);
  }
  // The unlisted runtime file also exists in the generated source artifact.
  // Both copies must be excluded by the sync allowlist.
  fs.writeFileSync(path.join(f.destination, '.git', 'review-sentinel'), 'git directory must survive');
  fs.writeFileSync(path.join(f.destination, 'UNRELATED-NOTES.txt'), 'outside the package deletion scope');
  fs.mkdirSync(path.join(f.destination, 'runtime'));
  fs.writeFileSync(path.join(f.destination, 'runtime', 'stale.cjs'), 'old distribution file');
  const gitConfig = fs.readFileSync(path.join(f.destination, '.git', 'config'));
  const result = sync(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Review the working tree/);
  assert.equal(fs.readFileSync(path.join(f.destination, '.git', 'review-sentinel'), 'utf8'), 'git directory must survive');
  assert.deepEqual(fs.readFileSync(path.join(f.destination, '.git', 'config')), gitConfig);
  assert.equal(fs.readFileSync(path.join(f.destination, 'UNRELATED-NOTES.txt'), 'utf8'), 'outside the package deletion scope');
  assert.equal(fs.existsSync(path.join(f.destination, 'runtime', 'stale.cjs')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'scripts/public-evals-deps/node_modules')), false);
  for (const relative of ['scripts/score-public-evals.cjs', 'scripts/public-evals-deps/package-lock.json', 'docs/PUBLIC_EVALS.md', 'tests/public-evals.test.cjs', 'tests/guard-pack-heredoc.test.cjs', 'tests/fixtures/decision-model-fresh.jsonl', 'tests/fixtures/guard-pack-redteam/K-credentials.json',
    'runtime/attest.cjs', 'runtime/attestation-schema.cjs', 'runtime/presets/website.json', 'docs/ATTESTATION.md', 'tests/attest.test.cjs', 'tests/fixtures/attest-offline.cjs']) {
    assert.ok(fs.readFileSync(path.join(f.destination, relative)).equals(fs.readFileSync(path.join(f.source, relative))), relative);
  }
  for (const relative of files(f.destination)) assert.equal(fs.readFileSync(path.join(f.destination, relative)).includes(Buffer.from(marker)), false, relative);
  const catalog = JSON.parse(fs.readFileSync(path.join(f.destination, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(catalog.name, 'agentguard');
  assert.equal(catalog.plugins[0].source.path, './compat/codex-0.154/agentguard');
  assert.deepEqual(catalog.plugins[0].policy, {installation: 'AVAILABLE', authentication: 'ON_INSTALL'});
  assert.equal(catalog.plugins[0].category, 'Productivity');
  const before = snapshot(f.destination);
  const again = sync(f);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(snapshot(f.destination), before);
  assert.equal(execFileSync('git', ['-C', f.destination, 'rev-list', '--all', '--count'], {encoding: 'utf8'}).trim(), '0');
});

test('synced standalone checkout passes the same packaging tests without ancestor files', t => {
  const f = fixture(t);
  const result = sync(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Provision the existing registry packages into the isolated test checkout.
  // Runtime resolution must not depend on ancestor or global packages.
  fs.cpSync(path.join(root, 'node_modules'), path.join(f.destination, 'node_modules'), {recursive: true, verbatimSymlinks: true});
  const env = {...process.env, AGENTGUARD_HOME: path.join(f.temporary, 'sdk-home')};
  delete env.NODE_PATH;
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', 'tests/packaging.test.cjs'], {
    cwd: f.destination, encoding: 'utf8', timeout: 30000,
    env,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /(?:#|ℹ) fail 0/);
  assert.equal(fs.existsSync(path.join(f.temporary, 'public', 'logo.svg')), false);
});

// A runtime module that is missing from the enumerated list makes every hook fail
// open in the public tree (runtime/page-guard.cjs, Oct 18 2026). The synced tree
// must resolve every static relative require, and its core modules must load.
test('synced tree resolves every static require and loads the engine, MCP, client, guard and common modules', t => {
  const f = fixture(t);
  const result = sync(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const unresolved = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.(?:cjs|mjs|js)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(/\brequire\((['"])(\.\.?\/[^'"]+)\1\)|\bfrom (['"])(\.\.?\/[^'"]+)\3/g)) {
        const target = match[2] ?? match[4];
        if (target.includes('receipt-format')) continue;  // flag-gated and excluded on purpose
        if (target.includes('node_modules/')) continue;   // provisioned at install time, not part of the tree
        const base = path.resolve(path.dirname(full), target);
        if (![base, base + '.cjs', base + '.js', base + '.mjs', base + '.json', path.join(base, 'index.cjs'), path.join(base, 'index.js')].some(candidate => fs.existsSync(candidate)))
          unresolved.push(`${path.relative(f.destination, full)} -> ${target}`);
      }
    }
  };
  for (const name of ['runtime', 'hooks', 'live', 'scripts']) if (fs.existsSync(path.join(f.destination, name))) walk(path.join(f.destination, name));
  assert.deepEqual(unresolved, [], 'every static require in the synced tree must resolve');
  fs.cpSync(path.join(root, 'node_modules'), path.join(f.destination, 'node_modules'), {recursive: true, verbatimSymlinks: true});
  const env = {...process.env, AGENTGUARD_HOME: path.join(f.temporary, 'sdk-home')};
  delete env.NODE_PATH; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['-e', "for (const m of ['./runtime/common.cjs','./runtime/command-policy.cjs','./runtime/client.cjs','./runtime/engine.cjs','./runtime/mcp.cjs']) require(m); console.log('loaded')"],
    {cwd: f.destination, encoding: 'utf8', timeout: 30000, env});
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /loaded/);
});

test('sync rejects source symlinks and destination symlinks before modifying the checkout', t => {
  const f = fixture(t);
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside directory');
  fs.symlinkSync(outside, path.join(f.destination, 'runtime'), 'dir');
  const unsafeDestination = sync(f);
  assert.notEqual(unsafeDestination.status, 0);
  assert.match(unsafeDestination.stderr, /unsafe path/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside directory');
  assert.equal(fs.existsSync(path.join(f.destination, 'package.json')), false);
  fs.unlinkSync(path.join(f.destination, 'runtime'));
  fs.unlinkSync(path.join(f.source, 'assets', 'logo.svg'));
  fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(f.source, 'assets', 'logo.svg'));
  const unsafeSource = sync(f);
  assert.notEqual(unsafeSource.status, 0);
  assert.match(unsafeSource.stderr, /regular package file/);
  assert.equal(fs.existsSync(path.join(f.destination, 'package.json')), false);
});

test('sync refuses a checkout ancestor of its source and a checkout subdirectory', t => {
  const f = fixture(t);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', f.temporary]);
  const ancestor = sync(f, f.temporary);
  assert.notEqual(ancestor.status, 0);
  assert.match(ancestor.stderr, /must not contain/);
  fs.mkdirSync(path.join(f.destination, 'nested'));
  const nested = sync(f, path.join(f.destination, 'nested'));
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /root of an existing Git checkout/);
});
