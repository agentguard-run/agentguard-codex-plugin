#!/usr/bin/env node
'use strict';
// A stand-in for a worker from before 0.7.3, as a real process: it holds the lock and the ready file (announcing no
// version unless one is given), answers every message, and on the stop request does what its mode says.
//   stops    answers, removes its lock and ready file, and exits (what a real worker does)
//   mute     never answers the stop request and keeps running
//   lingers  answers the stop request and keeps running
//   returns  answers, hands the lock straight to another stand-in (an older session starting its own worker), exits
// usage: node helper-old-worker.cjs <ipc folder> <mode> [<version>]
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('./helper-test-env.cjs');
const client = require('../runtime/client.cjs');
const common = require('../runtime/common.cjs');
const [ipc, mode, version] = process.argv.slice(2);
const lock = path.join(ipc, 'worker.lock'), ready = path.join(ipc, 'worker.ready'), log = path.join(ipc, 'stand-in.log');
const note = line => fs.appendFileSync(log, JSON.stringify({pid: process.pid, ...line}) + '\n', {mode: 0o600});
common.writeWorkerPid(lock, process.pid);
client.writeMessage(ready, {pid: process.pid, transport: 'files-v1', ...(version ? {version} : {})});
note({event: 'ready'});
process.on('SIGTERM', () => { note({event: 'signalled'}); process.exit(0); });
setInterval(() => {
  for (const name of fs.readdirSync(ipc).filter(name => name.endsWith('.request')).sort()) {
    let message;
    try { message = JSON.parse(fs.readFileSync(path.join(ipc, name), 'utf8')); fs.unlinkSync(path.join(ipc, name)); } catch { continue; }
    note({event: 'message', control: message.control ?? null, keys: Object.keys(message).sort()});
    const answer = () => client.writeMessage(path.join(ipc, name.replace(/\.request$/, '.response')), {});
    if (message.control !== 'stop') { answer(); continue; }
    if (mode === 'mute') continue;
    if (mode === 'lingers') { answer(); continue; }
    if (mode === 'returns') {
      // The next stand-in takes the lock and the ready file itself; this one leaves once it has.
      const next = spawn(process.execPath, [__filename, ipc, 'returns'], {detached: true, stdio: 'ignore'});
      next.unref();
      const until = Date.now() + 5000;
      const taken = () => { try { return Number(fs.readFileSync(lock, 'utf8')) === next.pid && JSON.parse(fs.readFileSync(ready, 'utf8')).pid === next.pid; } catch { return false; } };
      const wait = setInterval(() => { if (taken() || Date.now() > until) { clearInterval(wait); answer(); process.exit(0); } }, 2);
      return;
    }
    answer();
    try { fs.unlinkSync(lock); } catch {}
    try { fs.unlinkSync(ready); } catch {}
    process.exit(0);
  }
}, 2);
