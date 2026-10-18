'use strict';
// Raw command text stays inside the hook. IPC contains rule IDs and a digest.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {segments, SHELL} = require('./guard-pack.cjs');
const {hashPolicy} = require('./org-policy-contract.cjs');
const {locations} = require('./common.cjs');
const groups = config => config.commandRuleGroups ?? [config.commandRules ?? []];
const commandHash = config => hashPolicy(groups(config));
// Every scan runs inside a hook with a two second host budget, so text, lines,
// words, path depth and filesystem work are all bounded. A bound that drops
// anything marks the scan incomplete; nothing here may throw into a fail-open.
const MAX_SCAN_CHARS = 65536, LINE_CAP = 2048, WHOLE_CAP = 4096, MAX_LINES = 4096, MAX_WORDS = 512, MAX_COMPONENTS = 256, MAX_GLOB = 4096, MAX_BRACES = 64, MAX_WILDCARDS = 2;
// Verbs that change policy or approvals are never the agent's to run, on any host.
const POLICY_VERBS = new Set(['preset', 'set-cap', 'set-depth', 'helper-model', 'block', 'allow', 'push', 'approve', 'quiet', 'benchmark']);
// A move, copy or rename writes its destination and unlinks its source, so
// both count as write targets for the built-in plugin-state stop.
const WRITE = /(?:^|[._])(?:write|edit|multiedit|apply_patch|notebookedit|write_file|edit_file|create_file|update_file|str_replace_editor|str_replace_based_edit_tool|move_file|copy_file|rename_file|move|copy|rename)$/i;
const STATE_VARIABLES = /\$\{?(?:PLUGIN_DATA|CLAUDE_PLUGIN_DATA|AGENTGUARD_HOME)\b/;
const STATE_NAMES = new Set(['policy.json', 'org-policy.json', 'org-policy-status.json', 'policy-approvals', 'license-status', 'signing-key.hex', 'public-key.hex', 'fail-open-pending.ndjson', 'upgrade-moments', 'worker.ready', 'worker.lock',
  // The person's sharing choices: team weekly waste, daily counts and the acknowledged share.
  'team-waste.json', 'team-counts.json', 'waste-share.json']);
const DELETERS = new Set(['rm', 'remove-item', 'rmdir', 'unlink']);
const DEPLOYERS = /^(?:vercel|vc|netlify|fly|flyctl|wrangler|gcloud|aws|kubectl|terraform|helm|pulumi|serverless|sls|firebase)$/;
const DEPLOY_WORDS = /^(?:deploy|deployment|apply|destroy|upgrade|up|publish)$/;
const PUBLISHERS = /^(?:npm|pnpm|yarn|bun|cargo|poetry|twine|gem|dotnet|docker)$/;
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'time', 'function', 'case', 'esac']);
// A reference to the policy modules by name, with room for a glob or a split
// inside the name, and the words a node one-liner must mention to count.
const MODULE_REFERENCE = /(?:policy-(?:cl|approv|stat).{0,8}|counts-sync)\.c?js\b/i;
const MODULE_MENTION = /(?:^|[^A-Za-z0-9_-])(?:policy-(?:cli|approval|state)|policy\.json|policy-approvals|org-policy|counts-sync|team-(?:waste|counts)\.json|waste-share\.json|\.agentguard\b)/i;
// Burn's anonymous install count is the person's choice too: `agentguard-burn telemetry on|off|status`.
const BURN_TELEMETRY = /(?:^|[\s;&|(`])(?:npx\s+(?:-y\s+|--yes\s+)?)?agentguard-burn(?:@[^\s]+)?\s+telemetry(?=\s|$|[;&|)`])/i;
// An agent lifting a Burn STOP itself: Burn's resume, shadow or calibrate
// (which writes a shadow policy) run in any form, or Burn's override or policy
// file touched. The raw-text patterns are Burn 0.3.18's own
// (agentOverrideAttempt); the parse below also sees quoting, wrappers, nested
// shells and node running Burn's cli.js. Only a flag leaves the hook.
const BURN_VERBS = new Set(['resume', 'shadow', 'calibrate']);
const BURN_OVERRIDE_TEXT = /(?:@agentguard-run\/burn|agentguard-burn)\S*\s+(?:resume|shadow|calibrate)\b/;
const BURN_STATE_TEXT = /\.agentguard[\\/](?:override|burn-policy)\.json\b/;
const BURN_FILES = ['override.json', 'burn-policy.json'];
const BURN_PACKAGE = /^@agentguard-run\/burn(?:@[^\s/]*)?$/;
const BURN_CLI = /(?:agentguard-burn|@agentguard-run[\\/]burn)[\\/](?:dist[\\/](?:src[\\/])?)?cli\.js$/;
const BURN_CODE = /@agentguard-run\/burn|agentguard-burn/;
const BURN_CODE_OVERRIDE = /\b(?:writeOverride|consumeOverride|clearOverride|resume|shadow|calibrate)\b|override\.json|burn-policy\.json/;
const BURN_MENTION = /agentguard-burn|@agentguard-run\/burn|override\.json|burn-policy\.json/;
const burnHome = () => path.resolve(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));
let currentUser = null;
try { currentUser = os.userInfo().username; } catch { /* No user name means no ~user form to expand. */ }
const expandHome = value => value.replace(/^~([^/]*)(?=\/|$)|^\$\{?HOME\}?(?=\/|$)/, (match, user) => user === undefined || user === '' || user === currentUser ? os.homedir() : match);
// The shell removes a backslash before an ordinary character before a program
// ever sees its arguments, so the scan does the same.
const unescape = value => value.replace(/\\(.)/g, '$1');
const compiled = new Map();
function regex(pattern) {
  if (!compiled.has(pattern)) { if (compiled.size > 512) compiled.clear(); compiled.set(pattern, new RegExp(pattern, 'i')); }
  return compiled.get(pattern);
}
function realTarget(target, memo) {
  // Resolve the deepest existing prefix once (canonical case on case-insensitive
  // volumes) and append the rest. Iterative and bounded, so a deep path can
  // neither overflow the stack nor cost more than a fixed number of lookups.
  const normalized = path.resolve(target);
  if (memo?.has(normalized)) return memo.get(normalized);
  const parts = normalized.split(path.sep).filter(Boolean);
  let result = normalized;
  if (parts.length <= MAX_COMPONENTS) {
    for (let index = parts.length; index >= 0; index--) {
      try { const real = fs.realpathSync.native(path.sep + parts.slice(0, index).join(path.sep)); result = index === parts.length ? real : path.join(real, ...parts.slice(index)); break; }
      catch { /* Try the parent. */ }
    }
  }
  memo?.set(normalized, result);
  return result;
}
function workspaceRoot(cwd) {
  let current = cwd;
  while (current && path.dirname(current) !== current) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return cwd;
}
const inside = (target, roots) => roots.some(root => { const relative = path.relative(root, target); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); });
const ancestorOf = (target, roots) => roots.some(root => inside(root, [target]));
function protectedRoots(options, memo) {
  // The plugin's own state: its data directory, the hook IPC directory and the
  // Burn home, each as configured and as its real path. Resolved lazily, so a
  // command with no path-like word costs no disk lookups.
  const loc = locations(options.data);
  const configured = [loc.data, loc.ipc, path.resolve(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'))];
  return [...new Set([...configured, ...configured.map(root => realTarget(root, memo))])];
}
const CLI_FILE = path.join(__dirname, 'policy-cli.cjs');
// A deliberately small read grammar, not a guess about arbitrary JavaScript.
// Only a standalone Node print/read of a literal policy JSON path is exempt.
// Extra statements, preload flags, substitutions and writes remain protected.
function readOnlyPolicyInspection(commands, parsed) {
  if (commands.length !== 1 || parsed.length !== 1 || !/^(?:node|\/[^\s]+\/node)\s/.test(commands[0])) return false;
  const list = parsed[0].words;
  if (list.length !== 3 || list[0] !== 'node' || !['-e','--eval','-p','--print'].includes(list[1]) || parsed[0].redirects.length) return false;
  const match = /^(?:console\.(?:log|dir)\(\s*)?(?:JSON\.parse\(\s*)?require\((['"])(?:node:)?fs\1\)\.readFileSync\(\s*(['"])([A-Za-z0-9_./ -]+)\2\s*,\s*(['"])utf-?8\4\s*\)\s*\)?\s*\)?\s*;?$/.exec(list[2].trim());
  return Boolean(match && /^(?:(?:default|org)-)?policy\.json$/.test(path.basename(match[3])));
}
let cliReal = null;
const cli = memo => cliReal ?? (cliReal = realTarget(CLI_FILE, memo));
// Brace expansion, bounded. null means the word expands past the bound.
function braces(value) {
  const out = [], queue = [value];
  while (queue.length) {
    const current = queue.shift();
    const match = /\{([^{}]*)\}/.exec(current);
    if (!match) { out.push(current); if (out.length > MAX_BRACES) return null; continue; }
    const body = match[1], range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
    const head = current.slice(0, match.index), tail = current.slice(match.index + match[0].length);
    let alternatives;
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (Math.abs(to - from) >= MAX_BRACES) return null;
      alternatives = []; for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? 1 : -1) alternatives.push(String(n));
    } else if (body.includes(',')) alternatives = body.split(',');
    else { queue.push(head + '\u0001' + body + '\u0002' + tail); continue; }
    for (const alternative of alternatives) queue.push(head + alternative + tail);
    if (queue.length > MAX_BRACES) return null;
  }
  return out.map(item => item.replace(/\u0001/g, '{').replace(/\u0002/g, '}'));
}
// The literal directory a wildcard or brace pattern starts from.
function literalPrefix(value) {
  const cut = value.search(/[*?[{]/);
  const literal = cut < 0 ? value : value.slice(0, cut);
  return literal.endsWith('/') ? literal : path.dirname(literal + 'x');
}
// Every spelling the shell would produce for a word: brace alternatives, then
// glob matches for shallow patterns. A recursive or deep pattern is not walked;
// it is reported as uncertain and judged by the directory it starts from.
function spellings(value, ctx) {
  const expanded = braces(value);
  if (expanded === null) { ctx.incomplete = true; return {list: [value], uncertain: [value]}; }
  const list = [], uncertain = [];
  for (const item of expanded) {
    list.push(item);
    if (!/[*?[]/.test(item)) continue;
    const wildcards = item.split('/').filter(part => /[*?[]/.test(part)).length;
    if (item.includes('**') || wildcards > MAX_WILDCARDS || typeof fs.globSync !== 'function') { uncertain.push(item); continue; }
    const home = expandHome(item), key = ctx.cwd + '\0' + home;
    if (!ctx.globs.has(key)) {
      let matches = [];
      try { matches = fs.globSync(path.isAbsolute(home) ? home : item, {cwd: ctx.cwd}).slice(0, MAX_GLOB).map(match => path.isAbsolute(match) ? match : path.resolve(ctx.cwd, match)); }
      catch { uncertain.push(item); }
      ctx.globs.set(key, matches);
    }
    list.push(...ctx.globs.get(key));
  }
  return {list, uncertain};
}
function stateTarget(value, ctx) {
  if (STATE_VARIABLES.test(value)) return true;
  // An option value (of=..., --target-directory=...) is a path too.
  for (const candidate of value.includes('=') ? [value, value.slice(value.indexOf('=') + 1)] : [value]) {
    const expanded = expandHome(candidate);
    if (!(/^(?:[~$./]|.*\/)/.test(expanded) || STATE_NAMES.has(path.basename(expanded)))) continue;
    if (inside(realTarget(path.resolve(ctx.cwd, expanded), ctx.memo), ctx.roots())) return true;
  }
  return false;
}
function invokesCli(value, ctx) {
  if (/^policy-cl.{0,8}\.c?js$/i.test(path.basename(value))) return true;
  if (!/^(?:[~$./]|.*\/)/.test(value)) return false;
  return realTarget(path.resolve(ctx.cwd, expandHome(value)), ctx.memo) === cli(ctx.memo);
}
// Burn's override or policy file in the Burn home, as configured or as its
// real path, in any spelling the scan resolves.
function burnStateTarget(value, ctx) {
  for (const candidate of value.includes('=') ? [value, value.slice(value.indexOf('=') + 1)] : [value]) {
    const expanded = expandHome(candidate);
    if (BURN_STATE_TEXT.test(expanded)) return true;
    if (!BURN_FILES.includes(path.basename(expanded))) continue;
    if (/\$\{?AGENTGUARD_HOME\b/.test(expanded)) return true;
    if (ctx.burnFiles().includes(realTarget(path.resolve(ctx.cwd, expanded), ctx.memo))) return true;
  }
  return false;
}
// The Burn verb a command runs, or null when the program is not Burn: the
// scoped package after a runner (npx, bunx, npm exec, dlx), its bin, or node
// running its cli.js. `npx -p @agentguard-run/burn agentguard-burn <verb>` names
// both. The first word that is not a flag is the verb.
function burnVerb(list) {
  let at = -1;
  const name = path.basename(list[0] ?? '').toLowerCase();
  if (BURN_PACKAGE.test(list[0] ?? '')) at = 1;
  else if (/^agentguard-burn(?:\.cmd)?$/.test(name)) at = 1;
  else if (/^node(?:\.exe)?$/.test(name)) { const script = list.findIndex((value, index) => index > 0 && BURN_CLI.test(value)); if (script > 0) at = script + 1; }
  if (at < 0) return null;
  if (/^agentguard-burn(?:\.cmd)?$/.test(path.basename(list[at] ?? '').toLowerCase())) at++;
  return list.slice(at).find(value => !value.startsWith('-')) ?? null;
}
// Burn's own check, loaded only when the input names Burn at all: the plugin's
// scan above covers it, and this keeps the two in step as Burn adds forms.
function burnLibraryAttempt(tool, input) {
  try { return require('./dependencies.cjs').loadDependency('@agentguard-run/burn').agentOverrideAttempt({tool_name: tool, tool_input: input}, burnHome()); }
  catch { return null; } // The plugin's own scan still applies.
}
// A pattern the scan will not walk is judged by where it starts: from inside a
// protected root, or from any directory above one, it can reach that root.
function uncertainReaches(item, ctx) {
  const start = realTarget(path.resolve(ctx.cwd, expandHome(literalPrefix(item))), ctx.memo), runtime = [path.dirname(cli(ctx.memo))];
  return {state: inside(start, ctx.roots()) || ancestorOf(start, ctx.roots()), cli: inside(start, runtime) || ancestorOf(start, runtime)};
}
const PATH_KEYS = /^(?:path|file_path|filepath|filename|file|notebook_path|destination|dest|destination_path|target|target_path|new_path|newPath|to|source|src|source_path|from|old_path|oldPath)$/i;
const PATH_SHAPED = /^(?:~|[A-Za-z]:)?[\\/][^\r\n]*$|^\.{1,2}[\\/][^\r\n]*$|^[^\s]+[\\/][^\s]+$/;
function writePaths(input) {
  const targets = [], markers = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12) return;
    for (const [key, item] of Object.entries(value)) {
      // A listed key names a path, as a string or a list of strings. Any other
      // string shaped like a path is a candidate too: a tool may name its
      // destination however it likes (output_path, dst), and a destination
      // this collector misses is a write it never checks.
      const listed = PATH_KEYS.test(key);
      for (const entry of Array.isArray(item) ? item : [item]) {
        if (typeof entry !== 'string') continue;
        if (listed || entry.length <= 4096 && PATH_SHAPED.test(entry)) targets.push(entry);
      }
      if (typeof item === 'string' && /^(?:patch|input|diff)$/i.test(key)) for (const match of item.matchAll(markers)) targets.push(match[1]);
      if (item && typeof item === 'object') visit(item, depth + 1);
    }
  };
  if (typeof input === 'string') for (const match of input.matchAll(markers)) targets.push(match[1]);
  else visit(input);
  return targets;
}
function resolveProgram(token, cwd) {
  try {
    if (token.includes('/')) return fs.realpathSync(path.resolve(cwd, token));
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(directory, token);
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch { continue; }
    }
  } catch { /* An unresolved program is not the packaged interpreter. */ }
  return null;
}
function readOnlyHelper(commands, cwd) {
  // The packaged show and explain commands stay usable under strict, but only in
  // exact form: one plain command with no quoting, assignment, wrapper or
  // substitution, run by this same Node binary. Nothing else is exempt.
  if (commands.length !== 1 || /[^\x21-\x7e ]|[;&|<>`$'"\\(){}#=*?]/.test(commands[0].trim())) return false;
  const tokens = commands[0].trim().split(/ +/);
  if (!(tokens.length === 3 && tokens[2] === 'show' || tokens.length === 4 && tokens[2] === 'explain' && /^[A-Za-z0-9_-]+$/.test(tokens[3]))) return false;
  let helper, self, execPath;
  try { helper = fs.realpathSync(path.resolve(cwd, tokens[1])); self = fs.realpathSync(path.join(__dirname, 'policy-cli.cjs')); execPath = fs.realpathSync(process.execPath); } catch { return false; }
  return helper === self && resolveProgram(tokens[0], cwd) === execPath;
}
// Wrappers that run the rest of the line as the real command.
function unwrap(list) {
  for (;;) {
    if (!list.length) return list;
    const name = path.basename(list[0]).toLowerCase();
    if (['nohup', 'exec', 'time', 'builtin', 'command'].includes(name)) { list = list.slice(1); continue; }
    if (name === 'nice') { list = list.slice(1); if (/^-n$/.test(list[0] ?? '')) list = list.slice(2); else if (/^-\d+$/.test(list[0] ?? '')) list = list.slice(1); continue; }
    if (name === 'timeout') {
      list = list.slice(1);
      while (list[0]?.startsWith('-')) { const flag = list.shift(); if (/^(?:-s|--signal|-k|--kill-after)$/.test(flag)) list.shift(); }
      list = list.slice(1); continue;
    }
    if (name === 'xargs') {
      list = list.slice(1);
      while (list[0]?.startsWith('-')) { const flag = list.shift(); if (/^(?:-n|-I|-L|-P|-d|-s|-a|-E|--max-args|--replace|--max-lines|--max-procs|--delimiter|--max-chars|--arg-file|--eof)$/.test(flag)) list.shift(); }
      continue;
    }
    if (['npx', 'bunx'].includes(name)) {
      // Skip every leading runner and its flags in one pass; repeated slicing was
      // quadratic on a long chain of runners.
      let at = 1; while (at < list.length && (['npx', 'bunx'].includes(path.basename(list[at])) || list[at].startsWith('-'))) at++;
      list = list.slice(at).filter(value => !value.startsWith('-')); continue;
    }
    if (['npm', 'pnpm', 'yarn', 'bun', 'uv'].includes(name) && ['exec', 'dlx'].includes(list[1])) { list = list.slice(2).filter(value => !value.startsWith('-')); continue; }
    return list;
  }
}
// Bounded lines with shell line continuations joined. Anything dropped by a
// bound is reported through ctx.incomplete.
function boundedLines(text, ctx) {
  const joined = text.replace(/\\\r?\n/g, '');
  const capped = joined.length > MAX_SCAN_CHARS ? joined.slice(0, MAX_SCAN_CHARS) : joined;
  if (capped.length !== joined.length) ctx.incomplete = true;
  const lines = capped.split('\n');
  if (lines.length > MAX_LINES) { ctx.incomplete = true; lines.length = MAX_LINES; }
  return lines.map(line => { if (line.length > LINE_CAP) ctx.incomplete = true; return line.slice(0, LINE_CAP); });
}
// Linear token walks for the raw text: each test must match a later token.
const tokens = line => line.split(/\s+/).filter(Boolean);
function ordered(list, ...tests) {
  let at = 0;
  for (const test of tests) { at = list.findIndex((token, index) => index >= at && test(token)); if (at < 0) return false; at++; }
  return true;
}
const is = pattern => token => pattern.test(token);
function rawCategories(lines, found) {
  for (const line of lines) {
    const list = tokens(unescape(line)).map(token => path.basename(token));
    if (ordered(list, is(/^git$/i), is(/^push$/i), is(/^--force\b|^--mirror$|^-[a-z]*f[a-z]*$|^\+/i))) found.add('force-push');
    if (ordered(list, is(DEPLOYERS), is(DEPLOY_WORDS)) || list.some(is(/^(?:vercel|vc)$/)) || ordered(list, is(/^(?:npm|pnpm|yarn|bun)$/), is(/^run$/), is(/^deploy$/))) found.add('deploy');
    if (ordered(list, is(PUBLISHERS), is(/^(?:publish|upload|push)$/)) || ordered(list, is(/^gh$/), is(/^release$/), is(/^create$/))) found.add('package-publish');
    if (list.some(is(/^(?:rm|rmdir|unlink|remove-item)$/i)) || list.includes('find') && list.includes('-delete')) found.add('outside-workspace-delete');
    if (list.includes('gh-pages') || ordered(list, is(/^wrangler$/), is(/^pages$/)) || ordered(list, is(/^git$/), is(/^push$/), is(/^(?:main|master|production)$/))) found.add('website-publish');
    if (list.some(is(/^(?:rm|unlink|trash|trash-put|remove-item)$/i)) || ordered(list, is(/^git$/), is(/^rm$/)) || ordered(list, is(/^mv$/), is(/(?:^|\/)(?:\.Trash|\.Trashes|Trash)(?:\/|$)/))) {
      if (list.some(value => require('./page-guard.cjs').PAGE.test(value.replace(/["';]+$/, '')))) found.add('page-delete');
    }
  }
}
function pageDelete(list, cwd, ctx) {
  const name = path.basename(list[0] ?? '').toLowerCase();
  let operands;
  if (['rm', 'unlink', 'trash', 'trash-put', 'remove-item'].includes(name)) operands = list.slice(1);
  else if (name === 'git' && list.includes('rm')) operands = list.slice(list.indexOf('rm') + 1);
  else if (name === 'gio' && list[1] === 'trash') operands = list.slice(2);
  else if (name === 'osascript' && list.some(value => /application\s+["']Finder["']/i.test(value))) operands = list.flatMap(value => [...value.matchAll(/\bdelete\s+(?:POSIX\s+file|file|alias)\s+["']([^"']+)["']/ig)].map(match => match[1]));
  else if (name === 'mv' && list.some(value => /(?:^|\/)(?:\.Trash|\.Trashes|Trash)(?:\/|$)/.test(value))) {
    const at = list.findIndex(value => value === '-t' || value === '--target-directory');
    operands = at >= 0 ? list.slice(1).filter((_, i) => i + 1 !== at && i + 1 !== at + 1) : list.some(value => value.startsWith('--target-directory=')) ? list.slice(1) : list.slice(1, -1);
  }
  else return false;
  const {PAGE} = require('./page-guard.cjs');
  const deadline = performance.now() + 20; let visited = 0;
  const contains = file => {
    if (PAGE.test(file)) return true;
    if (++visited > 4096 || performance.now() > deadline) return true;
    let stat; try { stat = fs.lstatSync(file); } catch { return false; }
    if (!stat.isDirectory()) return false;
    try { return fs.readdirSync(file).some(name => contains(path.join(file, name))); } catch { return true; }
  };
  let ended = false;
  return operands.filter(value => { if (value === '--' && !ended) { ended = true; return false; } return ended || !value.startsWith('-'); }).some(value => {
    const variants = braces(value) ?? [value];
    return variants.some(form => PAGE.test(form) || spellings(form, ctx).list.some(target => contains(path.resolve(cwd ?? ctx.cwd, expandHome(target)))));
  });
}
function categories(tool, input, options) {
  const found = new Set();
  // Shells and arbitrary connector tools can open a network connection even
  // when their names look local. Strict therefore asks for these calls too.
  if (SHELL.test(tool) || /^(?:mcp[_.]|web|browser|fetch|python|computer)/i.test(tool)) found.add('network');
  const commands = SHELL.test(tool) ? (typeof input === 'string' ? [input] : [input?.command, input?.cmd, input?.script].flat().filter(value => typeof value === 'string')) : [];
  if (/(?:^|[._])(?:deploy(?:_project)?|create_deployment|trigger_deployment)$/.test(tool)) found.add('deploy');
  const base = options.cwd || process.cwd();
  const ctx = {cwd: base, memo: new Map(), globs: new Map(), verdicts: new Map(), forms: 0, incomplete: false};
  let rootsResolved = null, rootsConfigured = null;
  ctx.roots = () => rootsResolved ?? (rootsResolved = protectedRoots(options, ctx.memo));
  // The configured spellings alone are enough for the raw-text check and cost no lookup.
  const configuredRoots = () => rootsConfigured ?? (rootsConfigured = (() => { const loc = locations(options.data); return [loc.data, loc.ipc, path.resolve(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'))]; })());
  let builtIn = null;
  const stop = kind => { builtIn = builtIn === 'policy_cli' ? builtIn : kind; };
  // Burn's override and policy files, configured and real, resolved on first use.
  let burnFilesResolved = null;
  const burnFilesConfigured = () => BURN_FILES.map(name => path.join(burnHome(), name));
  ctx.burnFiles = () => burnFilesResolved ?? (burnFilesResolved = [...new Set([...burnFilesConfigured(), ...burnFilesConfigured().map(file => realTarget(file, ctx.memo))])]);
  // A command reaching Burn's override is 'command'; a file tool writing one is 'file'.
  let burnOverride = null;
  const override = kind => { burnOverride ??= kind; };
  const lines = commands.map(text => boundedLines(text, ctx));
  let exempt = false, policyInspection = false;
  try {
    let parsed = [];
    // The tokenizer reports a parse it could not finish through `parsing`
    // (it no longer throws for that), and may still throw for other reasons.
    const parsing = {incomplete: false};
    try { parsed = commands.flatMap(value => segments(value, 0, parsing)); } catch { ctx.incomplete = true; }
    if (parsing.incomplete) ctx.incomplete = true;
    exempt = !ctx.incomplete && readOnlyHelper(commands, base);
    policyInspection = !ctx.incomplete && readOnlyPolicyInspection(commands, parsed);
    if (exempt) found.delete('network');
    // Raw-text checks run on every scan, parsed or not: a protected path, a state
    // variable, a policy module or a node one-liner that mentions them, named
    // anywhere in the command, is enough.
    for (const [index, text] of commands.entries()) {
      const plain = unescape(text);
      if (!policyInspection && (STATE_VARIABLES.test(plain) || configuredRoots().some(root => plain.includes(root)) || /\/(?:policy-approvals|org-policy(?:-status)?\.json|policy\.json)\b/.test(plain) && ctx.roots().some(root => plain.includes(root)))) stop('plugin_state');
      if (!exempt && MODULE_REFERENCE.test(plain)) stop('policy_cli');
      if (!exempt && BURN_TELEMETRY.test(plain)) stop('policy_cli');
      if (!exempt && !policyInspection && MODULE_MENTION.test(plain) && lines[index].some(line => { const list = tokens(line).map(token => path.basename(token)); return ordered(list, is(/^node(?:\.exe)?$/i), is(/^(?:-e|--eval|-p|--print|-)$/)); })) stop('policy_cli');
      if (BURN_OVERRIDE_TEXT.test(plain) || BURN_STATE_TEXT.test(plain) || burnFilesConfigured().some(file => plain.includes(file))) override('command');
      if (BURN_CODE.test(plain) && BURN_CODE_OVERRIDE.test(plain) && lines[index].some(line => { const list = tokens(line).map(token => path.basename(token)); return ordered(list, is(/^node(?:\.exe)?$/i), is(/^(?:-e|--eval|-p|--print|-)$/)); })) override('command');
    }
    if (ctx.incomplete) for (const list of lines) rawCategories(list, found);
    if (WRITE.test(tool) && !(typeof input?.command === 'string' && input.command === 'view')) {
      for (const target of writePaths(input)) {
        if (stateTarget(unescape(target), ctx)) stop('plugin_state');
        if (burnStateTarget(unescape(target), ctx)) override('file');
      }
    }
    // The workspace root is needed only for a delete, so it is resolved on first use.
    let workspace = null;
    const root = () => workspace ?? (workspace = realTarget(path.resolve(options.workspace || workspaceRoot(options.cwd) || process.cwd()), ctx.memo));
    // The shell is persistent: follow cd, pushd and subshells where the target is
    // literal. An unknown working directory makes every delete count as outside.
    const declared = ['workdir', 'cwd'].map(key => input?.[key]).find(value => value !== undefined);
    let cwd = declared === undefined ? path.resolve(options.cwd || process.cwd()) : typeof declared === 'string' ? path.resolve(options.cwd || process.cwd(), declared) : null;
    // A working directory the tool input itself points into plugin state means
    // every relative path in the command lands there.
    if (declared !== undefined && cwd !== null && inside(realTarget(cwd, ctx.memo), ctx.roots())) stop('plugin_state');
    const stack = [];
    const relocated = lines.some(list => list.some(line => { const words = tokens(line); return ordered(words, is(/^env$/), is(/^(?:-C$|--chdir(?:=|$))/)) || ordered(words, is(/^sudo$/), is(/^(?:-D$|--chdir(?:=|$))/)); }));
    const work = parsed.map(command => ({words: command.words, redirects: command.redirects, env: command.env}));
    const nested = text => {
      const parsing = {incomplete: false};
      try { work.unshift(...segments(text, 0, parsing).map(item => ({words: item.words, redirects: item.redirects}))); } catch { parsing.incomplete = true; }
      if (parsing.incomplete) { ctx.incomplete = true; rawCategories(boundedLines(text, ctx), found); }
    };
    let examined = 0;
    while (work.length) {
      const command = work.shift();
      let list = command.words.map(unescape).map(value => value.replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (match, a, b) => command.env?.get(a || b) ?? match));
      const redirects = command.redirects.map(unescape);
      let closes = false;
      if (list[0]?.startsWith('(')) { list[0] = list[0].slice(1); stack.push(cwd); }
      if (list.at(-1)?.endsWith(')')) { list[list.length - 1] = list.at(-1).slice(0, -1); closes = true; }
      list = list.filter(Boolean);
      // Reserved words and a function definition in front of the command.
      while (list.length && (KEYWORDS.has(list[0]) || /^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(list[0]))) list.shift();
      if (list.length > 1 && list[1] === '()') list = list.slice(2);
      ctx.cwd = cwd ?? base;
      for (const value of [...list, ...redirects]) {
        // Each distinct word is judged once per working directory, and the total
        // number of expanded forms examined in one scan is bounded.
        const key = ctx.cwd + '\0' + value;
        let verdict = ctx.verdicts.get(key);
        if (!verdict) {
          if (++examined > MAX_WORDS || ctx.forms > MAX_GLOB * 2) { ctx.incomplete = true; break; }
          const {list: forms, uncertain} = spellings(value, ctx);
          ctx.forms += forms.length;
          verdict = {state: false, cli: false, burn: false};
          for (const form of forms) {
            if (stateTarget(form, ctx)) verdict.state = true;
            // Any invocation of the helper other than the exact read-only form stops,
            // so a verb the shell fills in later is never trusted.
            if (invokesCli(form, ctx)) verdict.cli = true;
            if (burnStateTarget(form, ctx)) verdict.burn = true;
          }
          for (const item of uncertain) { const reach = uncertainReaches(item, ctx); verdict.state ||= reach.state; verdict.cli ||= reach.cli; }
          ctx.verdicts.set(key, verdict);
        }
        if (verdict.state && !policyInspection) stop('plugin_state');
        if (verdict.cli && !exempt) stop('policy_cli');
        if (verdict.burn) override('command');
      }
      list = unwrap(list);
      // A Burn verb the shell fills in later ($verb, a substitution) is not trusted either.
      const verb = list.length ? burnVerb(list) : null;
      if (verb !== null && (BURN_VERBS.has(verb) || /[$`]/.test(verb))) override('command');
      if (list.length) {
        const name = path.basename(list[0]).toLowerCase().replace(/@[^@]+$/, '');
        if (name === 'eval') nested(list.slice(1).join(' '));
        else if (/^(?:dash|ksh|ash|mksh)$/.test(name) && list.some(value => /^-[a-z]*c[a-z]*$/.test(value))) { const at = list.findIndex(value => /^-[a-z]*c[a-z]*$/.test(value)); if (list[at + 1]) nested(list[at + 1]); }
        else if (name === 'cd' || name === 'pushd') {
          const target = list.slice(1).find(value => !value.startsWith('-')) ?? (list.includes('-') ? '-' : null);
          if (name === 'pushd') stack.push(cwd);
          if (target === null) cwd = os.homedir();
          else { const expanded = expandHome(target); cwd = target === '-' || /[$`]/.test(expanded) || cwd === null ? null : path.resolve(cwd, expanded); }
          // A directory deeper than the component bound is unknown from here on.
          if (cwd !== null && cwd.split(path.sep).length > MAX_COMPONENTS) cwd = null;
        } else if (name === 'popd') cwd = stack.length ? stack.pop() : null;
        else {
          if (name === 'git' && list.includes('push') && list.some(value => /^--force(?:-with-lease)?(?:=|$)|^--mirror$|^-[a-zA-Z]*f[a-zA-Z]*$|^\+/.test(value))) found.add('force-push');
          if (DEPLOYERS.test(name) && (list.some(value => DEPLOY_WORDS.test(value)) || /^(?:vercel|vc)$/.test(name) && (list.length === 1 || list[1].startsWith('-') || /^[.~/]/.test(list[1])))) found.add('deploy');
          if (/^(?:npm|pnpm|yarn|bun)$/.test(name) && list[1] === 'run' && list.includes('deploy')) found.add('deploy');
          if (PUBLISHERS.test(name) && list.some(value => /^(?:publish|upload|push)$/.test(value))) found.add('package-publish');
          if (name === 'gh' && list[1] === 'release' && list[2] === 'create') found.add('package-publish');
          if (name === 'gh-pages' || name === 'wrangler' && list.includes('pages')
            || name === 'git' && list.includes('push') && list.slice(list.indexOf('push') + 1).some(value => /^(?:main|master|production)$/.test(value.replace(/^\+/, '').split(':').at(-1).replace(/^refs\/heads\//, '')))) found.add('website-publish');
          if (name === 'git' && list.includes('push')) {
            const args = list.slice(list.indexOf('push') + 1), positional = args.filter(value => !value.startsWith('-'));
            if (positional.length <= 1 || args.includes('--all') || positional.slice(1).includes('HEAD')) found.add('website-publish');
          }
          if (/^(?:vercel|vc)$/.test(name) && list[1] && !/^(?:ls|list|inspect|logs|whoami|help|version|login|logout|link|dev|build|env|teams|project|--help|--version|-h|-v)$/.test(list[1])) found.add('website-publish');
          if (groups(options.config ?? {}).flat().some(rule => rule.match === 'page-delete') && pageDelete(list, cwd, ctx)) found.add('page-delete');
          const findDeletes = name === 'find' && (list.includes('-delete') || list.some((value, index) => /^-(?:exec|execdir|ok|okdir)$/.test(value) && DELETERS.has(path.basename(list[index + 1] ?? '').toLowerCase())));
          if (DELETERS.has(name) || findDeletes) {
            // find takes its start paths after any pre-path options and before the first expression.
            const findTargets = () => {
              const rest = list.slice(1), out = []; let at = 0;
              while (at < rest.length && /^-(?:[HLP]|E|X|s|d|O\S*|D|f)$/.test(rest[at])) { if (rest[at] === '-f' && rest[at + 1]) out.push(rest[at + 1]); at += rest[at] === '-f' ? 2 : 1; }
              while (at < rest.length && !/^[-!(]/.test(rest[at])) out.push(rest[at++]);
              return out;
            };
            const targets = findDeletes ? findTargets() : list.slice(1).filter(value => !value.startsWith('-'));
            if (findDeletes && !targets.length && cwd === null) found.add('outside-workspace-delete');
            for (const value of targets) {
              const expanded = expandHome(value);
              if (cwd === null || relocated || /[$`]/.test(expanded)) { found.add('outside-workspace-delete'); continue; }
              const target = realTarget(path.resolve(cwd, expanded), ctx.memo), relative = path.relative(root(), target);
              if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) found.add('outside-workspace-delete');
              // Deleting a directory above a protected root deletes the root.
              if (ancestorOf(target, ctx.roots())) stop('plugin_state');
            }
          }
        }
      }
      if (closes) cwd = stack.length ? stack.pop() : cwd;
    }
  } catch {
    // An unexpected failure inside the walk is never a fail-open: the raw text
    // was already checked above, and the raw categories fill in for the parse.
    ctx.incomplete = true;
    for (const list of lines) rawCategories(list, found);
  }
  if (!burnOverride) {
    let text = '';
    try { text = JSON.stringify(input) ?? ''; } catch { /* An input that cannot be serialized names nothing here. */ }
    if (BURN_MENTION.test(text)) { const attempt = burnLibraryAttempt(tool, input); if (attempt === 'command' || attempt === 'file') override(attempt); }
  }
  return {found, commands, lines, incomplete: ctx.incomplete, builtIn, burnOverride};
}
function scanCommands(config, tool, input, options = {}) {
  const ruleGroups = groups(config);
  const {found, commands, lines, incomplete, builtIn, burnOverride} = categories(tool, input, {...options, config});
  const result = {...(builtIn ? {builtInStop: builtIn} : {}), ...(burnOverride ? {burnOverride} : {}), ...(incomplete ? {commandScanIncomplete: true} : {})};
  if (!ruleGroups.some(group => group.length)) return result;
  // Patterns see the whole text (continuations joined) only when it is short;
  // otherwise each bounded line is tested on its own and the split is recorded.
  const texts = [];
  for (const [index, command] of commands.entries()) {
    const joined = command.replace(/\\\r?\n/g, '');
    if (joined.length <= WHOLE_CAP) texts.push(joined);
    else { result.commandScanIncomplete = true; texts.push(...lines[index]); }
  }
  return {...result, commandPolicyHash: commandHash(config), commandRuleIds: ruleGroups.map(group => {
    // Last match wins within a layer. A personal allow cannot weaken Team.
    return group.filter(rule => rule.match ? found.has(rule.match) : texts.some(text => regex(rule.pattern).test(text))).map(rule => rule.id).at(-1) ?? null;
  })};
}
function commandResult(config, meta) {
  const ruleGroups = groups(config);
  if (!ruleGroups.some(group => group.length)) return null;
  if (meta.commandPolicyHash !== commandHash(config) || !Array.isArray(meta.commandRuleIds) || meta.commandRuleIds.length !== ruleGroups.length) throw new Error('command_policy_changed');
  const matches = meta.commandRuleIds.map((id, index) => id === null ? null : ruleGroups[index].find(rule => rule.id === id));
  if (matches.some((match, index) => !match && meta.commandRuleIds[index] !== null)) throw new Error('command_rule_invalid');
  // A website one-use exception cannot relax a hard block in another layer.
  const blocks = matches.filter(rule => rule?.action === 'block');
  if (blocks.length) return blocks.find(rule => !rule.allowOnce) ?? blocks[0];
  return matches.find(rule => rule?.action === 'ask') ?? null;
}
module.exports = {scanCommands, commandResult, commandHash, POLICY_VERBS, BURN_VERBS, MAX_SCAN_CHARS};
