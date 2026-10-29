'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Layered rule groups exist only as the output of a merge. A policy file that
// carried them would override every other layer, so they are dropped on read.
const MERGE_ONLY = ['commandRuleGroups', 'allowedToolGroups'];
function stripMergeFields(policy) {
  if (policy && typeof policy === 'object' && !Array.isArray(policy)) for (const key of MERGE_ONLY) delete policy[key];
  return policy;
}
function readPolicy(data) {
  const local = path.join(data, 'policy.json');
  let personal;
  try { personal = stripMergeFields(JSON.parse(fs.readFileSync(local, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; personal = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/default-policy.json'), 'utf8')); }
  const teamFile = process.env.AGENTGUARD_PLUGIN_POLICY || personal.teamPolicyFile;
  if (!teamFile || path.resolve(data, teamFile) === path.resolve(local)) return {policy: personal, personal, team: false};
  const shared = stripMergeFields(JSON.parse(fs.readFileSync(path.resolve(data, teamFile), 'utf8')));
  // The key and the person's member ID are this machine's own, never the team file's.
  return {policy: {...personal, ...shared, ...(personal.licenseKey ? {licenseKey: personal.licenseKey} : {}), ...(personal.memberId ? {memberId: personal.memberId} : {})}, personal, shared, team: true};
}
module.exports = {readPolicy, stripMergeFields};
