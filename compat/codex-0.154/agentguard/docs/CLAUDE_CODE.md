# Claude Code adapter

The shared package adds Claude Code 2.1.275 without renaming its repository
or npm package. The runtime, license gate, skills, signing keys and ledger
format are shared code. Each host normally has its own plugin data directory.

## Released contract

Claude discovers `.claude-plugin/plugin.json`, `hooks/hooks.json`,
`.mcp.json` and the four `skills` directories at the package root. The
manifest does not repeat default component paths as additional sources.
The public `.claude-plugin/marketplace.json` selects that root. Codex keeps
its existing generated compatibility directory and hook source path.
[Plugin reference](https://code.claude.com/docs/en/plugins-reference).

Command hooks use the regular-expression matcher `.*`. A policy denial uses
`hookSpecificOutput` with `hookEventName: PreToolUse`,
`permissionDecision: deny` and a one-line `permissionDecisionReason`.
Burn's STOP box and its refusal of an agent override keep Burn's own lines.
A Burn STOP in default, acceptEdits, auto or plan mode returns
`permissionDecision: ask` with Burn's three-line reason, which Claude Code
shows to the person in its own permission prompt and not to Claude.
An admission returns an empty successful object, preserving Claude's own
permission checks. Internal failures also abstain and attempt to record a
fail-open event. Successful and failed calls have separate receipt events:
PostToolUse and PostToolUseFailure.
[Hook inputs and outputs](https://code.claude.com/docs/en/hooks).

## Payload normalization

The following mapping is exercised against stdin captured in a live 2.1.275
session. The committed fixture documents its deterministic redactions. Raw
capture files and authentication state are excluded from the distribution.

- `session_id`: Authoritative session identifier.
- `tool_name`: Recorded tool name and capability lookup.
- `tool_use_id`: Link a decision to its outcome.
- `tool_input`: Compute a keyed HMAC-SHA256 digest, serialized byte count and key count in memory.
- `transcript_path`: Pass the locator to Burn for local usage observation.
- `cwd`: Find an applicable standalone Burn hook.
- `permission_mode`: Decide whether a Burn STOP waits for the person (default, acceptEdits, auto, plan) or is refused (bypassPermissions, dontAsk, absent). Only this bounded identifier reaches the worker.
- `hook_event_name`: Distinguish a failed tool from a successful receipt event.
- `tool_response`: Measure serialized output bytes without retaining output text.
- `agent_id`: Preserve the host's subagent identifier when present.
- `duration_ms`: Use a finite nonnegative host duration when provided.
- `error, is_interrupt`: Record failure from PostToolUseFailure without retaining error text.
- `prompt` (UserPromptSubmit): Test against the configured `untrustedOrigin.inboundMarkers` in memory. Only whether it matched, the prompt id and a keyed digest of a frame sender reach the worker; the prompt is never stored, logged or hashed, and the hook prints nothing.
- `transcript_path` (UserPromptSubmit and PreToolUse): Read the tail of the transcript (256 KB) for the newest user entry's structural `origin.kind`, its time and prompt id. Entry text is never read out. The field is undocumented; when it is missing the untrusted-origin mark stays.

Host-specific normalization lives in `runtime/common.cjs`. New metadata adds
`host` to the existing schema. Readers accept older rows without it and label
their host unknown. They do not rewrite or infer a host for an old signature.
Missing duration or Bash exit status is not inferred from output text.

The Bash process used by a skill does not inherit plugin variables just
because hooks do. Claude replaces exact plugin placeholders in skill text;
the documented helper commands pass those paths explicitly. The session
placeholder is passed explicitly too, so a different session's seat status
cannot authorize an export.
[Plugin variables](https://code.claude.com/docs/en/plugins-reference#environment-variables).

## Coverage and Burn coexistence

Bash, Read, Edit, Write and MCP calls reach the policy gates. Agent spawns
reach Burn; the older Task name remains supported. WebFetch and WebSearch
use the read_only minimum tier. Claude omits PreToolUse for EndConversation.
Disabled hooks, non-tool activity and a host crash can leave gaps. Codex
hosted tools have different coverage.
[PreToolUse coverage](https://code.claude.com/docs/en/hooks#pretooluse).

For a matching, recognized standalone Burn command, the plugin records
`burn_external_hook` and defers Burn accounting. This avoids a second spawn
reservation. That observation does not claim to know the external hook's
decision, receipt or policy mode. The plugin never disables another hook.

## Trust and test evidence

Claude Code 2.1.275 installed the public marketplace at commit
`b889b5fc830dae16250c40a6b867e5b90457c28d`. Marketplace addition printed
`Successfully added marketplace: agentguard (declared in user settings)`.
The CLI installation in JSON output mode returned `outcome: ok`,
`plugin: agentguard@agentguard` and `scope: user`, with no separate plugin
trust or permission prompt. This observation does not describe an untested
interactive marketplace selection screen.

The first interactive session displayed “Quick safety check: Is this a
project you created or one you trust?” and offered “Yes, I trust this folder”.
After that normal confirmation, `/hooks` showed “6 hooks configured” and
“This menu is read-only”. The six entries were the two PreToolUse gates,
one PostToolUse receipt, one PostToolUseFailure receipt, SessionStart and
SessionEnd. No permission bypass or trust-file injection was used. The
UserPromptSubmit hook for requests from other agents was added after this
observation, so a current install lists seven hooks.

Claude's `/hooks` menu has no Codex-style per-hook hash trust action. Review
the public source before installation and complete the normal workspace
trust prompt. Installing the plugin permits its local commands to run once
the workspace is trusted and the hooks are enabled.
[Installation](https://code.claude.com/docs/en/discover-plugins),
[Hooks menu](https://code.claude.com/docs/en/hooks#the-hooks-menu),
[Workspace trust](https://code.claude.com/docs/en/hooks#workspace-trust).

From a provisioned public source checkout, `npm run test:hosts` runs the full
suite twice. The host-facing hook, Burn, lifecycle, offline and recovery
tests switch to captured Claude payloads in the Claude run. Generic policy,
license and ledger tests run in both. Explicit Codex compatibility and trust
regressions continue testing Codex in both runs. No test retries a normal
decision through a fail-open result.
