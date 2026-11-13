#!/usr/bin/env node
'use strict';
// PreModelSwitch and PostModelSwitch (Claude Code only). Before a switch: the
// cost line, and Claude Code's confirmation above the owner's limit. After it:
// one line appended for the worker to sign, and the first-session line for a
// model this machine has not run. It reads only the local policy, never the
// conversation, never contacts the worker or the network, and any failure lets
// the switch go ahead unchanged. See runtime/model-switch.cjs.
const fs = require('node:fs');
let output = {};
try {
  const modelSwitch = require('../runtime/model-switch.cjs');
  const change = modelSwitch.read(JSON.parse(fs.readFileSync(0, 'utf8')));
  if (change?.event === 'pre') output = modelSwitch.decide(change, modelSwitch.settings(change.sessionId));
  else if (change?.event === 'post') {
    try { modelSwitch.pend(require('../runtime/common.cjs').locations().data, change); } catch { /* Only this record is lost. */ }
    modelSwitch.markSeen(change.fromModel);
    const line = modelSwitch.firstSeen(change.toModel);
    if (line) output = {systemMessage: line};
  }
} catch { output = {}; }
process.stdout.write(JSON.stringify(output) + '\n');
