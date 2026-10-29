# AgentGuard directory submission pack

Prepared for version 0.6.1 on 2026-10-29 (first prepared for 0.4.0 on 2026-10-06). This is a review pack, not a submitted or approved listing. No directory draft, publication or remote MCP deployment was created by preparing it.

## Submission route

AgentGuard contains local hooks, four skills and a local stdio MCP server. The current portal documents skills-only ZIP uploads and remote MCP submissions; local MCP needs a public HTTPS server or coordination with OpenAI. The complete local package therefore needs an agreed review route. A skills-only upload would exclude its MCP configuration and must not be described as installing the complete runtime. [Submission routes](https://developers.openai.com/plugins/deploy/submission), [ZIP exclusions](https://developers.openai.com/plugins/deploy/submission-errors#archive-errors).

Keep the public marketplace installation available while this is resolved. Do not invent an HTTPS MCP URL, an existing integration ID, OAuth credentials or a domain-verification token.

## Account prerequisites

The submitter needs Apps Management Write in the selected organization and project, plus a verified developer or business identity. Organization owners already have write access. Company publishers need business verification. These are documented prerequisites; this pack has not inspected the publisher's account, roles or verification state. [Submission permissions and identity](https://developers.openai.com/plugins/deploy/submission#before-you-start).

The proposed public developer name is AgentGuard. The publisher must select its actual verified business identity in the portal; no verified company selection is assumed here. A GitHub account or ownership of a website does not establish OpenAI verification.

## Info fields

Listing values follow. Business identity verification remains pending.

- Package name: `agentguard`.
- Version: `0.6.1`.
- Display name: `AgentGuard`.
- Short description: `Tool policy and signed records`.
- Developer name: `AgentGuard`.
- Category: `Productivity`.
- Website: [AgentGuard](https://agentguard.run).
- Support: [AgentGuard help](https://agentguard.run/help).
- Privacy: [Privacy policy](https://agentguard.run/legal/privacy).
- Terms: [Terms of service](https://agentguard.run/legal/terms-of-service).
- Repository: [Public plugin source](https://github.com/agentguard-run/agentguard-codex-plugin).
- License: `SEE LICENSE IN LICENSE`.
- Logo: `assets/logo-512.png`.
- Composer icon: `assets/icon-128.png`.
- Brand colors: optional; omit until the chosen light and dark colors pass the portal's contrast checks.
- Capabilities: `Local tool policy hooks`, `Signed decision and outcome records`, `License and seat status`, `Read-only local audit MCP`, `Policy, status, verification and score skills`, `Opt-in AgentGuard Score questionnaire`.

The current final form permits three starters, each at most 128 characters, and 30 characters each for display name and short description. `Productivity` preserves the installed plugin category. This pack includes six candidate starters and selects three below. [Final metadata limits](https://developers.openai.com/plugins/deploy/submission-errors#final-directory-submission).

### Long description

AgentGuard applies operator-defined policies to supported local tool calls in Codex, ChatGPT Work and Claude Code. Set capability tiers, tool allowlists, ethical-wall denies and budgets based on configured unit costs. Burn handles subagent fan-out and sustained usage. Signed local decisions and outcome records retain tool names, identifiers, input digests and sizes, without retaining tool input or output text.

Free provides full Enforce, local signed receipts and Burn on one machine, with no key or account. Solo is $19 per month or $190 per year for up to three machines, the dashboard, receipts export and email support. Team is $199 per month or $1,990 per year for ten seats, org policy, seats you add and revoke, and one invoice. Team is the only trial. Existing Growth and Pro licenses remain supported. Shadow is a fallback state or an explicit local policy choice; a failed paid license keeps its shadow reason.

The status skill and read-only MCP tools explain the effective mode, license expiry, seat count and verification state, daily decisions, configured spend and fail-open events. The verification skill checks the signed chain; paid users can export a bundle for their own records. The score skill runs the optional AgentGuard Score questionnaire for agents that make or receive payments: five self-reported questions, a separate choice about a hosted report link, and consent that names the service origin before anything is sent.

Local policy enforcement and decision records stay on your machine. AgentGuard Score is the only MCP tool that makes a hosted request. Paid licensing, seat renewal and optional policy sync are separate network features. Score requests do not include your local policy, decision ledger or signing key.

Hooks require review and trust. Disabled or untrusted hooks do not govern calls. Internal errors and timeouts fail open. Codex hosted tools such as WebSearch, web ChatGPT and specialized paths outside hook dispatch are not covered. Claude Code routes WebSearch and WebFetch through its tool hooks. Managed installation does not change this fail-open contract. Protect policy files from agent writes and retain service-side access controls.

Install the Node 22 runtime dependencies in the plugin root and follow the Codex 0.154 compatibility instructions. Paid license validation and live-session seat renewal use bounded requests to AgentGuard; tool hook processes and the audit MCP tools do not open network sockets.

## MCP fields and annotations

- Submission type: pending local MCP review route. Do not choose a remote MCP type for the current stdio server.
- Local configuration: `mcp.json`, command `node`, argument `${PLUGIN_ROOT}/runtime/mcp.cjs`.
- Production MCP URL, Universal or Template selection, template example URL: not applicable to the current package; none supplied.
- MCP authentication and OAuth demo credentials: none. Access is the installed user's bounded local `PLUGIN_DATA` directory. A paid product license is separate from MCP transport authentication.
- Domain verification and challenge base URL: not applicable without a remote endpoint; no token was requested.
- Custom UI, UI fetch domains, frame domains and CSP: none. The MCP server returns text and structured data, not a UI resource.
- Tool scan: not run in the submission portal. Local tools and their arguments are tested below.
- Static MCP-imported skills: none. The four skills are bundled files.
- Demo recording URL: pending capture and public hosting. A local filename is not a production URL.

The following annotation values describe each MCP tool, not the separate policy-edit skill or background license worker. Each tool uses the fixed local data root and accepts no arbitrary file or URL target. Six tools make no network call. The seventh, agent_score, is the only MCP tool that makes a hosted request: with the user's consent it sends questionnaire answers to the AgentGuard Score service at a validated origin and is annotated open-world. The offline tests compare file hashes before and after all seven calls.

### get_status

`readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`, `idempotentHint: true`.

It reads local policy, license snapshots, health and signed decision records to calculate a status response. It does not refresh a license, register a seat, create a log or update a file. Timestamps, expiry, seat provenance and aggregate counts explain the current state. A display allowlist omits key fingerprints, session fingerprints, seat identities and unknown snapshot fields from the response.

Arguments: optional `day` as a UTC date and `sessionId`. Result: `host`, `hosts`, `license`, `health`, `day`, `timezone`, `decisions`, `spendCents`, `blocks`, `failOpenEvents`, `outcomes`, `integrityEvents`, `totalEntries`, plus pending recovery counts. Unverified recovery rows are reported separately from signed decisions.

### list_decisions

`readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`, `idempotentHint: true`.

It reads a bounded page of local summary rows. It does not amend a decision or contact a tool provider. Actor IDs, decision IDs and hashes are present to identify and link the records requested by the user.

Arguments: optional `fromSequence` and `limit`, at most 200. Result: `entries`, `nextSequence`, `totalEntries`. A row contains sequence, hash, decision ID, timestamp, action, record type, provider, model, actor, configured amount, reasons and tool metadata.

### verify_chain

`readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`, `idempotentHint: true`.

It computes signature and hash verification from the local ledger and public verification key. It does not repair, re-sign or overwrite failed records, and never reads the private signing key. Verification is available without a paid license.

Arguments: empty object. Result: `ok`, `entries`, `publicKeyHex`, `lastEntryHash`, with SDK verification failure details when applicable. A malformed physical ledger is an error, not a silently shortened valid chain.

### export_receipts

`readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`, `idempotentHint: true`.

It verifies and returns a bounded page of signed local records and the public key to an eligible paid session. The MCP tool does not create a file or upload a bundle. Saving returned data with another tool is a separate action. Free export fails with a license reason; verification still works.

Arguments: optional `sessionId`, `fromSequence` and `limit`, at most 200. Result: `format: agentguard-signed-receipts-v1`, `publicKeyHex`, `verified`, `complete`, `entries`, `nextSequence`, `totalEntries`, `lastEntryHash`.

### get_work_receipt

`readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`, `idempotentHint: true`.

It reads the local ledger and returns the work receipt of one finished session: the signed `session_receipt` row the worker appends when a session ends, holding counts only (first and last activity time, tokens recorded, sub-agents started, finished and ended without finishing, decisions by result, Burn's policy mode and the plugin version). It verifies that row's signature and the whole chain against the local public verification key, and never reads the private signing key. Available without a paid license.

Arguments: optional `sessionId`; without it, the latest receipt. Result: `found`, `receipt`, `signature` (`sequence`, `entryHash`, `previousHash`, `signature`, `signerFingerprint`, `publicKeyHex`, `valid`) and `chain` (`verified`, `entries`, `lastEntryHash`).

### agent_score_questions

`readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`, `idempotentHint: true`.

It returns the AgentGuard Score questionnaire bundled in `runtime/agent-score-questions.cjs`: the intro, five question ids, their wording, the published options and categories, plus `serviceOrigin`, the validated origin that `agent_score` would call (https only, no credentials, path, query or fragment; `https://agentguard.run` unless `AGENTGUARD_SCORE_URL` is set). It reads no user data and makes no network call, so the agent can ask the user every question and name the destination before anything is sent. An unusable configured origin is reported as `serviceOrigin: null` with `serviceOriginError`.

Arguments: empty object. Result: `intro`, `questions`, `serviceOrigin`.

### agent_score

`readOnlyHint: false`, `openWorldHint: true`, `destructiveHint: false`, `idempotentHint: false`. With `openReport: true`, only together with `createShare: true`, the server launches the operating system's default browser opener with the report address as a single argument after a successful score; nothing else is launched, it never runs on a failure, and `AGENTGUARD_NO_BROWSER=1` disables it.

It sends the user's five questionnaire answers to the AgentGuard Score service at the validated origin and returns the computed score. It is the only MCP tool that makes a hosted request, and it is not read-only because a requested report link is stored by the service. It requires `consent: true` and refuses without it with a score-specific `consent_required` result, refuses an unusable origin with `invalid_origin`, refuses any answer outside the published questions and options and any incomplete answer set with `invalid_answers`, all before making a request; it reads no local ledger, policy or key, and writes nothing locally. No email address is collected. The request refuses redirects, sends no credentials or referrer, reads at most 64 KB of response, and keeps one timeout across the request and the body read. A result is accepted only when it is complete and well formed; an error status, an oversized or unreadable body or a malformed result is `service_error` with no result to display, and a network failure is `network` with the statement that no usable result was received and the service may have processed the request. The tool never retries. Every refused or failed call is returned as an MCP tool error (`isError: true`) that still carries the structured result. A report link is created only when `createShare` is true and is returned only when it is on the consented origin.

Arguments: `answers` keyed by question id (every question required), `consent` (must be true), optional `createShare` (default false). Result: `ok`, `score`, `tier`, `breakdown`, `factors` with recommendations, `shareUrl` (null unless requested), `scoredAt`, `validUntil`, `serviceOrigin`, and `assessmentType`, `questionnaireVersion` and `rubricVersion` when the service supplies them; or `ok: false` with a `reason`.

These values follow the documented distinction between read-only computation, bounded private data and external or destructive actions. They are set in `runtime/mcp.cjs`. [Tool annotation guidance](https://developers.openai.com/plugins/app-guidelines#correct-annotation).

## Skills

- `skills/agentguard-policy/SKILL.md`: operator-requested policy edits and license activation. It preserves unrelated rules and never treats a denied tool request as permission to weaken policy. The activation helper takes a key on standard input and does not echo it.
- `skills/agentguard-status/SKILL.md`: read daily decisions, configured spend, blocks, fail-open rates, license mode and seat evidence. Missing values remain unknown.
- `skills/agentguard-verify/SKILL.md`: verify signatures and links; return a paid receipt export when requested. A failed chain is not repaired.
- `skills/agentguard-score/SKILL.md`: run the optional AgentGuard Score questionnaire: ask the five questions, ask once whether the full visual report should open in the browser when the score is ready, obtain consent that names the service origin, call `agent_score`, and report the self-reported result. It never calls the tool without consent and never presents the score as a verification.

Include every runtime helper and asset these skills reference in any agreed local package. Do not upload four isolated `SKILL.md` files and assume their local helpers will be installed. Automated tests validate runtime behavior; live host selection of each skill is pending reviewer execution.

## Starter prompts

Submit these three after the route is agreed:

1. Set a per-matter budget and a read-only tool allowlist for this session.
2. Show today's decisions, spend, blocks, fail-open rate, license mode and seat status.
3. Verify my signed decision chain and explain any integrity failure.

Additional candidates for review, not additional form entries:

4. Add an ethical-wall deny for the restricted document tools in this session.
5. Explain why this session is in shadow mode and whether its seat count is verified.
6. With my paid license, export a verified receipt bundle for a records custodian.

The selected prompts cover policy, status and verification. They do not ask a user to put a license key or document text in a conversation.

## Reproducible review fixtures

The catalog is `docs/DIRECTORY_FIXTURES.json`. The runner is `tests/directory-review.test.cjs`. Run automated review from a checkout of the public repository source root, where the tests are included:

```sh
git clone https://github.com/agentguard-run/agentguard-codex-plugin.git
cd agentguard-codex-plugin
npm ci
node tests/directory-review.test.cjs
```

The installed Codex compatibility package and npm archive include the fixture catalog for manual review. They omit the source test runner. Provisioning an installed plugin root is separate from this source checkout workflow.

The runner creates temporary local state, an ephemeral signing key and synthetic license snapshots, then deletes them. It sends no license or seat request. Fixture seat counts are not observations of production KV. No customer account, document, private repository, credential or live payment is needed. The synthetic tool inputs are empty objects represented by a digest and byte count. Signed rows contain metadata only.

The eight cases below are exact catalog entries. Their prompts describe reviewer interactions; the automated runner checks the underlying policy engine and MCP result shapes without claiming a live Codex or ChatGPT Work conversation.

### Positive P1: installation and shadow decision

Prompt: Install AgentGuard from its public marketplace, provision it, review its hooks and record a synthetic read without a license.

Expected: The installed package loads its registry dependencies. After hook review, a Free call follows the local policy and is recorded as a signed decision. Required fixture: `install_free`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {},
  "license": {
    "initialPaid": false,
    "syntheticKey": null,
    "status": null,
    "expiresAfterMs": null
  },
  "seatResponse": null,
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_docs__get_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    }
  ]
}
```

Shape:

```json
{
  "permissionDecision": "allow",
  "action": "allow",
  "mode": "enforce",
  "reason": null,
  "entries": 1,
  "chainOk": true
}
```

Reviewer installation:

```sh
codex plugin marketplace add agentguard-run/agentguard-codex-plugin
codex plugin add agentguard@agentguard
npm ci
```

Run `npm ci` in the installed plugin root. Start a new session, inspect `/hooks` and trust the reviewed definitions. The offline test checks the provisioned files and signed Free enforce result; it does not substitute for that live install and trust flow.

### Positive P2: ethical-wall denial

Prompt: Configure an ethical wall for this session and check that the synthetic save is denied.

Expected: Deny the save and retain the operator's ethical wall. A requested tool action is not permission to weaken its policy. Required fixture: `paid_ethical_wall`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {
    "sessions": {
      "session-SYNTHETIC-review": {
        "ethicalWall": [
          "^mcp__synthetic_docs__save_document$"
        ]
      }
    }
  },
  "license": {
    "initialPaid": true,
    "syntheticKey": "ag_SYNTHETIC_TEST_PAID_LICENSE",
    "status": {
      "valid": true,
      "tier": "startup",
      "seats": 5,
      "features": {
        "maxActiveSeats": 5
      }
    },
    "expiresAfterMs": 86400000
  },
  "seatResponse": {
    "ok": true,
    "tier": "startup",
    "activeSeats": 3,
    "maxActiveSeats": 5,
    "storage": "kv"
  },
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_docs__save_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    }
  ]
}
```

Shape:

```json
{
  "permissionDecision": "deny",
  "action": "block",
  "reasonCode": "ethical_wall",
  "chainOk": true
}
```

### Positive P3: license activation

Prompt: Activate my existing license through the local activation helper, then show the mode and seat status without echoing the key.

Expected: Store the key only in local policy, resolve its status outside hooks and return paid enforcement plus verified seat evidence. The automated fixture uses injected license and seat responses. Required fixture: `license_activation`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {},
  "license": {
    "initialPaid": false,
    "syntheticKey": "ag_SYNTHETIC_TEST_PAID_LICENSE",
    "status": {
      "valid": true,
      "tier": "startup",
      "seats": 5,
      "features": {
        "maxActiveSeats": 5
      }
    },
    "expiresAfterMs": 86400000
  },
  "seatResponse": {
    "ok": true,
    "tier": "startup",
    "activeSeats": 1,
    "maxActiveSeats": 5,
    "storage": "kv"
  },
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_docs__get_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    }
  ]
}
```

Shape:

```json
{
  "tier": "startup",
  "mode": "enforce",
  "reason": null,
  "seatsUsed": 1,
  "seatLimit": 5,
  "seatStorage": "kv",
  "seatsVerified": true,
  "keyInLedger": false
}
```

The operator supplies the existing key to the activation helper through standard input. The fixture invokes the same activation function with synthetic license and seat responses, preserves unrelated policy fields and checks that no key reaches the signed ledger or returned status. It does not activate a production license.

### Positive P4: status and seats

Prompt: Show this session's license mode, verified seat count and today's decision totals.

Expected: Call get_status with the synthetic session ID. Report 3 of 5 seats from the fixture KV response, enforce mode and one allowed decision. Required fixture: `paid_kv_status`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {},
  "license": {
    "initialPaid": true,
    "syntheticKey": "ag_SYNTHETIC_TEST_PAID_LICENSE",
    "status": {
      "valid": true,
      "tier": "startup",
      "seats": 5,
      "features": {
        "maxActiveSeats": 5
      }
    },
    "expiresAfterMs": 86400000
  },
  "seatResponse": {
    "ok": true,
    "tier": "startup",
    "activeSeats": 3,
    "maxActiveSeats": 5,
    "storage": "kv"
  },
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_docs__get_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    }
  ]
}
```

Shape:

```json
{
  "license": {
    "tier": "startup",
    "mode": "enforce",
    "seatsUsed": 3,
    "seatLimit": 5,
    "seatStorage": "kv",
    "seatsVerified": true
  },
  "decisions": 1,
  "blocks": 0,
  "totalEntries": 1
}
```

### Positive P5: verification and paid export

Prompt: Verify this paid session's chain and return its signed receipt bundle for a records custodian.

Expected: Call verify_chain followed by export_receipts. Both succeed and the bundle contains exact signed records with no private key or file writes. Required fixture: `paid_signed_bundle`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {},
  "license": {
    "initialPaid": true,
    "syntheticKey": "ag_SYNTHETIC_TEST_PAID_LICENSE",
    "status": {
      "valid": true,
      "tier": "startup",
      "seats": 5,
      "features": {
        "maxActiveSeats": 5
      }
    },
    "expiresAfterMs": 86400000
  },
  "seatResponse": {
    "ok": true,
    "tier": "startup",
    "activeSeats": 3,
    "maxActiveSeats": 5,
    "storage": "kv"
  },
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_docs__get_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    },
    {
      "gate": "receipt",
      "toolName": "mcp__synthetic_docs__get_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0,
      "outputBytes": 2,
      "durationMs": 4,
      "durationSource": "host",
      "success": true
    }
  ]
}
```

Shape:

```json
{
  "format": "agentguard-signed-receipts-v1",
  "verified": true,
  "complete": true,
  "totalEntries": 2,
  "nextSequence": null
}
```

### Negative N1: payment tool above tier

Prompt: Run the synthetic checkout tool from a session limited to data_write.

Expected: Deny the payment-like tool with capability_tier_exceeded and record the decision. Required fixture: `payment_above_tier`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {
    "maxCapability": "data_write"
  },
  "license": {
    "initialPaid": true,
    "syntheticKey": "ag_SYNTHETIC_TEST_PAID_LICENSE",
    "status": {
      "valid": true,
      "tier": "startup",
      "seats": 5,
      "features": {
        "maxActiveSeats": 5
      }
    },
    "expiresAfterMs": 86400000
  },
  "seatResponse": {
    "ok": true,
    "tier": "startup",
    "activeSeats": 3,
    "maxActiveSeats": 5,
    "storage": "kv"
  },
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_payments__checkout",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    }
  ]
}
```

The payment tool requires a capability above the operator's configured tier.

Shape:

```json
{
  "permissionDecision": "deny",
  "action": "block",
  "reasonCode": "capability_tier_exceeded",
  "capabilityTier": "payment_initiate",
  "chainOk": true
}
```

### Negative N2: tool denied by policy

Prompt: Run the synthetic save tool even though deniedTools names it.

Expected: Deny the tool with tool_denied, retain the policy and record the signed decision. Required fixture: `policy_denied_tool`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {
    "deniedTools": [
      "^mcp__synthetic_docs__save_document$"
    ]
  },
  "license": {
    "initialPaid": true,
    "syntheticKey": "ag_SYNTHETIC_TEST_PAID_LICENSE",
    "status": {
      "valid": true,
      "tier": "startup",
      "seats": 5,
      "features": {
        "maxActiveSeats": 5
      }
    },
    "expiresAfterMs": 86400000
  },
  "seatResponse": {
    "ok": true,
    "tier": "startup",
    "activeSeats": 3,
    "maxActiveSeats": 5,
    "storage": "kv"
  },
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_docs__save_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    }
  ]
}
```

An explicit operator tool deny applies to this session.

Shape:

```json
{
  "permissionDecision": "deny",
  "action": "block",
  "reasonCode": "tool_denied",
  "chainOk": true
}
```

### Negative N3: corrupt policy fail-open

Prompt: Show what happens when a tool arrives while policy.json is malformed.

Expected: Allow the call under the fail-open contract, emit a warning and record a signed fail_open event without exposing the malformed content. Required fixture: `corrupt_policy`.

Fixture data, merged with the catalog's base policy. Event IDs and timestamps are generated for each run; the test license key is synthetic.

```json
{
  "policyOverrides": {},
  "license": {
    "initialPaid": true,
    "syntheticKey": "ag_SYNTHETIC_TEST_PAID_LICENSE",
    "status": {
      "valid": true,
      "tier": "startup",
      "seats": 5,
      "features": {
        "maxActiveSeats": 5
      }
    },
    "expiresAfterMs": 86400000
  },
  "seatResponse": {
    "ok": true,
    "tier": "startup",
    "activeSeats": 3,
    "maxActiveSeats": 5,
    "storage": "kv"
  },
  "toolEvents": [
    {
      "gate": "spend",
      "toolName": "mcp__synthetic_docs__get_document",
      "sessionId": "session-SYNTHETIC-review",
      "agentId": "agent-SYNTHETIC-review",
      "inputSha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "inputBytes": 2,
      "inputKeys": 0
    }
  ],
  "corruptPolicyText": "SYNTHETIC_MALFORMED_POLICY_DO_NOT_LOG"
}
```

A corrupt policy cannot produce an enforcement decision; the documented runtime fallback is allow plus a recorded warning.

Shape:

```json
{
  "permissionDecision": "allow",
  "warning": true,
  "event": "fail_open",
  "reasonCode": "license_required",
  "chainOk": true,
  "policyReasonCode": "policy_or_runtime_error",
  "warningCause": "policy_or_runtime_error"
}
```

Because the malformed policy also prevents license resolution, the signed row carries `license_required` as its public reason and retains `policy_or_runtime_error` as `policyReasonCode`. The warning cause identifies that same runtime failure.

### Supplemental regressions

The catalog also retains S1 per-matter caps, S2 paged decision/outcome linkage, S3 free verification, S4 refused free export and S5 actor tampering. These are additional tests, not substitutes for the five positive and three negative cases above.

## Screenshots and recording

Required real package screenshots, each 1280 by 800 pixels. Reserve these paths for a future capture; the files do not exist and are not referenced by the manifest:

- `assets/directory-ethical-wall.png`: a real policy interaction and ethical-wall denial.
- `assets/directory-status.png`: real status output with mode and seat provenance visible.
- `assets/directory-verify.png`: real chain verification and, when eligible, export.

Capture could not complete on the preparation machine. macOS reported `CGPreflightScreenCaptureAccess() = false`, and capturing the dedicated Terminal window failed. No synthetic images were substituted. After screen recording permission is available, capture the real Codex 0.154 interactions, review them for private data, then add the files and manifest references together. Preserve the requested full-size originals and any synthetic license fixture label.

The current portal reserves its UI screenshot fields for a scanned custom UI template and requires width 706 pixels. AgentGuard has no such template. The requested manifest assets therefore need separate acceptance for this local plugin rather than being described as portal-compatible UI images. A real demo recording URL is also pending. [Review media requirements](https://developers.openai.com/plugins/deploy/submission-errors#final-directory-submission).

Recording slot: `docs/directory/demo.mp4`. Supply its public URL after the recording has been reviewed; the path itself is not a production URL.

## Domain challenge setup

The site exposes `https://agentguard.run/.well-known/openai-apps-challenge`. It returns 404 while `OPENAI_APPS_CHALLENGE_TOKEN` is unset. Once OpenAI provides the token for the agreed submission route, copy the exact token from the portal domain-verification step into the production site's environment variable of that name. Do not paste it into this repository, a skill prompt or the plugin policy. Apply the normal reviewed site deployment, confirm that the route returns the exact plain-text token, then select Verify in the portal. Do not generate a substitute token.

This preparation leaves the token unset. An HTTP 404 proves the empty configuration behavior; it does not prove domain verification or directory eligibility. The submitter still completes those steps in the portal. [Domain verification](https://developers.openai.com/plugins/deploy/submission#mcp).

## Global availability

All countries and regions offered by the submission portal. Listing and support language: English.

## Release notes for 0.3.8

AgentGuard Score, the optional five-question payment self-check, now names its real destination before consent, treats a hosted report link as a separate choice, hardens the one hosted request (no redirects, no credentials or referrer, a 64 KB response cap, one timeout), accepts only a complete well-formed result, returns every refusal or failure as a tool error with its reason, and reports the local quiet preference in status so the score is never suggested to someone who turned announcements off. Local policy enforcement and decision records stay on the machine; score requests do not include the local policy, the decision ledger or the signing key.

### Previous 0.3.7 notes

Add AgentGuard Score to the plugin: the `agentguard-score` skill, an offline `agent_score_questions` tool and the opt-in `agent_score` tool, with a once-per-install invitation on a quiet session start.

### Previous 0.3.6 notes

Approve held Codex calls only from the operator's terminal, with a pending command that lists them and no token shown to the model. Protect the plugin's own state and policy commands from agent tool calls on every host. Keep command rules working when a command cannot be fully parsed, validate command patterns as linear, keep Solo sync state in one file for hook and worker, let personal policies only tighten the Guard Pack, and cover more ordinary command spellings. Preserve all failed-license fallbacks, paid receipts export and existing signed chains.

Benchmark mode needs the operator's signed consent per run. A hook budget below 250 ms is refused. A policy the worker cannot read keeps a definite built-in stop. Move, copy and rename tools are writes for the plugin-state stop. Org policy withdrawal and replay are handled explicitly. The command scanner reads reserved words, wrappers, substitutions, here-strings, ANSI-C quoting and CRLF heredocs; recursive-delete targets built from variables resolve where possible; secret, credential-file, env-template and package-source checks are tuned by category against a public corpus with regression pairs. Evals tooling stays out of the package.

### Previous 0.3.5 notes

Improve local checks for shell commands that contain heredoc data, including nested shell calls and patch input. Preserve known guard matches when parsing is incomplete. Add regression coverage and a comparison against public Next.js eval transcripts.

### Previous 0.3.0 notes

Add Claude Code marketplace packaging, host metadata and failed-tool receipts to the shared runtime. Preserve the public package name, Codex compatibility installation and existing signed chains. Claude allows keep normal host permission checks; standalone Burn coexistence avoids duplicate spawn accounting.

### Previous 0.2.2 notes

Initial directory review proposal for AgentGuard 0.2.2. The package supplies local tool policy hooks, policy/status/verification skills and read-only MCP access to signed local records. Free sessions record decisions in shadow mode; existing paid licenses enable enforcement, team policy files, receipt export and seat metering.

Version 0.2.2 renews seats across machines through the shared license KV service. Active seats use a fifteen minute window and a twenty four hour key lifetime. The worker renews each live session every five minutes; tool hook processes do not send heartbeats. Status reports the seat count, limit, storage and verification state. Memory fallback is marked unverified. Startup over-limit sessions use shadow mode, and later heartbeat failures do not change the current mode. Renewal stops after SessionEnd or host exit, with a bounded activity lease when the host cannot be identified.

Review fixtures are synthetic and offline. They exercise five positive and three negative scenarios with no production account. Local MCP review eligibility, publisher account checks and a live multi-platform recording remain pending. No claim of directory approval is made.

## Privacy and policy attestation review

Do not complete attestations from this document alone. The official guidelines require a published privacy policy, narrow collection and responses that omit unnecessary secrets and personal data. [Privacy requirements](https://developers.openai.com/plugins/app-guidelines#privacy).

Product facts for the reviewer:

- Hook payloads are processed locally to calculate tool names, digests, sizes and decisions. Tool input and output text are not retained in the plugin ledger. Host transcripts are controlled by the host, outside this plugin's ledger.
- Decision and outcome records include operator or host IDs needed to identify policies and link events. These identifiers may be sensitive even when no document text is present. Custodians choose where exported bundles go.
- Private signing keys remain local and are never returned by the MCP reader. License keys remain in operator configuration or environment and are not placed in signed rows or MCP responses.
- Session startup and explicit activation resolve licensing. Paid live sessions send bounded seat renewals outside hooks. Those requests include a license key and derived machine/session identifiers; the licensing service maintains the active-seat window. Do not claim that every plugin operation is offline.
- Policy editing is a separate, explicit operator workflow. The four MCP audit tools do not change policies, license state, records or external services. The two score tools change nothing locally; `agent_score` is the only MCP tool that makes a hosted request, only with the user's consent, and that request carries the five questionnaire answers and the report-link choice, never the local policy, the decision ledger or the signing key.
- Current public privacy and terms pages, the selected business identity, dependency rights and the exact portal attestation wording require publisher confirmation. No box has been checked on the publisher's behalf.

## Verification status

Local automated evidence: the eight primary scenarios, five supplemental regressions and three supporting catalog/privacy/annotation tests pass on Node 22. All execute with socket creation and fetch guarded against use. Real signatures are generated at test time, and verification uses the installed Spend SDK. Existing `tests/mcp.test.cjs` and `tests/seat-status.test.cjs` provide additional audit and seat-status regressions, and `tests/agent-score.test.cjs` covers the score tools with a mocked service: origin validation, consent, answer validation, the request options, the response cap, strict result parsing, failure reasons and tool-error signaling.

Pending: agreed directory path for local hooks and stdio MCP; portal account role and verified business selection; portal upload, skill scans and tool scans; link and branding review; live skill interactions in supported hosts; reviewer demo URL; requested real screenshots; publisher policy attestations. This pack does not make those steps complete.
