'use strict';
// Money-moving calls. `stripe pay` sends instant business-to-business
// transfers (docs.stripe.com/cli/pay): with --yes it sends; --dry-run, --json
// and --agent without --yes only validate or review. The `payment` command
// category names the sending runs, the careful and strict presets ask before
// them, the untrusted-origin check holds them, and the default payment pattern
// covers refunds, payouts, finalized invoices, dispute updates and
// subscription cancellations while leaving read-only list, retrieve, get and
// search tools alone.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const matrix = require('./helper-host-matrix.cjs');
const {Engine} = require('../runtime/engine.cjs');
const common = require('../runtime/common.cjs');
const {scanCommands} = require('../runtime/command-policy.cjs');
const {validateCommandRules, validateOrgPolicy} = require('../runtime/org-policy-contract.cjs');
const {DEFAULT_PAYMENT_PATTERN} = require('../runtime/policy-schema.cjs');
const root = path.resolve(__dirname, '..');
const free = () => ({paid: false, tier: 'free', mode: 'enforce', reason: null});
const permission = result => result.output.hookSpecificOutput?.permissionDecision ?? 'allow';
const held = matrix.isClaude ? 'ask' : 'deny';
const categories = command => scanCommands({}, 'Bash', {command}, {cwd: os.tmpdir()}).actionCategories ?? [];

function fixture(t, policy) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pay-'));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data);
  Object.assign(process.env, {AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_PLUGIN_POLICY: '', AGENTGUARD_HOME: path.join(data, 'burn')});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', ...policy}));
  const engines = [];
  t.after(async () => {
    for (const engine of engines) await engine.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true});
  });
  let n = 0;
  const gate = async (engine, tool, input, session = 'pay-session') => engine.handle({meta: common.metadata({session_id: session, tool_use_id: `pay_${n++}`, tool_name: tool, cwd: os.tmpdir(), tool_input: input}, 'spend')});
  const start = async () => { const engine = new Engine({licenseReader: free}); await engine.init(); engines.push(engine); return engine; };
  return {data, gate, start};
}
const preset = name => JSON.parse(fs.readFileSync(path.join(root, 'runtime/presets', name + '.json'), 'utf8'));

test('the payment category names stripe pay runs that can send money and leaves review runs out', () => {
  for (const command of ['stripe pay @x 10 usd --yes', 'stripe pay @x 10 usd -y', 'stripe pay @x 10 usd --yes --json', 'stripe pay profile_123 25 usd --dry-run --yes',
    'stripe pay @x 10 usd', 'yes | stripe pay @x 10 usd', 'STRIPE_API_KEY=x stripe pay @x 10 usd --yes', 'npx @stripe/cli pay @x 10 usd --yes', '/usr/local/bin/stripe pay @x 10 usd --yes=true',
    'cd /tmp && stripe pay @x 10 usd --yes']) {
    assert.ok(categories(command).includes('payment'), command);
  }
  for (const command of ['stripe pay @x 10 usd --json', 'stripe pay @x 10 usd --agent', 'stripe pay @x 10 usd --dry-run', 'stripe pay @x 10 usd --yes=false --json',
    'stripe payments list', 'stripe whoami', 'stripe login', 'npm test', 'echo pay']) {
    assert.equal(categories(command).includes('payment'), false, command);
  }
  // A parse the scanner cannot finish counts any stripe pay as a payment.
  assert.ok(categories(`stripe pay @x 10 usd --json $(${'('.repeat(3)}`).includes('payment'));
});

test('the shared contract accepts the payment match in command rules and org policies', () => {
  assert.deepEqual(validateCommandRules([{id: 'payment', match: 'payment', action: 'ask'}]), []);
  assert.deepEqual(validateOrgPolicy({version: 1, commandRules: [{id: 'pay', match: 'payment', action: 'block', allowOnce: true}]}), []);
  assert.notDeepEqual(validateCommandRules([{id: 'x', match: 'payments', action: 'ask'}]), []);
});

test('careful and strict ask before stripe pay sends; a review run passes', async t => {
  for (const name of ['careful', 'strict']) {
    assert.deepEqual(preset(name).commandRules.find(rule => rule.match === 'payment'), {id: 'payment', match: 'payment', action: 'ask'}, name);
  }
  const f = fixture(t, preset('careful')); const engine = await f.start();
  assert.equal(permission(await f.gate(engine, 'Bash', {command: 'stripe pay @x 10 usd --json'})), 'allow');
  const result = await f.gate(engine, 'Bash', {command: 'stripe pay @x 10 usd --yes'});
  assert.equal(permission(result), held);
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /AgentGuard payment requires/);
  if (!matrix.isClaude) assert.equal(require('../runtime/policy-approval.cjs').pending(f.data).at(-1).ruleId, 'payment');
  const g = fixture(t, preset('strict')); const strict = await g.start();
  const strictResult = await g.gate(strict, 'Bash', {command: 'stripe pay @x 10 usd --yes'});
  assert.equal(permission(strictResult), held);
  assert.match(strictResult.output.hookSpecificOutput.permissionDecisionReason, /payment/);
});

test('a session another agent has messaged holds stripe pay as money, and still lets a review run through', async t => {
  const f = fixture(t, {untrustedOrigin: {categories: ['payment']}}); const engine = await f.start();
  await f.gate(engine, 'mcp__relay__check_inbox', {});
  await engine.handle({meta: common.metadata({session_id: 'pay-session', tool_use_id: 'pay_0', tool_name: 'mcp__relay__check_inbox', cwd: os.tmpdir(), tool_input: {}, hook_event_name: 'PostToolUse', tool_response: {content: 'x'}}, 'receipt')});
  assert.equal(permission(await f.gate(engine, 'Bash', {command: 'stripe pay @x 10 usd --json'})), 'allow');
  assert.equal(permission(await f.gate(engine, 'Bash', {command: 'stripe pay @x 10 usd --yes'})), held);
  assert.equal(permission(await f.gate(engine, 'mcp__stripe__create_refund', {payment_intent: 'pi_x'})), held);
  assert.equal(permission(await f.gate(engine, 'mcp__stripe__list_payment_intents', {})), 'allow');
});

test('the default payment pattern covers money-moving tools and leaves read-only tools alone', () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(root, 'config/default-policy.json'), 'utf8'));
  assert.equal(defaults.paymentPattern, DEFAULT_PAYMENT_PATTERN);
  const pattern = new RegExp(DEFAULT_PAYMENT_PATTERN, 'i');
  for (const name of ['stripe create_refund', 'stripe create_payout', 'stripe finalize_invoice', 'stripe update_dispute', 'stripe cancel_subscription',
    'stripe create_payment_link', 'payments checkout', 'billing charge_customer', 'bank transfer_funds', 'shop purchase', 'x pay_invoice', 'codex make_payment']) {
    assert.match(name, pattern, name);
  }
  for (const name of ['stripe list_payment_intents', 'stripe retrieve_balance', 'stripe get_payment_link', 'stripe search_documentation', 'stripe list_refunds',
    'stripe list_disputes', 'stripe list_subscriptions', 'claude-code Bash', 'codex Read', 'stripe create_customer']) {
    assert.doesNotMatch(name, pattern, name);
  }
});

test('the wider pattern applies by default to policies that do not set one', async t => {
  const f = fixture(t, {maxCapability: 'data_write'}); const engine = await f.start();
  assert.equal(permission(await f.gate(engine, 'mcp__stripe__create_refund', {})), 'deny');
  assert.equal(permission(await f.gate(engine, 'mcp__stripe__list_payment_intents', {})), 'allow');
});
