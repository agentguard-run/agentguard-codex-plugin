# Organization policy and seat contract

This contract is shared by the site and canonical plugin. It is a control plane for policy distribution and licensed seat state. It never receives tool calls, prompts, files, receipts or usage counts. It has not been deployed as part of this change.

Team member seats and shared Team caps are specified in `TEAM_CAPS_CONTRACT.md`. The Team caps endpoints are separate from this control plane: they receive reservation and release amounts as numbers only, never content.

## Publication and retrieval

`GET /api/org/policy` authenticates a license key in the Bearer header using the same license mapping, tier normalization and expiration check as license validation. Invalid or expired keys receive 401; store failures receive 503. Team and 50-seat licenses, including their existing Pro variants, receive the published envelope. Solo receives its personal policy through the same contract. Licenses with no published policy receive 204.

`POST /api/dashboard/org-policy` accepts exactly `{policy: object}`. It requires a verified session for the account that owns a valid Team or 50-seat license. Neither an email query parameter, an asserted tier, nor possession of another account's shared license is admin authority. The endpoint validates every field, computes the hash, increments the published version atomically and stores the envelope. Its authenticated GET variant reads the same envelope for administration. Validation returns 400 with an `errors` array of sentences; ownership failures return 403.

The response is exactly `{version, published_at, sha256, policy}`. The envelope version is a positive increasing integer; `policy.version` must be 1. `published_at` is UTC ISO time. SHA256 covers UTF-8 JSON of the policy only, with object keys sorted recursively, array order retained, no whitespace and standard JSON scalar serialization. Empty arrays remain arrays through storage. Publishing identical policy content still increments the envelope version without changing its hash.

The same pure CommonJS contract module is copied byte-for-byte into both repos. The server and worker validate it independently. Server storage requires the configured KV store in production; unavailable storage does not silently acknowledge an in-memory publication.

Solo also supports `PUT /api/org/policy` with `Authorization: Bearer <Solo key>`,
`Content-Type: application/json` and exactly `{"policy":{...}}`, at most 64 KB.
Only the detached worker sends this explicit CLI push. It projects the local
configuration onto the shared field allowlist and does not upload the local
file, licenseKey, unrelated settings or session content. Team keys cannot use
PUT; their owner still publishes through the dashboard. Both GET and PUT are
limited to 120 requests per IP per minute, plus 60 GETs or 10 PUTs per license
per minute. A rate limit returns 429 with Retry-After 60. Invalid bodies return
400, excessive bodies 413, and unsupported content types 415.

## Accepted policy fields

| Scope | Fields |
| --- | --- |
| Root | version, tenantId, mode, hookBudgetMs, defaultMatterId, maxCapability, allowedTools, deniedTools, ethicalWall, paymentPattern, toolRules, caps, sessions, guardPack, commandRules, teamCaps |
| Team caps | tokensPerDay, tokensPerMonth, usdCentsPerDay, usdCentsPerMonth |
| Tool rule | pattern, capability, requiredCapability, unitCostCents |
| Cap | window, amountCents, action, selector, reason |
| Selector | tenantId, agentId, taskId, sessionId, provider, userId, teamId |
| Session | matterId, agentId, allowedTools, deniedTools, ethicalWall, maxCapability, caps |

These are the fields in the site's Policy file reference. Its local-only `licenseKey`, `teamPolicyFile` and `memberId` fields are rejected by org publication. `teamCaps` is server-held: each of its fields is an optional nonnegative integer, it is accepted at the root only, and Solo PUT refuses it. `GET /api/org/policy` serves the policy without `teamCaps`, and the served `sha256` is the hash of the policy as served, so a worker copy of this module that predates the field still validates the envelope. Without `teamCaps` the served envelope is the published one unchanged. The plugin's push projects the shared fields minus the server-held ones, so a local file that carries `teamCaps` never uploads it. Unknown fields and prototype-related keys are rejected at every level. Identifiers allow 1 to 128 letters, digits, underscores, dots, slashes, colons, at signs or hyphens. Tool expressions must compile as case-insensitive JavaScript regex and have at most 512 characters. Each list and session map has at most 256 entries. Capability, mode, cap action and cap window values use the documented enums. Monetary units are nonnegative safe integers; hookBudgetMs is a positive safe integer with the existing runtime clamp.

Command rules accept an identifier, an action of allow, block or ask, and
exactly one regex pattern or built-in match. Built-in matches are force-push,
deploy, outside-workspace-delete, network, package-publish, website-publish,
page-delete and payment (a shell command that can move money, such as stripe pay
with its yes flag). The site's copy of the contract module needs the payment
match before a published or pushed policy can use it. A block rule may carry
`allowOnce: true` for one-use operator approval. Guard Pack accepts GP001
through GP020 and inbox-reset-codes, with stop, warn or off; GP020 (page
guard) also accepts ask, and `guardPack.pageGuard.internalLinkThreshold` is a
positive integer. The inbox rule and GP020 default off; the other rules retain
their existing defaults. Cap windows include per_session in addition to the
existing windows.

## Root merge

| Setting | Effective rule |
| --- | --- |
| allowedTools | Semantic intersection: a tool must match a regex in every supplied layer's list. Missing lists add no restriction; an empty list matches nothing. |
| deniedTools and ethicalWall | Union across layers, both root and each matching session. |
| maxCapability | Most restrictive tier across layers and the selected session. |
| caps | Append root and session caps. A more permissive cap does not replace a stricter one. |
| mode | Org enforce, including its default, cannot become shadow through a local file. Lower layers may tighten org shadow to enforce. Licensing and failure state take precedence and select shadow. |
| toolRules | Local rules, then shared team rules, then org rules. Later matching org fields are authoritative. |
| Actor mappings and paymentPattern | Org fields win, with documented default tenant and payment classification. Lower mappings cannot redirect an explicit org default matter or session mapping. |
| untrustedOrigin | Local and shared team files only; it is not a published contract field yet, so push and org publication leave it out. Where an org policy merges the shared team file with the personal one, the strictest action (block, then ask, then off) wins, every list (inbound tools, markers and paths, categories, peer send tools) is combined, and the upper layer's senderField applies when it names one. |

Without a published org policy, the existing paid shared-file replacement behavior remains. Solo applies a healthy, license-bound personal snapshot as a replacement of its policy settings; it retains its machine-local key and preferences. A failed Solo sync selects its original local policy instead. Team merges remain as described above. Paid policy restrictions can block a tool call when the effective mode is enforce; licensing, revocation, availability and validation failures cannot.

## Worker and cache

Only the detached worker makes license, seat or org-policy requests. Hook processes, SessionStart helpers, activation helpers and status reads use private file IPC or synchronous local reads. Status asks the already running worker over private file IPC for its effective mode, including in-memory failure latches. If that worker cannot answer, status says current worker status is unavailable and reports shadow with reason status_unavailable; cached license details are labeled as cached. Fetching runs outside the tool admission queue. License refresh has its existing two-second deadline and the separate org GET has a two-second deadline. Org fetch occurs at session start alongside license refresh and every fifth live-session heartbeat. Heartbeats run every five minutes, so the periodic policy interval is approximately twenty five minutes.

A validated envelope and local license fingerprint are written atomically to `${PLUGIN_DATA}/org-policy.json`; status is stored separately. The hash is the hash of policy alone, not the local fingerprint. Team failures retain the last good copy, including the existing seven-day offline license grace, but select shadow with a reason. Solo retains the cached file for inspection but selects its original local policy after any failed sync, including an unwritable status file reported by the worker. A successful 204 unbinds any retained policy. No failed request or late response may clear known revocation. An unwritable cache also keeps the worker in shadow; a successful relevant refresh is needed to clear that failure.

## Seats and invitations

Worker heartbeats contain exactly `{license_key, machine_fingerprint, process_id, org_policy_sha256}`, and for Team licenses an optional `member_id` from the Team roster. The policy hash is a lowercase hexadecimal SHA256 or null until a verified policy is loaded. No decision totals, block totals, fail-open totals, tool names, input, output, prompt, file content, signed receipt, input hash or output hash is uploaded. Local usage and health records remain on the machine and are not read by seat registration or heartbeat code.

The server selects only those heartbeat fields and does not retain extra submitted activity fields. A missing or malformed policy hash becomes null; an otherwise valid registration still receives HTTP 200. Team supports ten seats, and the larger plan supports fifty.

Each person uses one seat. A Team heartbeat with a roster member ID counts as that person, so all of the person's sessions and machines share one seat. A heartbeat without one counts per active session, as before. A person who does not hold a seat while every seat is taken receives `ok: false` with `error: "seat_limit"` and is not registered, so the people already seated keep working. Solo counts up to three active machines and ignores member IDs. `TEAM_CAPS_CONTRACT.md` lists the response fields.

The server stores licensed registrations and each registration's last reported policy hash. Labels and reversible revocation are keyed by fingerprint and remain durable. Revoked registrations do not consume active seat capacity. Dashboard display IDs are the first eight fingerprint characters; admin actions use an opaque registration reference. Labels are at most 40 characters and never appear in worker responses. A policy version count includes fresh, nonrevoked heartbeat evidence. A matching hash does not attest enforcement.

`POST /api/dashboard/seats` takes an opaque `registration_id` and a label or boolean revoked value. The next heartbeat returns `revoked: true` for a revoked machine; the worker selects shadow with reason `seat_revoked`. A successful heartbeat with explicit `revoked: false` permits restoration, subject to all other license and org checks. This is not a remote kill switch.

`POST /api/dashboard/invite` takes exactly `{email}` with the same owner and tier checks. The owner plus unique invitations cannot exceed the seat limit; duplicate emails receive a sentence. The existing license template sends the shared key with the inviting account email as its first content line. Only confirmed sends receive a sent date. An ambiguous provider failure remains reserved to avoid a duplicate send; a confirmed non-send releases the reservation. A shared key cannot attribute invite acceptance, so the UI does not invent acceptance status. Each roster entry, the owner and each sent invitation, has one member ID that `GET /api/dashboard/members` returns to the verified owner; the person's member ID, not the shared key, identifies them for seat counting.

## Review boundary

New server-held data is admin-authored policy identifiers and expressions, published versions and hashes, admin labels, invite addresses and sent dates, existing registration identifiers, each seat's last reported policy hash, roster member IDs, and Team caps totals per UTC day and month with open grants keyed by a hashed holder. Those identifiers may still be sensitive. Solo explicitly uploads only validated policy configuration through PUT; local files and unrelated fields are not uploaded. None of these operations forwards tool or model content. Existing local MCP receipt export remains a paid feature and can report an entitlement error; it is separate from the hook's rule that licensing never denies a tool invocation. Tests and screenshots use synthetic accounts and mocked mail. No live invitation was sent.
