'use strict';
// Raw arguments are inspected in this hook process only. Results contain IDs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {guardDefault} = require('./org-policy-contract.cjs');
const {dangerousRules, rawDangerousRules} = require('./guard-dangerous.cjs');
const RULES = Object.freeze([
  ['GP001', 'remote_shell', '\\b(?:curl|wget)\\b.*\\|\\s*(?:sh|bash|zsh|python(?:3)?)\\b', 'A downloaded response is being executed by a shell or Python.'],
  ['GP002', 'recursive_delete', '\\b(?:rm|Remove-Item)\\b.*(?:-r|--recursive|-Recurse)', 'Recursive deletion targets a root, home, current directory or shallow wildcard.'],
  ['GP003', 'git_history', '\\bgit\\b.*\\bpush\\b.*(?:--force(?:-with-lease)?|-f)', 'A force push targets the shared main or master branch.'],
  ['GP004', 'git_history', '\\bgit\\b.*\\breset\\b.*--hard', 'A hard reset targets a shared branch or a branch whose state is unknown.'],
  ['GP005', 'git_history', '\\bgit\\b.*\\bclean\\b', 'Git clean would remove untracked directories and ignored files.'],
  ['GP006', 'infrastructure', '\\bterraform\\b.*\\b(?:apply|destroy)\\b.*-auto-approve(?:=true)?(?: |$)', 'Terraform would apply infrastructure changes without interactive approval.'],
  ['GP007', 'infrastructure', '\\bkubectl\\b.*\\bdelete\\s+(?:namespace|namespaces|ns)\\b', 'Kubernetes would delete a namespace.'],
  ['GP008', 'infrastructure', '\\b(?:aws|gcloud)\\b.*\\b(?:delete|terminate|disable)[-a-z]*\\b', 'A cloud command would delete, terminate or disable a resource.'],
  ['GP009', 'sensitive_write', '(?:^|[/\\\\])(?:\\.env|credentials|id_rsa|\\.aws|\\.ssh|keychain|wallet)', 'A write targets a credential, private-key, wallet or environment file.'],
  // Each shape must begin a token: `sk-` inside `task-rest_run-01` is an identifier, not a key.
  ['GP010', 'secret_argument', '(?<![A-Za-z0-9_-])(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|ant-api[0-9]+-)?[A-Za-z0-9_-]{20,})', 'An argument contains a known secret-key format.'],
  ['GP011', 'system_security', '\\bchmod\\b.*\\b(?:0?777)\\b', 'Permissions would allow every local user to write and execute the target.'],
  ['GP012', 'system_security', '(?:ufw disable|pfctl -d|firewall.*(?:disable|off)|(?:stop|disable).*firewall)', 'A command would turn off or flush a local firewall.'],
  ['GP013', 'system_security', '^/etc/(?:hosts|sudoers(?:/|\\.d/|$))', 'A write targets host resolution or sudo authorization settings.'],
  ['GP014', 'package_source', '(?:https?://|git\\+|git://|git@|github:|gitlab:|bitbucket:|--git|#)', 'A package install uses a URL or Git source rather than a registry version.'],
  ['GP015', 'secret_exfiltration', '\\b(?:curl|wget|scp|rsync|rclone|aws|gsutil|gcloud|az|sftp|ftp|socat|ssh|nc|python3?|node)\\b.*(?:\\.ssh|\\.aws|\\.gnupg|\\.kube|\\.docker|\\.config/(?:gcloud|gh)|\\.npmrc|\\.pypirc|\\.git-credentials|\\.netrc|\\.env|id_(?:rsa|ed25519)|\\.(?:pem|p12)|/run/secrets|keychain|private[_-]?key)', 'An upload or send targets credentials, private keys or a secret store.'],
  ['GP016', 'disk_wipe', '\\b(?:mkfs(?:\\.[a-z0-9]+)?|wipefs|diskutil\\s+erase|dd\\s+.*of=/dev/)\\b', 'A command would format, erase or overwrite a disk or filesystem.'],
  ['GP017', 'system_auth', '/(?:private/)?etc/(?:sudoers|shadow|gshadow|passwd|group|master\\.passwd|security|pam\\.d|ssh/sshd_config)', 'A write or permission change targets system authentication files.'],
  ['GP018', 'database_wipe', '\\b(?:TRUNCATE|DROP\\s+(?:DATABASE|TABLE)|FLUSHALL|FLUSHDB)\\b', 'An action would clear a database, table or Redis store.'],
  ['GP019', 'home_data_delete', '\\b(?:rm|find|rmSync|rmdirSync|rmtree)\\b.*(?:/home/|/Users/|/root/|/srv/|\\$HOME/[^\\s]|~/[^\\s])', 'Recursive deletion targets a home subfolder or shared server data.'],
  ['inbox-reset-codes', 'inbox_credentials', 'verification codes, one-time codes, password reset or sign-in links', 'An email or messaging search targets authentication codes or account access links.'],
  ['GP020', 'page_guard', '(?!)', 'A page edit removes protected elements or changes site indexing or redirects.'],
].map(([id, category, pattern, reason]) => Object.freeze({id, category, pattern, reason, severity: id === 'GP020' ? 'ask' : 'stop'})));
const BY_ID = new Map(RULES.map(rule => [rule.id, rule]));
const SHELL = /(?:^|[._])(?:bash|powershell|shell|exec_command|run_command|execute_command|run_shell_command|shell_command)$/i;
// Claude Code emits Write, Edit and NotebookEdit (MultiEdit is legacy); Codex emits
// apply_patch; OpenHands emits str_replace_editor and the Anthropic text editor
// tool is str_replace_based_edit_tool. The editor tools carry the operation in a
// `command` field, and `view` is a read.
const WRITE = /(?:^|[._])(?:write|edit|multiedit|apply_patch|notebookedit|write_file|edit_file|create_file|update_file|str_replace_editor|str_replace_based_edit_tool|[a-z0-9_]*editor|[a-z0-9_]*edit_tool)$/i;
const EDITOR_READ = /^view$/i;
const SECRET = new RegExp(RULES[9].pattern, 'g');
// Documented placeholders are not secrets: the AWS documentation keys, a token
// that says EXAMPLE, SAMPLE, PLACEHOLDER, DUMMY, FAKE, CHANGEME, REPLACE or
// YOUR_..., or one whose body is a run of one repeated character.
const PLACEHOLDER = /EXAMPLE|SAMPLE|PLACEHOLDER|DUMMY|FAKE|CHANGEME|REPLACE|YOUR[_-]?|XXXXXXXX/i;
// A synthetic token written for a test or a document: its body says TEST,
// TOKEN, MOCK or DEMO (checked after the vendor prefix, so a Stripe test-mode
// key is still a key), or it is typed out as a run of consecutive characters
// (abcdefgh..., 12345678...). A generated secret is random and has neither.
const SYNTHETIC_BODY = /TEST|TOKEN|MOCK|DEMO/i;
function consecutiveRun(text, length = 8) {
  let run = 1;
  for (let index = 1; index < text.length; index++) {
    run = text.charCodeAt(index) - text.charCodeAt(index - 1) === 1 ? run + 1 : 1;
    if (run >= length) return true;
  }
  return false;
}
function secretShaped(value) {
  if (typeof value !== 'string') return false;
  for (const match of value.matchAll(SECRET)) {
    const token = match[0];
    if (PLACEHOLDER.test(token)) continue;
    const body = token.replace(/^(?:AKIA|ASIA|gh[pousr]_|github_pat_|(?:sk|rk)_(?:live|test)_|sk-(?:proj-|ant-api[0-9]+-)?)/, '');
    if (/^(.)\1+$/.test(body) || /(.)\1{7,}/.test(body)) continue;
    if (SYNTHETIC_BODY.test(body) || consecutiveRun(body)) continue;
    return true;
  }
  return false;
}
// A credential store is protected; a code or documentation file that happens to
// be named credentials.py (or .js, .go ...) is source, and an env template
// (.env.example, .env.sample, .env.template, .env.dist) carries no values.
const SENSITIVE = /(?:^|[/\\])(?:\.env(?!\.(?:example|sample|template|dist|defaults?)(?:[/\\]|$))(?:\.[^/\\]*)?|credentials(?!\.(?:py|pyi|js|mjs|cjs|ts|tsx|jsx|rb|go|java|kt|kts|rs|c|h|cc|cpp|hpp|cs|php|swift|scala|m|mm|md|rst)(?:[/\\]|$))(?:\.[^/\\]*)?|id_rsa(?:\.pub)?|\.aws|\.ssh|(?:[a-z-]+\.)?keychain(?:-db)?|wallet(?:\.[^/\\]*)?)(?:[/\\]|$)/i;
const SYSTEM = /^\/etc\/(?:hosts|sudoers|sudoers\.d)(?:\/|$)/;
const MAX_CHARS = 262144, MAX_NODES = 1024;
// The structured parser reads at most this much of one command string; a longer
// string is scanned to the cap, marked incomplete, and the raw pass sees it all.
const MAX_COMMAND_CHARS = 65536;
// Shell reserved words that can stand in front of a command on the same line
// (if x; then CMD, do CMD, { CMD; }, ! CMD, time CMD, coproc CMD, function f {
// CMD). They are structure, never the command, so they are stepped over.
const RESERVED = /^(?:if|then|else|elif|fi|do|done|while|until|for|select|case|esac|in|\{|\}|!|time|coproc|function)$/;
// Wrappers that run the command that follows them, with the options each one
// takes a value for. The command they run is the one the rules judge.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'timeout', 'nohup', 'nice', 'ionice', 'exec', 'xargs', 'setsid', 'caffeinate', 'stdbuf', 'chronic', 'unbuffer', 'busybox']);
const WRAPPER_VALUE_FLAGS = {sudo: /^(?:-[ughpCDT]|--user|--group|--host|--prompt|--chdir)$/, doas: /^-[uC]$/, env: /^(?:-u|--unset|-C|--chdir|-S|--split-string)$/,
  nice: /^(?:-n|--adjustment)$/, ionice: /^-[cnp]$/, exec: /^-a$/, xargs: /^(?:-[InPdsLEa]|--max-args|--max-procs|--max-lines|--delimiter|--replace|--arg-file|--eof)$/,
  stdbuf: /^-[ioe]$/, caffeinate: /^-[tw]$/, timeout: /^(?:-s|--signal|-k|--kill-after)$/};
function strings(value, result = [], budget = {nodes: 0, chars: 0}, depth = 0) {
  if (++budget.nodes > MAX_NODES || depth > 12) throw new Error('guard_scan_limit');
  if (typeof value === 'string') { result.push(value); budget.chars += value.length; if (budget.chars > MAX_CHARS) throw new Error('guard_scan_limit'); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { strings(key, result, budget, depth + 1); strings(item, result, budget, depth + 1); }
  return result;
}
// Only the expansion spans of an unquoted heredoc execute. The surrounding
// data must not become shell commands or package-source matches.
function substitutions(text) {
  const result = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '`') {
      const start = index + 1;
      while (++index < text.length && text[index] !== '`') if (text[index] === '\\') index++;
      if (index >= text.length) throw new Error('guard_shell_incomplete');
      result.push(text.slice(start, index));
    } else if (text[index] === '$' && text[index + 1] === '(') {
      const start = index + 2; let depth = 1, quote = null;
      index++;
      while (++index < text.length && depth) {
        const char = text[index];
        if (char === '\\' && quote !== "'") { index++; continue; }
        if (quote) { if (char === quote) quote = null; continue; }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if (char === '(') depth++;
        else if (char === ')') depth--;
      }
      if (depth || quote) throw new Error('guard_shell_incomplete');
      const span = text.slice(start, index - 1);
      if (text[start] === '(') result.push(...substitutions(span.slice(1, -1)));
      else result.push(span);
      index--;
    }
  }
  return result;
}
// A command substitution or backtick span belongs to the word that contains
// it, so its parentheses and metacharacters never split the word. Returns the
// index of the closing delimiter, or -1 when the span does not close.
function spanEnd(command, index) {
  if (command[index] === '`') {
    for (let cursor = index + 1; cursor < command.length; cursor++) {
      if (command[cursor] === '\\') { cursor++; continue; }
      if (command[cursor] === '`') return cursor;
    }
    return -1;
  }
  let depth = 0, inner = null;
  for (let cursor = index + 1; cursor < command.length; cursor++) {
    const char = command[cursor];
    if (char === '\\' && inner !== "'") { cursor++; continue; }
    if (inner) { if (char === inner) inner = null; continue; }
    if (char === '"' || char === "'" || char === '`') { inner = char; continue; }
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return cursor;
  }
  return -1;
}
function words(command) {
  const tokens = [], pending = [];
  // `expandable` holds the parts of the current word the shell would expand
  // (unquoted and double-quoted text), so substitutions inside single quotes
  // stay data while the others are scanned as commands.
  let word = '', expandable = '', quote = null, started = false, quoted = false, delimiter = null, processSpans = [];
  const incomplete = () => { const error = new Error('guard_shell_incomplete'); error.tokens = tokens; throw error; };
  const flush = () => {
    if (started) {
      const token = {value: word, operator: false};
      if (/\$\(|`/.test(expandable)) { try { token.substitutions = substitutions(expandable); } catch { incomplete(); } }
      if (processSpans.length) token.substitutions = [...(token.substitutions ?? []), ...processSpans];
      if (delimiter) {
        token.heredoc = {delimiter: word, stripTabs: delimiter.stripTabs, fd: delimiter.fd, quoted, body: ''};
        pending.push(token.heredoc); delimiter = null;
      }
      tokens.push(token);
    }
    word = ''; expandable = ''; started = false; quoted = false; processSpans = [];
  };
  const span = at => {
    const end = spanEnd(command, at);
    if (end < 0) incomplete();
    const text = command.slice(at, end + 1);
    word += text; expandable += text; started = true; return end;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      if (char === '\\' && quote === '"' && /["\\$`\n]/.test(command[index + 1] ?? '')) { if (command[index + 1] !== '\n') word += command[index + 1]; index++; continue; }
      if (quote === '"' && (char === '`' || char === '$' && command[index + 1] === '(')) { index = span(index); continue; }
      word += char; if (quote === '"') expandable += char; continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; quoted = true; continue; }
    if (char === '\\' && command[index + 1] === '\n') { index++; continue; }
    if (char === '\\' && index + 1 < command.length) { word += command[++index]; started = true; quoted = true; continue; }
    if (char === '`' || char === '$' && command[index + 1] === '(') { index = span(index); continue; }
    if ((char === '<' || char === '>') && command[index + 1] === '(') {
      const end = spanEnd(command, index);
      if (end < 0) incomplete();
      processSpans.push(command.slice(index + 2, end));
      word += command.slice(index, end + 1); started = true; index = end; continue;
    }
    if (char === '$' && command[index + 1] === "'") {
      let cursor = index + 2, decoded = '';
      for (; cursor < command.length && command[cursor] !== "'"; cursor++) {
        if (command[cursor] !== '\\') { decoded += command[cursor]; continue; }
        const next = command[++cursor] ?? '';
        const simple = {n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?'};
        if (next in simple) decoded += simple[next];
        else if (next === 'x' && /^[0-9A-Fa-f]{1,2}/.test(command.slice(cursor + 1, cursor + 3))) { const hex = command.slice(cursor + 1, cursor + 3).match(/^[0-9A-Fa-f]{1,2}/)[0]; decoded += String.fromCharCode(parseInt(hex, 16)); cursor += hex.length; }
        else if (/^[0-7]/.test(next)) { const octal = command.slice(cursor, cursor + 3).match(/^[0-7]{1,3}/)[0]; decoded += String.fromCharCode(parseInt(octal, 8)); cursor += octal.length - 1; }
        else if (next === 'u' && /^[0-9A-Fa-f]{1,4}/.test(command.slice(cursor + 1, cursor + 5))) { const hex = command.slice(cursor + 1, cursor + 5).match(/^[0-9A-Fa-f]{1,4}/)[0]; decoded += String.fromCharCode(parseInt(hex, 16)); cursor += hex.length; }
        else decoded += '\\' + next;
      }
      if (cursor >= command.length) incomplete();
      word += decoded; started = true; quoted = true; index = cursor; continue;
    }
    // A comment is not a redirect header. Keep its newline for pending bodies.
    if (char === '#' && !started) { while (index + 1 < command.length && command[index + 1] !== '\n') index++; continue; }
    if (/[|;&<>()\n]/.test(char)) {
      const descriptor = /[<>]/.test(char) && !quoted && /^\d+$/.test(word);
      const fd = descriptor ? word : char === '<' ? '0' : '1';
      if (descriptor) { word = ''; started = false; }
      flush();
      if (delimiter) incomplete();
      const operator = ['&>>', '<<<', '>>', '<<', '>&', '<&', '&>', '>|', '|&', '||', '&&', '<>'].find(value => command.startsWith(value, index)) ?? char;
      index += operator.length - 1;
      if (operator === '<<') {
        delimiter = {stripTabs: command[index + 1] === '-', fd};
        if (delimiter.stripTabs) index++;
      }
      tokens.push({value: operator, operator: true});
      if (char === '\n') {
        for (const document of pending.splice(0)) {
          let cursor = index + 1, closed = false;
          while (cursor <= command.length) {
            let end = command.indexOf('\n', cursor), stop = end < 0 ? command.length : end;
            let line = command.slice(cursor, stop);
            // Unquoted backslash-newline is removed before delimiter matching.
            while (!document.quoted && end >= 0 && (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1) {
              cursor = end + 1; end = command.indexOf('\n', cursor); stop = end < 0 ? command.length : end;
              line = line.slice(0, -1) + command.slice(cursor, stop);
            }
            const value = document.stripTabs ? line.replace(/^\t+/, '') : line;
            if (value === document.delimiter) { index = end < 0 ? command.length : end; closed = true; break; }
            document.body += value + (end < 0 ? '' : '\n');
            if (end < 0) break;
            cursor = end + 1;
          }
          if (!closed) incomplete();
          try { document.substitutions = document.quoted ? [] : substitutions(document.body); }
          catch { incomplete(); }
        }
      }
      continue;
    }
    // Only a space or a tab ends a word (a newline is an operator above). A
    // carriage return is an ordinary character the shell keeps in the word, so a
    // CRLF heredoc delimiter carries it and matches its CRLF terminator line.
    if (char === ' ' || char === '\t') { flush(); continue; }
    word += char; expandable += char; started = true;
  }
  if (quote) incomplete();
  flush();
  if (delimiter || pending.length) incomplete();
  return tokens;
}
function segments(command, depth = 0, parsing = {incomplete: false}, stdin = []) {
  if (depth > 8) { parsing.incomplete = true; return []; }
  // `known` holds literal assignments made by bare assignment statements earlier
  // in this command string, so a later target such as $DIR can be resolved. An
  // assignment prefix (VAR=x cmd) is scoped to its own command only.
  const result = [], current = [], known = new Map(); let piped = stdin;
  let tokens;
  try { tokens = words(command); }
  catch (error) { if (!error.tokens) throw error; parsing.incomplete = true; tokens = error.tokens; }
  for (const token of [...tokens, {value: ';', operator: true}]) {
    if (token.operator && ['|', '|&', '||', '&&', '&', ';', '\n', '(', ')'].includes(token.value)) {
      let forwarded = [];
      if (current.length) {
        // Command substitutions run wherever they appear: arguments, assignment
        // values and redirect targets alike.
        for (const item of current) for (const span of item.substitutions ?? []) result.push(...segments(span, depth + 1, parsing));
        const documents = current.filter(item => item.heredoc).map(item => item.heredoc);
        const list = [], redirects = [], reads = []; let herestring = null;
        for (let index = 0; index < current.length; index++) {
          const item = current[index];
          if (item.operator && ['<', '>', '>>', '<<', '<<<', '<>', '>&', '<&', '&>', '&>>', '>|'].includes(item.value)) {
            const target = current[++index];
            if (!target || target.operator) { parsing.incomplete = true; continue; }
            if (['>', '>>', '<>', '&>', '&>>', '>|'].includes(item.value) || item.value === '>&' && !/^(?:\d+|-)$/.test(target.value)) redirects.push(target.value);
            if (item.value === '<') reads.push(target.value);
            if (item.value === '<<<') herestring = target;
          } else if (!item.heredoc) list.push(item);
        }
        const assigned = [];
        // Walk with an index, then drop the prefix once: repeated shift() on a
        // long token list is quadratic and a pathological line could reach the
        // host's hook timeout.
        let start = 0, cwdChanged = false;
        const versionFlag = list.some(item => /^-(?:v|V)$/.test(item.value));
        while (start < list.length) {
          if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(list[start].value)) { assigned.push(list[start++].value); continue; }
          const head = list[start].value;
          if (RESERVED.test(head)) {
            start++;
            if (head === 'function' && start < list.length) start++;
            if (head === 'time' && list[start]?.value === '-p') start++;
            continue;
          }
          const wrapper = path.basename(head);
          if (!WRAPPERS.has(wrapper) || wrapper === 'command' && versionFlag) break;
          start++;
          while (list[start]?.value.startsWith('-')) {
            const flag = list[start++].value; if (flag === '--') break;
            if (wrapper === 'env' && /^(?:-C|--chdir(?:=|$))/.test(flag) || wrapper === 'sudo' && /^(?:-D|--chdir(?:=|$))/.test(flag)) cwdChanged = true;
            if (WRAPPER_VALUE_FLAGS[wrapper]?.test(flag)) start++;
          }
          // timeout takes the duration as its first operand.
          if (wrapper === 'timeout' && list[start] && /^[0-9.]+[smhd]?$/.test(list[start].value)) start++;
        }
        if (start) list.splice(0, start);
        if (list.length && /^(?:export|declare|local|typeset|readonly)$/.test(path.basename(list[0].value)) && list.slice(1).every(item => !item.operator && /^(?:-[A-Za-z]+|[A-Za-z_][A-Za-z_0-9]*(?:=.*)?)$/s.test(item.value))) {
          assigned.push(...list.slice(1).map(item => item.value).filter(value => value.includes('='))); list.length = 0;
        }
        const env = new Map(known);
        for (const item of assigned) { const at = item.indexOf('='); env.set(item.slice(0, at), item.slice(at + 1)); }
        // An assignment is a word too: `export K=AKIA""...` is whole once joined.
        if (assigned.some(secretShaped)) parsing.secret = true;
        if (!list.length && redirects.length) result.push({words: [':'], after: token.value, redirects});
        if (list.length) {
          const values = list.map(item => item.value); values[0] = path.basename(values[0]);
          const ownInput = documents.filter(value => value.fd === '0').at(-1);
          const input = ownInput ? [ownInput] : piped.length ? piped : stdin;
          // Remote content fetched inside a substitution and handed to something
          // that executes its argument is remote execution (bash -c "$(curl ...)").
          const fetched = list.some(item => (item.substitutions ?? []).some(span => /^\s*(?:curl|wget)\b/.test(span)));
          const transferInput = /^(?:sftp|ftp)$/.test(values[0]) ? [...input.map(document => document.body), ...(herestring ? [herestring.value] : [])] : [];
          result.push({words: values, after: token.value, env, redirects, fetched, ...(reads.length ? {reads} : {}),
            ...(cwdChanged ? {cwdChanged} : {}), ...(transferInput.length ? {transferInput} : {})});
          // A here-string is stdin data; a shell that reads stdin executes it.
          if (herestring && executesStdin(values)) result.push(...segments(herestring.value, depth + 1, parsing));
          for (const document of documents) for (const span of document.substitutions ?? []) result.push(...segments(span, depth + 1, parsing));
          if (values[0] === 'cat' || values[0] === 'tee') forwarded = input;
          if (/^(?:sh|bash|zsh|dash|ksh)$/.test(values[0])) {
            const index = values.findIndex(value => /^-[a-z]*c[a-z]*$/.test(value));
            if (index >= 0 && values[index + 1]) {
              // A body held in a variable resolves when the assignment was a
              // literal earlier in this command; otherwise the shell will run
              // text this scan cannot see, which is an incomplete scan.
              const body = nestedBody(values[index + 1], env, parsing, false, values.slice(index + 2));
              if (body !== null) result.push(...segments(body, depth + 1, parsing, input));
            }
          }
          // eval and source execute computed text: a literal resolves, anything
          // else is text this scan cannot see.
          if (/^(?:eval|source|\.)$/.test(values[0])) {
            for (const value of values.slice(1)) { const body = nestedBody(value, env, parsing, true); if (body !== null && values[0] === 'eval') result.push(...segments(body, depth + 1, parsing)); }
          }
          // A shell reading stdin executes the body. Ordinary consumers such
          // as cat and apply_patch receive data, including literal shell text.
          if (/^(?:sh|bash|zsh)$/.test(values[0]) && !values.some(value => /^-[a-z]*c[a-z]*$/.test(value))) {
            const arguments_ = list.slice(1).filter((item, index, rest) => !item.operator && !rest[index - 1]?.operator).map(item => item.value);
            if (arguments_.some(value => /^-[a-z]*s[a-z]*$/.test(value)) || arguments_.every(value => value.startsWith('-'))) {
              for (const document of input) result.push(...segments(document.body, depth + 1, parsing));
            }
          }
        } else for (const [name, value] of env) known.set(name, value);
      }
      piped = ['|', '|&'].includes(token.value) ? forwarded : [];
      current.length = 0;
    } else current.push(token);
  }
  return result;
}
// The text a nested shell, eval or source will run. A body that is exactly
// one variable resolves from a literal assignment earlier in this command;
// a body that is exactly one substitution, or a variable set elsewhere, is
// text this scan cannot see (incomplete, so the raw pass runs). Any other
// literal body is scanned as the command text it is; substitutions inside it
// are scanned as nested commands by the tokenizer.
function nestedBody(value, env, parsing, strict = false, positional = []) {
  // A substitution that only prints a literal (printf %s '...', echo '...') is
  // that literal; any other computed text cannot be seen here.
  const printed = /^\$\((?:printf\s+(?:%s|'%s'|"%s")\s+|echo\s+(?:-[neE]+\s+)*)(.*)\)$/s.exec(value) ?? /^`(?:printf\s+(?:%s|'%s'|"%s")\s+|echo\s+(?:-[neE]+\s+)*)(.*)`$/s.exec(value);
  if (printed) {
    const text = printed[1].trim();
    const quoted = /^'(.*)'$/s.exec(text) ?? /^"(.*)"$/s.exec(text);
    if (quoted) return quoted[0][0] === "'" ? quoted[1].replaceAll("'\\''", "'") : quoted[1].replace(/\\(["\\$`])/g, '$1');
    return text;
  }
  if (/^(?:\$\(.*\)|`.*`)$/s.test(value) || strict && /\$\(|`|\$\{?[A-Za-z_]/.test(value)) { parsing.incomplete = true; return null; }
  // Every expansion the scanner can know is substituted before the body is
  // read: a variable assigned earlier in this command, a positional from the
  // arguments after the body ($0 is the first), and a default expansion
  // ${NAME:-text}, which reads as text when NAME is unknown. An unknown
  // default, an unseen positional, or a computed command position is text the
  // shell will run and this scan cannot see: the scan is incomplete, and a
  // computed command position leaves no body to read.
  let text = value.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*):?[-=]([^}]*)\}/g, (match, name, fallback) => env?.has(name) ? env.get(name) : fallback);
  text = text.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)|\$([0-9@*#])/g, (match, braced, bare, special) => {
    if (special !== undefined) return /[0-9]/.test(special) && positional[Number(special)] !== undefined ? positional[Number(special)] : match;
    const name = braced ?? bare;
    return env?.has(name) ? env.get(name) : match;
  });
  // An unknown default is read as its literal text (the cautious reading; a
  // value set elsewhere is as unknown as any other variable). A computed
  // command position leaves no body to read, so the raw pass runs instead.
  const computed = /^\s*[$`]/.test(text);
  if (computed) parsing.incomplete = true;
  return computed ? null : text;
}
// Brace expansion runs before pathname expansion: `rm -rf {/,x}` removes `/`.
// Comma lists are expanded (up to 64 results); a parameter expansion `${...}`
// is not a brace list and is left to resolveTarget.
function braceExpand(value) {
  let results = [value];
  for (let round = 0; round < 8; round++) {
    const next = [];
    for (const item of results) {
      const match = /(?<!\$)\{([^{}]*,[^{}]*)\}/.exec(item);
      if (!match) { next.push(item); continue; }
      for (const choice of match[1].split(',')) next.push(item.slice(0, match.index) + choice + item.slice(match.index + match[0].length));
    }
    if (next.length > 64) return results;
    if (next.length === results.length && next.every((item, index) => item === results[index])) return results;
    results = next;
  }
  return results;
}
function resolveTarget(value, env) {
  const expanded = braceExpand(value);
  if (expanded.length > 1 || expanded[0] !== value) return expanded.flatMap(item => resolveTarget(item, env));
  // Substitute only what the scanner can know: HOME and PWD, the working
  // directory from $(pwd), and literals assigned earlier in the same command.
  // Anything else that still expands is unknown, and an unknown recursive-delete
  // target is treated as dangerous rather than assumed harmless.
  const literal = input => input.replace(/\$\(\s*pwd\s*\)|`\s*pwd\s*`/g, '.')
    .replace(/\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`/g, '/tmp/mktemp.placeholder');
  let text = literal(value);
  for (let round = 0; round < 4 && /[$`]/.test(text); round++) {
    const before = text;
    text = literal(text);
    text = text.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g, (match, braced, bare) => {
      const name = braced ?? bare;
      if (name === 'HOME') return '~';
      if (name === 'PWD') return '.';
      return env?.has(name) ? env.get(name) : match;
    });
    if (text === before) break;
  }
  if (!/[$`]/.test(text)) return [text];
  // Whatever is still unknown could be one path component or nothing at all.
  // Both readings are judged: `$DIR/a/b` stays deep either way, while `$DIR`,
  // `$DIR/` and `$DIR/*` read as a root or a shallow wildcard and stop.
  const unknown = /\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$env:[A-Za-z_][A-Za-z_0-9]*|\$[A-Za-z_][A-Za-z_0-9]*|\$[0-9@*#?$!-]/g;
  return [text.replace(unknown, 'unknown'), text.replace(unknown, '/')];
}
// Directories that hold generated files and the extensions of generated
// artifacts. A wildcard delete confined to one of these is routine cleanup;
// the directory itself is never protected by this rule, so this only narrows
// the wildcard branch.
const GENERATED_DIRS = new Set(['build', 'dist', 'out', 'target', 'tmp', 'temp', '.cache', 'cache', '__pycache__', 'node_modules', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.eggs', 'htmlcov', 'coverage', '_build', '.next', '.nuxt', '.parcel-cache', '.turbo', '.gradle', 'bin', 'obj', '.venv', 'venv', 'site-packages', '.ipynb_checkpoints', '.hypothesis', '.benchmarks']);
const GENERATED_EXTENSIONS = /\.(?:pyc|pyo|pyd|egg-info|dist-info|o|obj|a|class|log|tmp|temp|bak|orig|rej|swp|swo|DS_Store|coverage|gcda|gcno|whl|tgz|nupkg)$/i;
function generatedCleanup(value) {
  if (/^(?:\/|~|[A-Za-z]:)/.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return false;
  const parts = value.replace(/^\.\//, '').split(/[\\/]/).filter(part => part && part !== '.');
  const extensionGlob = part => /[*?]/.test(part) && !/^\*\*?$/.test(part) && GENERATED_EXTENSIONS.test(part.replace(/[*?]/g, ''))
    && /^\*?\.?[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/.test(part);
  if (parts.length === 1) return extensionGlob(parts[0]);
  if (GENERATED_DIRS.has(parts[0]) && !/[*?]/.test(parts[0])) return true;
  // A wildcard that lands on a generated name matches only generated
  // artifacts: */__pycache__, src/*.pyc, **/build. A wildcard that lands on
  // anything else (*/src, build/*/lib) is judged by depth as before.
  const last = parts[parts.length - 1];
  return (GENERATED_DIRS.has(last) || extensionGlob(last)) && parts.slice(0, -1).every(part => /^[A-Za-z0-9_.*?-]+$/.test(part));
}
function shallowDelete(value) {
  value = /^[A-Za-z]:[\\/]/.test(value) ? path.win32.normalize(value) : path.posix.normalize(value);
  value = value.replace(/[\\/]+$/, '') || '/';
  if (/^(?:\/|~|\$HOME|\$\{HOME\}|\.|\.\.|[A-Za-z]:[\\/]?)$/.test(value)) return true;
  if (value === path.normalize(os.homedir()).replace(/[\\/]+$/, '')) return true;
  if (generatedCleanup(value)) return false;
  return /[*?]|\[[^\]]+\]/.test(value) && value.replace(/^\$\{?HOME\}?|^~|^[A-Za-z]:/, '').split(/[\\/]/).filter(part => part && part !== '.').length <= 2;
}
function executesStdin(list = []) {
  if (!/^(?:sh|bash|zsh|dash|ksh|python(?:3)?)$/.test(list[0] ?? '')) return false;
  const arguments_ = list.slice(1);
  if (arguments_.some(value => /^-[a-z]*c[a-z]*$/.test(value))) return false;
  if (arguments_.some(value => /^(?:\/dev\/stdin|\/dev\/fd\/0|-)$/.test(value))) return true;
  if (/^python/.test(list[0]) && arguments_.includes('-m')) return false;
  if (/^(?:sh|bash|zsh)$/.test(list[0]) && arguments_.some(value => /^-[a-z]*s[a-z]*$/.test(value))) return true;
  return arguments_.every(value => value.startsWith('-'));
}
function cloudOperation(list) {
  const positional = [];
  for (let index = 1; index < list.length; index++) {
    const value = list[index];
    if (value.startsWith('-')) {
      if (!value.includes('=') && /^(?:--profile|--region|--endpoint-url|--output|--query|--project|--account|--configuration|--billing-project|--impersonate-service-account|--flags-file)$/.test(value)) index++;
      continue;
    }
    positional.push(value);
  }
  if (list[0] === 'aws') return positional[1] ?? '';
  // Gcloud has variable-depth command groups. Stop at the first recognized
  // operation so an object named "delete" is never mistaken for an operation.
  return positional.find(value => /^(?:delete|terminate|disable|describe|list|get|show|create|update|add|remove|set|unset|enable|start|stop|restart|submit|deploy|export|import|print|login|activate|revoke|ssh|scp|cp|ls)(?:-[a-z]+)*$/.test(value)) ?? '';
}
function chmodMode(list) {
  for (let index = 1; index < list.length; index++) {
    if (list[index] === '--reference' || list[index].startsWith('--reference=')) return '';
    if (list[index] === '--') return list[index + 1] ?? '';
    if (!list[index].startsWith('-')) return list[index];
  }
  return '';
}
function readGitReference(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error('guard_git_reference_invalid');
    const buffer = Buffer.alloc(4097), bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) throw new Error('guard_git_reference_invalid');
    return buffer.toString('utf8', 0, bytes);
  } finally { fs.closeSync(fd); }
}
function branchState(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  let directory = cwd;
  for (let level = 0; level < 16; level++) {
    const candidate = path.join(directory, '.git');
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() && !stat.isFile()) return null;
      let git = candidate;
      try {
        if (stat.isFile()) { const match = /^gitdir: ([^\r\n]+)\s*$/.exec(readGitReference(candidate)); if (!match) return null; git = path.resolve(directory, match[1]); }
        const ref = /^ref: refs\/heads\/([^\r\n]+)\s*$/.exec(readGitReference(path.join(git, 'HEAD')))?.[1];
        return ref ? /^(?:main|master)$/.test(ref) : null;
      } catch { return null; }
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    const parent = path.dirname(directory); if (parent === directory) return null; directory = parent;
  }
  return null;
}
// Only literal project-relative template copies get this exception. It removes
// that copy destination, never redirects, other writes or exfiltration checks.
// As with the rest of the scanner, path checks are lexical, not file inspection.
function templateCopy(list) {
  const operands = []; let ended = false;
  for (const value of list.slice(1)) {
    if (!ended && value === '--') { ended = true; continue; }
    if (!ended && value.startsWith('-')) { if (!/^-[finvp]+$/.test(value)) return false; continue; }
    operands.push(value);
  }
  if (operands.length !== 2 || operands.some(value => !/^[\w./ -]+$/.test(value) || value.startsWith('/')
    || /(?:^|\/)\.\.(?:\/|$)/.test(value) || SENSITIVE.test(path.posix.dirname(value)))) return false;
  const [source, destination] = operands.map(value => path.posix.basename(value));
  return /^\.env\.(?:example|sample|template|dist|defaults?)$/.test(source)
    && /^\.env(?:\.[\w-]+)*$/.test(destination) && !/^\.env\.(?:example|sample|template|dist|defaults?)(?:\.|$)/.test(destination);
}
function writeTargets(tool, input, commands) {
  const targets = [];
  const sameDirectory = !commands.some(command => command.cwdChanged || /^(?:cd|pushd|popd)$/.test(command.words[0]));
  const editorRead = input && typeof input === 'object' && typeof input.command === 'string' && EDITOR_READ.test(input.command) && /(?:editor|edit_tool)$/i.test(tool);
  if (WRITE.test(tool) && !editorRead) {
    const visit = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 12) return;
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:path|file_path|filepath|filename|file|notebook_path)$/i.test(key) && typeof item === 'string') targets.push(item);
        if (typeof item === 'string' && /^(?:patch|input|diff)$/i.test(key)) for (const match of item.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) targets.push(match[1]);
        if (item && typeof item === 'object') visit(item, depth + 1);
      }
    };
    if (typeof input === 'string') for (const match of input.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) targets.push(match[1]);
    else visit(input);
  }
  for (const {words: list, redirects} of commands) {
    targets.push(...redirects);
    const name = list[0].toLowerCase();
    if (['tee', 'touch', 'truncate'].includes(name)) targets.push(...list.slice(1).filter(value => !value.startsWith('-')));
    if (['cp', 'mv', 'install'].includes(name) && list.length > 2) {
      if (name === 'cp' && sameDirectory && templateCopy(list)) continue;
      const at = list.findIndex(value => value === '-t' || value === '--target-directory');
      targets.push(at >= 0 && list[at + 1] ? list[at + 1] : list.find(value => value.startsWith('--target-directory='))?.slice(19) ?? list.at(-1));
    }
    if (['sed', 'perl'].includes(name) && list.some(value => /^-[a-z]*i/.test(value))) targets.push(list.at(-1));
    if (/^(?:set-content|add-content|out-file|new-item)$/i.test(name)) { const at = list.findIndex(value => /^(?:-path|-literalpath|-filepath)$/i.test(value)); if (at >= 0 && list[at + 1]) targets.push(list[at + 1]); }
  }
  return targets.map(target => target.replace(/\\/g, '/')).map(target => path.posix.normalize(target));
}
function scanGuardPack(tool, input, options = {}) {
  const found = new Set(); let reason;
  const values = [];
  const commandValues = SHELL.test(tool) ? (typeof input === 'string' ? [input] : [input?.command, input?.cmd, input?.script].flat().filter(value => typeof value === 'string')) : [];
  try {
    strings(input, values);
    const queries = [];
    const queryFields = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:q|query|search|search_query|searchQuery|filter|keywords)$/.test(key) && typeof item === 'string') queries.push(item);
        else if (item && typeof item === 'object') queryFields(item);
      }
    };
    queryFields(input);
    const inboxSearch = /(?:gmail|outlook|email|mail|slack|teams|discord|messag|inbox)/i.test(tool);
    const searchValues = queries.length ? queries : /(?:search|query|find)/i.test(tool) ? values : [];
    if (inboxSearch && searchValues.some(value => /\b(?:verification[ -]?codes?|one[ -]?time[ -]?(?:codes?|passwords?)|password[ -]?reset(?:[ -]?(?:links?|codes?))?|sign[ -]?in[ -]?links?|login[ -]?links?|otp)\b/i.test(value))) found.add('inbox-reset-codes');
    if (values.some(secretShaped)) found.add('GP010');
    const parsing = {incomplete: false};
    const commands = commandValues.flatMap(value => { if (value.length > MAX_COMMAND_CHARS) { parsing.incomplete = true; value = value.slice(0, MAX_COMMAND_CHARS); } return segments(value, 0, parsing); });
    if (parsing.incomplete) reason = 'guard_scan_incomplete';
    if (parsing.secret) found.add('GP010');
    const sharedBranch = list => {
      let cwd = options.cwd, uncertain = false;
      for (let index = 1; index < list.length; index++) {
        if (list[index] === '-C') { if (!cwd || !list[index + 1]) { uncertain = true; break; } cwd = path.resolve(cwd, list[++index]); }
        else if (list[index].startsWith('--git-dir') || list[index].startsWith('--work-tree')) uncertain = true;
      }
      const shared = uncertain ? null : options.sharedBranch === undefined ? branchState(cwd) : options.sharedBranch;
      if (shared === null && !reason) reason = 'guard_branch_unknown'; return shared !== false;
    };
    for (const [index, command] of commands.entries()) {
      const list = command.words, name = list[0].toLowerCase(), text = list.join(' ');
      // A secret split by empty quotes is whole again once the shell has joined the word.
      if (list.some(secretShaped)) found.add('GP010');
      if (list.some(value => /^--dry-run(?:=(?!false$|none$).*)?$/.test(value))) continue;
      if (/^(?:curl|wget)$/.test(name) && ['|', '|&'].includes(command.after) && executesStdin(commands[index + 1]?.words)) found.add('GP001');
      if (command.fetched && /^(?:sh|bash|zsh|dash|ksh|eval|source|\.|python(?:3)?|node|perl|ruby)$/.test(name)) found.add('GP001');
      if (name === 'rm' && list.some(value => /^-[a-z]*r|^--recursive$/i.test(value)) || name === 'remove-item' && list.some(value => /^-recurse$/i.test(value))) {
        // Operands only: options are skipped until a bare `--` ends them.
        let seenEnd = false;
        let operands = list.slice(1).filter(value => { if (seenEnd) return !command.redirects.includes(value); if (value === '--') { seenEnd = true; return false; } return !value.startsWith('-') && !command.redirects.includes(value); });
        // `echo / | xargs rm -rf`: the operands arrive on stdin from a literal echo.
        if (!operands.length && index > 0 && ['|', '|&'].includes(commands[index - 1].after) && /^(?:echo|printf)$/.test(commands[index - 1].words[0])) operands = commands[index - 1].words.slice(1);
        if (operands.some(value => resolveTarget(value, command.env).some(shallowDelete))) found.add('GP002');
      }
      if (name === 'git') {
        if (list.includes('push')) {
          const arguments_ = list.slice(list.indexOf('push') + 1);
          const forced = arguments_.some(value => /^--force(?:-with-lease)?(?:=|$)|^-f$/.test(value));
          const destinations = arguments_.filter(value => !value.startsWith('-'));
          const refs = destinations.slice(1);
          if (refs.some(value => (forced || value.startsWith('+')) && /^(?:main|master)$/.test(value.replace(/^\+/, '').split(':').at(-1).replace(/^refs\/heads\//, '')))
            || (forced && destinations.length <= 1 || refs.some(value => /^(?:\+HEAD|HEAD)$/.test(value) && (forced || value.startsWith('+')))) && sharedBranch(list)) found.add('GP003');
        }
        if (list.includes('reset') && list.includes('--hard') && sharedBranch(list)) found.add('GP004');
        if (list.includes('clean')) { const flags = list.filter(value => /^-[^-]/.test(value)).join(''); if (!flags.includes('n') && (flags.includes('f') || list.includes('--force')) && flags.includes('d') && flags.includes('x')) found.add('GP005'); }
      }
      if (name === 'terraform' && list.some(value => /^(?:apply|destroy)$/.test(value)) && list.some(value => /^-auto-approve(?:=true)?$/.test(value))) found.add('GP006');
      if (name === 'kubectl' && /\bdelete (?:namespace|namespaces|ns)\b/.test(text)) found.add('GP007');
      if (/^(?:aws|gcloud)$/.test(name) && /^(?:delete|terminate|disable)(?:[-a-z]*)$/.test(cloudOperation(list))) found.add('GP008');
      if (name === 'chmod' && /^0?777$/.test(chmodMode(list))) found.add('GP011');
      if (name === 'ufw' && list.includes('disable') || name === 'pfctl' && list.includes('-d') || name === 'iptables' && list.includes('-F')
        || /^(?:systemctl|service)$/.test(name) && list.some(value => /^(?:stop|disable)$/.test(value)) && list.some(value => /^(?:ufw|firewalld|iptables)(?:\.service)?$/.test(value))
        || name === 'netsh' && /advfirewall .*state off/i.test(text) || name === 'socketfilterfw' && /--setglobalstate off/.test(text)
        || name === 'set-netfirewallprofile' && /-enabled (?:false|\$false)/i.test(text)) found.add('GP012');
      const installing = /^(?:npm|pnpm|yarn|pip|pip3|uv|cargo)$/.test(name) && list.some(value => /^(?:install|add|i)$/.test(value));
      const sources = [];
      for (let index = 1; index < list.length; index++) {
        if (/^(?:--registry|--index-url|--extra-index-url|--trusted-host)$/.test(list[index]) || /^(?:pip|pip3|uv)$/.test(name) && list[index] === '-i') { index++; continue; }
        if (/^(?:--registry|--index-url|--extra-index-url|--trusted-host)=/.test(list[index]) || /^(?:\.{1,2}[\\/]|[\\/]|file:|link:|workspace:)/.test(list[index])) continue;
        sources.push(list[index]);
      }
      // A path (., ./x, ../x, /x, ~/x) or an editable install is a local source.
      // owner/repo shorthand resolves to GitHub for the npm family only; pip
      // and cargo read such an argument as a path.
      const shorthand = /^(?:npm|pnpm|yarn)$/.test(name);
      if (installing && sources.some(value => /(?:https?:\/\/|git\+|git:\/\/|git@|github:|gitlab:|bitbucket:|^--git$|#[A-Za-z0-9])/.test(value)
        || shorthand && !/^(?:\.|\/|~)/.test(value) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))) found.add('GP014');
    }
    const targets = writeTargets(tool, input, commands);
    for (const id of dangerousRules(tool, input, commands, values, targets, resolveTarget)) found.add(id);
    for (const target of targets) { if (SENSITIVE.test(target)) found.add('GP009'); if (SYSTEM.test(target)) found.add('GP013'); }
  } catch { reason = 'guard_scan_incomplete'; }
  if (reason === 'guard_scan_incomplete') {
    // Raw text is a fallback only. A clean parse never turns quoted examples
    // or patch bodies into commands. Keep any match even if parsing failed.
    for (const value of new Set(commandValues)) {
      for (const id of rawDangerousRules(value)) found.add(id);
      for (const rule of RULES) {
        if (['GP015','GP016','GP017','GP018','GP019'].includes(rule.id)) continue;
        // A comment, heading or URL in unparsed text is not a package source; the
        // raw GP014 check needs an install verb and a remote source spelling.
        if (rule.id === 'GP014') {
          if (/\b(?:npm|pnpm|yarn|pip3?|uv|cargo)\b[^\n]*\b(?:install|add|i)\b/i.test(value) && /(?:https?:\/\/|git\+|git:\/\/|git@|github:|gitlab:|bitbucket:|--git\b)/i.test(value)) found.add(rule.id);
          continue;
        }
        if (rule.id === 'GP010') { if (secretShaped(value)) found.add(rule.id); continue; }
        if (new RegExp(rule.pattern, 'im').test(value)) found.add(rule.id);
      }
    }
    if (values.some(secretShaped)) found.add('GP010');
    for (const target of writeTargets(tool, input, [])) { if (SENSITIVE.test(target)) found.add('GP009'); if (SYSTEM.test(target)) found.add('GP013'); }
  }
  return {ruleIds: [...found].sort(), ...(reason ? {reason} : {})};
}
function guardResult(ids, config = {}, mode = 'shadow', warnOnly = []) {
  if (!Array.isArray(ids) || ids.length > RULES.length || ids.some(id => !BY_ID.has(id))) throw new Error('guard_rule_ids_invalid');
  const matches = [...new Set(ids)].map(id => { const configured = config.rules?.[id] ?? guardDefault(id); if (!['stop', 'warn', 'off', ...(id === 'GP020' ? ['ask'] : [])].includes(configured)) throw new Error('guard_policy_invalid'); return {id, action: ['stop', 'ask'].includes(configured) && (mode !== 'enforce' || warnOnly.includes(id)) ? 'warn' : configured}; });
  const active = matches.filter(match => match.action !== 'off');
  const stop = mode === 'enforce' && active.some(match => match.action === 'stop');
  const ask = mode === 'enforce' && active.some(match => match.action === 'ask');
  return {matches, stop, ask, warning: active.some(match => match.action === 'warn') && !stop,
    message: active.map(match => `AgentGuard ${mode === 'enforce' && match.action === 'stop' ? 'STOP' : match.action === 'ask' ? 'ASK' : 'WARN'} ${match.id}: ${BY_ID.get(match.id).reason}`).join(' ')};
}
// `internals` exposes the tokenizer to test-only referees and replay harnesses so
// they compare the real parser, never a reimplementation.
module.exports = {segments, SHELL, RULES, scanGuardPack, guardResult, branchState, internals: Object.freeze({words, segments})};
