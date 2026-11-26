'use strict';
const {readPolicy} = require('./policy-file.cjs');
const DEFAULT_WARM_MS = 250;
// A warm budget below the default cannot be served: the hook would time out on
// ordinary calls and fail open, so smaller values are floored, never honoured.
const MIN_WARM_MS = 250;
const COLD_MS = 1500;
// A sub-agent launch is decided on counts read from the session first, and that read takes longer the larger the
// session. A launch waits for it as long as a cold start may take; an ordinary call keeps the short wait.
const LAUNCH_MS = 1500;
const HOST_TIMEOUT_MS = 2000;
// Reserve time for the hook to serialize its response and exit before the host.
const MAX_WARM_MS = HOST_TIMEOUT_MS - 100;
function normalizeBudget(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(Math.max(value, MIN_WARM_MS), MAX_WARM_MS) : DEFAULT_WARM_MS;
}
function warmBudget(data) {
  try { return normalizeBudget(readPolicy(data).policy.hookBudgetMs); }
  catch { return DEFAULT_WARM_MS; }
}
module.exports = {DEFAULT_WARM_MS, MIN_WARM_MS, COLD_MS, LAUNCH_MS, HOST_TIMEOUT_MS, MAX_WARM_MS, normalizeBudget, warmBudget};
