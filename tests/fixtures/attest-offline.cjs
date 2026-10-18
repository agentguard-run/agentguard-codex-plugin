'use strict';
// Run the actual CLI with all network entry points and child processes denied.
let attempted = false;
const forbidden = () => { attempted = true; throw new Error('Attestation must stay offline and must not launch another process.'); };
// A swallowed exception must not hide a network or subprocess attempt.
process.on('exit', () => { if (attempted) process.exitCode = 86; });
globalThis.fetch = forbidden;
require('node:net').Socket.prototype.connect = forbidden;
require('node:tls').connect = forbidden;
require('node:dgram').createSocket = forbidden;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) require('node:dns')[name] = forbidden;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[name] = forbidden;
require('node:module').syncBuiltinESMExports();
