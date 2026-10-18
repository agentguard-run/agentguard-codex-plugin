'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('./helper-test-env.cjs');
const page = require('../runtime/page-guard.cjs');
const {metadata} = require('../runtime/common.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {run, localPolicy, policyConfig} = require('../runtime/policy-cli.cjs');
const {scanCommands, commandResult} = require('../runtime/command-policy.cjs');
const {mergeGuardPack, validateGuardPack, validateOrgPolicy} = require('../runtime/org-policy-contract.cjs');
const {approve, pending} = require('../runtime/policy-approval.cjs');
const matrix = require('./helper-host-matrix.cjs');
const website = require('../runtime/presets/website.json');
const root = path.resolve(__dirname, '..');
const permission = result => result.output.hookSpecificOutput?.permissionDecision ?? 'allow';
const held = matrix.isClaude ? 'ask' : 'deny';
function fixture(t, policy = website) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-page-data-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-page-workspace-'));
  const keys = [...matrix.envKeys, 'AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data); process.env.AGENTGUARD_HOME = path.join(data, 'burn');
  process.env.AGENTGUARD_LICENSE_KEY = ''; process.env.AGENTGUARD_PLUGIN_POLICY = '';
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
  let engine;
  t.after(async () => {
    await engine?.close();
    const loc = require('../runtime/common.cjs').locations(data);
    if (fs.existsSync(loc.ready)) {
      spawnSync(process.execPath, ['runtime/control.cjs', 'stop'], {cwd: root, env: {...process.env}, encoding: 'utf8'});
      const deadline = Date.now() + 3000;
      while (fs.existsSync(loc.ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(loc.ready), false, 'Fixture worker must stop before cleanup');
    }
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true}); fs.rmSync(workspace, {recursive: true, force: true}); fs.rmSync(loc.ipc, {recursive: true, force: true});
  });
  return {data, workspace, write: (file, content) => { fs.writeFileSync(path.join(workspace, file), content); },
    meta: (tool, input, id = 'edit') => metadata({session_id: 'page-session', tool_use_id: id, tool_name: tool, cwd: workspace, tool_input: input}, 'spend'),
    start: async () => { engine = new Engine(); await engine.init(); return engine; }};
}
const examples = {form: '<form></form>', table: '<table></table>', iframe: '<iframe />', video: '<video />', audio: '<audio />', embed: '<embed />', object: '<object />', img: '<img src="/private-image" />', structured_data: '<script type="application/ld+json">{"private":"value"}</script>', canonical: '<link rel="canonical" href="https://private.invalid/page" />', h1: '<h1>Private title</h1>', h2: '<h2>Private title</h2>', h3: '<h3>Private title</h3>'};
for (const ext of ['html', 'md', 'mdx', 'jsx']) for (const [type, source] of Object.entries(examples)) test(`${ext}: detects removal of ${type}, permits addition and text-only changes`, () => {
  assert.equal(page.compare(source, '', 'page.' + ext).counts[type], 1);
  assert.deepEqual(page.compare('', source, 'page.' + ext).counts, {});
  assert.deepEqual(page.compare(source, source.replaceAll('Private title', 'Updated title').replace('"value"', '"changed"'), 'page.' + ext).counts, {});
});
for (const ext of ['mdx', 'jsx', 'tsx', 'astro', 'vue', 'svelte']) test(`${ext}: component identities survive equal overall tag counts`, () => {
  const change = page.compare('<Quiz /><Pricing.Table /><Quiz />', '<Quiz /><Other />', 'page.' + ext);
  assert.equal(change.counts.component, 2); assert.deepEqual(change.components, [['Quiz', 1], ['Pricing.Table', 1]]);
});
test('JSX capitalized native lookalikes are components and do not hide following tags', () => {
  for (const name of ['Form', 'Table', 'Img', 'Video', 'Audio', 'H1', 'Script', 'Link']) {
    const result = page.compare(`<${name} /><form />`, `<${name.toLowerCase()} /><form />`, 'page.jsx');
    assert.equal(result.counts.component, 1, name); assert.deepEqual(result.components, [[name, 1]]);
  }
  assert.deepEqual(page.compare('<Script /><form />', '', 'page.jsx').counts, {form: 1, component: 1});
  assert.equal(page.compare('<FORM />', '', 'page.html').counts.form, 1);
});
test('canonical href changes are detected in quoted, unquoted and JSX attributes', () => {
  for (const attrs of ['rel="canonical" href="/old"', "href='/old' rel='alternate canonical'", 'rel=canonical href=/old', 'href={"/old"} rel="canonical"']) {
    assert.equal(page.compare(`<link ${attrs} />`, `<link ${attrs.replace('/old', '/new')} />`, 'p.jsx').counts.canonical, 1);
  }
  assert.deepEqual(page.compare('<link href="/a" rel="canonical">', '<link rel="canonical" href="/a" />', 'p.html').counts, {});
});
test('canonical href changes ask through the engine on both hosts', async t => {
  const f = fixture(t), engine = await f.start(); f.write('page.jsx', '<link rel="canonical" href="/old" />');
  const meta = f.meta('Edit', {file_path: 'page.jsx', old_string: '/old', new_string: '/new'});
  assert.equal(permission(await engine.handle({meta})), held);
  assert.deepEqual(meta.pageGuard.counts, {canonical: 1});
});
test('Markdown headings, tables, images, inline links and reference links are counted', () => {
  const source = '# One\n## Two\n### Three\nSetext\n======\n\n| A | B |\n| --- | --- |\n| a | b |\n![photo](/img.png)\n[a](/pricing) [b](../docs) [c][help]\n[help]: /help\n';
  assert.deepEqual(page.compare(source, '', 'p.md').counts, {h1: 2, h2: 1, h3: 1, table: 1, img: 1, internal_link: 3});
  assert.deepEqual(page.compare(source, source.replace('One', 'New one').replace('photo', 'New photo'), 'p.md').counts, {});
});
test('comments, code fences, inline code, script strings, anchors and external links do not count', () => {
  const source = '<!-- <form /> -->\n```html\n<table />\n```\n`<img />`\n<script>const x = "<video />";</script>\n[a](https://private.invalid) [b](//example.invalid) [c](mailto:a@example.invalid) [d](#here)';
  assert.deepEqual(page.compare(source, '', 'p.mdx').counts, {});
  assert.equal(page.compare('<form title="a > b">x</form>', '', 'p.html').counts.form, 1);
});
test('website preset preserves careful limits and enables validated opt-in checks', async t => {
  const f = fixture(t, {...require('../runtime/presets/careful.json'), unrelated: true, licenseKey: 'synthetic-key'});
  await run(['preset', 'website'], {data: f.data}); const policy = localPolicy(f.data);
  assert.equal(policy.unrelated, true); assert.equal(policy.licenseKey, 'synthetic-key');
  assert.deepEqual(policy.caps, require('../runtime/presets/careful.json').caps);
  assert.equal(policy.guardPack.rules.GP020, 'ask'); assert.equal(policy.guardPack.rules['inbox-reset-codes'], 'stop');
  assert.equal(mergeGuardPack().rules.GP020, 'off'); assert.deepEqual(validateOrgPolicy(policyConfig(policy)), []);
  for (const id of ['force-push', 'outside-workspace-delete', 'page-delete']) assert.equal(policy.commandRules.find(rule => rule.id === id).action, 'block');
  assert.match(await run(['explain', 'page-guard'], {data: f.data}), /GP020.*Effective action: ask/);
  await run(['preset', 'solo-dev'], {data: f.data}); assert.equal(mergeGuardPack(localPolicy(f.data)).rules.GP020, 'off');
});
test('page threshold is validated and stricter policy layers win', () => {
  for (const threshold of [0, -1, '3', 1.5, null]) assert.ok(validateGuardPack({pageGuard: {internalLinkThreshold: threshold}}).length);
  assert.ok(validateGuardPack({rules: {GP001: 'ask'}}).length);
  assert.ok(validateGuardPack({pageGuard: {content: '/private'}}).length);
  const merged = mergeGuardPack({guardPack: {rules: {GP020: 'ask'}, pageGuard: {internalLinkThreshold: 4}}}, {guardPack: {rules: {GP020: 'warn'}, pageGuard: {internalLinkThreshold: 2}}});
  assert.equal(merged.rules.GP020, 'ask'); assert.equal(merged.pageGuard.internalLinkThreshold, 2);
});
const deployments = ['vercel', 'vercel --prod', 'vercel deploy', 'vc .', 'netlify deploy', 'npx netlify deploy --prod', 'wrangler deploy', 'wrangler pages deploy dist', 'wrangler pages publish dist', 'firebase deploy', 'gh-pages -d dist', 'npx gh-pages -d dist', 'git push origin main', 'git push origin master', 'git push origin production', 'git push origin HEAD:refs/heads/main', 'npm publish', 'pnpm publish', 'yarn npm publish', 'bun publish'];
for (const command of deployments) test(`website requests approval: ${command}`, async t => {
  const f = fixture(t), engine = await f.start();
  const result = await engine.handle({meta: f.meta('Bash', {command})});
  assert.equal(permission(result), held); assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /AgentGuard (deploy|website-publish|package-publish).*([Aa]llow|allow once)/);
});
for (const ext of ['html', 'htm', 'md', 'mdx', 'astro', 'vue', 'svelte', 'jsx', 'tsx', 'njk', 'liquid']) test(`website blocks shell page deletion: ${ext}`, async t => {
  const f = fixture(t), engine = await f.start();
  for (const [i, command] of [`rm page.${ext}`, `git rm page.${ext}`, `unlink page.${ext}`, `mv page.${ext} ~/.Trash/`, `trash page.${ext}`, `gio trash page.${ext}`].entries()) {
    const result = await engine.handle({meta: f.meta('Bash', {command}, String(i))});
    assert.equal(permission(result), 'deny'); assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /page-delete.*allow once/);
  }
});
test('page deletion follows wrappers, braces, variables, globs and directory operands', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.workspace, 'pages')); f.write('pages/index.html', '<form />');
  for (const command of ['sudo rm page.html', 'bash -c "unlink page.mdx"', 'rm page.{md,txt}', 'P=page.jsx; rm "$P"', 'rm pages/*', 'rm -r pages', 'rm -- -page.html', 'mv -t ~/.Trash page.html', 'osascript -e \'tell application "Finder" to delete POSIX file "page.html"\'']) {
    assert.deepEqual(scanCommands(website, 'Bash', {command}, {cwd: f.workspace}).commandRuleIds, ['page-delete'], command);
  }
});
test('ordinary non-page deletes and feature pushes stay allowed', async t => {
  const f = fixture(t), engine = await f.start();
  for (const [i, command] of ['rm temp.txt', 'git rm cache.json', 'unlink script.js', 'mv data.csv ~/.Trash/', 'git push origin feature/topic'].entries()) {
    assert.equal(permission(await engine.handle({meta: f.meta('Bash', {command}, String(i))})), 'allow', command);
  }
});
test('shell delete blocks can be allowed once, with other policy restrictions retained', async t => {
  const f = fixture(t), engine = await f.start();
  const call = id => ({meta: f.meta('Bash', {command: 'rm page.html'}, id)});
  assert.equal(permission(await engine.handle(call('one'))), 'deny');
  approve(f.data, pending(f.data)[0].token);
  assert.equal(permission(await engine.handle(call('two'))), 'allow');
  assert.equal(permission(await engine.handle(call('three'))), 'deny');
  const layered = {...website, commandRuleGroups: [website.commandRules, [{id: 'team-delete', match: 'page-delete', action: 'block'}]]};
  const command = commandResult(layered, scanCommands(layered, 'Bash', {command: 'rm page.html'}, {cwd: f.workspace}));
  assert.equal(command.id, 'team-delete'); assert.notEqual(command.allowOnce, true);
  fs.writeFileSync(path.join(f.data, 'policy.json'), JSON.stringify({...website, deniedTools: ['Bash']}));
  assert.equal(permission(await engine.handle(call('tool-denied'))), 'deny');
});
for (const file of ['robots.txt', 'sitemap.xml', 'sitemap-products.xml', '.htaccess', '_redirects', 'vercel.json', 'netlify.toml']) test(`any site configuration change asks: ${file}`, async t => {
  const f = fixture(t), engine = await f.start(); f.write(file, 'before');
  assert.equal(permission(await engine.handle({meta: f.meta('Write', {file_path: file, content: 'after'})})), held);
  assert.equal(permission(await engine.handle({meta: f.meta('Write', {file_path: file, content: 'before'}, 'unchanged')})), 'allow');
});
test('actual before state, exact edits, MultiEdit, editor tools and Codex patches reconstruct without writing', t => {
  const f = fixture(t); const source = '<h1>Title</h1>\n<form />\n<Quiz />\n'; f.write('page.mdx', source);
  const variants = [
    ['Edit', {file_path: 'page.mdx', old_string: '<form />', new_string: ''}],
    ['MultiEdit', {file_path: 'page.mdx', edits: [{old_string: '<form />', new_string: '<table />'}, {old_string: '<table />', new_string: ''}]}],
    ['str_replace_editor', {command: 'str_replace', path: 'page.mdx', old_str: '<form />', new_str: ''}],
    ['apply_patch', '*** Begin Patch\n*** Update File: page.mdx\n@@\n <h1>Title</h1>\n-<form />\n <Quiz />\n*** End Patch'],
    ['functions.apply_patch', {input: '*** Begin Patch\n*** Update File: page.mdx\n@@ <h1>Title</h1>\n-<form />\n <Quiz />\n*** End of File\n*** End Patch'}],
  ];
  for (const [tool, input] of variants) { const result = page.scan(tool, input, {cwd: f.workspace}); assert.equal(result.triggered, true, tool); assert.deepEqual(result.meta.counts, {form: 1}, tool); assert.equal(result.meta.errors, 0, tool); }
  assert.equal(fs.readFileSync(path.join(f.workspace, 'page.mdx'), 'utf8'), source);
  assert.equal(page.scan('apply_patch', {patch: '*** Begin Patch\n*** Delete File: page.mdx\n*** End Patch'}, {cwd: f.workspace}).meta.counts.component, 1);
});
test('additions, unchanged element counts, reads, shell rewrites and default-off never trigger', t => {
  const f = fixture(t, {version: 1}); f.write('page.html', '<form />');
  assert.equal(f.meta('Write', {file_path: 'page.html', content: ''}).pageGuard, undefined);
  for (const [tool, input] of [['Write', {file_path: 'page.html', content: '<form /><table />'}], ['Edit', {file_path: 'page.html', old_string: '<form />', new_string: '<form>new text</form>'}], ['apply_patch', '*** Begin Patch\n*** Add File: new.mdx\n+<Quiz />\n*** End Patch']]) assert.equal(page.scan(tool, input, {cwd: f.workspace}).triggered, false);
  assert.equal(page.scan('str_replace_editor', {command: 'view', path: 'page.html'}, {cwd: f.workspace}), null);
  assert.equal(page.scan('Bash', {command: "sed -i '' 's/form/div/g' page.html"}, {cwd: f.workspace}), null);
});
test('internal-link threshold uses removed destinations and aggregates one edit', t => {
  const f = fixture(t); f.write('links.md', '[a](/pricing) [b](/docs) [c](help) [d](#anchor) [e](https://private.invalid)');
  const input = {file_path: 'links.md', content: '[d](#anchor) [e](https://private.invalid)'};
  for (const threshold of [1, 2, 3]) assert.equal(page.scan('Write', input, {cwd: f.workspace, threshold}).triggered, true);
  assert.equal(page.scan('Write', input, {cwd: f.workspace, threshold: 4}).triggered, false);
  assert.equal(page.scan('Write', {...input, content: '[a](/new) [b](/docs) [c](help)'}, {cwd: f.workspace}).triggered, false);
  f.write('one.html', '<a href="/one">x</a>'); f.write('two.html', '<a href="/two">x</a><a href="/three">x</a>');
  assert.equal(page.scan('apply_patch', '*** Begin Patch\n*** Delete File: one.html\n*** Delete File: two.html\n*** End Patch', {cwd: f.workspace}).triggered, true);
});
test('files over 2 MB skip with a notice; exactly 2 MB is scanned', async t => {
  const f = fixture(t), engine = await f.start();
  f.write('large.html', '<form />' + 'x'.repeat(page.MAX_BYTES - 8));
  let meta = f.meta('Write', {file_path: 'large.html', content: ''}); assert.equal(meta.pageGuard.counts.form, 1); assert.equal(meta.pageGuard.skippedFiles, 0);
  f.write('large.html', 'x'.repeat(page.MAX_BYTES + 1)); meta = f.meta('Write', {file_path: 'large.html', content: ''});
  const result = await engine.handle({meta}); assert.equal(permission(result), 'allow');
  assert.match(page.decorate(result.output, meta).systemMessage, /GP020 skipped 1 file over 2 MB/);
  assert.equal(meta.pageGuard.skippedFiles, 1);
});
test('reconstruction errors fail open with content-free recorded events and notice', async t => {
  const f = fixture(t), engine = await f.start(); f.write('page.html', '<form /><form />');
  const meta = f.meta('Edit', {file_path: 'page.html', old_string: '<form />', new_string: ''});
  const result = await engine.handle({meta}); assert.equal(permission(result), 'allow');
  assert.equal(meta.pageGuard.event, 'fail_open'); assert.match(page.decorate(result.output, meta).systemMessage, /failed open/);
  assert.match(fs.readFileSync(engine.logStore.filePath, 'utf8'), /page_guard:fail_open/);
  fs.mkdirSync(path.join(f.workspace, 'dir.html'));
  assert.equal(f.meta('Write', {file_path: 'dir.html', content: ''}).pageGuard.errors, 1);
});
test('shadow warns with GP020 and creates no approval tickets', async t => {
  const f = fixture(t, {...website, mode: 'shadow'}), engine = await f.start(); f.write('page.html', '<form />');
  const meta = f.meta('Write', {file_path: 'page.html', content: ''});
  const result = await engine.handle({meta}); assert.equal(permission(result), 'allow');
  assert.match(page.decorate(result.output, meta).systemMessage, /This edit removes: 1 form.*WARN GP020/s);
  assert.deepEqual(pending(f.data), []);
});
test('moves and multi-hunk patches inspect the source and preserve content-free results', t => {
  const f = fixture(t); f.write('page.mdx', '<form />\nkeep\n<table />\n');
  const patch = '*** Begin Patch\n*** Update File: page.mdx\n@@\n-<form />\n+plain\n keep\n@@\n-<table />\n+text\n*** End of File\n*** End Patch';
  const result = page.scan('apply_patch', {patch}, {cwd: f.workspace});
  assert.equal(result.meta.errors, 0); assert.deepEqual(result.meta.counts, {form: 1, table: 1});
  const move = page.scan('apply_patch', '*** Begin Patch\n*** Update File: page.mdx\n*** Move to: other.mdx\n@@\n <form />\n keep\n <table />\n*** End Patch', {cwd: f.workspace});
  assert.equal(move.triggered, true); assert.deepEqual(move.meta.counts, {form: 1, table: 1});
  f.write('plain.txt', 'text\n');
  const overwrite = page.scan('apply_patch', '*** Begin Patch\n*** Update File: plain.txt\n*** Move to: page.mdx\n@@\n-text\n+new text\n*** End Patch', {cwd: f.workspace});
  assert.equal(overwrite.triggered, true); assert.deepEqual(overwrite.meta.counts, {form: 1, table: 1});
});
test('malformed Markdown remains bounded instead of backtracking over a whole page', () => {
  for (const before of ['['.repeat(2 * 1024 * 1024 - 16) + '\n<form />', '| heading |\n' + ' '.repeat(2 * 1024 * 1024 - 32) + '\n<form />']) {
    const start = performance.now(); assert.equal(page.compare(before, '', 'page.md').counts.form, 1);
    assert.ok(performance.now() - start < 250);
  }
  const start = performance.now(); assert.deepEqual(page.compare('{/*'.repeat(600000), '', 'page.jsx').counts, {});
  assert.ok(performance.now() - start < 250);
  assert.equal(page.compare('| One |\n| --- |\n| value |', '', 'page.md').counts.table, 1);
});
test('Codex holds GP020 until operator approval, binds file state, expires and consumes once', async t => {
  const f = fixture(t), engine = await f.start(); f.write('secret-page.mdx', '<form /><Quiz />');
  const call = id => ({meta: {...f.meta('Write', {file_path: 'secret-page.mdx', content: 'plain text'}, id), host: 'codex'}});
  assert.equal(permission(await engine.handle(call('one'))), 'deny'); let ticket = pending(f.data)[0]; assert.equal(ticket.ruleId, 'GP020'); approve(f.data, ticket.token);
  f.write('secret-page.mdx', '<form /><Quiz /><table />');
  assert.equal(permission(await engine.handle(call('two'))), 'deny'); ticket = pending(f.data).at(-1); approve(f.data, ticket.token);
  assert.equal(permission(await engine.handle(call('three'))), 'allow');
  assert.equal(permission(await engine.handle(call('four'))), 'deny');
  const expired = pending(f.data).at(-1); const file = path.join(f.data, 'policy-approvals', expired.token + '.json');
  const value = JSON.parse(fs.readFileSync(file)); fs.writeFileSync(file, JSON.stringify({...value, expires: Date.now() - 1, approved: true}));
  assert.equal(permission(await engine.handle(call('five'))), 'deny');
  const token = pending(f.data)[0].token;
  for (const id of ['six', 'seven', 'eight']) assert.equal(permission(await engine.handle(call(id))), 'deny');
  assert.equal(pending(f.data).length, 1); assert.equal(pending(f.data)[0].token, token);
});
test('human removal list includes component names and links; metadata, tickets and receipts never do', async t => {
  const f = fixture(t), engine = await f.start();
  f.write('private-page.mdx', '<form /><table /><PrivateQuiz /><a href="/private-pricing">A</a><a href="/private-docs">B</a><a href="/private-help">C</a>');
  const meta = f.meta('Write', {file_path: 'private-page.mdx', content: 'PRIVATE_PAGE_COPY'});
  const result = await engine.handle({meta}), output = page.decorate(result.output, meta);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /This edit removes: 1 form, 1 table/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /<PrivateQuiz \/> component/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /3 internal links.*\/private-pricing/s);
  const secret = /PrivateQuiz|private-page|private-pricing|private-docs|private-help|PRIVATE_PAGE_COPY/;
  assert.doesNotMatch(JSON.stringify(meta), secret); assert.doesNotMatch(fs.readFileSync(engine.logStore.filePath, 'utf8'), secret);
  for (const item of pending(f.data)) assert.doesNotMatch(fs.readFileSync(path.join(f.data, 'policy-approvals', item.token + '.json'), 'utf8'), secret);
  await engine.sessionReceipt({sessionId: 'page-session'}); await engine.flush();
  const reader = require('../runtime/mcp.cjs').createReader({dataDir: f.data});
  assert.equal((await reader.call('verify_chain', {})).ok, true);
  assert.doesNotMatch(JSON.stringify(await reader.call('list_decisions', {})), secret);
  assert.equal((await reader.call('get_work_receipt', {sessionId: 'page-session'})).signature.valid, true);
  for (const invalid of [{...meta.pageGuard, urls: ['/private-pricing']}, {...meta.pageGuard, counts: {PrivateQuiz: 1}}, {...meta.pageGuard, counts: {form: '/private'}}]) assert.equal(page.receiptValid(invalid), false);
});
test('real hook outputs the GP020 removal list on both hosts', async t => {
  const f = fixture(t); f.write('page.mdx', '<form /><Quiz />');
  // Start and stop only this fixture's worker, never a machine-wide process.
  const env = {...process.env}; matrix.environment(env, f.data);
  const raw = {session_id: 'page-session', tool_use_id: 'real-hook', tool_name: 'Write', cwd: f.workspace, tool_input: {file_path: 'page.mdx', content: ''}};
  const child = spawnSync(process.execPath, ['hooks/spend-gate.cjs'], {cwd: root, env, encoding: 'utf8', input: JSON.stringify(raw), timeout: 10000});
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
  const output = JSON.parse(child.stdout); assert.equal(output.hookSpecificOutput.permissionDecision, held); assert.match(output.hookSpecificOutput.permissionDecisionReason, /This edit removes:.*form.*Quiz/s);
  assert.doesNotMatch(fs.readFileSync(path.join(f.data, 'ledger/decisions.ndjson'), 'utf8'), /Quiz|page\.mdx/);
});
