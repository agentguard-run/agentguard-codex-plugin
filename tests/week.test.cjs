'use strict';
// The local week view shows and saves Burn's week on this machine and sends nothing.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('./helper-test-env.cjs');
const {viewWeek} = require('../runtime/week.cjs');
const NOW = Date.parse('2026-10-05T12:00:00.000Z'), MONDAY = '2026-09-28';

function box(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-week-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const data = path.join(dir, 'data'), home = path.join(dir, 'home'); fs.mkdirSync(data);
  return {data, home};
}
const fakeBurn = (b, order, extra = {}) => ({
  isMonday: value => value === MONDAY,
  collectWeek: options => { assert.equal(options.home, b.home); assert.equal(options.weekStart, MONDAY); return {weekStart: MONDAY}; },
  renderWeek: () => 'week shown',
  saveWeek: (home, value) => { assert.equal(home, b.home); assert.equal(value.weekStart, MONDAY); order.push('save'); return {saved: true, reason: null}; },
  ...extra,
});

test('week view reports an older Burn, and a capable Burn saves only after its report was printed', async t => {
  assert.deepEqual(await viewWeek({burn: {}}), {status: 'burn_update_required', command: 'npx agentguard-burn@latest week'});
  const b = box(t), order = [];
  await viewWeek({home: b.home, now: NOW, weekStart: MONDAY, burn: fakeBurn(b, order),
    write: async text => { assert.equal(text, 'week shown\n'); order.push('print'); }});
  assert.deepEqual(order, ['print', 'save']);
});

test('week view refuses a date that is not a Monday and reports a failed save', async t => {
  const b = box(t), order = [];
  await assert.rejects(viewWeek({home: b.home, now: NOW, weekStart: '2026-09-29', burn: fakeBurn(b, order), write: async () => order.push('print')}), /Monday/);
  assert.deepEqual(order, []);
  await assert.rejects(viewWeek({home: b.home, now: NOW, weekStart: MONDAY, write: async () => order.push('print'),
    burn: fakeBurn(b, order, {saveWeek: () => ({saved: false, reason: 'write_failed'})})}), /could not save/);
  assert.deepEqual(order, ['print']);
});

test('the week module opens no network connection', () => {
  const source = fs.readFileSync(path.join(__dirname, '../runtime/week.cjs'), 'utf8');
  assert.doesNotMatch(source, /fetch|https?:\/\/|require\('node:(?:net|http|https|tls|dns|dgram)'\)/);
});

test('the week command takes at most one date', t => {
  const b = box(t);
  const out = spawnSync(process.execPath, [path.join(__dirname, '../runtime/week.cjs'), MONDAY, 'extra'], {env: {...process.env, PLUGIN_DATA: b.data, AGENTGUARD_HOME: b.home}, encoding: 'utf8'});
  assert.equal(out.status, 1); assert.match(out.stderr, /at most one Monday date/);
});
