'use strict';
// Shared verbatim with the control-plane publisher. This module has no I/O.
const {createHash} = require('node:crypto');
const TIERS = ['read_only', 'data_write', 'payment_initiate', 'payment_execute'];
const ROOT_FIELDS = ['version', 'tenantId', 'mode', 'hookBudgetMs', 'defaultMatterId', 'maxCapability', 'allowedTools', 'deniedTools', 'ethicalWall', 'paymentPattern', 'toolRules', 'caps', 'sessions', 'guardPack', 'commandRules', 'teamCaps'];
// Team caps are one budget per team per UTC day and month, enforced by the server's allowance endpoint.
// They are server-held: the policy a worker downloads omits them and is hashed without them, so a worker
// whose copy of this module predates the field still validates the envelope it receives.
const TEAM_CAP_FIELDS = ['tokensPerDay', 'tokensPerMonth', 'usdCentsPerDay', 'usdCentsPerMonth'];
const SERVER_HELD_FIELDS = ['teamCaps'];
const GUARD_RULE_IDS = [...Array.from({length: 20}, (_, index) => `GP${String(index + 1).padStart(3, '0')}`), 'inbox-reset-codes'];
const guardDefault = id => ['inbox-reset-codes', 'GP020'].includes(id) ? 'off' : 'stop';
const COMMAND_MATCHES = ['force-push', 'deploy', 'outside-workspace-delete', 'network', 'package-publish', 'website-publish', 'page-delete', 'payment'];
// Character sets for the adjacency check, lowercased because rules run with the
// i flag. `negated` sets stand for everything outside `chars`.
const ANY = {chars: new Set(), negated: true};
function characterRange(from, to) { const out = new Set(); for (let code = from.charCodeAt(0); code <= to.charCodeAt(0) && out.size < 256; code++) out.add(String.fromCharCode(code).toLowerCase()); return out; }
const CLASS_SETS = {d: characterRange('0', '9'), w: new Set([...characterRange('a', 'z'), ...characterRange('0', '9'), '_']), s: new Set([' ', '\t', '\n', '\r', '\f', '\v'])};
function classSet(body) {
  const negated = body.startsWith('^'); if (negated) body = body.slice(1);
  const chars = new Set();
  for (let index = 0; index < body.length; index++) {
    let char = body[index];
    if (char === '\\') {
      const next = body[++index] ?? '';
      if (CLASS_SETS[next]) { for (const item of CLASS_SETS[next]) chars.add(item); continue; }
      if (/[DWS]/.test(next)) return ANY;
      char = next;
    }
    if (body[index + 1] === '-' && index + 2 < body.length) { for (const item of characterRange(char, body[index + 2])) chars.add(item); index += 2; continue; }
    chars.add(char.toLowerCase());
  }
  return {chars, negated};
}
function overlaps(first, second) {
  if (first.negated && second.negated) return true;
  if (!first.negated && !second.negated) return [...first.chars].some(char => second.chars.has(char));
  const [positive, negative] = first.negated ? [second, first] : [first, second];
  return [...positive.chars].some(char => !negative.chars.has(char));
}
function union(first, second) {
  if (first === null) return second; if (second === null) return first;
  if (first.negated || second.negated) return ANY;
  return {chars: new Set([...first.chars, ...second.chars]), negated: false};
}
function unsafePattern(pattern) {
  // Hooks scan untrusted text with these patterns under a fixed budget, so any
  // construction that can backtrack super-linearly is refused: a backreference;
  // a repeated group that contains an alternation, or whose end can overlap its
  // own start across a repetition; and two quantified atoms that can become
  // adjacent in a match (through group edges, empty groups, lookarounds and
  // optional atoms) whose character sets overlap. `reach` is the set a previous
  // quantified atom may still be consuming at the current point.
  const frame = (reach, lookaround = false) => ({reach, initial: reach, first: null, firstOpen: true, alternation: false, branches: [], quantified: false, union: null, lookaround, quantifiedUnion: null, last: null});
  const stack = [frame(null)];
  let index = 0;
  const quantifier = () => {
    const match = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/.exec(pattern.slice(index));
    if (!match) return null;
    index += match[0].length;
    const [symbol, low, comma, high] = [match[1], match[2], match[3], match[4]];
    const optional = symbol === '*' || symbol === '?' || (low !== undefined && Number(low) === 0);
    const repeats = symbol === '*' || symbol === '+' || (low !== undefined && (comma !== undefined && high === '' || Number(high ?? low) > 1));
    return {optional, repeats};
  };
  const consume = (level, atom, quantified) => {
    if (level.firstOpen) { level.first = union(level.first, atom); if (!quantified?.optional) level.firstOpen = false; }
    level.union = union(level.union, atom);
    level.last = atom;
    if (!quantified) { level.reach = null; return true; }
    level.quantifiedUnion = union(level.quantifiedUnion, atom);
    if (level.reach !== null && overlaps(level.reach, atom)) return false;
    level.quantified = true;
    level.reach = quantified.repeats ? (quantified.optional ? union(level.reach, atom) : atom) : (quantified.optional ? union(level.reach, atom) : null);
    return true;
  };
  while (index < pattern.length) {
    const char = pattern[index], level = stack[stack.length - 1];
    let atom;
    if (char === '\\') {
      const next = pattern[index + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return true;
      index += 2;
      if (next === 'b' || next === 'B') continue;
      atom = CLASS_SETS[next] ? {chars: CLASS_SETS[next], negated: false} : /[DWS]/.test(next) ? {chars: CLASS_SETS[next.toLowerCase()], negated: true} : {chars: new Set([next.toLowerCase()]), negated: false};
    } else if (char === '[') {
      let end = index + 1; if (pattern[end] === '^') end++; if (pattern[end] === ']') end++;
      while (end < pattern.length && pattern[end] !== ']') { if (pattern[end] === '\\') end++; end++; }
      atom = classSet(pattern.slice(index + 1, end)); index = end + 1;
    } else if (char === '(') {
      let lookaround = false;
      index++;
      if (pattern[index] === '?') {
        if (pattern[index + 1] === '<' && !/[=!]/.test(pattern[index + 2] ?? '')) index = pattern.indexOf('>', index) + 1;
        else { lookaround = pattern[index + 1] !== ':'; index += pattern[index + 1] === '<' ? 3 : 2; }
      }
      stack.push(frame(level.reach, lookaround));
      continue;
    } else if (char === ')') {
      const group = stack.pop() ?? frame(null), parent = stack[stack.length - 1] ?? group;
      index++;
      const end = group.branches.concat([group.reach]).reduce(union, null);
      const quantified = quantifier();
      if (group.lookaround) { if (quantified && group.quantified) return true; continue; }
      if (quantified) {
        // A repeated group is unsafe when its end can overlap its own start, or
        // when a quantified atom inside it can consume both the group's last atom
        // (the separator) and its first atom, so an iteration boundary can move:
        // (?:.*,)* splits ambiguously, (?:-[rf]+\s+)+ and (?:a+b)* do not.
        if (quantified.repeats && (group.alternation || group.quantified && end !== null && group.first !== null && overlaps(end, group.first)
          || group.quantifiedUnion !== null && group.last !== null && group.first !== null && overlaps(group.quantifiedUnion, group.last) && overlaps(group.quantifiedUnion, group.first))) return true;
        if (parent.reach !== null && group.first !== null && overlaps(parent.reach, group.first)) return true;
        parent.quantified = true;
        const after = quantified.repeats ? group.union : end;
        parent.reach = quantified.optional ? union(parent.reach, after) : after;
      } else { parent.reach = end; parent.quantified ||= group.quantified; }
      parent.union = union(parent.union, group.union);
      parent.quantifiedUnion = union(parent.quantifiedUnion, group.quantifiedUnion);
      parent.last = group.last ?? parent.last;
      if (parent.firstOpen) { parent.first = union(parent.first, group.first); if (!group.firstOpen && !quantified?.optional) parent.firstOpen = false; }
      continue;
    } else if (char === '|') { level.branches.push(level.reach); level.reach = level.initial; level.alternation = true; level.firstOpen = true; index++; continue; }
    else if (char === '^' || char === '$') { index++; continue; }
    else if (char === '.') { atom = ANY; index++; }
    else { atom = {chars: new Set([char.toLowerCase()]), negated: false}; index++; }
    if (!consume(level, atom, quantifier())) return true;
  }
  return false;
}
function validateCommandRules(rules) {
  if (rules === undefined) return [];
  if (!Array.isArray(rules) || rules.length > 256) return ['commandRules must have at most 256 rules.'];
  const ids = new Set();
  for (const rule of rules) {
    if (!object(rule) || Object.keys(rule).some(key => !['id', 'pattern', 'match', 'action', 'allowOnce'].includes(key))) return ['Each command rule accepts id, pattern or match, action and optional allowOnce.'];
    if (rule.allowOnce !== undefined && (typeof rule.allowOnce !== 'boolean' || rule.action !== 'block')) return ['allowOnce is a boolean for block rules only.'];
    if (!identifier(rule.id) || ids.has(rule.id)) return ['Command rule IDs must be valid and unique.'];
    ids.add(rule.id);
    if (!['allow', 'block', 'ask'].includes(rule.action)) return ['Command rule action must be allow, block or ask.'];
    if ((rule.pattern !== undefined) === (rule.match !== undefined)) return ['Use exactly one command pattern or built-in match.'];
    if (rule.match !== undefined && !COMMAND_MATCHES.includes(rule.match)) return ['Unknown built-in command match.'];
    if (rule.pattern !== undefined) {
      if (typeof rule.pattern !== 'string' || !rule.pattern.length || rule.pattern.length > 512) return ['Command patterns must contain 1 to 512 characters.'];
      try { new RegExp(rule.pattern, 'i'); } catch { return ['Command pattern is not a valid regular expression.']; }
      let unsafe = true;
      try { unsafe = unsafePattern(rule.pattern); } catch { unsafe = true; }
      if (unsafe) return ['Command patterns must avoid backreferences, repeated alternations, and quantified atoms that can become adjacent over overlapping characters (a*a*, \\s+.*).'];
    }
  }
  return [];
}
const SESSION_FIELDS = ['matterId', 'agentId', 'allowedTools', 'deniedTools', 'ethicalWall', 'maxCapability', 'caps'];
const CAP_FIELDS = ['window', 'amountCents', 'action', 'selector', 'reason'];
const SELECTOR_FIELDS = ['tenantId', 'agentId', 'taskId', 'sessionId', 'provider', 'userId', 'teamId'];
const RULE_FIELDS = ['pattern', 'capability', 'requiredCapability', 'unitCostCents'];
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_./:@-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validateGuardPack(value) {
  if (value === undefined) return [];
  if (!object(value)) return ['policy.guardPack must be an object.'];
  const errors = [];
  if (Object.keys(value).some(key => !['rules', 'pageGuard'].includes(key))) errors.push('policy.guardPack accepts only rules and pageGuard.');
  if (value.pageGuard !== undefined && (!object(value.pageGuard) || Object.keys(value.pageGuard).some(key => key !== 'internalLinkThreshold')
    || value.pageGuard.internalLinkThreshold !== undefined && (!Number.isSafeInteger(value.pageGuard.internalLinkThreshold) || value.pageGuard.internalLinkThreshold < 1))) errors.push('pageGuard internalLinkThreshold must be a positive integer.');
  if (value.rules !== undefined) {
    if (!object(value.rules)) errors.push('policy.guardPack.rules must be an object of built-in rule IDs.');
    else for (const [id, mode] of Object.entries(value.rules)) {
      if (!GUARD_RULE_IDS.includes(id)) errors.push('policy.guardPack.rules contains an unknown built-in rule ID.');
      if (!['stop', 'warn', 'off', ...(id === 'GP020' ? ['ask'] : [])].includes(mode)) errors.push('Each guardPack rule must be stop, warn or off; GP020 also accepts ask.');
    }
  }
  return errors;
}
function mergeGuardPack(personal = {}, team, org) {
  for (const layer of [personal, team, org].filter(Boolean)) if (validateGuardPack(layer.guardPack).length) throw new Error('guard_policy_invalid');
  const authority = org ?? team;
  const rules = Object.fromEntries(GUARD_RULE_IDS.map(id => [id, authority?.guardPack?.rules?.[id] ?? guardDefault(id)]));
  // Personal files can tighten an admin choice but cannot authorize a downgrade.
  const rank = {off: 0, warn: 1, ask: 2, stop: 3};
  for (const lower of [personal, ...(org && team ? [team] : [])]) for (const [id, mode] of Object.entries(lower.guardPack?.rules ?? {})) if (rank[mode] > rank[rules[id]]) rules[id] = mode;
  const thresholds = [personal, team, org].filter(Boolean).map(layer => layer.guardPack?.pageGuard?.internalLinkThreshold).filter(value => value !== undefined);
  return {rules, ...(thresholds.length ? {pageGuard: {internalLinkThreshold: Math.min(...thresholds)}} : {})};
}
function validateOrgPolicy(policy) {
  const errors = [];
  function fields(value, permitted, at) {
    if (!object(value)) { errors.push(`${at} must be an object.`); return false; }
    for (const key of Object.keys(value)) if (FORBIDDEN.has(key) || !permitted.includes(key)) errors.push(`${at}.${key} is not an allowed organization policy field.`);
    return true;
  }
  function id(value, at) { if (!identifier(value)) errors.push(`${at} must be an identifier of 1 to 128 letters, digits, underscores, dots, slashes, colons, at signs or hyphens.`); }
  function regex(value, at) {
    if (typeof value !== 'string' || value.length > 512) { errors.push(`${at} must be a regular expression of at most 512 characters.`); return; }
    try { new RegExp(value, 'i'); } catch { errors.push(`${at} must be a valid JavaScript regular expression.`); }
  }
  function integer(value, at, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) errors.push(`${at} must be a safe integer of at least ${minimum}.`); }
  function enumeration(value, permitted, at) { if (!permitted.includes(value)) errors.push(`${at} must be one of ${permitted.join(', ')}.`); }
  function array(value, at, visit) {
    if (!Array.isArray(value) || value.length > 256) { errors.push(`${at} must be an array with at most 256 entries.`); return; }
    for (let i = 0; i < value.length; i++) visit(value[i], `${at}[${i}]`);
  }
  function cap(value, at) {
    if (!fields(value, CAP_FIELDS, at)) return;
    enumeration(value.window, ['per_call', 'per_session', 'per_minute', 'per_hour', 'per_day', 'per_month'], `${at}.window`);
    integer(value.amountCents, `${at}.amountCents`);
    if (value.action !== undefined) enumeration(value.action, ['block', 'shadow', 'allow'], `${at}.action`);
    if (value.reason !== undefined) id(value.reason, `${at}.reason`);
    if (value.selector !== undefined && fields(value.selector, SELECTOR_FIELDS, `${at}.selector`)) {
      for (const [key, val] of Object.entries(value.selector)) if (SELECTOR_FIELDS.includes(key)) id(val, `${at}.selector.${key}`);
    }
  }
  function constraints(value, at) {
    for (const key of ['allowedTools', 'deniedTools', 'ethicalWall']) if (value[key] !== undefined) array(value[key], `${at}.${key}`, regex);
    if (value.maxCapability !== undefined) enumeration(value.maxCapability, TIERS, `${at}.maxCapability`);
    if (value.caps !== undefined) array(value.caps, `${at}.caps`, cap);
  }
  if (!fields(policy, ROOT_FIELDS, 'policy')) return errors;
  if (policy.version !== 1) errors.push('policy.version must be the integer 1.');
  for (const key of ['tenantId', 'defaultMatterId']) if (policy[key] !== undefined) id(policy[key], `policy.${key}`);
  if (policy.mode !== undefined) enumeration(policy.mode, ['enforce', 'shadow'], 'policy.mode');
  // Below 250 ms every warm hook times out and fails open; refuse it here so a
  // personal file, a preset or a synced policy can never carry it.
  if (policy.hookBudgetMs !== undefined) integer(policy.hookBudgetMs, 'policy.hookBudgetMs', 250);
  if (policy.paymentPattern !== undefined) regex(policy.paymentPattern, 'policy.paymentPattern');
  errors.push(...validateGuardPack(policy.guardPack), ...validateCommandRules(policy.commandRules));
  if (policy.teamCaps !== undefined && fields(policy.teamCaps, TEAM_CAP_FIELDS, 'policy.teamCaps')) {
    for (const key of TEAM_CAP_FIELDS) if (policy.teamCaps[key] !== undefined) integer(policy.teamCaps[key], `policy.teamCaps.${key}`);
  }
  constraints(policy, 'policy');
  if (policy.toolRules !== undefined) array(policy.toolRules, 'policy.toolRules', (rule, at) => {
    if (!fields(rule, RULE_FIELDS, at)) return;
    regex(rule.pattern, `${at}.pattern`);
    for (const key of ['capability', 'requiredCapability']) if (rule[key] !== undefined) enumeration(rule[key], TIERS, `${at}.${key}`);
    if (rule.unitCostCents !== undefined) integer(rule.unitCostCents, `${at}.unitCostCents`);
  });
  if (policy.sessions !== undefined) {
    if (!object(policy.sessions) || Object.keys(policy.sessions).length > 256) errors.push('policy.sessions must be an object with at most 256 session identifiers.');
    else for (const [key, session] of Object.entries(policy.sessions)) {
      if (FORBIDDEN.has(key)) errors.push(`policy.sessions.${key} is not an allowed session identifier.`);
      id(key, `policy.sessions key ${key}`);
      if (!fields(session, SESSION_FIELDS, `policy.sessions.${key}`)) continue;
      for (const field of ['matterId', 'agentId']) if (session[field] !== undefined) id(session[field], `policy.sessions.${key}.${field}`);
      constraints(session, `policy.sessions.${key}`);
    }
  }
  return errors;
}
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hashPolicy = policy => createHash('sha256').update(canonicalize(policy)).digest('hex');
function validateEnvelope(value) {
  if (!object(value)) return ['The organization policy response must be an object.'];
  const errors = [];
  if (Object.keys(value).some(key => !['version', 'published_at', 'sha256', 'policy'].includes(key))) errors.push('The organization policy response contains an unknown field.');
  if (!Number.isSafeInteger(value.version) || value.version < 1) errors.push('The published policy version must be a positive safe integer.');
  if (typeof value.published_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.published_at) || !Number.isFinite(Date.parse(value.published_at))
    || new Date(value.published_at).toISOString().slice(0, 19) !== value.published_at.slice(0, 19)) errors.push('The published time must be an ISO date in UTC.');
  const policyErrors = validateOrgPolicy(value.policy);
  errors.push(...policyErrors);
  if (!/^[a-f0-9]{64}$/.test(value.sha256 ?? '') || (!policyErrors.length && value.sha256 !== hashPolicy(value.policy))) errors.push('The organization policy SHA256 does not match its canonical JSON.');
  return errors;
}
// The policy a worker receives: the published policy without server-held fields.
function distributedPolicy(policy) {
  if (!object(policy)) return policy;
  return Object.fromEntries(Object.entries(policy).filter(([key]) => !SERVER_HELD_FIELDS.includes(key)));
}
// The envelope a worker receives. Without server-held fields it is the published envelope unchanged.
function distributedEnvelope(envelope) {
  if (!envelope || !object(envelope.policy) || !SERVER_HELD_FIELDS.some(key => Object.hasOwn(envelope.policy, key))) return envelope;
  const policy = distributedPolicy(envelope.policy);
  return {version: envelope.version, published_at: envelope.published_at, sha256: hashPolicy(policy), policy};
}
// Identifies the cap definitions an allowance was granted against.
const teamCapsSha256 = policy => object(policy?.teamCaps) ? createHash('sha256').update(canonicalize(policy.teamCaps)).digest('hex') : null;
module.exports = {guardDefault, COMMAND_MATCHES, unsafePattern, validateCommandRules, validateOrgPolicy, validateGuardPack, mergeGuardPack, GUARD_RULE_IDS, canonicalize, hashPolicy, validateEnvelope, TIERS, ROOT_FIELDS, SESSION_FIELDS, CAP_FIELDS, SELECTOR_FIELDS, RULE_FIELDS,
  TEAM_CAP_FIELDS, SERVER_HELD_FIELDS, distributedPolicy, distributedEnvelope, teamCapsSha256};
