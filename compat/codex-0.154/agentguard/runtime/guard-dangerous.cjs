'use strict';
// Deterministic local checks over parsed commands and explicit tool arguments.
// No tool input is executed and no file content is opened by these checks.
const path = require('node:path');
const os = require('node:os');
const SECRET_PATH = /(?:^|[\s'"`@=:(/\\])(?:\.ssh(?![/\\]id_(?:rsa|dsa|ecdsa|ed25519)\.pub(?:$|[\s'"`),;]))|\.aws|\.gnupg|\.kube|\.docker|\.config[/\\](?:gcloud|gh)|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(?!\.(?:example|sample|template|dist|defaults?)(?:$|[\s'"`),;/\\]))(?:\.[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub(?:$|[\s'"`),;/\\]))(?:\.[\w.-]+)?|[\w.-]+\.(?:pem|p12)|(?:[\w.-]+\.)?keychain(?:-db)?|private[_-]?key(?:\.[\w.-]+)?)(?=$|[\s'"`),;/\\])|\/run\/secrets(?:\/|\b)|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i;
const AUTH_PATH = /^\/(?:private\/)?etc\/(?:sudoers(?:\.d)?|shadow|gshadow|passwd|group|master\.passwd|security|pam\.d|ssh\/sshd_config(?:\.d)?)(?:\/|$)/i;
const DEVICE = /^\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|md\d|loop\d|mapper\/)/;
const SEND_FLAG = /^(?:-T|-d|-F|--(?:upload-file|data(?:-ascii|-binary|-raw|-urlencode)?|form(?:-string)?|post-file|post-data|body-file|body-data))(?:=|$)/;
const NATIVE_NET = /\b(?:fetch|request|post|put|send|sendall|connect|create_connection|urlopen)\s*\(/;
const FILE_READ = /\b(?:readFileSync|readFile|createReadStream|open|read_text|read_bytes)\s*\(/;
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:[^/\s:@]+@)?[^/\s:]+:)/i;
const COPY_OPTIONS = /^(?:-[eFiJoPS]|--(?:rsh|rsync-path|files-from|exclude-from|include-from|filter|config|password-file|identity-file|port))$/;
const CLOUD_OPTIONS = /^(?:-[ou]|--(?:profile|region|endpoint-url|output|query|project|account|configuration|billing-project|impersonate-service-account|flags-file))$/;

// Skip option values such as an SSH identity or a cloud CLI config. Those
// authenticate the transfer; they are not its payload. No referenced file is read.
function operands(args, valueOptions) {
  const result = []; let ended = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!ended && value === '--') { ended = true; continue; }
    if (!ended && value.startsWith('-') && value !== '-') {
      if (valueOptions.test(value)) i++;
    } else result.push(value);
  }
  return result;
}
function sendBodies(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (SEND_FLAG.test(value)) result.push(value.includes('=') ? value.slice(value.indexOf('=') + 1) : args[++i] ?? '');
    else if (/^-[TdF].+/.test(value)) result.push(value.slice(2));
  }
  return result;
}
function copySends(name, args, secretPipe) {
  if (['scp', 'rsync', 'rclone'].includes(name)) {
    const parts = operands(args, COPY_OPTIONS);
    if (name === 'rclone' && !/^(?:copy|copyto|sync|move|moveto)$/.test(parts.shift() ?? '')) return false;
    return parts.length >= 2 && REMOTE.test(parts.at(-1)) && parts.slice(0, -1).some(secret);
  }
  const parts = operands(args, CLOUD_OPTIONS);
  let source, destination;
  if (name === 'aws' && parts[0] === 's3' && /^(?:cp|sync)$/.test(parts[1] ?? '')) [source, destination] = parts.slice(2);
  if (name === 'gsutil' && parts[0] === 'cp') {
    destination = parts.at(-1);
    if (/^gs:\/\//.test(destination ?? '') && parts.slice(1, -1).some(secret)) return true;
    source = parts[1];
  }
  if (name === 'gcloud' && parts[0] === 'storage' && /^(?:cp|rsync)$/.test(parts[1] ?? '')) {
    destination = parts.at(-1);
    if (/^gs:\/\//.test(destination ?? '') && parts.slice(2, -1).some(secret)) return true;
    source = parts[2];
  }
  if (source && /^(?:s3|gs):\/\//.test(destination ?? '') && (secret(source) || source === '-' && secretPipe)) return true;
  if (name === 'az' && parts[0] === 'storage' && /^(?:blob|file)$/.test(parts[1] ?? '') && /^(?:upload|upload-batch|sync)$/.test(parts[2] ?? '')) {
    return args.some((value, i) => /^(?:--file|--source|-f)$/.test(value) && secret(args[i + 1] ?? '')
      || /^--(?:file|source)=/.test(value) && secret(value.slice(value.indexOf('=') + 1)));
  }
  return false;
}

function decode(value) {
  return String(value).replace(/\\x([a-f0-9]{2})|\\u([a-f0-9]{4})/ig, (_, hex, unicode) => String.fromCharCode(parseInt(hex || unicode, 16)));
}
function secret(value) { return SECRET_PATH.test(decode(value)); }
function expanded(value, env = new Map()) {
  return decode(value).replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (match, a, b) => env.get(a || b) ?? match);
}
// Preserve code outside strings and comments so printing an example cannot
// turn into an executable operation. Literal values remain separately usable.
function codeOnly(source, sql = false) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (c === '/' && next === '*' || !sql && c === '/' && next === '/' || sql && c === '-' && next === '-' || !sql && c === '#') {
      const block = next === '*'; i += block || next === '/' || next === '-' ? 2 : 1;
      while (i < source.length && (block ? !(source[i] === '*' && source[i + 1] === '/') : source[i] !== '\n')) i++;
      if (block) i++;
      out += ' '; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c, start = i + 1; out += sql && c !== "'" ? 'identifier' : ' ';
      for (i++; i < source.length; i++) {
        if (source[i] === '\\') { i++; continue; }
        if (source[i] === quote) { if (sql && source[i + 1] === quote) { i++; continue; } break; }
      }
      // JSON-style property names are code keys, not string data values.
      const key = source.slice(start, i);
      if (!sql && /^[A-Za-z_$][\w$]*$/.test(key) && /^\s*:/.test(source.slice(i + 1))) out += key;
    } else out += c;
  }
  return out;
}
function inlineCode(list) {
  if (!/^(?:node(?:\.exe)?|python(?:\d+(?:\.\d+)?)?)$/.test(list[0])) return '';
  for (let i = 1; i < list.length; i++) {
    if (/^(?:-e|--eval|-p|--print|-c)$/.test(list[i])) return list[i + 1] ?? '';
    if (/^(?:--eval|--print)=/.test(list[i])) return list[i].slice(list[i].indexOf('=') + 1);
  }
  return '';
}
function literals(code) {
  const values = [];
  for (const match of code.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) values.push(decode(match[2]));
  return values;
}
function protectedTree(value) {
  const normalized = path.posix.normalize(value.replace(/^~(?=\/|$)|^\$\{?HOME\}?(?=\/|$)/, os.homedir()));
  const home = path.posix.normalize(os.homedir());
  const relative = normalized.startsWith(home + '/') ? normalized.slice(home.length + 1)
    : /^\/(?:Users|home)\/[^/]+\/(.*)$/.exec(normalized)?.[1] ?? /^\/root\/(.*)$/.exec(normalized)?.[1];
  if (relative !== undefined) {
    // Preserve the existing generated-artifact cleanup cases. This exception is
    // lexical and confined to known cache/temp/build directory components.
    const parts = relative.split('/');
    if (parts[0] === '.cache' || parts[0] === 'tmp' || parts.length > 1 && parts.some(part => ['build','dist','node_modules','__pycache__','.next','coverage'].includes(part))) return false;
    return relative.length > 0;
  }
  return /^\/srv(?:\/|$)/.test(normalized);
}
function sqlWipe(value) {
  return /(?:^|;)\s*(?:TRUNCATE(?:\s+TABLE)?\s+[\w]|DROP\s+(?:DATABASE|TABLE)\b)/im.test(codeOnly(value, true));
}
function redisWipe(list) {
  let i = 1;
  while (i < list.length && list[i].startsWith('-')) {
    const flag = list[i++];
    if (/^(?:-[hpunasr]|--user|--pass|--cacert|--cert|--key|--sni)$/.test(flag)) i++;
  }
  return /^(?:FLUSHALL|FLUSHDB)$/i.test(list[i] ?? '');
}
function findDeletes(args) {
  for (let i = 0; i < args.length; i++) {
    if (/^-(?:name|iname|path|ipath|regex|iregex|user|group|newer|samefile)$/.test(args[i])) { i++; continue; }
    if (args[i] === '-delete') return true;
    if (/^-exec(?:dir)?$/.test(args[i])) {
      if (/^(?:rm|rmdir)$/.test(path.posix.basename(args[i + 1] ?? ''))) return true;
      while (i < args.length && ![';', '+'].includes(args[i])) i++;
    }
  }
  return false;
}
function uploadSource(input, depth = 0) {
  if (!input || typeof input !== 'object' || depth > 12) return false;
  return Object.entries(input).some(([key,value]) => /^(?:body|body_source|data|file|files|file_path|path|attachment|attachments|script|code)$/i.test(key) || uploadSource(value, depth + 1));
}
function dangerousRules(tool, input, commands, values, targets, resolveTarget = value => [value]) {
  const found = new Set();
  let secretPipe = false, transferPipe = false;
  for (const command of commands) {
    const list = command.words.map(value => expanded(value, command.env)), name = list[0].toLowerCase();
    const args = list.slice(1), joined = args.join(' ');
    const script = inlineCode(list), code = codeOnly(script);
    const scriptValues = literals(script);
    const reads = (command.reads ?? []).map(value => expanded(value, command.env));
    const bodies = ['curl', 'wget'].includes(name) ? sendBodies(args) : [];
    const sends = bodies.some(secret) || bodies.length > 0 && secretPipe
      || bodies.some(value => /(?:^|@)(?:-|\/dev\/stdin)$/.test(value)) && reads.some(secret)
      || ['curl', 'wget'].includes(name) && args.some(value => /\$\(|`/.test(value) && secret(value));
    const remoteCopy = copySends(name, args, secretPipe);
    const netcat = /^(?:nc|ncat|netcat)$/.test(name);
    const ssh = name === 'ssh' && operands(args, COPY_OPTIONS).length > 0;
    const socat = name === 'socat' && args.some(value => /^(?:TCP[46]?|UDP[46]?|OPENSSL)(?:-CONNECT)?:/i.test(value));
    const transfer = /^(?:sftp|ftp)$/.test(name) && (transferPipe || (command.transferInput ?? []).some(value =>
      value.split('\n').some(line => /^\s*(?:put|mput)\s+/i.test(line) && secret(expanded(line, command.env)))));
    const ftpUpload = name === 'ftp' && args.includes('-u') && args.some(value => /^ftps?:\/\//i.test(value)) && args.some(secret);
    if (sends || remoteCopy || (netcat || ssh) && (secretPipe || reads.some(secret))
      || socat && (secretPipe || reads.some(secret) || args.some(value => /^(?:OPEN|FILE):/i.test(value) && secret(value)))
      || transfer || ftpUpload
      || script && NATIVE_NET.test(code) && FILE_READ.test(code) && scriptValues.some(secret)) found.add('GP015');
    const readsSecret = /^(?:cat|tar|base64|openssl)$/.test(name) && (args.some(secret) || reads.some(secret));
    transferPipe = ['|', '|&'].includes(command.after) && /^(?:printf|echo)$/.test(name) && /\b(?:put|mput)\b/i.test(joined) && secret(joined);
    secretPipe = ['|', '|&'].includes(command.after) && (readsSecret || secretPipe);

    if (/^mkfs(?:\.[\w]+)?$/.test(name) && args.some(value => !value.startsWith('-')) && !args.some(value => ['--help','--version','-n'].includes(value))
      || name === 'dd' && args.some(value => value.startsWith('of=') && DEVICE.test(value.slice(3)))
      || name === 'diskutil' && /^(?:erase|zeroDisk|secureErase|partitionDisk)/i.test(args[0] ?? '')
      || name === 'wipefs' && args.some(value => /^(?:-a|--all|-o|--offset(?:=|$))/.test(value)) && !args.some(value => /^(?:-n|--no-act)$/.test(value))) found.add('GP016');

    if (/^(?:chmod|chown|chgrp|setfacl)$/.test(name) && args.some(value => AUTH_PATH.test(path.posix.normalize(value)))) found.add('GP017');
    if (scriptValues.some(value => AUTH_PATH.test(path.posix.normalize(value))) && /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|chmodSync|chmod|chownSync|chown|truncateSync|truncate|unlinkSync|unlink|write_text|write_bytes)\s*\(/.test(code)) found.add('GP017');
    if (scriptValues.some(value => AUTH_PATH.test(path.posix.normalize(value))) && /\bopen\s*\(/.test(code) && scriptValues.some(value => /^(?:[wax][bt+]?|[wax]\+[bt]?)$/.test(value))) found.add('GP017');

    if (/^(?:psql|mysql|mariadb|sqlite3|sqlcmd|isql|duckdb)$/.test(name) && args.some(sqlWipe) || name === 'redis-cli' && redisWipe(list)) found.add('GP018');
    if (script && /\b(?:execute|executescript|query|exec)\s*\(/.test(code) && scriptValues.some(sqlWipe)) found.add('GP018');
    if (scriptValues.some(value => /redis/i.test(value)) && /\bflush(?:all|db)\s*\(/i.test(code)) found.add('GP018');

    const recursiveRm = /^(?:rm|remove-item)$/.test(name) && args.some(value => /^-[a-z]*r|^--recursive$|^-recurse$/i.test(value));
    const findDelete = name === 'find' && findDeletes(args);
    if ((recursiveRm || findDelete) && args.some(value => resolveTarget(value, command.env).some(protectedTree))) found.add('GP019');
    if (scriptValues.some(protectedTree) && (/\b(?:rmSync|rmdirSync|rm|rmdir)\s*\(/.test(code) && /\brecursive\s*:\s*true\b/.test(code) || /\brmtree\s*\(/.test(code))) found.add('GP019');
  }
  for (const target of targets) if (AUTH_PATH.test(target)) found.add('GP017');

  const networkTool = /(?:^|[._])(?:http|https|browser|fetch|web|upload|send|request)(?:[._]|$)/i.test(tool);
  if (networkTool && values.some(secret)) {
    if (uploadSource(input) || values.some(value => /\b(?:upload|send|transmit|attach|post)\b/i.test(value))) found.add('GP015');
  }
  if (/(?:sql|database|postgres|mysql|redis|db).*(?:query|execute|run|command)/i.test(tool) && values.some(sqlWipe)) found.add('GP018');
  if (/redis.*(?:execute|run|command)/i.test(tool) && values.some(value => /^FLUSH(?:ALL|DB)(?:\s+(?:ASYNC|SYNC))?$/i.test(value.trim()))) found.add('GP018');
  // An explicit destructive instruction delegated to a helper is still the
  // pending action. Descriptive review or documentation prompts do not match.
  if (/^(?:Task|Agent|spawn_agent|functions\.spawn_agent)$/.test(tool)) {
    for (const value of values) {
      if (/^(?:please\s+)?(?:read|upload|send|transmit|copy)\b/i.test(value.trim()) && /\b(?:upload|send|transmit)\b/i.test(value)
        && (secret(value) || /\b(?:cloud access keys|private (?:signing )?keys?|credentials)\b/i.test(value))) found.add('GP015');
      if (/^(?:please\s+)?(?:erase|wipe|delete|drop|truncate)\b/i.test(value.trim()) && /\b(?:live|production|all)\b/i.test(value) && /\b(?:databases?|datastores?|records)\b/i.test(value)) found.add('GP018');
    }
  }
  return [...found];
}
// A failed shell parse gets a conservative bounded-work fallback. Test separate
// token classes instead of an unanchored command.*path regex, which can become
// quadratic on a long sequence of command words with no matching path.
function rawDangerousRules(value) {
  const found = [];
  if (/\b(?:curl|wget|scp|rsync|rclone|aws|gsutil|gcloud|az|sftp|ftp|socat|ssh|nc|ncat|python3?|node)\b/i.test(value) && secret(value)) found.push('GP015');
  if (/\bmkfs(?:\.[a-z0-9]+)?\b|\bdiskutil\s+(?:erase\w*|zeroDisk|secureErase|partitionDisk)/i.test(value)
    || /\bdd\b/.test(value) && /\bof=\/dev\/(?:r?disk\d|sd[a-z]|nvme\d|mapper\/)/.test(value)
    || /\bwipefs\b/.test(value) && /(?:^|\s)(?:-a|--all|-o|--offset)(?:\s|=|$)/.test(value)) found.push('GP016');
  if (/\/(?:private\/)?etc\/(?:sudoers|shadow|gshadow|passwd|group|master\.passwd|security|pam\.d|ssh\/sshd_config)(?:\b|\/)/.test(value)
    && /\b(?:chmod|chown|chgrp|setfacl|tee|writeFileSync|appendFileSync|write_text|write_bytes)\b|[>]/.test(value)) found.push('GP017');
  if (/\b(?:psql|mysql|mariadb|sqlite3|sqlcmd|redis-cli|execute|query)\b/.test(value) && /\b(?:TRUNCATE|DROP\s+(?:DATABASE|TABLE)|FLUSHALL|FLUSHDB)\b/i.test(value)) found.push('GP018');
  if (/\b(?:rm|find|rmSync|rmdirSync|rmtree)\b/.test(value) && /(?:\/home\/|\/Users\/|\/root\/|\/srv\/|\$HOME\/[^\s]|~\/[^\s])/.test(value)) found.push('GP019');
  return found;
}
module.exports = {dangerousRules, rawDangerousRules};
