# Local benchmark measurement

Benchmark mode is an explicit instrumentation surface for disposable, isolated
task environments. It is off by default. It must not be enabled as a substitute
for policy enforcement on a developer's machine.

The environment switch alone never weakens Enforce. Before a run, the operator
records consent for its run id from their own terminal:

    node runtime/policy-cli.cjs benchmark on <run-id>

The worker appends one signed row to the plugin ledger (`benchmark_consent`,
the run id, `granted: true`) and writes `benchmark-consent.json` in the plugin
data directory naming that row. On every hook call in benchmark mode the hook
reads the file, finds the row, verifies its signature with the worker's public
key and checks that no later row revoked it; if any of that fails the hook
falls through to normal enforcement and leaves a `.incomplete` marker with the
reason `benchmark_consent_missing`. `benchmark off <run-id>` appends a revoking
row and removes the file. The agent cannot run either verb: the benchmark
verb is a built-in STOP like the other policy verbs.

Set `AGENTGUARD_BENCHMARK=1` and provide the following environment fields:

| Field | Meaning |
| --- | --- |
| `AGENTGUARD_BENCH_POLICY_FILE` | Absolute path to the frozen policy JSON |
| `AGENTGUARD_BENCH_POLICY_HASH` | SHA-256 of its recursively key-sorted canonical JSON |
| `AGENTGUARD_BENCH_EVENTS_FILE` | Absolute path to a dedicated local NDJSON transport |
| `AGENTGUARD_BENCH_RUN_ID` | Explicit run identity |
| `AGENTGUARD_BENCH_AGENT_ID` | Explicit identity of this agent process |
| `AGENTGUARD_BENCH_PARENT_AGENT_ID` | Parent identity, empty for a root process |
| `AGENTGUARD_BENCH_SPAWN_DEPTH` | Integer depth, zero for a root process |

The frozen policy declares `version:1`, `enforced:false`, all built-in rule IDs,
their unchanged patterns and reasons, `stop`, `warn` or `off` actions, and
`scanner_sha256` of `runtime/guard-pack.cjs`. The hook checks the policy hash and
scanner bytes before classifying. Normal license, policy and Burn paths remain
unchanged when the environment switch is absent.

The spend hook records every tool request and its intrinsic CLEAN, WARN or STOP
classification, matched rule IDs, policy hash and `enforced:false`. The burn hook
is silent so the two configured hooks do not duplicate decisions. Receipt and
lifecycle hooks record tool results and session boundaries. Tool arguments are
inspected only in memory; the transport includes an input digest, not arguments,
output, credentials or prompt text. No hook opens a socket or starts a worker in
this mode. Every hook returns an empty admission response, including on failure.

Events use the canonical envelope `schema_version`, `event_id`, `type`,
`timestamp`, `run_id`, `agent_id`, `parent_agent_id`, `spawn_depth` and `data`.
The runner must propagate identities explicitly to each child. Tool requests
alone never establish a spawn. A conflicting host identity is incomplete
measurement, not a guessed lineage.

Unknown branch context, scan limits, invalid configuration and write failures
leave execution permitted. They emit a generic incomplete-measurement warning
and, when writable, an adjacent `.incomplete` marker. Scan uncertainty also
appears in `policy_decision.data.uncertainty`. The collector must reject such a
run as complete telemetry and must check that every host call has a policy event.

This local hook transport is unsigned. A collector outside the agent's access
must validate coverage and sign canonical events using the existing chained
Ed25519 ledger after teardown. Signing establishes integrity of collected bytes,
not protection from a malicious agent that altered its own measurement files.
The benchmark does not weaken native host permissions or provide containment.
A disposable sandbox with no host mounts or credentials supplies containment.
