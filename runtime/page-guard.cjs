'use strict';
// File text and the human-readable findings live only in the hook process.
// The worker receives fixed count keys and digests, never names or URLs.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
const PAGE = /\.(?:html?|mdx?|astro|vue|svelte|jsx|tsx|njk|liquid)$/i;
const CONFIG = /^(?:robots\.txt|sitemap[^/]*\.xml|\.htaccess|_redirects|vercel\.json|netlify\.toml)$/i;
const EDIT = /(?:^|[._])(?:write|edit|multiedit|apply_patch|write_file|edit_file|create_file|update_file|str_replace_editor|str_replace_based_edit_tool)$/i;
const TYPES = ['form', 'table', 'iframe', 'video', 'audio', 'embed', 'object', 'img', 'structured_data', 'canonical', 'component', 'h1', 'h2', 'h3', 'internal_link', 'site_config'];
const ELEMENTS = new Set(TYPES.slice(0, 8).concat(['h1', 'h2', 'h3']));
const local = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const protectedFile = file => PAGE.test(file) || CONFIG.test(path.basename(file));
const policyHash = config => hash(JSON.stringify([config?.rules?.GP020 ?? 'off', config?.pageGuard?.internalLinkThreshold ?? 3]));
const internal = value => value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\?)/i.test(value.trim());
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
function attributes(text) {
  const out = {};
  for (const match of text.matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+))?/g)) {
    let value = match[2] ?? '';
    if (value.startsWith('{')) value = value.slice(1, -1).trim();
    if (/^["']/.test(value)) value = value.slice(1, -1);
    out[match[1].toLowerCase()] = value;
  }
  return out;
}
function inventory(source, file, check = () => {}) {
  const counts = {}, components = new Map(), canonicals = new Map(), links = new Map();
  const add = key => { counts[key] = (counts[key] ?? 0) + 1; };
  const markdown = /\.mdx?$/i.test(file);
  // Examples in comments, fenced code and inline code are not page elements.
  let text = source.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/\{\/\*[\s\S]*?(?:\*\/\}|$)/g, '');
  if (markdown) {
    let fence = null;
    text = text.split('\n').map(line => {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (match && (!fence || match[1][0] === fence[0] && match[1].length >= fence.length)) { fence = fence ? null : match[1]; return ''; }
      return fence ? '' : line.replace(/`+[^`\n]*`+/g, '');
    }).join('\n');
  }
  const tag = /<([A-Za-z][\w.:-]*)(?=[\s/>])/g;
  let match;
  while ((match = tag.exec(text))) {
    check();
    let end = tag.lastIndex, quote = null, braces = 0;
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) { if (c === '\\') end++; else if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '{') braces++;
      else if (c === '}') braces = Math.max(0, braces - 1);
      else if (!braces && (c === '>' || c === '<')) break;
    }
    if (text[end] !== '>') { tag.lastIndex = Math.max(tag.lastIndex, end); continue; }
    const name = match[1], lower = name.toLowerCase(), attrs = attributes(text.slice(tag.lastIndex, end));
    tag.lastIndex = end + 1;
    const component = /^[A-Z]/.test(name) && /\.(?:mdx|jsx|tsx|astro|vue|svelte)$/i.test(file);
    if (component) increment(components, name);
    else if (ELEMENTS.has(lower)) add(lower);
    if (!component && lower === 'script' && attrs.type?.trim().toLowerCase() === 'application/ld+json') add('structured_data');
    if (!component && lower === 'link' && attrs.rel?.toLowerCase().split(/\s+/).includes('canonical')) increment(canonicals, attrs.href ?? '');
    if (lower === 'a' || name === 'Link' || name === 'NavLink') {
      const target = attrs.href ?? attrs.to;
      if (internal(target)) increment(links, target);
    }
    // Do not treat JS strings, JSON-LD bodies or CSS as HTML elements.
    if (!component && (lower === 'script' || lower === 'style') && !/\/\s*$/.test(text.slice(match.index, end))) {
      const close = new RegExp('</' + lower + '\\s*>', 'ig'); close.lastIndex = tag.lastIndex;
      tag.lastIndex = close.exec(text) ? close.lastIndex : text.length;
    }
  }
  if (markdown) {
    const lines = text.split('\n'), references = new Map();
    for (const line of lines) {
      const ref = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)/.exec(line);
      if (ref) references.set(ref[1].toLowerCase(), ref[2]);
    }
    for (let i = 0; i < lines.length; i++) {
      check();
      const heading = /^ {0,3}(#{1,3})(?:\s|$)/.exec(lines[i]);
      if (heading) add('h' + heading[1].length);
      else if (i && lines[i - 1].trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i])) add(lines[i].trim()[0] === '=' ? 'h1' : 'h2');
      if (i && lines[i - 1].includes('|') && lines[i].includes('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|');
        if (cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))) add('table');
      }
      if (/^ {0,3}\[[^\]]+\]:/.test(lines[i])) continue;
      for (const link of lines[i].matchAll(/(!?)\[([^\[\]\n]*)\](?:\(\s*<?([^\s)>\[]+)>?[^)[\n]*\)|\[([^\[\]\n]*)\])/g)) {
        if (link[1]) add('img');
        else { const target = link[3] ?? references.get((link[4] || link[2]).toLowerCase()); if (internal(target)) increment(links, target); }
      }
    }
  }
  return {counts, components, canonicals, links};
}
function removed(before, after) {
  return [...before].flatMap(([name, count]) => count > (after.get(name) ?? 0) ? [[name, count - (after.get(name) ?? 0)]] : []);
}
function compare(before, after, file, check) {
  if (before === after) return {counts: {}, components: [], links: []};
  if (CONFIG.test(path.basename(file))) return {counts: {site_config: 1}, components: [], links: []};
  const a = inventory(before, file, check), b = inventory(after, file, check), counts = {};
  for (const key of Object.keys(a.counts)) if (a.counts[key] > (b.counts[key] ?? 0)) counts[key] = a.counts[key] - (b.counts[key] ?? 0);
  const components = removed(a.components, b.components), links = removed(a.links, b.links);
  for (const [key, values] of [['component', components], ['canonical', removed(a.canonicals, b.canonicals)], ['internal_link', links]]) {
    const count = values.reduce((sum, [, n]) => sum + n, 0); if (count) counts[key] = count;
  }
  return {counts, components, links};
}
function read(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('page_file_not_regular');
    if (stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1); let bytes = 0, n;
    do { n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null); bytes += n; } while (n && bytes < buffer.length);
    return bytes > MAX_BYTES ? null : buffer.toString('utf8', 0, bytes);
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function replacement(before, edit) {
  const old = edit.old_string ?? edit.old_str ?? edit.oldText, next = edit.new_string ?? edit.new_str ?? edit.newText;
  if (typeof old !== 'string' || !old || typeof next !== 'string') throw new Error('page_edit_unsupported');
  const at = before.indexOf(old);
  if (at < 0 || !edit.replace_all && before.indexOf(old, at + old.length) >= 0) throw new Error('page_edit_ambiguous');
  return edit.replace_all ? before.split(old).join(next) : before.slice(0, at) + next + before.slice(at + old.length);
}
// Exact patch reconstruction. Unsupported or mismatched hunks are reported,
// never guessed. Nothing is written to the target files.
function patched(before, lines) {
  let output = before.replace(/\r\n/g, '\n').split('\n'), cursor = 0;
  if (output.at(-1) === '') output.pop();
  for (let i = 0; i < lines.length;) {
    const header = lines[i].startsWith('@@') ? lines[i++].slice(2).trim() : '';
    if (header && !/^[-+]\d/.test(header)) { const at = output.indexOf(header, cursor); if (at < 0) throw new Error('page_patch_context'); cursor = at + 1; }
    const old = [], next = []; let eof = false;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i++];
      if (line === '*** End of File') { eof = true; break; }
      if (line === '\\ No newline at end of file') continue;
      if (line[0] === ' ' || line[0] === '-') old.push(line.slice(1));
      if (line[0] === ' ' || line[0] === '+') next.push(line.slice(1));
      if (!/^[ +\-]/.test(line)) throw new Error('page_patch_unsupported');
    }
    let at = old.length ? -1 : output.length;
    // Compare a joined context with indexOf to avoid quadratic hunk matching.
    if (old.length) {
      const haystack = '\n' + output.slice(cursor).join('\n') + '\n', needle = '\n' + old.join('\n') + '\n';
      const offset = eof ? haystack.endsWith(needle) ? haystack.length - needle.length : -1 : haystack.indexOf(needle);
      if (offset >= 0) at = cursor + (haystack.slice(0, offset).match(/\n/g)?.length ?? 0);
    }
    if (at < 0) throw new Error('page_patch_mismatch');
    output = output.slice(0, at).concat(next, output.slice(at + old.length)); cursor = at + next.length;
  }
  return output.join('\n') + '\n';
}
function scan(tool, input, {cwd = process.cwd(), threshold = 3} = {}) {
  const counts = {}, components = [], links = [], files = new Map();
  let skippedFiles = 0, errors = 0, totalBytes = 0;
  const deadline = performance.now() + 100;
  const check = () => { if (performance.now() > deadline) throw new Error('page_scan_budget'); };
  if (!EDIT.test(tool) || input?.command === 'view') return null;
  const get = (name, force = false) => {
    check();
    if (typeof name !== 'string') throw new Error('page_path_missing');
    const file = path.resolve(cwd, name);
    if (!force && !protectedFile(file)) return null;
    if (!files.has(file)) {
      if (files.size >= 32 || totalBytes > 8 * MAX_BYTES) throw new Error('page_scan_budget');
      const before = read(file); totalBytes += before?.length ?? 0;
      if (before === null) skippedFiles++;
      files.set(file, {before, after: before});
    }
    return files.get(file);
  };
  const update = (name, transform, force = false) => {
    const item = get(name, force);
    if (item && item.after !== null) {
      item.after = transform(item.after);
      if (typeof item.after !== 'string') throw new Error('page_edit_unsupported');
      if (Buffer.byteLength(item.after) > MAX_BYTES) { skippedFiles++; item.after = null; }
    }
  };
  try {
    const patch = typeof input === 'string' ? input : input?.patch ?? input?.input ?? input?.diff;
    if (/(?:^|[._])apply_patch$/i.test(tool)) {
      if (typeof patch !== 'string') throw new Error('page_patch_missing');
      const lines = patch.replace(/\r\n/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i++) {
        check();
        const entry = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i]);
        if (!entry) continue;
        const [, kind, file] = entry, body = []; let move;
        while (i + 1 < lines.length && !/^\*\*\* (?:(?:Add|Update|Delete) File:|End Patch)/.test(lines[i + 1])) {
          const line = lines[++i];
          if (line.startsWith('*** Move to: ')) move = line.slice(13); else body.push(line);
        }
        try {
          update(file, before => kind === 'Delete' ? '' : kind === 'Add' ? body.map(line => { if (!line.startsWith('+')) throw new Error('page_patch_add'); return line.slice(1); }).join('\n') + '\n' : patched(before, body), move && protectedFile(move));
          if (move && protectedFile(move)) {
            const target = get(move), source = files.get(path.resolve(cwd, file));
            if (target && source) target.after = source.after;
          }
          if (move && files.has(path.resolve(cwd, file))) files.get(path.resolve(cwd, file)).after = '';
        } catch { errors++; }
      }
    } else {
      const file = input?.file_path ?? input?.path ?? input?.filepath ?? input?.filename ?? input?.file;
      update(file, before => {
        if (input.command === 'insert') {
          if (!Number.isSafeInteger(input.insert_line) || input.insert_line < 0 || typeof input.new_str !== 'string') throw new Error('page_insert_invalid');
          const lines = before.split('\n'); if (input.insert_line > lines.length) throw new Error('page_insert_invalid');
          lines.splice(input.insert_line, 0, input.new_str); return lines.join('\n');
        }
        if (Array.isArray(input.edits)) return input.edits.reduce(replacement, before);
        if ('old_string' in input || 'old_str' in input || 'oldText' in input) return replacement(before, input);
        return input.content ?? input.contents ?? input.file_text ?? input.text;
      });
    }
    for (const [file, item] of files) {
      if (!protectedFile(file) || item.before === null || item.after === null) continue;
      try {
        check(); const result = compare(item.before, item.after, file, check);
        for (const [key, count] of Object.entries(result.counts)) counts[key] = (counts[key] ?? 0) + count;
        components.push(...result.components); links.push(...result.links);
      } catch { errors++; }
    }
  } catch { errors++; }
  if (!files.size && !errors) return null;
  const triggered = Object.entries(counts).some(([key, n]) => key === 'internal_link' ? n >= threshold : n > 0);
  return {meta: {counts, beforeSha256: hash(JSON.stringify([...files].map(([file, item]) => [file, item.before === null ? null : hash(item.before)]))),
    skippedFiles, errors, ...(errors ? {event: 'fail_open'} : {})}, triggered, components, links};
}
function summary(result) {
  const counts = result.meta.counts, parts = [];
  const labels = {structured_data: 'structured data script', canonical: 'canonical link removed or changed', img: 'image', internal_link: 'internal link'};
  for (const [key, n] of Object.entries(counts)) {
    if (key === 'site_config' || key === 'component') continue;
    let label = labels[key] ?? (key[0] === 'h' ? key + ' heading' : key);
    parts.push(`${n} ${label}${n === 1 ? '' : 's'}`);
  }
  for (const [name, n] of result.components.slice(0, 8)) parts.push(`${n === 1 ? 'the' : n} <${name.length > 80 ? name.slice(0, 80) + '...' : name} /> component${n === 1 ? '' : 's'}`);
  const unlisted = result.components.slice(8).reduce((sum, [, n]) => sum + n, 0);
  if (unlisted) parts.push(`${unlisted} other custom component${unlisted === 1 ? '' : 's'}`);
  let message = parts.length ? 'This edit removes: ' + parts.join(', ') + '.' : '';
  if (result.links.length) message += ' Internal links: ' + result.links.slice(0, 6).map(([url]) => url.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100)).join(', ') + (result.links.length > 6 ? ', ...' : '') + '.';
  if (counts.site_config) message += ` This edit changes ${counts.site_config} site indexing or redirect file${counts.site_config === 1 ? '' : 's'}.`;
  return message.trim();
}
function attach(meta, result) { if (result) local.set(meta, result); return meta; }
function receiptValid(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const keys = ['counts', 'beforeSha256', 'policySha256', 'skippedFiles', 'errors', 'event'];
  return !(Object.keys(meta).some(key => !keys.includes(key)) || !meta.counts || typeof meta.counts !== 'object' || Array.isArray(meta.counts)
    || Object.entries(meta.counts).some(([key, n]) => !TYPES.includes(key) || !Number.isSafeInteger(n) || n < 1)
    || !/^[a-f0-9]{64}$/.test(meta.beforeSha256) || !/^[a-f0-9]{64}$/.test(meta.policySha256)
    || [meta.skippedFiles, meta.errors].some(n => !Number.isSafeInteger(n) || n < 0)
    || meta.event !== undefined && meta.event !== 'fail_open');
}
function validate(meta, config) {
  if (meta === undefined) return;
  if (!receiptValid(meta) || meta.policySha256 !== policyHash(config)) throw new Error('page_guard_metadata_invalid');
}
function decorate(output, meta) {
  const result = local.get(meta); if (!result) return output;
  const hook = output.hookSpecificOutput;
  const mentioned = /\bGP020\b/.test((hook?.permissionDecisionReason ?? '') + (output.systemMessage ?? ''));
  if (result.triggered && mentioned) {
    const detail = summary(result);
    if (hook?.permissionDecisionReason) output = {...output, hookSpecificOutput: {...hook, permissionDecisionReason: detail + '\n' + hook.permissionDecisionReason}};
    else output = {...output, systemMessage: detail + '\n' + output.systemMessage};
  }
  const notices = [];
  if (result.meta.skippedFiles) notices.push(`AgentGuard GP020 skipped ${result.meta.skippedFiles} file${result.meta.skippedFiles === 1 ? '' : 's'} over 2 MB.`);
  if (result.meta.errors) notices.push('AgentGuard GP020 could not reconstruct or scan an edit. That check failed open; a content-free event was recorded.');
  if (notices.length) output = {...output, systemMessage: [output.systemMessage, ...notices].filter(Boolean).join('\n')};
  return output;
}
module.exports = {MAX_BYTES, PAGE, TYPES, protectedFile, policyHash, compare, scan, attach, decorate, validate, receiptValid};
