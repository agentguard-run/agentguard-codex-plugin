#!/usr/bin/env node
'use strict';
// UserPromptSubmit: marks or clears the session's untrusted-origin state. It
// prints nothing, so it never adds text to the conversation, and it always
// lets the prompt through. The prompt is tested in memory and never stored.
const fs = require('node:fs');
let text = '';
try { text = fs.readFileSync(0, 'utf8'); } catch { /* No input: nothing changes. */ }
try { require('../runtime/untrusted-origin.cjs').promptHook(text).catch(() => { /* Any failure keeps the current state. */ }); }
catch { /* Any failure keeps the current state. */ }
