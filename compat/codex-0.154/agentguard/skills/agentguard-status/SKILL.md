---
name: agentguard-status
description: Read AgentGuard recorded host, license tier, seat counts and verification status, expiry, effective mode, today's signed decisions, configured spend, blocks, and rolling fail-open counts and rates without changing policy or tools.
---

# AgentGuard status

Use the optional AgentGuard MCP server's `get_status` tool with `{}` for the
current UTC date, or `{"day":"YYYY-MM-DD"}` for a requested date. Identify
the timezone in the summary. The server reads the same Spend decision store
used by the hooks: `${PLUGIN_DATA}/ledger/decisions.ndjson` in Codex, or
`${CLAUDE_PLUGIN_DATA}/ledger/decisions.ndjson` in Claude Code. These are
host-specific paths, not interchangeable fallbacks.

Include the known host `sessionId` in the tool arguments when available so
the returned license state belongs to that session. Do not invent an ID.

Report the license tier, `seatsUsed`, `seatLimit`, `seatStorage`,
`seatsVerified`, expiry, effective mode, and reason from the returned `license`
object. Include offline grace or unavailable seat registration when reported.
A `kv` response with `seatsVerified: true` is a validated shared count across
machines over the service's fifteen minute active window. Its storage key has
a twenty four hour lifetime renewed by heartbeats. It is still an observation
at a point in time, not a guarantee about future activity.

Label `memory` counts as unverified. They do not establish shared occupancy
across machines. If storage is unknown or `seatsVerified` is false, do not
claim a verified seat total. A retained numeric count after a failed heartbeat
is an earlier observation; preserve that qualification. Report
`seatRefreshedAt` as the last well-formed seat response time when available.
`seatHeartbeatAt` identifies the latest heartbeat attempt; a failure can update
that field while the count and its response time remain unchanged. Report
`seatHeartbeatError` as a reason code when present. Do not show the
license key. Unknown seats or expiry must stay unknown; do not infer them from
ledger activity. Free enforces the local policy on one machine without a key. Solo adds up to
three machines with personal policy sync, dashboard and export; Team adds org policy and ten seats. A
key does not override a policy set to shadow.

Team counts one seat per person. When the person entered their roster member
ID, report `seatUnit` and `memberStatus` from the `license` object: `member`
with `active` means this person holds one seat shared by all of their machines
and sessions (`memberMachines` is how many are active); `over_limit` means
every seat was taken when this session asked, so it is in shadow with
`seat_limit` until a seat frees and the next heartbeat succeeds; `session` with
`unknown` means the ID is not on this license's roster and the session is
counted on its own, in its normal mode. Absent fields mean no member ID was
sent (Solo, Free, or none entered). Never show the member ID itself.

`teamCaps` is the team's shared budget as the worker cached it, or null when
this machine never reserved one (Free, Solo, or no caps published). Per kind
(`tokens`, `usd_cents`) report `capped`, `available` (what this machine still
holds), `remaining` (what the team had left after the last grant),
`windowResetsAt`, `reached` and `failOpen`. A reached cap refuses calls with
`team_cap_reached` in enforce and records them in shadow, until the window
resets. `unavailable.failOpen` true means an allowance ran out while
agentguard.run could not be reached: the kind whose `failOpen` is true is not
gating on this machine, recorded as a signed `team_caps_unavailable` row, and
local caps still apply; the worker asks again at most once a minute, and the
first grant restores gating for that kind without counting what ran meanwhile. `stopped` names a
refusal that ends reserving until the next session start. The worker alone
reserves and releases; a status read makes no request.

The worker sends bounded heartbeats every five minutes for live sessions.
Those calls happen outside hook processes and do not delay a tool decision.
Heartbeats stop on `SessionEnd` or identified host process exit. When the host
process cannot be identified, recent tool activity renews a fifteen minute
lease; the worker does not renew an orphaned session indefinitely.
A failed heartbeat selects shadow with `seat_unavailable`; a later over-limit
response selects shadow with `seat_limit`. Status reads make no network request.
A revoked seat stays shadow with `seat_revoked` until a successful heartbeat
explicitly reports `revoked: false`. Explain that an admin can restore it from
the Seats panel. Revocation never denies a tool call.

Explain `license_required` as a failed configured license fallback: decisions
are signed and recorded, but no tool call is blocked. No key selects the
local Free policy, default enforce, with `reason: null`. Explain `seat_limit` as shadow mode
because the license's active seat limit was exceeded. These reason codes
are not tool denials. License refresh happens once per session outside the
hooks, with a two second timeout. Previously valid cached status can remain
eligible offline for seven days after its expiry. A refresh failure still puts
enforcement in shadow with `license_unavailable` or `org_policy_unavailable`.
The last good org policy stays cached and is merged locally in shadow. Only the
detached worker fetches it at session start and every fifth five minute
heartbeat. Report `orgPolicyVersion` and `orgPolicySha256` when present.
Status reads do not refresh
the license, register a seat or send a heartbeat.
A status read asks an already running worker for its current mode through
private local files, including any failure it could not persist. It never
starts a worker or performs a network request. If `statusError` is
`status_unavailable`, show shadow and say "Current worker status is unavailable;
license details are cached." `cachedMode` is historical evidence, not the
current effective mode.

Use `list_decisions` with `fromSequence` and `limit` to inspect the relevant
entries when a total or failure needs explanation. Follow the returned
pagination cursor. Do not modify the ledger, policy, or signing key. If the
server is disabled or the ledger cannot be read, state that limitation;
do not treat unavailable records as zero activity.

Summarize decisions, allowed calls, blocks, configured spend in cents,
signed fail-open events, and recorded outcomes. Report
`pendingFailOpenEvents` separately with `pendingRecoveryStatus`: the pending
queue is unsigned/unverified, covers all dates, and can contain recovery
duplicates. Do not add it to the verified daily failure count. Separate observations from gaps:
an interrupted tool may have a pre-tool decision with no post-tool receipt.
Do not describe configured unit-cost accounting as a provider invoice or
report a verification success without calling `verify_chain`.

Explain fail-open entries with their recorded reason codes, without adding
input/output contents. Tool names, hashes, byte counts, actor identifiers,
and decision metadata are sufficient. Do not read tool transcripts or
document bodies to enrich the report.

Report only the current host's hook coverage. Codex hosted tools, skipped
or untrusted hooks, specialized paths, and logging failures can leave
activity outside the ledger. No records is not proof that no tool ran.

Report `health.lastHour` and `health.sinceStart`: fail-open count, total gate
hook invocations, rate as a percentage, and known cause counts. Name the worker
start time. The denominator includes each PreToolUse gate invocation, including
a gate that passes the tool through to the other gate. PostToolUse receipt
observations are reported separately under `health.postToolUse`. A timeout
and its late worker response share one observation; a timeout wins.

If either rate exceeds 5 percent, print `health.warning` as one plain
line, including the known cause. These counters are unsigned operational
observations. They supplement the signed audit chain and must not be presented
as signed decisions. Pending timeout observations may be visible before the
worker recovers their signed audit rows. Do not add them again to these rates.

When `health.denominatorComplete` is false, describe the denominator as partial.
The ledger fallback cannot count pass-through hook invocations that had no
decision row. A missing worker start is unknown, not the start of the day.
If `health.truncated` is true, state that the bounded rolling record limit was
reached. Report `integrityEvents` separately from tool decisions and spend.

Report `host` and the daily `hosts` counts from signed metadata. A legacy row
without a host stays unknown; do not infer its host from the provider name.
Use the current session ID when available so another session's license or
seat state is not reported as this one. In Claude Code skill text,
`${CLAUDE_SESSION_ID}` supplies that session identifier; pass it explicitly
to get_status. Codex can supply CODEX_THREAD_ID, or the operator can choose a
recorded session. If no session can be identified, label the aggregate view.

Claude Code routes WebFetch and WebSearch through tool hooks. Codex hosted
tools do not use the same coverage. Report the actual host's documented
coverage and keep unknown host rows qualified.

For Solo, a failed personal policy refresh selects the local policy. The loaded policy hash is null until a valid snapshot is applied. Inspect policy with `node runtime/policy-cli.cjs show`; a matching reported hash is not evidence of enforcement.

`displayPreferences.quiet` reports the local quiet display preference. If it is true or missing, do not mention AgentGuard Score at all. Otherwise, if this session's recorded tool names suggest payments (names containing pay, stripe, checkout, wallet, transfer, invoice or refund) and the user has not mentioned an AgentGuard Score this session, say once that the free agentguard-score skill takes about a minute, sends the selected answers to the service only after the user agrees, and returns a score, the fixes and an optional report link. Do not repeat it in the same session, and do not call agent_score automatically.
