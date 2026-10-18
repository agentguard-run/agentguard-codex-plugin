'use strict';
// Optional Team counts transport. Importing this module never reads or uploads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCHEMA = 'agentguard.team-counts.v1';
const ENDPOINT = 'https://agentguard.run/api/team/counts';
const WASTE_ENDPOINT = 'https://agentguard.run/api/team/waste';
const WASTE_SCHEMA = 'agentguard.team-waste.v1';
const SHARE_SCHEMA = 'agentguard.team-waste-share.v1';
const FIELDS = ['launches', 'allowed', 'asked', 'saidYes', 'stopped', 'shadow', 'unrecorded', 'unresolvedAsked'];
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function settings(data) {
  try { return {enabled: JSON.parse(fs.readFileSync(path.join(data, 'team-counts.json'), 'utf8'))?.enabled === true}; } catch { return {enabled: false}; }
}
function setEnabled(data, enabled) {
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, 'team-counts.json'), tmp = file + '.' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify({enabled: enabled === true}) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, file);
  return {enabled: enabled === true};
}
function dailyPayload(tallies, date, seatId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date || !/^[a-f0-9]{64}$/.test(seatId)) throw new Error('Daily count identity is invalid.');
  // Never upload a partial aggregate. Missing sessions require receipt recovery.
  if (tallies.some(t => t.status !== 'verified')) throw new Error('Daily counts require complete verified session receipts.');
  const rows = tallies.filter(t => t.date === date);
  if (!rows.length) return null;
  const counts = Object.fromEntries(FIELDS.map(k => [k, 0]));
  let tokens = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.tokens) || row.tokens < 0) throw new Error('Signed token totals are missing.');
    tokens += row.tokens;
    for (const key of FIELDS) {
      if (!Number.isSafeInteger(row.counts?.[key]) || row.counts[key] < 0) throw new Error('Signed tally counts are missing.');
      counts[key] += row.counts[key];
    }
  }
  if (![tokens, ...Object.values(counts)].every(n => Number.isSafeInteger(n) && n <= 1e12)) throw new Error('Daily counts exceed the supported range.');
  if (counts.launches !== counts.allowed + counts.asked + counts.stopped + counts.shadow + counts.unrecorded || counts.asked !== counts.saidYes + counts.unresolvedAsked) throw new Error('Daily counts do not reconcile.');
  return {schema: SCHEMA, date, seatId, counts, tokens};
}
function signPayload(payload, seed) {
  if (!/^[a-f0-9]{64}$/i.test(seed)) throw new Error('Receipt signing key is unavailable.');
  const key = crypto.createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]), type: 'pkcs8', format: 'der'});
  const publicKey = crypto.createPublicKey(key).export({type: 'spki', format: 'der'}).subarray(-32).toString('hex');
  return {payload, publicKey, signature: crypto.sign(null, Buffer.from(canonical(payload)), key).toString('hex')};
}
async function syncDailyCounts({data, home, sessionId, policy, date, now = Date.now(), transport = fetch, burn, licenseReader, featureEnabled = process.env.AGENTGUARD_TEAM_COUNTS === '1'} = {}) {
  data ||= require('./common.cjs').locations().data;
  if (!featureEnabled || settings(data).enabled !== true) return {status: 'off'};
  policy ||= require('./policy-file.cjs').readPolicy(data).personal;
  const license = require('./license.cjs');
  const key = license.configuredKey(policy);
  const status = (licenseReader || license.readSessionLicense)({data, sessionId, policy, now});
  if (!key || !status?.paid || !['startup', 'startup_pro', 'growth', 'growth_pro'].includes(status.tier)
      || status.offlineGrace || status.seatRevoked || status.reason || status.seatStatus !== 'registered'
      || (status.expiresAt && !(Date.parse(status.expiresAt) > now))) return {status: 'license_required'};
  const fingerprint = status.seatIdentity?.machineFingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) return {status: 'seat_required'};
  date ||= new Date(now - 86400000).toISOString().slice(0, 10);
  if (date >= new Date(now).toISOString().slice(0, 10)) throw new Error('Only completed UTC days can sync.');
  burn ||= require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
  if (typeof burn.readLedgerTallies !== 'function') return {status: 'burn_update_required'};
  home ||= process.env.AGENTGUARD_HOME || path.join(require('node:os').homedir(), '.agentguard');
  const seatId = digest(key + '\0' + fingerprint), directory = path.join(home, 'team-counts', seatId);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const lock = path.join(directory, 'sync.lock');
  try { fs.writeFileSync(lock, String(process.pid), {flag: 'wx', mode: 0o600}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) return {status: 'busy'};
    try { process.kill(pid, 0); return {status: 'busy'}; }
    catch (e) { if (e.code !== 'ESRCH') return {status: 'busy'}; }
    try { fs.unlinkSync(lock); } catch {}
    return {status: 'retry'};
  }
  try {
    const directories = [...new Set([data, ...(burn.pluginLedgerDirectories?.(home) ?? [])].map(d => path.resolve(d)))].sort();
    const rows = [];
    for (const candidate of directories) {
      if (!settings(candidate).enabled) continue;
      const sourcePolicy = path.resolve(candidate) === path.resolve(data) ? policy : require('./policy-file.cjs').readPolicy(candidate).personal;
      if (license.configuredKey(sourcePolicy) !== key) continue;
      rows.push(...await (burn.readLedgerDailyTallies ?? burn.readLedgerTallies)(candidate));
    }
    const unique = new Map();
    for (const row of rows) {
      const id = row.host + ':' + row.session + ':' + row.date;
      if (unique.has(id) && canonical(unique.get(id)) !== canonical(row)) return {status: 'overlapping_sessions'};
      unique.set(id, row);
    }
    const payload = dailyPayload([...unique.values()], date, seatId);
    if (!payload) return {status: 'no_receipts'};
    // Pin one existing receipt signer for this machine and license. Other
    // installations verify their own chains but never replace this signer.
    const ownerFile = path.join(directory, 'owner.json');
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      owner = {data: path.resolve(data), publicKey: fs.readFileSync(path.join(data, 'public-key.hex'), 'utf8').trim()};
      fs.writeFileSync(ownerFile, JSON.stringify(owner) + '\n', {flag: 'wx', mode: 0o600});
    }
    const seed = fs.readFileSync(path.join(owner.data, 'signing-key.hex'), 'utf8').trim();
    const envelope = signPayload(payload, seed);
    if (envelope.publicKey !== owner.publicKey) throw new Error('Machine counts signer changed.');
    const sentFile = path.join(directory, date + '.json'), payloadDigest = digest(canonical(payload));
    if (fs.existsSync(sentFile)) {
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      return {status: sent.payloadDigest === payloadDigest ? 'already_synced' : 'changed_after_sync', date};
    }
    // Only this allowlisted aggregate leaves. No ledger rows or paths leave.
    const response = await transport(ENDPOINT, {method: 'POST', headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: JSON.stringify(envelope), signal: AbortSignal.timeout(5000), redirect: 'error'});
    if (!response.ok) return {status: 'upload_failed', httpStatus: response.status};
    fs.writeFileSync(sentFile, JSON.stringify({payloadDigest, publicKey: envelope.publicKey}) + '\n', {mode: 0o600});
    return {status: 'synced', date};
  } finally { try { fs.unlinkSync(lock); } catch {} }
}
const SHARE_MODES = ['off', 'totals', 'seat'];
const utcStamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function wasteSettings(data) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(data, 'team-waste.json'), 'utf8'));
    if (Object.keys(value).length === 2 && SHARE_MODES.includes(value.mode) && utcStamp(value.setAt)) return {mode: value.mode, setAt: value.setAt};
  } catch { /* Missing or invalid local consent means off. */ }
  return {mode: 'off', setAt: null};
}
function writeWasteFile(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function setWaste(data, mode, now = Date.now()) {
  if (!SHARE_MODES.includes(mode)) throw new Error('Use waste off, totals or seat.');
  const previous = wasteSettings(data);
  // The initial explicit choice establishes a timestamp; repeated choices keep it.
  const value = {mode, setAt: previous.mode === mode && previous.setAt !== null ? previous.setAt
    : new Date(Math.max(now, previous.setAt === null ? 0 : Date.parse(previous.setAt) + 1)).toISOString()};
  writeWasteFile(path.join(data, 'team-waste.json'), value);
  return value;
}
function weeklyPayload(file, seatId, now = Date.now()) {
  const {WEEK_SCHEMA, isMonday, weekFigures} = require('./week-figures.cjs');
  const value = typeof file === 'string' ? JSON.parse(fs.readFileSync(file, 'utf8')) : file;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
      || !['schema', 'weekStart', 'viewedAt', 'figures'].every(k => Object.hasOwn(value, k))
      || value.schema !== WEEK_SCHEMA || !isMonday(value.weekStart) || !utcStamp(value.viewedAt)
      || !/^[a-f0-9]{64}$/.test(seatId || '')) throw new Error('Invalid saved Burn week.');
  const end = Date.parse(value.weekStart) + 7 * 86400000;
  if (end > now || Date.parse(value.viewedAt) < end || Date.parse(value.viewedAt) > now) throw new Error('Only viewed, completed UTC weeks can sync.');
  const figures = weekFigures(value.figures);
  return {schema: WASTE_SCHEMA, weekStart: value.weekStart, seatId, ...figures};
}
function readWasteFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function wasteHome(home) { return home || process.env.AGENTGUARD_HOME || path.join(require('node:os').homedir(), '.agentguard'); }
async function withWasteLock(directory, work) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const lock = path.join(directory, 'sync.lock');
  try { fs.writeFileSync(lock, String(process.pid), {flag: 'wx', mode: 0o600}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) return {status: 'busy'};
    try { process.kill(pid, 0); return {status: 'busy'}; }
    catch (e) { if (e.code !== 'ESRCH') return {status: 'busy'}; }
    try { fs.unlinkSync(lock); } catch {}
    return {status: 'retry'};
  }
  try { return await work(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}
function wasteEnvelope(directory, data, payload) {
  const file = path.join(directory, 'owner.json');
  let owner = readWasteFile(file);
  if (owner === null) {
    owner = {data: path.resolve(data), publicKey: fs.readFileSync(path.join(data, 'public-key.hex'), 'utf8').trim()};
    fs.writeFileSync(file, JSON.stringify(owner) + '\n', {flag: 'wx', mode: 0o600});
  }
  const envelope = signPayload(payload, fs.readFileSync(path.join(owner.data, 'signing-key.hex'), 'utf8').trim());
  if (envelope.publicKey !== owner.publicKey) throw new Error('Machine counts signer changed.');
  return envelope;
}
async function postWaste(envelope, key, transport) {
  // These are the only two allowlisted payload constructors. No local context is added.
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body) > 4096) throw new Error('Weekly request exceeds the supported size.');
  const response = await transport(WASTE_ENDPOINT, {method: 'POST', headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
    body, signal: AbortSignal.timeout(5000), redirect: 'error'});
  return response.ok && response.status >= 200 && response.status < 300 ? null : {status: 'upload_failed', httpStatus: response.status};
}
async function sendWasteShare({directory, data, seatId, selection, key, transport}) {
  const payload = {schema: SHARE_SCHEMA, seatId, share: selection.mode, setAt: selection.setAt};
  if (!SHARE_MODES.includes(payload.share) || !utcStamp(payload.setAt) || !/^[a-f0-9]{64}$/.test(seatId)) throw new Error('Invalid weekly share choice.');
  const failed = await postWaste(wasteEnvelope(directory, data, payload), key, transport);
  if (failed) return failed;
  writeWasteFile(path.join(directory, 'waste-share.json'), {share: selection.mode, setAt: selection.setAt});
  return null;
}
/** A removal needs the configured bearer and pinned signer, never current paid status. */
async function syncWasteOff({data, home, policy, now = Date.now(), transport = fetch}) {
  const selection = wasteSettings(data);
  if (selection.mode !== 'off') return {status: 'share_changed'};
  let seats;
  try { seats = fs.readdirSync(path.join(wasteHome(home), 'team-counts'), {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return {status: 'off'}; throw error; }
  let result = {status: 'off'};
  for (const seat of seats) {
    if (!seat.isDirectory() || !/^[a-f0-9]{64}$/.test(seat.name)) continue;
    const directory = path.join(wasteHome(home), 'team-counts', seat.name), ack = readWasteFile(path.join(directory, 'waste-share.json'));
    if (!['totals', 'seat'].includes(ack?.share)) continue;
    if (selection.setAt && utcStamp(ack.setAt) && ack.setAt > selection.setAt) continue;
    policy ||= require('./policy-file.cjs').readPolicy(data).personal;
    const key = require('./license.cjs').configuredKey(policy);
    if (!key) return {status: 'license_required'};
    try {
      const sent = await withWasteLock(directory, async () => {
        if (wasteSettings(data).mode !== 'off') return {status: 'share_changed'};
        const current = readWasteFile(path.join(directory, 'waste-share.json'));
        if (!['totals', 'seat'].includes(current?.share)) return {status: 'off'};
        if (selection.setAt && utcStamp(current.setAt) && current.setAt > selection.setAt) return {status: 'share_changed'};
        return await sendWasteShare({directory, data, seatId: seat.name,
          selection: {mode: 'off', setAt: selection.setAt ?? new Date(now).toISOString()}, key, transport}) || {status: 'off'};
      });
      if (sent.status !== 'off') result = sent;
    } catch { result = {status: 'upload_failed'}; }
  }
  return result;
}
async function syncWeeklyWaste({data, home, sessionId, policy, now = Date.now(), transport = fetch, licenseReader,
  featureEnabled = process.env.AGENTGUARD_TEAM_WASTE === '1'} = {}) {
  if (!featureEnabled) return {status: 'off'};
  data ||= require('./common.cjs').locations().data;
  const selection = wasteSettings(data);
  if (selection.mode === 'off') {
    // Without an explicit setting, importing or running the worker does no other file work.
    if (selection.setAt === null) return {status: 'off'};
    return syncWasteOff({data, home, policy, now, transport});
  }
  policy ||= require('./policy-file.cjs').readPolicy(data).personal;
  const license = require('./license.cjs'), key = license.configuredKey(policy);
  const status = (licenseReader || license.readSessionLicense)({data, sessionId, policy, now});
  if (!key || !status?.paid || !['startup', 'startup_pro', 'growth', 'growth_pro'].includes(status.tier)
      || status.offlineGrace || status.seatRevoked || status.reason || status.seatStatus !== 'registered'
      || (status.expiresAt && !(Date.parse(status.expiresAt) > now))) return {status: 'license_required'};
  const fingerprint = status.seatIdentity?.machineFingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) return {status: 'seat_required'};
  home = wasteHome(home);
  const seatId = digest(key + '\0' + fingerprint), directory = path.join(home, 'team-counts', seatId);
  return withWasteLock(directory, async () => {
    const unchanged = () => canonical(wasteSettings(data)) === canonical(selection);
    if (!unchanged()) return {status: 'share_changed'};
    let files;
    try { files = fs.readdirSync(path.join(home, 'week'), {withFileTypes: true}); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    let candidate = null, lastSent = null;
    // Preflight before even a share request. Corrupt or changed figures never cause a request.
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
      const weekStart = entry.name.slice(0, 10);
      if (Date.parse(weekStart) < now - 91 * 86400000) continue;
      const payload = weeklyPayload(path.join(home, 'week', entry.name), seatId, now);
      if (payload.weekStart !== weekStart) throw new Error('Saved week date does not match its file.');
      const payloadDigest = digest(canonical(payload)), sentFile = path.join(directory, `waste-${weekStart}.json`);
      const sent = readWasteFile(sentFile);
      if (sent) {
        if (sent.payloadDigest !== payloadDigest) return {status: 'changed_after_sync', weekStart};
        lastSent = weekStart;
      } else if (!candidate) candidate = {payload, payloadDigest, sentFile};
    }
    if (!candidate && !lastSent) return {status: 'not_viewed'};
    const ack = readWasteFile(path.join(directory, 'waste-share.json'));
    // A stale installation cannot undo a newer local choice made through another host.
    if (utcStamp(ack?.setAt) && (ack.setAt > selection.setAt || (ack.setAt === selection.setAt && ack.share === 'off'))) return {status: 'share_changed'};
    if (ack?.share !== selection.mode || ack?.setAt !== selection.setAt) {
      if (!unchanged()) return {status: 'share_changed'};
      const failed = await sendWasteShare({directory, data, seatId, selection, key, transport});
      if (failed) return failed;
    }
    if (!unchanged()) return {status: 'share_changed'};
    if (!candidate) return {status: 'already_synced', weekStart: lastSent};
    const {payload, payloadDigest, sentFile} = candidate;
    const envelope = wasteEnvelope(directory, data, payload);
    const failed = await postWaste(envelope, key, transport);
    if (failed) return failed;
    writeWasteFile(sentFile, {payloadDigest, publicKey: envelope.publicKey});
    return {status: 'synced', weekStart: payload.weekStart};
  });
}

async function viewWeek({weekStart, home, now = Date.now(), burn, write = text => new Promise((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve()))} = {}) {
  burn ||= require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
  if (typeof burn.collectWeek !== 'function') return {status: 'burn_update_required', command: 'npx agentguard-burn@latest week'};
  if (weekStart !== undefined && !require('./week-figures.cjs').isMonday(weekStart)) throw new Error('Use week with a Monday date: YYYY-MM-DD.');
  home = wasteHome(home);
  const report = burn.collectWeek({weekStart, now, home});
  const language = String(process.env.AGENTGUARD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale).split(/[_.@-]/)[0].toLowerCase();
  await write(burn.renderWeek(report, ['es', 'pt'].includes(language) ? language : 'en') + '\n');
  const saved = burn.saveWeek(home, report, now);
  if (saved.reason === 'write_failed') throw new Error('Burn could not save this week for sharing.');
}

// Used only by the detached worker. The hook reply is already published and
// all receipt writes must be durable before a sync can inspect their chains.
class DailyCountsScheduler {
  constructor({data, home, flush = async () => {}, sync = syncDailyCounts, weekly = syncWeeklyWaste, now = Date.now} = {}) {
    Object.assign(this, {data, home, flush, sync, weekly, now}); this.due = 0; this.running = false;
  }
  completed(sessionId) { this.sessionId = sessionId; this.due = 0; }
  async tick() {
    if (!this.sessionId || this.running || this.now() < this.due) return;
    this.running = true; this.due = this.now() + 60000;
    try {
      const options = {data: this.data, home: this.home, sessionId: this.sessionId, now: this.now()};
      let daily;
      try { await this.flush(); daily = await this.sync(options); }
      catch { daily = {status: 'unavailable'}; }
      try { await this.weekly(options); } catch { /* Weekly failure never replaces the daily result. */ }
      return daily;
    }
    finally { this.running = false; }
  }
}
module.exports = {SCHEMA, FIELDS, canonical, settings, setEnabled, dailyPayload, signPayload, syncDailyCounts, DailyCountsScheduler,
  WASTE_ENDPOINT, WASTE_SCHEMA, SHARE_SCHEMA, wasteSettings, setWaste, weeklyPayload, syncWeeklyWaste, syncWasteOff, viewWeek};
if (require.main === module) {
  const [command, sessionId, date] = process.argv.slice(2), data = require('./common.cjs').locations().data;
  const run = async () => {
    if (command === 'week') {
      if (date) throw new Error('Use week with at most one Monday date.');
      return viewWeek({weekStart: sessionId});
    }
    if (command === 'waste') {
      if (date) throw new Error('Use waste status, off, totals or seat.');
      if (sessionId === 'status') return wasteSettings(data);
      const choice = setWaste(data, sessionId);
      if (choice.mode !== 'off') return {...choice, message: 'The next upload applies this weekly sharing choice.'};
      const result = await syncWasteOff({data});
      return {...choice, ...result, message: result.status === 'off' ? 'Weekly sharing is off.' : 'Weekly sharing is off locally. The removal request failed or is pending; the worker will retry.'};
    }
    if (command === 'on' || command === 'off') return setEnabled(data, command === 'on');
    if (command === 'status') return settings(data);
    if (command === 'sync' && sessionId) return syncDailyCounts({data, sessionId, date});
    throw new Error('Use counts-sync.cjs on, off, status, or sync SESSION DATE.');
  };
  run().then(r => { if (r !== undefined) process.stdout.write(JSON.stringify(r) + '\n'); }).catch(() => {
    process.stderr.write(command === 'waste' || command === 'week' ? 'AgentGuard weekly sharing unavailable. Use waste status, off, totals or seat, or week with a Monday date.\n'
      : 'AgentGuard daily counts unavailable. Check local receipts and Team access.\n'); process.exitCode = 1;
  });
}
