# Team member seats and shared caps contract

This contract covers two Team features: one person uses one seat, and one budget is shared across a team's machines and agents. The site side is implemented in `api/license/seats.js`, `api/team/reserve.js`, `api/team/release.js` and `api/dashboard/members.js`. The plugin side is described here so the plugin can be built against it. It extends `ORG_FEATURES_CONTRACT.md`; everything in that contract still applies.

Only counts leave a machine. No prompt, tool name, argument, file path, model output, session ID or other content is ever sent by either feature.

## Who a person is

The server already knows a Team's roster: the license owner plus every invitation that was confirmed sent from the dashboard. When an invitation is reserved, the owner and the invitations together are capped at the seat count.

Each roster entry has one member ID: `agm_` followed by 32 lowercase hexadecimal characters. The server issues it and stores it with the roster entry. A member ID never changes for an email address. Member IDs belong to one license key; if the owner's key is replaced, the new key's roster gets new member IDs.

`GET /api/dashboard/members` returns the roster to the verified owner of a Team or 50-seat license, and to no one else (401 without a session, 403 for anyone who does not own a Team license). The response is `{seats, members: [{member_id, email, role, created_at}]}`, where `role` is `owner` or `invitee`. Calling it assigns an ID to any roster entry that has none, including invitations sent before member IDs existed.

The person enters their own member ID in the plugin once, next to the license key. The plugin stores it locally. It is not a secret on the level of the license key, but it identifies a person, so the plugin keeps it out of receipts, the ledger, logs and transcripts in the same way.

The dashboard panel and the invitation email do not show member IDs yet. They should start showing them when a plugin release that sends them is available, so no one is told to enter an ID that their plugin cannot use.

## Seat heartbeat

`POST /api/license/seats` keeps its four existing fields and accepts one more, for Team licenses only:

| Field | Type | Meaning |
| --- | --- | --- |
| `member_id` | string, optional | The person's member ID from the roster. Missing, `null` or empty means not sent. |

Solo, Free and unknown keys ignore `member_id`. Solo still counts up to three active machines, and a fourth machine still selects shadow with `seat_limit`.

When a Team heartbeat sends a non-empty `member_id`, the response keeps every existing field and adds:

| Field | Values | Meaning |
| --- | --- | --- |
| `seatUnit` | `member` or `session` | What this heartbeat was counted as. |
| `memberStatus` | `active`, `over_limit` or `unknown` | Whether the ID is on the roster and holds a seat. |
| `memberMachines` | integer | Active machines under this person, when `active`. |
| `error` | `seat_limit` | Present when `over_limit`. |

Counting rules:

1. A recognized member is one seat. All of that person's sessions and machines share it. `activeSeats` counts people.
2. A heartbeat without a member ID is counted per active session, exactly as before. People and older sessions count side by side.
3. When a session that was counted on its own starts sending its member ID (same machine fingerprint and process ID), it moves into the member's seat instead of adding one.
4. A member who does not already hold a seat, while every seat is taken, is refused and is not registered: `ok: false`, `error: "seat_limit"`, `memberStatus: "over_limit"`. The people already seated are not affected. The plugin's existing handling applies: it selects shadow with reason `seat_limit` and tries again at the next heartbeat. A seat frees fifteen minutes after its person's last heartbeat. This can only happen when the roster is larger than the paid seat count, for example after the seat quantity was lowered.
5. A member ID that is not on this license's roster is counted per session and answers `memberStatus: "unknown"`. The plugin keeps its normal mode and shows in status that the member ID was not recognized.
6. Machine revocation is unchanged: a revoked machine selects shadow with `seat_revoked`, and the person's other machines keep their seat.

A heartbeat that sends no member ID receives exactly the response it received before this change.

The managed inference key route still recognizes a session by its machine fingerprint and process ID after the session registers under its member.

## Team caps in the org policy

The org policy accepts one more root field, `teamCaps`, published by the owner in the dashboard:

| Field | Type | Meaning |
| --- | --- | --- |
| `tokensPerDay` | nonnegative integer, optional | Tokens the whole team may use per UTC day. |
| `tokensPerMonth` | nonnegative integer, optional | Tokens the whole team may use per UTC month. |
| `usdCentsPerDay` | nonnegative integer, optional | US cents of priced tool calls per UTC day. |
| `usdCentsPerMonth` | nonnegative integer, optional | US cents of priced tool calls per UTC month. |

A missing field means no team cap for that window. Zero means nothing is allowed. `teamCaps` is a root field only; it is rejected inside sessions, and a Solo `PUT /api/org/policy` that carries it receives 400.

`teamCaps` is server-held. `GET /api/org/policy` serves the policy without it, and the served envelope's `sha256` is the hash of the policy as served. A worker whose copy of the contract module predates `teamCaps` therefore still validates the envelope, and the hash a seat reports in its heartbeat matches what the dashboard compares it with. When no `teamCaps` is published, the served envelope is the published envelope unchanged. The worker does not need the cap values: the reserve endpoint reports them.

`tokens` are the token totals the plugin already records for its sessions. `usd_cents` are the `unitCostCents` of tool calls priced by `toolRules`. A kind with no team cap needs no reservation.

## Reserve

`POST https://agentguard.run/api/team/reserve` with a JSON body of at most 2 KB:

| Field | Type | Meaning |
| --- | --- | --- |
| `license_key` | string | The Team license key, checked as the seat heartbeat checks it. |
| `member_id` | string | The person's member ID. Send this or `seat_id`. |
| `seat_id` | 64 hex characters | The machine's registration ID, SHA-256 of the license key, a zero byte and the machine fingerprint (the same `seatId` count sharing uses). For a machine with no member ID. The machine must be registered and not revoked. |
| `kind` | `tokens` or `usd_cents` | Which budget. |
| `amount` | integer from 1 | What the worker needs now. |
| `windows` | `{day: "YYYY-MM-DD", month: "YYYY-MM"}` | The worker's current UTC windows. |

Any other field is refused with 400.

A successful grant answers 200:

```json
{
  "ok": true,
  "capped": true,
  "kind": "tokens",
  "granted": 50000,
  "grant_id": "tg_t_20261028_0123456789abcdef",
  "remaining": 850000,
  "window_resets_at": "2026-10-29T00:00:00.000Z",
  "cap_source_sha256": "64 hex characters",
  "windows": {
    "day": {"id": "2026-10-28", "cap": 1000000, "used": 150000, "remaining": 850000, "resets_at": "2026-10-29T00:00:00.000Z"},
    "month": {"id": "2026-10", "cap": null, "used": 150000, "remaining": null, "resets_at": "2026-11-01T00:00:00.000Z"}
  },
  "block": 50000
}
```

- `granted` is an allowance block, not the amount for one call. A standard block is one twentieth of the tightest cap for that kind. The grant is the larger of `amount` and a standard block, at most four blocks, and never more than what remains. Near the cap a standard block shrinks to a quarter of what remains, so one machine cannot strand the end of the budget.
- `granted` can be less than `amount`. The worker must not spend more than it was granted.
- `remaining` and `window_resets_at` belong to the binding window: the capped window with the least left after this grant. A tie names the month.
- `cap_source_sha256` is the SHA-256 of the canonical JSON of the published `teamCaps`. When it changes, the caps changed.
- Granted allowance counts as used in both windows until it is released.

At the cap, the answer is still 200, with nothing granted. With `tokensPerDay` 1000 and `tokensPerMonth` 60, once the month is used up:

```json
{
  "ok": false,
  "capped": true,
  "kind": "tokens",
  "granted": 0,
  "reason": "team_cap_reached",
  "remaining": 0,
  "window_resets_at": "2026-11-01T00:00:00.000Z",
  "cap_source_sha256": "64 hex characters",
  "windows": {
    "day": {"id": "2026-10-28", "cap": 1000, "used": 60, "remaining": 940, "resets_at": "2026-10-29T00:00:00.000Z"},
    "month": {"id": "2026-10", "cap": 60, "used": 60, "remaining": 0, "resets_at": "2026-11-01T00:00:00.000Z"}
  },
  "block": 3
}
```

`window_resets_at` is when the exhausted window resets; when the month is exhausted it is the month reset even if the day has room.

A kind with no team cap answers `{ok: true, capped: false, kind, granted: 0, remaining: null, window_resets_at: null, cap_source_sha256}`. The worker gates nothing for that kind. `cap_source_sha256` is null when no `teamCaps` is published.

## Release

`POST https://agentguard.run/api/team/release`:

| Field | Type | Meaning |
| --- | --- | --- |
| `license_key` | string | As for reserve. |
| `member_id` or `seat_id` | string | The same holder that reserved the grant. |
| `grant_id` | string | From the reserve response. |
| `unused` | integer from 0 | What the worker did not use. |

The answer is `{ok: true, grant_id, kind, released, held}`. The unused allowance returns to both windows of the grant. Releasing more than is still held releases only what is held, so a retried release is harmless. A grant can be released only by its holder (403 `grant_holder_mismatch`).

The worker releases at session end, when the UTC day changes (release yesterday's grant, then reserve in the new day), when `cap_source_sha256` changes, and whenever it drops a cached grant. Grants older than the previous UTC day are closed and answer 404 `grant_not_found`; after a day change, released allowance still returns to the month while the month is current.

## Errors

| Status | Body | Worker action |
| --- | --- | --- |
| 400 | `{errors: [sentences]}` | A worker bug. Do not retry the same body. |
| 401 | `license_required`, `license_not_found`, `license_expired` | Stop reserving for this session. Licensing rules already decide the mode. |
| 403 | `team_required`, `member_unknown`, `seat_unknown`, `seat_revoked`, `grant_holder_mismatch` | Stop reserving for this session and show the reason in status. |
| 404 | `grant_not_found` (release) | Forget the grant. |
| 409 | `window_mismatch` with the server's `windows` | The worker's clock disagrees at a window boundary. Adopt the server's windows and retry once. |
| 413 | `payload_too_large` | A worker bug. |
| 429 | `rate_limited`, with `Retry-After: 60` | Wait at least that long. Treat as unavailable meanwhile. |
| 503 | `team_caps_unavailable` | Unavailable. Apply the fail-open rule. |

Limits: 120 requests per minute per license key for each endpoint, and 240 per minute per IP address across both. Windows are UTC days and months.

## Local cache and gating

Only the detached worker calls these endpoints, outside the tool admission queue, with a two-second deadline, as for license and seat requests. Hooks never wait on the network: they read the cached allowance from a local file the worker writes atomically.

For each kind the worker caches the grant ID, granted, spent, the window IDs, `window_resets_at`, `cap_source_sha256` and when it was fetched. Tokens are debited when the host reports usage. Priced tool calls are debited by their `unitCostCents` before the call. When the cached remainder will not cover the next debit, or is close to running out, the worker reserves the next block in the background.

A refusal (`ok: false`, `team_cap_reached`) is a policy result, not an outage. Until `window_resets_at`, the worker treats the team cap for that kind as reached and handles it like an org cap whose action is `block`, with reason `team_cap_reached`. Effective mode rules still apply: in shadow it is recorded without blocking.

## Fail-open rule

The plugin must keep working when these endpoints are down. A network error, timeout, 5xx or 429 never denies a tool call.

1. The worker keeps gating against the last cached allowance for the current window.
2. When that allowance is used up and the endpoint is still unavailable, the worker stops gating on the team cap, records the outage as a fail-open event with reason `team_caps_unavailable` in status and in the signed record, and keeps local caps in force.
3. It retries at most once a minute, and honors `Retry-After`. The first successful reserve restores team-cap gating.
4. A cached grant from an earlier window is never used in a new window.

## Privacy

The request bodies above are the complete list of what is sent. The server refuses any other field. The license key authenticates the request, and the hosting service sees ordinary connection metadata such as the IP address, which is used for rate limiting.

The server stores, per team, kind and UTC month: the month total, per-day totals, and open grants with a hashed holder reference, the day, the amount granted and the amount released. These records expire three days after their month ends. The seat store holds a digest of the member ID, never the ID. The roster holds the owner and invitation email addresses the dashboard already stores, with their member IDs.

## Backward compatibility

- A plugin that sends no member ID keeps today's per-session Team counting, and its heartbeat responses are unchanged.
- Without published `teamCaps`, `GET /api/org/policy` is unchanged. With them, older contract copies still validate the served envelope.
- The reserve and release endpoints are new; older plugins never call them.

## Plugin checklist

1. Accept and store a member ID locally next to the license key. Never write it to receipts, the ledger or logs.
2. Send `member_id` in the seat heartbeat for Team licenses. Handle `memberStatus`: `over_limit` already maps to `seat_limit`; show `unknown` in status without changing mode.
3. Copy the updated `org-policy-contract` module, merging `teamCaps` with the plugin copy's newer guard rules. Never send `teamCaps` in a Solo push.
4. Reserve and release from the worker only, with a two-second deadline, using `member_id`, or `seat_id` when there is no member ID.
5. Keep a per-kind allowance cache written atomically, debit tokens and priced calls against it, and reserve ahead in the background.
6. Release at session end, at UTC day change, when `cap_source_sha256` changes and when dropping a grant.
7. Apply the refusal as an org cap with action `block` and reason `team_cap_reached` until `window_resets_at`.
8. Apply the fail-open rule above, with the outage recorded as `team_caps_unavailable`.
9. Update the plugin README's list of what it sends with the two new requests and the heartbeat field.
