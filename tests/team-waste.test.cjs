'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('./helper-test-env.cjs');
const sync = require('../runtime/counts-sync.cjs');
const contract = require('../runtime/week-figures.cjs');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/burn-week-v1.json'), 'utf8'));
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const KEY = 'ag_synthetic_team', FINGERPRINT = '1'.repeat(64);
const SEAT = crypto.createHash('sha256').update(KEY + '\0' + FINGERPRINT).digest('hex');
const STATUS = {paid: true, tier: 'startup', seatStatus: 'registered', expiresAt: '2026-11-01T00:00:00Z', seatIdentity: {machineFingerprint: FINGERPRINT}};
function box(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-waste-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const data = path.join(dir, 'data'), home = path.join(dir, 'home'); fs.mkdirSync(data);
  const seed = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(data, 'signing-key.hex'), seed);
  fs.writeFileSync(path.join(data, 'public-key.hex'), sync.signPayload({}, seed).publicKey);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({licenseKey: KEY}));
  const calls = [];
  const args = {data, home, now: NOW, sessionId: 'SENTINEL_SESSION', policy: {licenseKey: KEY, project: 'SENTINEL_PROJECT', teamWaste: 'seat'},
    featureEnabled: true, licenseReader: () => STATUS,
    transport: async (url, options) => { calls.push({url, options, envelope: JSON.parse(options.body)}); return {ok: true, status: 200}; }};
  return {dir, data, home, seed, calls, args, seat: path.join(home, 'team-counts', SEAT)};
}
function week(b, value = structuredClone(FIXTURE), filename = value.weekStart + '.json') {
  const directory = path.join(b.home, 'week'); fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, filename); fs.writeFileSync(file, JSON.stringify(value)); return file;
}
function ready(t, mode = 'totals') { const b = box(t); sync.setWaste(b.data, mode, NOW); week(b); return b; }
const unexpected = () => assert.fail('Disabled sharing performed work');
function verifyEnvelope(envelope, seed) {
  assert.deepEqual(Object.keys(envelope).sort(), ['payload', 'publicKey', 'signature']);
  assert.deepEqual(envelope, sync.signPayload(envelope.payload, seed));
  const key = crypto.createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(envelope.publicKey, 'hex')]), type: 'spki', format: 'der'});
  assert.equal(crypto.verify(null, Buffer.from(sync.canonical(envelope.payload)), key, Buffer.from(envelope.signature, 'hex')), true);
}

test('flag off does no file, license or network work; weekly sharing defaults off independently of policy and daily settings', async t => {
  const b = box(t); sync.setEnabled(b.data, true);
  assert.deepEqual(sync.wasteSettings(b.data), {mode: 'off', setAt: null});
  assert.deepEqual(await sync.syncWeeklyWaste({...b.args, licenseReader: unexpected, transport: unexpected}), {status: 'off'});
  sync.setWaste(b.data, 'seat', NOW);
  const read = t.mock.method(fs, 'readFileSync', unexpected);
  assert.deepEqual(await sync.syncWeeklyWaste({featureEnabled: false, licenseReader: unexpected, transport: unexpected}), {status: 'off'});
  read.mock.restore();
  assert.deepEqual(sync.settings(b.data), {enabled: true});
});

test('consent is private local state; same-mode calls retain setAt and mode changes advance it', t => {
  const b = box(t), first = sync.setWaste(b.data, 'totals', NOW);
  assert.deepEqual(sync.setWaste(b.data, 'totals', NOW + 60000), first);
  const second = sync.setWaste(b.data, 'seat', NOW + 1000);
  assert.equal(second.setAt, '2026-10-05T12:00:01.000Z');
  assert.equal(fs.statSync(path.join(b.data, 'team-waste.json')).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(b.data, 'team-waste.json'), 'utf8'))).sort(), ['mode', 'setAt']);
  assert.throws(() => sync.setWaste(b.data, 'organization'));
  assert.deepEqual(sync.settings(b.data), {enabled: false});
});

test('each daily-equivalent license failure prevents weekly network calls; seat identity is required', async t => {
  const b = ready(t);
  for (const patch of [{paid: false}, {tier: 'free'}, {tier: 'solo'}, {tier: 'solo_pro'}, {offlineGrace: true}, {seatRevoked: true},
    {reason: 'license_unavailable'}, {expiresAt: '2026-10-05T12:00:00Z'}, {expiresAt: 'invalid'}, {seatStatus: 'unknown'}, {seatStatus: 'denied'}]) {
    assert.equal((await sync.syncWeeklyWaste({...b.args, licenseReader: () => ({...STATUS, ...patch})})).status, 'license_required', JSON.stringify(patch));
  }
  assert.equal((await sync.syncWeeklyWaste({...b.args, licenseReader: () => null})).status, 'license_required');
  assert.equal((await sync.syncWeeklyWaste({...b.args, policy: {}})).status, 'license_required');
  for (const seatIdentity of [null, {}, {machineFingerprint: 'not-hex'}]) assert.equal((await sync.syncWeeklyWaste({...b.args, licenseReader: () => ({...STATUS, seatIdentity})})).status, 'seat_required');
  assert.equal(b.calls.length, 0);
});

test('without a viewed week no figures or share request is sent', async t => {
  const b = box(t); sync.setWaste(b.data, 'seat', NOW);
  assert.deepEqual(await sync.syncWeeklyWaste(b.args), {status: 'not_viewed'}); assert.equal(b.calls.length, 0);
});

test('a viewed week sends the exact share and figures contracts, signed by the pinned receipt key', async t => {
  const b = ready(t, 'seat');
  const deadlines = [], timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => {deadlines.push(ms); return timeout(ms);});
  assert.deepEqual(await sync.syncWeeklyWaste(b.args), {status: 'synced', weekStart: FIXTURE.weekStart});
  assert.equal(b.calls.length, 2); assert.deepEqual(deadlines, [5000, 5000]);
  const [share, weekly] = b.calls.map(c => c.envelope.payload);
  assert.deepEqual(share, {schema: sync.SHARE_SCHEMA, seatId: SEAT, share: 'seat', setAt: '2026-10-05T12:00:00.000Z'});
  assert.deepEqual(weekly, {schema: sync.WASTE_SCHEMA, weekStart: FIXTURE.weekStart, seatId: SEAT, ...FIXTURE.figures});
  assert.deepEqual(Object.keys(weekly).sort(), ['schema', 'weekStart', 'seatId', ...Object.keys(FIXTURE.figures)].sort());
  for (const {url, options, envelope} of b.calls) {
    assert.equal(url, 'https://agentguard.run/api/team/waste'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + KEY); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal); assert.ok(Buffer.byteLength(options.body) <= 4096);
    assert.doesNotMatch(options.body, /SENTINEL|\/Users\/|sessionId|modelId|prompt|completion|file_path|project|viewedAt/);
    verifyEnvelope(envelope, b.seed);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.seat, 'waste-share.json'), 'utf8')), {share: 'seat', setAt: '2026-10-05T12:00:00.000Z'});
  const sent = JSON.parse(fs.readFileSync(path.join(b.seat, `waste-${FIXTURE.weekStart}.json`), 'utf8'));
  assert.deepEqual(Object.keys(sent).sort(), ['payloadDigest', 'publicKey']);
  assert.equal(fs.statSync(path.join(b.seat, 'waste-share.json')).mode & 0o777, 0o600);
});

test('extra fields, broken identities, wrong cause, non-Monday and incomplete weeks are rejected before any request', async t => {
  const b = ready(t);
  const mutations = [v => {v.extra = 'SENTINEL';}, v => {v.figures.tokens.total++;}, v => {v.figures.topCause = 'wrong_model';},
    v => {v.weekStart = '2026-09-29';}, v => {v.weekStart = '2026-10-05';}, v => {v.viewedAt = '2026-09-30T10:00:00.000Z';},
    v => {v.viewedAt = '2026-10-06T00:00:00.000Z';}, v => {v.viewedAt = '2026-10-05T09:12:00Z';},
    v => {v.figures.causes.reloads.file = 'SENTINEL';}, v => {v.figures.wrongModel.smallerUsdMicros = 9999999;},
    v => {v.figures.usdMicros.useful = null;}, v => {v.figures.subagentTokens = 1e13 + 1;}, v => {v.schema = 'other';}];
  for (const mutate of mutations) {
    const value = structuredClone(FIXTURE); mutate(value); week(b, value, FIXTURE.weekStart + '.json');
    await assert.rejects(sync.syncWeeklyWaste(b.args));
  }
  assert.equal(b.calls.length, 0);
});

test('weekly acknowledgements are immutable: already_synced then changed_after_sync without a request', async t => {
  const b = ready(t); await sync.syncWeeklyWaste(b.args); b.calls.length = 0;
  assert.equal((await sync.syncWeeklyWaste(b.args)).status, 'already_synced');
  const value = structuredClone(FIXTURE); value.figures.tokens.useful++; value.figures.tokens.total++; week(b, value);
  sync.setWaste(b.data, 'seat', NOW + 1000);
  assert.equal((await sync.syncWeeklyWaste(b.args)).status, 'changed_after_sync');
  assert.equal(b.calls.length, 0);
});

test('one oldest unsent week per call; weeks over 91 days old are never read or uploaded', async t => {
  const b = ready(t);
  const older = {...structuredClone(FIXTURE), weekStart: '2026-09-21'}; week(b, older);
  week(b, {weekStart: '2026-06-30', secret: 'SENTINEL'});
  assert.equal((await sync.syncWeeklyWaste(b.args)).weekStart, '2026-09-21');
  assert.equal((await sync.syncWeeklyWaste(b.args)).weekStart, FIXTURE.weekStart);
  assert.deepEqual(b.calls.filter(c => c.envelope.payload.schema === sync.WASTE_SCHEMA).map(c => c.envelope.payload.weekStart), ['2026-09-21', FIXTURE.weekStart]);
});

test('off immediately removes every acknowledged seat, requires no paid status, and retries a failed removal', async t => {
  const b = ready(t, 'seat'); await sync.syncWeeklyWaste(b.args); b.calls.length = 0;
  const other = path.join(b.home, 'team-counts', '2'.repeat(64)); fs.mkdirSync(other);
  for (const name of ['owner.json', 'waste-share.json']) fs.copyFileSync(path.join(b.seat, name), path.join(other, name));
  sync.setWaste(b.data, 'off', NOW + 1000);
  let fail = true;
  const transport = async (url, options) => {b.calls.push({url, options, envelope: JSON.parse(options.body)}); return {ok: !fail, status: fail ? 503 : 200};};
  assert.equal((await sync.syncWasteOff({...b.args, transport, licenseReader: unexpected})).status, 'upload_failed');
  assert.equal(b.calls.length, 2);
  fail = false;
  assert.equal((await sync.syncWeeklyWaste({...b.args, transport, licenseReader: unexpected})).status, 'off');
  assert.equal(b.calls.length, 4);
  for (const call of b.calls) {assert.equal(call.envelope.payload.schema, sync.SHARE_SCHEMA); assert.equal(call.envelope.payload.share, 'off'); verifyEnvelope(call.envelope, b.seed);}
  await sync.syncWeeklyWaste({...b.args, transport: unexpected, licenseReader: unexpected});
});

test('waste off CLI performs the signed removal before returning; totals and seat only change local consent', async t => {
  const b = ready(t); await sync.syncWeeklyWaste(b.args);
  const requests = path.join(b.dir, 'requests.jsonl'), preload = path.join(b.dir, 'transport.cjs');
  fs.writeFileSync(preload, `global.fetch = async (url, options) => { require('node:fs').appendFileSync(${JSON.stringify(requests)}, JSON.stringify({url, options}) + '\\n'); return {ok:true, status:200}; };`);
  const env = {...process.env, PLUGIN_DATA: b.data, AGENTGUARD_HOME: b.home, AGENTGUARD_LICENSE_KEY: KEY, CLAUDE_PLUGIN_OPTION_LICENSE_KEY: '', AGENTGUARD_TEAM_WASTE: '0'};
  const run = mode => spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '../runtime/counts-sync.cjs'), 'waste', mode], {env, encoding: 'utf8'});
  const off = run('off'); assert.equal(off.status, 0, off.stderr); assert.equal(JSON.parse(off.stdout).mode, 'off');
  const calls = fs.readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); const envelope = JSON.parse(calls[0].options.body); assert.equal(envelope.payload.share, 'off'); verifyEnvelope(envelope, b.seed);
  for (const mode of ['totals', 'seat']) {const result = run(mode); assert.equal(result.status, 0); assert.match(JSON.parse(result.stdout).message, /next upload/);}
  assert.equal(fs.readFileSync(requests, 'utf8').trim().split('\n').length, 1);
});

test('two host data directories share one lock and pinned signer for weekly and daily uploads', async t => {
  const one = ready(t), two = ready(t);
  // Equal local consent timestamps make this the same machine choice for both workers.
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;}), blocked = new Promise(resolve => {release = resolve;});
  const first = sync.syncWeeklyWaste({...one.args, transport: async (url, options) => {
    one.calls.push({url, options, envelope: JSON.parse(options.body)}); entered(); await blocked; return {ok: true, status: 200};
  }});
  await started;
  assert.deepEqual(await sync.syncWeeklyWaste({...two.args, home: one.home}), {status: 'busy'});
  sync.setEnabled(two.data, true);
  assert.deepEqual(await sync.syncDailyCounts({...two.args, home: one.home, burn: {readLedgerTallies: unexpected}}), {status: 'busy'});
  release(); assert.equal((await first).status, 'synced');
  assert.equal((await sync.syncWeeklyWaste({...two.args, home: one.home})).status, 'already_synced');
  assert.equal(two.calls.length, 0); assert.equal(one.calls.length, 2);
  for (const call of one.calls) verifyEnvelope(call.envelope, one.seed);
  // A fresh weekly row continues using the first installation's signer.
  week(one, {...structuredClone(FIXTURE), weekStart: '2026-09-21'});
  assert.equal((await sync.syncWeeklyWaste({...two.args, home: one.home})).status, 'synced');
  verifyEnvelope(two.calls[0].envelope, one.seed);
});

test('a share change during the share request prevents any weekly figures from being sent', async t => {
  const b = ready(t);
  const result = await sync.syncWeeklyWaste({...b.args, transport: async (url, options) => {
    b.calls.push(JSON.parse(options.body)); sync.setWaste(b.data, 'off', NOW + 1000); return {ok: true, status: 200};
  }});
  assert.equal(result.status, 'share_changed'); assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].payload.schema, sync.SHARE_SCHEMA);
  assert.equal((await sync.syncWeeklyWaste({...b.args, licenseReader: unexpected})).status, 'off');
  assert.equal(b.calls[1].envelope.payload.share, 'off');
});

test('failed shares prevent a weekly upload; a changed pinned key cannot sign any request', async t => {
  const b = ready(t);
  assert.equal((await sync.syncWeeklyWaste({...b.args, transport: async () => ({ok: false, status: 503})})).status, 'upload_failed');
  assert.equal(fs.existsSync(path.join(b.seat, 'waste-share.json')), false);
  fs.writeFileSync(path.join(b.data, 'signing-key.hex'), crypto.randomBytes(32).toString('hex'));
  await assert.rejects(sync.syncWeeklyWaste(b.args), /signer changed/); assert.equal(b.calls.length, 0);
});

test('a stale host cannot turn sharing back on after a newer off acknowledgement', async t => {
  const one = ready(t), two = ready(t);
  await sync.syncWeeklyWaste(one.args);
  sync.setWaste(one.data, 'off', NOW + 1000);
  await sync.syncWasteOff(one.args);
  assert.equal((await sync.syncWeeklyWaste({...two.args, home: one.home, transport: unexpected})).status, 'share_changed');
});

test('weekly runs after daily, each failure is isolated, and tick keeps its daily return value', async () => {
  for (const failing of ['none', 'daily', 'weekly', 'flush']) {
    const order = [], result = {status: 'daily-result'};
    const worker = new sync.DailyCountsScheduler({now: () => NOW,
      flush: async () => {order.push('flush'); if (failing === 'flush') throw new Error('fixture');},
      sync: async () => {order.push('daily'); if (failing === 'daily') throw new Error('fixture'); return result;},
      weekly: async () => {order.push('weekly'); if (failing === 'weekly') throw new Error('fixture');}});
    worker.completed('local');
    assert.deepEqual(await worker.tick(), failing === 'daily' || failing === 'flush' ? {status: 'unavailable'} : result);
    assert.deepEqual(order, failing === 'flush' ? ['flush', 'weekly'] : ['flush', 'daily', 'weekly']);
  }
});

test('week command reports an older Burn, and a capable Burn saves only after its report was printed', async t => {
  assert.deepEqual(await sync.viewWeek({burn: {}}), {status: 'burn_update_required', command: 'npx agentguard-burn@latest week'});
  const b = box(t), order = [], report = {figures: FIXTURE.figures};
  await sync.viewWeek({home: b.home, now: NOW, weekStart: FIXTURE.weekStart,
    burn: {collectWeek: options => {assert.equal(options.home, b.home); return report;}, renderWeek: value => {assert.equal(value, report); return 'week shown';},
      saveWeek: (_home, value) => {assert.equal(value, report); order.push('save'); return {saved: true};}},
    write: async text => {assert.equal(text, 'week shown\n'); order.push('print');}});
  assert.deepEqual(order, ['print', 'save']);
  // The real command loads the installed dependency through dependencies.cjs.
  const installed = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/burn');
  if (typeof installed.collectWeek !== 'function') {
    const out = spawnSync(process.execPath, [path.join(__dirname, '../runtime/counts-sync.cjs'), 'week'], {env: {...process.env, PLUGIN_DATA: b.data, AGENTGUARD_HOME: b.home}, encoding: 'utf8'});
    assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(out.stdout).status, 'burn_update_required');
  }
});

test('the Burn fixture and CommonJS contract have identical values and reject every nested extra field', () => {
  const source = path.join(__dirname, '../../agentguard-burn/fixtures/burn-week-v1.json');
  if (fs.existsSync(source)) assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), FIXTURE);
  assert.deepEqual(sync.weeklyPayload(FIXTURE, SEAT, NOW).tokens, FIXTURE.figures.tokens);
  assert.equal(contract.weekFigures(FIXTURE.figures).topCause, 'history_resent');
  for (const parts of [[], ['tokens'], ['usdMicros'], ['causes'], ['causes', 'history_resent'], ['reloadsByCause'], ['reloadsByCause', 'idle'], ['wrongModel']]) {
    const value = structuredClone(FIXTURE); let at = value.figures;
    for (const key of parts) at = at[key]; at.unexpected = 'SENTINEL';
    assert.throws(() => sync.weeklyPayload(value, SEAT, NOW));
  }
  // Exercise the copied thresholds against the compiled source over many partitions.
  const sourceModule = path.join(__dirname, '../../agentguard-burn/dist/src/insights/week.js');
  const burn = fs.existsSync(sourceModule) ? require(sourceModule) : contract;
  for (let i = 0; i < 100; i++) {
    const f = structuredClone(FIXTURE.figures);
    f.causes.subagent_fanout.tokens += i * 100000; f.tokens.total += i * 100000; f.tokens.waste += i * 100000;
    f.topCause = burn.topWeekCause(f);
    assert.equal(contract.topWeekCause(f), f.topCause);
    assert.deepEqual(contract.weekFigures(f), burn.weekFigures(f));
    f.topCause = 'invalid'; assert.throws(() => contract.weekFigures(f)); assert.throws(() => burn.weekFigures(f));
  }
});
