# AgentGuard Verified attestation

Run `node runtime/attest.cjs` in the installed plugin folder. It reads the
existing local ledger, public key, signing key and policy, verifies every
ledger row, then signs a small public summary. It does not start a worker,
create a key, change a policy, contact a service or publish anything.

The optional CLI flags are <code>&#45;&#45;days</code> (7 or 30, default 30),
<code>&#45;&#45;label</code> (1 to 60 ASCII letters, digits, spaces or hyphens,
not blank), and <code>&#45;&#45;out</code> (a new output
file). Other characters and unknown or repeated flags are refused. The label
is a deliberately public value chosen by the operator, never inferred from
local content. Free is allowed without a license or account.

Without an output file, stdout contains one canonical JSON document followed
by a newline. With an output file, stdout is empty and that file contains
the same format, with permissions 0600. Existing files and symlinks are never
overwritten. Errors exit nonzero and do not print ledger contents or paths.

Run `node runtime/attest.cjs verify attestation.json` to check a bundle offline.
It prints the signed facts in plain words and exits zero only if the schema
and signature pass. It needs no ledger, private key, license, SDK or policy.
An unreadable, malformed, oversized or hand-edited bundle exits nonzero without
printing its contents. No network or subprocess is used by either command.

## Public contract

The schema is `agentguard.attestation.v1`. All objects have fixed allowed keys.
`runtime/attestation-schema.cjs` exports the pure synchronous boolean function
`verifyAttestation(bundle)`, also re-exported by `runtime/attest.cjs`. Pass a
parsed JSON object; it returns false for an invalid schema or signature and
does no I/O, clock reads or mutation. It uses only Node's built-in crypto, so
a Node-based site can import it without the plugin SDK. Unknown keys at any level are rejected, including
extra properties on arrays. Object keys are sorted recursively; array order
is preserved. Ed25519 signs the UTF-8 canonical JSON of all fields except
`signature`. The signature is 128 lowercase hex characters. Public keys are
32 bytes encoded as 64 lowercase hex characters. The signer fingerprint is
the first 16 hex characters of SHA-256 of the public key bytes, matching the
existing ledger convention.

| Field | Meaning |
| --- | --- |
| `schema` | Fixed version identifier. |
| `pluginVersion` | Version from the installed plugin package. |
| `createdAt`, `windowEnd` | The same UTC snapshot timestamp, with milliseconds. |
| `windowStart` | Exactly the requested number of 24-hour days before `windowEnd`. Both boundaries are included. |
| `host` | `claude-code` or `codex`, selected by the plugin's existing launch environment. |
| `label` | Optional public label. Absent when not supplied. |
| `limits` | Current settings described below. These are not a claim that the same settings applied throughout the window. |
| `counts` | Recorded decisions for the selected host in the window, described below. |
| `chain` | `entries`, `firstSequence`, `lastSequence` and `ok` for the selected host and period. Bounds can span excluded rows. The entire ledger must pass verification first. |
| `publicKeyHex`, `signerFingerprint` | The existing ledger signer's public identity. |
| `signature` | Ed25519 signature over every other field. |

### Limits

`mode` uses the existing offline policy and license resolution. It describes
configuration, not a live probe of a running worker. Session-specific mode
and launch depth use the current host session, or the most recent recorded
session for that host when no current session is supplied by the environment.
The session identifier never leaves the machine. `preset` names a shipped
preset only when its settings match; otherwise it is null. `caps` contains
configured caps, each with `window`, `amountCents`, `action` and `scope`.
Scope is `global`, `scoped` or `session`. Selectors and session names stay
private, so the recipient cannot identify which actors a scoped cap covers.
These caps count configured tool prices, not the AI provider's bill.

`subAgentLimits` contains its own `mode`, `spawnRate` with `count`,
`windowActiveMinutes` and `enforced`, `fanout` with `count` and
`windowActiveMinutes`, `maxDepth`, `launchMaxDepth`, and `sessionTokenLimit`. Count ceilings
describe how many launches are permitted before a stop: the short-window
ceiling is Burn's stop threshold minus one. Thresholds come from the installed
Burn policy, including its local defaults and shared thresholds. An absent
Burn policy uses the mode the plugin will seed at the first launch. A malformed
Burn policy is refused. `maxDepth` is Burn's limit, while `launchMaxDepth`
is the stricter of the plugin's global and current session depth limits,
null when both are off. The latter
follows `limits.mode`, even when Burn itself is in shadow. Spawn rate
`enforced` is false in shadow or when that detector is observe-only. Depth
limits still require reliable host lineage. Counts and token thresholds
govern new sub-agent launches; they are not a kill switch for running work.

`guardRules` is a sorted list of enabled built-in rules, each with `id` and
`action` (`warn`, `ask` or `stop`). Only GP001 through GP020 and
`inbox-reset-codes` are admitted. An empty list means all are off. In shadow
these settings are observations. Custom rule IDs, patterns, selectors,
matched commands, policy hashes and reasons are never published. The bundle
summarizes the listed controls, not every setting in the private policy.

### Counts and their limits

- `allowed`: ordinary admissions, including shadow observations and model routing. This count
  does not assert that all calls were enforced.
- `asked`: native approval prompts and recorded operator approval holds.
- `approved`: those asks linked to a host outcome by decision, session and
  call identity before the window ends. An executed call can fail and still
  prove approval. Unlinked Codex approval retries are not guessed.
- `denied`: policy stops and recorded fail-closed decisions, excluding asks.
  Hosts do not reliably report a person's refusal. Unanswered asks are never
  inferred to be denials.
- `failOpen`: signed fail-open records from the gate that owns the tool.

The number of recorded evaluations is `allowed + asked + denied + failOpen`;
`approved` is a subset of `asked`. Burn owns launches; Spend owns other tools.
These count evaluations, including retries, not unique tasks or people.
Outcomes, settlements, control rows, work-receipt summaries
and observations by a different gate do not add decisions. An external Burn
placeholder is not counted as an admission. Other-host and legacy hostless
rows remain in verification but not in this host's counts. An ask before the
window does not enter the window's counts merely because its outcome arrives
inside it. Unsigned recovery queues and unrecorded activity are not counts
from the signed ledger.

### Verification scope

The entire physical ledger is verified in its original order, including old,
future-dated and other-host rows. Nothing is filtered out before verification.
Malformed records, a failed chain, mismatched keys, or a ledger or policy
that changes during verification prevent publication. The read limit is
64 MiB and 100,000 entries; exceeding it refuses the operation instead of
attesting a truncated subset. An existing empty ledger has zero entries,
null sequence bounds. The same applies to a period with no matching rows.
Missing keys or a
missing ledger do not create a new installation.

### What it proves and what it does not

The local signer attests that the retained record is intact and the listed
limits were in force at creation. The bundle proves that the signed summary
has not changed under the supplied public key. The recipient cannot recheck
the private ledger from this content-free summary. It does not prove that the
work was good, who holds the key, that every action was recorded, that hooks
were continuously active, that settings stayed unchanged over the period,
or that the key owner has never replaced their history. Missing and unsigned
fail-open records cannot be counted. Historical policies are not recoverable
from every existing row, so the current snapshot is not a period-wide claim.
Commands, arguments, prompts, filenames, paths, sessions, models, usernames
and license keys are not copied into the public document.
