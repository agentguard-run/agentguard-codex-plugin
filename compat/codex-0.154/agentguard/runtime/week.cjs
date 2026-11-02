'use strict';
// Local week view: Burn's own week report, shown and saved on this machine.
// It opens no network connection and sends nothing.
const path = require('node:path');
const os = require('node:os');

function weekHome(home) { return home || process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'); }

async function viewWeek({weekStart, home, now = Date.now(), burn, write = text => new Promise((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve()))} = {}) {
  burn ||= require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
  if (typeof burn.collectWeek !== 'function' || typeof burn.isMonday !== 'function') return {status: 'burn_update_required', command: 'npx agentguard-burn@latest week'};
  if (weekStart !== undefined && !burn.isMonday(weekStart)) throw new Error('Use week.cjs with a Monday date: YYYY-MM-DD.');
  home = weekHome(home);
  const report = burn.collectWeek({weekStart, now, home});
  const language = String(process.env.AGENTGUARD_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale).split(/[_.@-]/)[0].toLowerCase();
  await write(burn.renderWeek(report, ['es', 'pt'].includes(language) ? language : 'en') + '\n');
  // Burn's own week command saves the same file after printing it.
  const saved = burn.saveWeek(home, report, now);
  if (saved.reason === 'write_failed') throw new Error('Burn could not save this week.');
}

module.exports = {viewWeek};
if (require.main === module) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args.length > 1) throw new Error('Use week.cjs with at most one Monday date.');
    return viewWeek({weekStart: args[0]});
  };
  run().then(r => { if (r !== undefined) process.stdout.write(JSON.stringify(r) + '\n'); }).catch(() => {
    process.stderr.write('AgentGuard week view unavailable. Use week.cjs with at most one Monday date: YYYY-MM-DD.\n'); process.exitCode = 1;
  });
}
