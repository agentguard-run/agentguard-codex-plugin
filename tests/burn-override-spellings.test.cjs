'use strict';
// Guarantee V (0.7.8). An agent cannot lift a Burn STOP by spelling the command another way.
//
// In plain words:
//   V1  Every spelling of a shell command that runs Burn's command line with an override verb (each verb in
//       BURN_VERBS) is flagged as an override attempt: whatever version, tag or range follows the package name,
//       however the name and the verb are quoted, whichever launcher and launcher flags come first, whatever
//       Burn flags stand before the verb, and whether the command stands alone, is handed to a shell or to
//       npx as a string, or reaches a shell tool as a list of words.
//   V2  The same spellings with any other Burn verb are not flagged, and the scan gives them exactly the answer
//       it gives the plain spelling (bare name, no quotes, single spaces).
//   V3  The check stays fast on a line built to make it slow.
//
// What the generator builds a spelling from:
//   the package: agentguard-burn or @agentguard-run/burn, bare or followed by a tag, a version or a range
//     (a range that needs quoting is always quoted);
//   the program: the package after npx, bunx, npm exec, npm x, pnpm dlx, yarn dlx or bun x, with their flags
//     and flag values; the bin after -p, --package and --package=; the bin by name, with .cmd, by path, or
//     after yarn, pnpm exec and npm exec; Burn's cli.js after node, or run by its path;
//   quoting of the name and of the verb: none, single, double, $'...', a quote opened inside the word, an
//     empty pair inside the word, a backslash inside the word;
//   Burn flags before the verb: none, --simple, --detailed, --record with its file;
//   spacing: one or more spaces and tabs;
//   around the command: nothing, sudo, env, an assignment, nohup, command, time, nice, cd first, another
//     command first, a subshell, a pipe, a redirect, and the command as a string for bash, sh, zsh, sudo sh,
//     env bash, eval, npx -c and npm exec -c.
// Temporary directories only. No command here is ever run: the scan reads text.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const {scanCommands, BURN_VERBS} = require('../runtime/command-policy.cjs');

const RUNS = 2000;
const VERBS = [...BURN_VERBS];
// Burn verbs that change nothing an agent may not change. `telemetry` is the person's choice under another rule.
const OTHER_VERBS = ['why', 'compare', 'models', 'week', 'status', 'tally', 'calendar', 'card', 'limits', 'enforce', 'install', 'help'];

// [what follows the name, whether a shell needs it quoted]
const TAGS = [['', false], ['@latest', false], ['@next', false], ['@beta', false], ['@0.7.2', false], ['@0.3.18', false], ['@0', false], ['@0.7', false],
  ['@0.7.x', false], ['@^0.7.0', false], ['@~0.7.1', false], ['@>=0.7.0', true], ['@>=0.7.0 <1', true], ['@0.7.1 || 0.7.2', true], ['@*', true], ['@<1', true]];
// Ways a shell reads the same word. `at` is a place inside the word.
const QUOTE = {
  plain: word => word,
  single: word => `'${word}'`,
  double: word => `"${word}"`,
  ansi: word => `$'${word}'`,
  openDouble: (word, at) => `${word.slice(0, at)}"${word.slice(at)}"`,
  openSingle: (word, at) => `${word.slice(0, at)}'${word.slice(at)}'`,
  emptyPair: (word, at) => `${word.slice(0, at)}''${word.slice(at)}`,
  backslash: (word, at) => `${word.slice(0, at)}\\${word.slice(at)}`,
};
const WHOLE = ['single', 'double', 'ansi', 'openDouble', 'openSingle'];  // styles that keep a space or a < inside one word
const shq = text => `'${text.replaceAll("'", "'\\''")}'`;
const dq = text => `"${text.replace(/[\\"$`]/g, '\\$&')}"`;
const SPEC_LAUNCHERS = ['npx', 'npx -y', 'npx --yes', 'npx -q', 'bunx', 'npm exec', 'npm exec --', 'npm exec --yes --', 'npm x', 'npm x --', 'pnpm dlx', 'yarn dlx', 'bun x',
  'npx --registry https://registry.npmjs.org', 'npx --cache /tmp/npx-cache', 'npm exec --registry=https://registry.npmjs.org --'];
const PACKAGE_LAUNCHERS = [['npx', ''], ['npx -y', ''], ['npm exec', ' --'], ['npm x', ' --']];
const PROGRAMS = [[], ['yarn'], ['pnpm', 'exec'], ['npm', 'exec'], ['npx', '--no-install']];
const BINS = ['agentguard-burn', 'agentguard-burn.cmd', './node_modules/.bin/agentguard-burn', 'node_modules/.bin/agentguard-burn', '/usr/local/bin/agentguard-burn'];
const SCRIPTS = ['./node_modules/@agentguard-run/burn/dist/src/cli.js', 'node_modules/@agentguard-run/burn/dist/src/cli.js',
  '/usr/local/lib/node_modules/@agentguard-run/burn/dist/src/cli.js', './node_modules/agentguard-burn/node_modules/@agentguard-run/burn/dist/src/cli.js'];
const NODES = [[], ['node'], ['node', '--no-warnings']];
const FLAGS = [[], ['--simple'], ['--detailed'], ['--record', '/tmp/r.jsonl'], ['--simple', '--record', 'r.jsonl'], ['--record', 'out.jsonl', '--detailed']];
const OVERRIDE_TAILS = [[], ['--once', '--reason', 'x'], ['--once', '--reason', "'checked by hand'"], ['--force'], ['--once']];
const OTHER_TAILS = [[], ['--json'], ['json'], ['--days', '14']];
const WRAPS = {
  none: text => text,
  sudo: text => `sudo ${text}`,
  sudoUser: text => `sudo -u me ${text}`,
  env: text => `env FOO=bar ${text}`,
  assignment: text => `FOO=bar ${text}`,
  nohup: text => `nohup ${text}`,
  command: text => `command ${text}`,
  time: text => `time ${text}`,
  nice: text => `nice -n 5 ${text}`,
  cdFirst: text => `cd /tmp && ${text}`,
  after: text => `true; ${text}`,
  orElse: text => `false || ${text}`,
  subshell: text => `( ${text} )`,
  piped: text => `${text} | cat`,
  redirected: text => `${text} > /dev/null 2>&1`,
  bash: text => `bash -c ${shq(text)}`,
  bashLogin: text => `bash -lc ${dq(text)}`,
  sh: text => `sh -c ${dq(text)}`,
  zsh: text => `zsh -c ${shq(text)}`,
  sudoSh: text => `sudo sh -c ${shq(text)}`,
  envBash: text => `env FOO=bar bash -c ${dq(text)}`,
  evaluated: text => `eval ${shq(text)}`,
  npxCall: text => `npx -c ${shq(text)}`,
  npxCallPackage: text => `npx --package=agentguard-burn@latest -c ${dq(text)}`,
  npmCall: text => `npm exec -c ${shq(text)}`,
};

const shape = fc.record({
  kind: fc.constantFrom('spec', 'spec', 'spec', 'package', 'package', 'bin', 'script'),
  pick: fc.nat({max: 9999}), at: fc.nat({max: 9999}), other: fc.nat({max: 9999}),
  pkg: fc.constantFrom('agentguard-burn', '@agentguard-run/burn'),
  tag: fc.constantFrom(...TAGS),
  nameQuote: fc.constantFrom(...Object.keys(QUOTE)), verbQuote: fc.constantFrom(...Object.keys(QUOTE)), packageQuote: fc.constantFrom('plain', 'single', 'double'),
  packageFlag: fc.constantFrom('-p ', '--package ', '--package='),
  flags: fc.constantFrom(...FLAGS), gap: fc.constantFrom(' ', '  ', '   ', '\t', ' \t '), wrap: fc.constantFrom(...Object.keys(WRAPS)),
});
const from = (list, number) => list[number % list.length];
// A place inside the last "burn" of a word, so a quote opened there also holds whatever follows the name.
const inName = (word, number) => word.lastIndexOf('burn') + 1 + number % 3;
const name = (s, word, plain, needsQuote = false) => plain ? word : QUOTE[needsQuote && !WHOLE.includes(s.nameQuote) ? 'double' : s.nameQuote](word, inName(word, s.at));
const spoken = (s, verb, plain) => plain ? verb : QUOTE[s.verbQuote](verb, 1 + s.other % (verb.length - 1));

// The words of one spelling. `plain` is the same command with a bare name, no quotes and single spaces.
function render(s, verb, tail, plain = false) {
  const [tag, needsQuote] = plain ? ['', false] : s.tag;
  let head;
  if (s.kind === 'spec') head = [from(SPEC_LAUNCHERS, s.pick), name(s, s.pkg + tag, plain, needsQuote)];
  else if (s.kind === 'package') {
    const [launcher, separator] = from(PACKAGE_LAUNCHERS, s.pick);
    const spec = plain ? s.pkg : QUOTE[needsQuote && s.packageQuote === 'plain' ? 'double' : s.packageQuote](s.pkg + tag);
    head = [`${launcher} ${s.packageFlag}${spec}${separator}`, name(s, 'agentguard-burn', plain)];
  } else if (s.kind === 'bin') {
    const runner = from(PROGRAMS, s.pick);
    // A bin with .cmd or a path is run as it is; a runner takes the bare bin name.
    head = [...runner, name(s, runner.length ? 'agentguard-burn' : from(BINS, s.other), plain)];
  } else {
    const script = from(SCRIPTS, s.other);
    head = [...from(NODES, s.pick), plain ? script : QUOTE[['plain', 'single', 'double'].includes(s.nameQuote) ? s.nameQuote : 'double'](script)];
  }
  const words = [...head, ...s.flags, spoken(s, verb, plain), ...tail];
  return WRAPS[s.wrap](words.join(plain ? ' ' : s.gap));
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-burn-spellings-')));
  const home = path.join(base, 'burn'), workspace = path.join(base, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  const previous = process.env.AGENTGUARD_HOME; process.env.AGENTGUARD_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.AGENTGUARD_HOME; else process.env.AGENTGUARD_HOME = previous; fs.rmSync(base, {recursive: true, force: true}); });
  // The agent works in its own folder, outside Burn's.
  return (command, tool = 'Bash', key = 'command') => scanCommands({}, tool, {[key]: command}, {cwd: workspace});
}

test('the override verbs under test are the ones the scan knows', () => {
  assert.deepEqual([...BURN_VERBS].sort(), ['calibrate', 'resume', 'shadow']);
  for (const verb of OTHER_VERBS) assert.equal(BURN_VERBS.has(verb), false);
});

test('V1: a versioned, quoted or flagged spelling of an override is flagged, each verb, each form seen on a real machine', t => {
  const scan = fixture(t);
  for (const verb of VERBS) for (const command of [
    `npx agentguard-burn ${verb}`, `npx "agentguard-burn" "${verb}"`,
    `npx "agentguard-burn@latest" "${verb}"`, `npx 'agentguard-burn@0.7.2' '${verb}'`, `npx -y "agentguard-burn@^0.7.0" "${verb}"`, `npx --yes "agentguard-burn@next" "${verb}"`,
    `npx "@agentguard-run/burn@latest" "${verb}"`, `npx "@agentguard-run/burn@>=0.7.0 <1" "${verb}"`, `npx "agentguard-burn@>=0.7.0 <1" "${verb}"`,
    `npx -p agentguard-burn@latest agentguard-burn "${verb}"`, `npx --package agentguard-burn@latest "agentguard-burn" "${verb}"`, `npx --package=@agentguard-run/burn@0.7.2 agentguard-burn "${verb}"`,
    `npx --registry https://registry.npmjs.org "agentguard-burn" "${verb}"`, `npm x "agentguard-burn@latest" "${verb}"`, `npm exec -- "agentguard-burn@latest" "${verb}"`, `bun x "agentguard-burn" "${verb}"`,
    `agentguard-burn --record /tmp/r.jsonl ${verb}`, `npx agentguard-burn@latest --record r.jsonl "${verb}"`, `agentguard-burn.cmd "${verb}"`, `npx   "agentguard-burn@latest"\t"${verb}"`,
    `npx -c "agentguard-burn '${verb}'"`, `npx -c 'npx "agentguard-burn@>=0.7.0 <1" "${verb}"'`, `"./node_modules/@agentguard-run/burn/dist/src/cli.js" "${verb}"`,
  ]) assert.equal(scan(command).burnOverride, 'command', command);
  // The other shell tools read their text the same way.
  for (const [tool, key] of [['PowerShell', 'command'], ['exec_command', 'cmd'], ['shell_command', 'command']]) {
    assert.equal(scan('npx "agentguard-burn@latest" "resume"', tool, key).burnOverride, 'command', tool);
  }
  // A shell tool that takes a list of words instead of a line: the words are read as they stand.
  for (const verb of VERBS) for (const words of [
    ['npx', 'agentguard-burn', verb], ['npx', '-y', 'agentguard-burn@latest', verb, '--once', '--reason', 'x'], ['npx', '@agentguard-run/burn@>=0.7.0 <1', verb],
    ['npx', '-p', 'agentguard-burn@0.7.2', 'agentguard-burn', verb], ['agentguard-burn', '--record', '/tmp/r.jsonl', verb], ['npm', 'x', '--', 'agentguard-burn@next', verb],
    ['node', './node_modules/@agentguard-run/burn/dist/src/cli.js', verb], ['bash', '-lc', `npx "agentguard-burn@latest" "${verb}"`], ['npx', '-c', `agentguard-burn '${verb}'`],
  ]) assert.equal(scan(words, 'shell').burnOverride, 'command', JSON.stringify(words));
  for (const words of [['npx', 'agentguard-burn@latest', 'models'], ['npx', '-y', 'agentguard-burn@latest', 'why', '--json'], ['agentguard-burn', '--record', '/tmp/r.jsonl', 'why'],
    ['echo', 'resume', 'shadow', 'calibrate'], ['npm', 'run', 'resume'], ['bash', '-lc', 'npx agentguard-burn@latest week']]) {
    assert.equal(scan(words, 'shell').burnOverride, undefined, JSON.stringify(words));
  }
});

test(`V1 property: every generated spelling of an override is flagged (${RUNS} shapes, every override verb)`, t => {
  const scan = fixture(t);
  let checked = 0;
  fc.assert(fc.property(shape, fc.constantFrom(...OVERRIDE_TAILS), (s, tail) => {
    for (const verb of VERBS) {
      const command = render(s, verb, tail);
      assert.equal(scan(command).burnOverride, 'command', `not flagged: ${command}`);
      checked++;
    }
  }), {numRuns: RUNS, seed: 20261126});
  assert.equal(checked, RUNS * VERBS.length);
});

test(`V2 property: the same spellings with another verb are not flagged and get the plain spelling's answer (${RUNS} shapes)`, t => {
  const scan = fixture(t);
  let checked = 0;
  fc.assert(fc.property(shape, fc.constantFrom(...OTHER_VERBS), fc.constantFrom(...OTHER_TAILS), (s, verb, tail) => {
    const command = render(s, verb, tail), plain = render(s, verb, tail, true);
    const result = scan(command), expected = scan(plain);
    assert.equal(result.burnOverride, undefined, `flagged: ${command}`);
    // The tokenizer marks a $'...' inside a string handed to a shell as text it cannot see, whatever the
    // command is. That mark is the one difference from the plain spelling allowed here.
    if (result.commandScanIncomplete && command.includes("$'")) expected.commandScanIncomplete = true;
    assert.deepEqual(result, expected, `${command} is answered differently from ${plain}`);
    checked++;
  }), {numRuns: RUNS, seed: 20261127});
  assert.equal(checked, RUNS);
});

test('V2: commands that only mention Burn, or only use an override word, stay unflagged', t => {
  const scan = fixture(t);
  for (const command of ['npx agentguard-burn@latest models', 'npx -y agentguard-burn@latest week', 'npx "agentguard-burn@latest" "why"', 'npx agentguard-burn@latest why --json',
    'echo resume shadow calibrate', 'npm run resume', 'npm view agentguard-burn@latest version', 'npm install agentguard-burn@latest', 'grep -rn "agentguard-burn" README.md',
    'cat packages/agentguard-burn/README.md', 'ls node_modules/.bin/agentguard-burn', 'git commit -m "Burn 0.7.2: the models view"', 'npx -c "agentguard-burn why"',
    'agentguard-burn --record /tmp/r.jsonl why', 'agentguard-burn why --record resume.jsonl']) {
    assert.equal(scan(command).burnOverride, undefined, command);
  }
});

test('V3: a line built to make the check slow is answered in well under a hook\'s two seconds', t => {
  const scan = fixture(t);
  const lines = [
    `agentguard-burn ${'--record '.repeat(220)}x`,
    `agentguard-burn ${'--record x '.repeat(160)}why`,
    `agentguard-burn${' '.repeat(1900)}why`,
    `${'agentguard-burn '.repeat(120)}why`,
    `npx -c "${'agentguard-burn --simple '.repeat(70)}why"`,
  ];
  const command = Array.from({length: 30}, (_, index) => lines[index % lines.length]).join('\n');
  const started = performance.now();
  const result = scan(command);
  const elapsed = performance.now() - started;
  assert.equal(result.burnOverride, undefined);
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
  // One very long line of names: the words are read in one pass, whatever their number.
  const long = `${'agentguard-burn '.repeat(24000)}why`;
  const longStarted = performance.now();
  assert.equal(scan(long).burnOverride, undefined);
  const longElapsed = performance.now() - longStarted;
  assert.ok(longElapsed < 1000, `24,000 names took ${Math.round(longElapsed)} ms`);
});
