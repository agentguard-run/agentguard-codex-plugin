#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const corpusFile = path.join(root, 'tests/fixtures/guard-pack-benign.cjs');
const ruleFile = path.join(root, 'runtime/guard-pack.cjs');
const corpus = require(corpusFile);
const {scanGuardPack} = require(ruleFile);
const matches = corpus.flatMap((command, index) => { const result = scanGuardPack('Bash', {command}, {sharedBranch: false}); return result.ruleIds.length || result.reason ? [{index, rule_ids: result.ruleIds, ...(result.reason ? {reason: result.reason} : {})}] : []; });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {corpus_size: corpus.length, unique_commands: new Set(corpus).size, match_count: matches.length, date: new Date().toISOString(), node: process.version,
  machine: {platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown'}, corpus_sha256: hash(corpusFile), rulepack_sha256: hash(ruleFile),
  dangerous_rules_sha256: hash(path.join(root, 'runtime/guard-dangerous.cjs')),
  scope: 'Static command strings scanned locally; no commands executed. Git reset examples use an explicit feature-branch context.', matches};
if (corpus.length < 300 || new Set(corpus).size !== corpus.length) throw new Error('Corpus must contain at least 300 unique commands.');
if (matches.length) { process.stderr.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = 1; }
else { fs.writeFileSync(path.join(root, 'docs/guard-pack-benign.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(`Guard-pack benign corpus: ${corpus.length} commands, ${matches.length} matches.\n`); }
