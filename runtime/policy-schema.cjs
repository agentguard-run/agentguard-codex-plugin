'use strict';
const {validateGuardPack, validateCommandRules} = require('./org-policy-contract.cjs');
const tiers = ['read_only', 'data_write', 'payment_initiate', 'payment_execute'];
// Tested against "<server or host> <tool>". Money-moving names count, including
// refunds, payouts, finalized invoices, dispute updates and subscription
// cancellations; read-only list_, retrieve_, get_ and search_ tools do not.
const DEFAULT_PAYMENT_PATTERN = '^(?!\\S+ (?:list|retrieve|get|search)_).*(?:payment|pay_|charge|transfer|checkout|purchase|refund|payout|finali[sz]e_invoice|invoice_finali[sz]e|update_dispute|dispute_update|cancel_subscription|subscription_cancel)';
const durations = {per_minute: 60000, per_hour: 3600000, per_day: 86400000, per_month: 2592000000};
function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('policy_invalid');
  if (policy.version !== 1 || !['enforce', 'shadow'].includes(policy.mode ?? 'enforce')) throw new Error('policy_invalid');
  if (policy.notifyOnStop !== undefined && typeof policy.notifyOnStop !== 'boolean') throw new Error('policy_invalid');
  if (validateGuardPack(policy.guardPack).length) throw new Error('guard_policy_invalid');
  const commandError = validateCommandRules(policy.commandRules)[0];
  if (commandError) throw new Error(commandError);
  for (const group of policy.commandRuleGroups ?? []) { const error = validateCommandRules(group)[0]; if (error) throw new Error(error); }
  // Requests from other agents: one root setting, never per session.
  require('./untrusted-origin.cjs').validate(policy.untrustedOrigin);
  const configs = [policy, ...Object.values(policy.sessions ?? {})];
  for (const config of configs) {
    if (!config || typeof config !== 'object') throw new Error('policy_invalid');
    require('./launch-policy.cjs').validate(config);
    if (config !== policy && config.guardPack !== undefined) throw new Error('guard_policy_invalid');
    if (config !== policy && config.untrustedOrigin !== undefined) throw new Error('untrusted_origin_policy_invalid');
    if (config.maxCapability !== undefined && !tiers.includes(config.maxCapability)) throw new Error('policy_invalid');
    for (const group of config.allowedToolGroups ?? []) {
      if (!Array.isArray(group)) throw new Error('policy_invalid');
      for (const pattern of group) { if (typeof pattern !== 'string' || pattern.length > 512) throw new Error('policy_invalid'); new RegExp(pattern, 'i'); }
    }
    for (const field of ['allowedTools', 'deniedTools', 'ethicalWall']) {
      if (config[field] !== undefined && !Array.isArray(config[field])) throw new Error('policy_invalid');
      for (const pattern of config[field] ?? []) { if (typeof pattern !== 'string' || pattern.length > 512) throw new Error('policy_invalid'); new RegExp(pattern, 'i'); }
    }
    for (const cap of config.caps ?? []) {
      if (!['per_call', 'per_session', ...Object.keys(durations)].includes(cap.window) || !Number.isSafeInteger(cap.amountCents) || cap.amountCents < 0 || (cap.action && !['block', 'shadow', 'allow'].includes(cap.action))) throw new Error('policy_invalid');
      if (cap.selector && Object.entries(cap.selector).some(([k, v]) => !['tenantId', 'userId', 'teamId', 'agentId', 'taskId', 'sessionId', 'provider'].includes(k) || typeof v !== 'string')) throw new Error('policy_invalid');
    }
  }
  new RegExp(policy.paymentPattern ?? DEFAULT_PAYMENT_PATTERN, 'i');
  for (const rule of policy.toolRules ?? []) {
    if (typeof rule.pattern !== 'string' || rule.pattern.length > 512) throw new Error('policy_invalid');
    new RegExp(rule.pattern, 'i');
    if ([rule.capability, rule.requiredCapability].some(v => v !== undefined && !tiers.includes(v))) throw new Error('policy_invalid');
    if (rule.unitCostCents !== undefined && (!Number.isSafeInteger(rule.unitCostCents) || rule.unitCostCents < 0)) throw new Error('policy_invalid');
  }
  return policy;
}

module.exports = {validatePolicy, DEFAULT_PAYMENT_PATTERN};
