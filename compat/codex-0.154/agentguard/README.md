# AgentGuard for Claude Code, Codex and the ChatGPT desktop app

![AgentGuard: your agents, stopped at the limit. A local plugin that checks every agent action against your policy, asks before runaway sub-agents start, and keeps a signed, content-free record on your machine. Free on one machine.](assets/social-card.png)

When a Claude Code session passes 15 sub-agents in 15 active minutes, 40 in 120 active minutes, or 5 billion tokens, AgentGuard makes the next launch wait for your yes (in Codex, it is refused until you allow it). To see where a session's tokens went, run `npx agentguard-burn why`. AgentGuard runs on your machine and is free on one machine.

[Watch the AgentGuard Burn clip](https://agentguard.run/burn).

You can also limit how deep copies may launch, separately from their total
count. The preset **Copies ask before launching copies** sets `max_depth` to
1. Opt-in helper model routing switches listed helper types to your chosen
model after your session token budget. Kept types and the main session retain
their models. Both additions default off. See [launch policies](docs/LAUNCH_POLICY.md)
for configuration, host limits and the [recorded canaries](docs/LAUNCH_POLICY_CANARY.md).

## Install in Claude Code

```sh
claude plugin marketplace add agentguard-run/agentguard-codex-plugin
claude plugin install agentguard@agentguard
```

Claude Code installs the plugin's dependencies by itself. If AgentGuard says its dependencies are missing, run `npm ci` in the plugin folder it names, then start a new session.

## Install in Codex and the ChatGPT desktop app (local tasks)

```sh
codex plugin marketplace add agentguard-run/agentguard-codex-plugin
codex plugin add agentguard@agentguard
# In the installed plugin root reported by Codex:
npm ci
```

## What this plugin runs, sends and decides

Docs and pricing: [agentguard.run](https://agentguard.run) ([docs](https://agentguard.run/docs), [pricing](https://agentguard.run/pricing)).

### What it sends, and where

- **Team weekly waste causes, only with local opt-in (off by default).** With `AGENTGUARD_TEAM_WASTE=1`, a valid Team license, a registered seat and the person's `totals` or `seat` choice, the detached worker sends at most one previously viewed, completed UTC week per call to `POST https://agentguard.run/api/team/waste`. The license key is the bearer token. Only the saved Burn figures, fixed schema and cause codes, UTC week date, hashed seat id, public key and signature are sent. A separate signed request carries a share choice and its UTC timestamp. Turning sharing off immediately requests removal of the seat's stored weeks, with retries if needed. See "Optional Team efficiency (weekly waste causes)" and [privacy details](https://agentguard.run/legal/privacy#team-efficiency).

- **Free use sends nothing.** With no license key, the hooks, the mod (AgentGuard Live) and the MCP server's local tools open no network connection. There is no telemetry: the Spend library's optional usage beacon is switched off in the only process that could send it, and Burn's optional anonymous install count (`agentguard-burn telemetry on`, off by default, asked once in an interactive `why` report) is never asked for or sent when Burn runs through the plugin.
- **AgentGuard Score, only when you ask and agree.** The `agent_score` MCP tool sends your five questionnaire answers to `https://agentguard.run` (or to the https origin in `AGENTGUARD_SCORE_URL`, if you set one). If you also ask for a report link, the service keeps your answers and score, and anyone with the link can see them.
- **With a license key (Solo or Team).** The plugin's background worker, at session start and while a session is open, sends two requests to agentguard.run: `POST /api/license/validate` with the license key, and `POST /api/license/seats` with the license key, a machine fingerprint, an identifier derived from the session and a fingerprint of the shared policy in use, if any. `AGENTGUARD_LICENSE_ENDPOINT`, if you set it, sends the license check to that host instead.
- **Paid shared policy.** The worker downloads it with `GET https://agentguard.run/api/org/policy`, sending the license key as a bearer token. `push`, only when you run it, uploads your policy settings with `PUT` to the same address.
- **Team daily counts, only when you turn them on (off by default).** With a valid Team license and registered seat, the `AGENTGUARD_TEAM_COUNTS=1` environment variable and `node runtime/counts-sync.cjs on` run in the plugin folder, the background worker sends one request per completed UTC day: `POST https://agentguard.run/api/team/counts`, with the license key as a bearer token. The body is a signed daily aggregate and nothing else: the date, a seat id (a SHA-256 hash of the license key and the machine fingerprint), the day's totals of launches, allowed, asked, said yes, stopped, shadow, unrecorded and unresolved asks, the day's token total, and the public key and signature of the receipt signer. It is sent after the session's closing receipt is written, never while a hook waits, and at most once a minute. `node runtime/counts-sync.cjs off` stops it. See "Optional Team daily counts".
- **Never sent:** prompts, file names or paths, commands, tool input or output, transcripts, session ids and the work receipts themselves. Every signed ledger row, receipts included, stays in the plugin's data folder on your machine.

The license key: in Claude Code, open `/plugin manage`, choose AgentGuard and set its `license_key` option. Claude Code keeps it in your system's credential store and hands it to the plugin's hooks and MCP server. Free needs no key. Codex, and installs that already set a key, keep using `AGENTGUARD_LICENSE_KEY` or the key saved by `activate license` (see "Free and paid features").

### What it runs

- `node runtime/counts-sync.cjs week [YYYY-MM-DD]`, only when you run it, displays and saves the local Burn week. `node runtime/counts-sync.cjs waste status|off|totals|seat` reads or changes the separate local weekly sharing setting. `off` immediately attempts a signed removal request. The worker retries pending removals and uploads already viewed weeks outside hook replies.

Every program starts from a file inside the plugin, with plain arguments:

- `node` runs the hook scripts in `hooks/` (named in `hooks/hooks.json`), the MCP server `runtime/mcp.cjs` (named in `.mcp.json`) and three background helpers the hooks start: `runtime/daemon.cjs`, the worker that checks each call against your policy and signs the ledger; `runtime/session-start.cjs`, which tells the worker that a session started; and `runtime/session-tip.cjs`, which reads the session that just ended with Burn, and that session's signed receipts in the local ledger, to keep one tip and tally line for your next session.
- `node runtime/counts-sync.cjs on`, `off` or `status`, only when you run it yourself, to turn Team daily counts on or off for this installation or show the setting.
- `ps`, at session start, to find the Claude Code or Codex process the session belongs to, so the worker knows when it has ended.
- On macOS, for STOP notifications only: `osascript`, and a small notifier app built once from the bundled Swift source with `xcrun swiftc`, `sips`, `iconutil`, `codesign` and `lsregister`. See "Local STOP notifications".
- `open` on macOS, `xdg-open` on Linux or `cmd /c start` on Windows, only to open an AgentGuard Score report link you asked to open.
- Nothing else. The plugin never runs `npx`, `npm` or another package launcher. Claude Code installs the two locked dependencies, `@agentguard-run/burn` and `@agentguard-run/spend`, from `package-lock.json` when you install the plugin. A STOP tells you to type `! npx agentguard-burn resume` yourself: that is a command for you, and while Burn enforces, the plugin refuses it when the agent tries to run it.

### What the hooks decide, and when

The hooks in `hooks/hooks.json` run on every tool call and at session start and end:

- **PreToolUse** (`burn-gate.cjs`, then `spend-gate.cjs`): the only hooks that decide. They answer `ask` or `deny`: an ordinary call gets no answer from them, so Claude Code's own permission rules and prompts apply as usual. They never answer `allow` in Claude Code. The one `allow` is in Codex, for a launch that opt-in helper model routing changes (below), because Codex applies a changed launch only together with `allow`.
  - The burn gate looks at sub-agent launches (Task and Agent). Over a limit (15 in 15 active minutes, 40 in 120, 5B tokens in a session, or more than two levels deep), it answers `ask` in default, accept edits, auto and plan mode, so Claude Code shows you its own prompt and you decide. Only where no prompt can show (bypass permissions, don't ask and print mode) does it answer `deny` with the STOP box. `"stopStyle": "deny"` in `burn-policy.json` makes it deny everywhere. In Codex, which has no prompt, a launch over a limit is refused until you allow it.
  - Depth limit (opt-in, off by default). With `max_depth` set in your policy (the preset "Copies ask before launching copies" sets 1), a launch deeper than the limit is held the same way: `ask` in Claude Code's default, manual, accept edits, auto and plan modes, and elsewhere, and in Codex, `deny` until you approve that exact launch with `node runtime/policy-cli.cjs pending` in your own terminal. Where the host does not report a launch's depth, the gate adds a one-line notice and the count limits still apply.
  - Helper model routing (opt-in, off by default). With `helper_models` enabled, once the session's recorded tokens pass your `token_budget`, a new launch of a listed helper type, not a kept type, gets the model you chose: the gate returns the launch's own input with only its `model` field changed (`updatedInput`). In Claude Code the permission decision stays as it was, including an outstanding ask. In Codex the change comes with `allow`, and only for default, worker and explorer launches when no custom agent roles are defined in `~/.codex` or the project's `.codex` folders, which the gate reads to check. Where a launch cannot be changed (a Claude Code fork, or another Codex launch), it holds the launch the same way as the depth limit and names the model to choose. The main session, kept types and resumed launches keep their models, and in shadow mode it only records what it would have chosen.
  - The spend gate answers `deny` when your policy refuses a call (a tool outside your allowlist, a spend cap reached or a built-in guard pack rule), and `ask` where a policy rule says to ask you. While Burn enforces, an agent's attempt to lift a STOP itself is denied.
  - What they change: nothing in the call, except the `model` field of a launch that helper model routing changes. They never change any other tool input, and never any output. They add one signed, content-free row to the ledger (for a launch, with its depth, agent type and the requested and chosen model names) and can show a one-line notice.
- **PostToolUse and PostToolUseFailure** (`receipt.cjs`): records whether the call succeeded, its output size and its duration, as a signed row. Decides and changes nothing.
- **SessionStart** (`session-start.cjs`): shows AgentGuard's startup lines and starts the background helper. Decides nothing.
- **SessionEnd** (`session-end.cjs`): asks the worker for the session's work receipt, waits at most one second, and always lets the session end. With Team daily counts on, the worker can send that day's aggregate later, outside the hook.
- **Fail open.** Each hook has two seconds. If it fails, times out or its dependencies are missing, it gives no answer, and the call goes through Claude Code's normal permission flow. The ledger records the call as failed open where it can.

### The mod: what it decides, changes, runs and sends

In Claude Code 2.1.287 and later the plugin also loads a mod, AgentGuard Live. `.claude-plugin/plugin.json` names its hooks file, `live/agentguard-live.json`, which names the module `live/agentguard-live.mjs`. Nothing else in the plugin points at the `live` folder.

- **What it decides: nothing.** Its one permission hook, `tool.check` on Task and Agent launches, runs after the PreToolUse gates and before Claude Code settles the permission. It refreshes the counts, then returns Claude Code's own decision unchanged with `return next(e)`. If anything in that hook fails, the decision still passes on unchanged. On `classic.SessionStart` it notes the new session id and passes the event on unchanged.
- **What it changes:** only what Claude Code draws. It adds a band above the prompt, a stamp under each sub-agent launch row and the sub-agent count to the spinner, and opens the `/agentguard` pane when you type that command. It never changes a prompt, a tool call, a message, a permission or a setting.
- **What it runs:** one program, <code>node &lt;plugin folder&gt;/runtime/mod-status.cjs &#45;&#45;session &lt;session id&gt;</code>, with <code>&#45;&#45;verify</code> added when you press v in the pane. That script reads Burn's session state and the plugin's ledger, changes no file and prints the counts as JSON. It runs at session start, at each sub-agent launch, after each turn, at most every 20 seconds while tokens are being used, and when you press a key in the pane.
- **What it sends: nothing.** It opens no network connection. Its other calls go to Claude Code itself: drawing, registering `/agentguard`, reading the session id and the plan usage Claude Code reports, and a 20 second timer. It reads one environment variable, `AGENTGUARD_LIVE`; `0` turns it off.

## Details

AgentGuard applies tool policies to **every local tool call that Codex,
ChatGPT Work or Claude Code sends through its hook path**, including plugin MCP tools. It
records signed decisions and outcomes locally without retaining tool input
contents or output text. Burn controls subagent spawning and sustained burn;
Spend controls the other calls using tool patterns, capability tiers, and
operator-configured unit costs. These unit costs use the Spend SDK pricing
path with a synthetic accounting unit; token counts in these decisions are
not observed model usage.

### Coverage and limits

The two `PreToolUse` gates and receipt hooks use matcher `.*`.
In Codex, supported paths include Bash, `apply_patch`/Edit/Write, MCP tools,
`update_plan`, `spawn_agent`, and the observed `collaborationspawn_agent` alias. Hosted tools such as WebSearch and web
ChatGPT are outside this hook path. `write_stdin` does not receive another
pre-tool decision for an already-approved shell session, and specialized tool
paths can opt out. The plugin therefore cannot provide universal interception.
See OpenAI's [tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage).

In Claude Code, coverage includes Bash, Read, Edit, Write, MCP tools, Agent
and the older Task spawn name. WebFetch and WebSearch pass through the Spend
gate at the read_only tier. Failed calls use PostToolUseFailure so their
outcomes are recorded too. Claude Code does not run PreToolUse for
EndConversation, and disabled hooks, work outside tool dispatch, and a host
crash remain outside the ledger. Built-in slash commands and model responses
are not tool calls. An allowed Claude gate returns no permission override,
so normal Claude Code permission checks still apply.
See [Claude Code hook events](https://code.claude.com/docs/en/hooks#pretooluse).

When a matching standalone Burn Claude hook is installed, the plugin defers
Burn accounting to that hook and records the deferral. It does not reserve
or charge the spawn twice. Separate installed hooks retain their own policy
and enforcement mode; the plugin does not disable them.


Hooks are **fail-open**. On an internal error, a gate allows the call, exits
successfully, emits a one-line warning, and records a fail-open event when
local storage is writable. A dead process, exhausted disk, inaccessible data
directory, or disabled/untrusted hook can prevent even that record. When the
signed writer is unavailable but local storage works, the client queues
content-free recovery metadata. Those pending records are unsigned and are
not part of the verified chain until the worker recovers them. An absent
receipt is not evidence that a tool was never used. The host can continue after
a hook failure or timeout. Do not use this plugin as the sole access control
for a client document system or payment service.

The warm worker deadline defaults to 250 ms. Set `hookBudgetMs` to an integer
from 250 to 1900 in `policy.json` to change it; values above 1900 ms are capped
to leave 100 ms before the host's two second hook timeout, and a value below
250 is refused by policy validation (a smaller deadline would time out on
ordinary calls and fail open). Cold worker startup keeps
its 1500 ms deadline. These are response budgets, not wall time guarantees:
process startup, scheduling and a stalled operating system can add delay.

Burn's published gateway combines its decision, reservation, receipt and
ledger writes in one synchronous operation. That operation stays inside the
same response budget so reservation and receipt behavior stay intact. The
plugin does not defer or bypass Burn's own writes. Local probes exercise both
gates, including delayed Burn appends, without retrying failed-open calls.

For a law firm using Astra for Law in Codex or ChatGPT Work, the operator can
assign per-matter budgets, limit a document-review session to selected tools,
and deny tools across an ethical wall. The firm keeps the signed,
content-free record in its own environment. These controls describe tool
authorization and recorded activity; they make no claim about legal analysis
or model accuracy. Tool names and actor identifiers can still be sensitive
metadata, so the firm controls access to the policy, signing key, and records.

### Free and paid features

Free is $0 for one machine, with no account or license key: full Enforce,
local signed receipts and Burn. It has no dashboard, receipts export or org
policy. The local policy selects the mode, default enforce. Shadow is a
fallback after a failure, or an explicit policy choice, not a plan.

Solo is $19 per month or $190 per year. Its license key adds up to three
machines with personal policy sync, the dashboard, receipts export and email support. A fourth active
machine selects shadow with `seat_limit`. Multiple sessions on one Solo
machine share its allowance.

Team starts at three seats, at $19.90 per seat per month or $199 per seat per year.
Ten seats remain $199 per month or $1,990 per year: one org policy every
seat runs, seats you add and revoke, one invoice. Team keeps its card trial
and is the only trial. Existing Growth and Pro keys remain supported.

A key adds features and seats; it does not unlock enforcement. A present but
invalid, expired, revoked or over-limit key still selects shadow with its
existing reason. Removing a key explicitly returns to the local Free policy.

With a key, at session start the detached worker resolves the license through
the Spend SDK. It makes one refresh attempt for that session, with a two
second deadline covering validation and seat registration. Hook processes
read only the local result and never open a socket. Without a usable cached
license, they remain in shadow until startup resolution finishes. A previously valid cached license is
retained offline for seven days after `expiresAt`; a server rejection does
not receive that grace. A failed license, seat or org refresh selects shadow
with a reason, even during grace. After grace the paid entitlement expires.
Unknown seat usage remains unknown during an outage.

The key comes from `AGENTGUARD_LICENSE_KEY`, otherwise the policy's
`licenseKey` field. Ask the `agentguard-policy` skill to
`activate license <KEY>` to save it in `policy.json` in the host plugin data directory and resolve
again. The activation helper receives the key on standard input, never in
command arguments or ledger entries. The environment variable takes
precedence over the saved key.

With a failed configured license, each decision records its failure reason
and the engine forces shadow regardless of the requested mode. No key means
Free Enforce, with no license request or anonymous seat registration. Seat registration
uses the existing license seat endpoint at session start. An exceeded startup
seat limit selects shadow with `seat_limit`. Licensing never denies a tool call.

The shared KV service counts Solo's active machines and Team's active heartbeats across machines
within a fifteen minute window. Its storage key has a twenty four hour
lifetime renewed by a heartbeat. The worker sends a bounded heartbeat every
five minutes for each live session, outside hook processes and without
waiting in the decision path. Heartbeat failures, later over-limit responses
and revocation select shadow with a reason. A revoked seat remains shadow
through failures until a successful heartbeat explicitly restores it. Heartbeats stop on `SessionEnd` or when
the identified host process exits. If the worker cannot identify a host
process, it uses a fifteen minute lease renewed by tool activity rather than
renewing an orphaned session indefinitely.

Use `agentguard-status` or the read-only MCP `get_status` tool to see the
recorded host, tier, `seatsUsed`, `seatLimit`, `seatStorage`, `seatsVerified`, expiry, effective
mode, and reason. `seatStorage` is `kv`, `memory`, or unknown. A verified count
comes from a valid shared KV response. Memory fallback is explicitly
unverified and does not establish cross-machine occupancy. After a failed
heartbeat, any retained count is an earlier observation, not a fresh verified
total; `seatsVerified` becomes false. `seatRefreshedAt` identifies the last
well-formed response, while `seatHeartbeatAt` and `seatHeartbeatError` describe
the latest heartbeat attempt. Signature verification stays free. Paid users
can ask `agentguard-verify` for an export, call `export_receipts`, or run
the host-specific local helper command in
[agentguard-verify](skills/agentguard-verify/SKILL.md) to write the signed bundle
locally. Set the destination to a path the operator authorized.

### Install

Use Node.js 22 with Codex CLI or Claude Code on macOS or Linux. Hooks communicate with the
worker through a private filesystem mailbox. Windows support is not verified.

Use the commands at the top to install from the
[public repository](https://github.com/agentguard-run/agentguard-codex-plugin).
In Claude Code, the two commands under
[Install in Claude Code](#install-in-claude-code) are the whole installation:
Claude Code installs locked npm dependencies for cached marketplace plugins
with lifecycle scripts disabled, and the plugin loads them from its own
`node_modules`. In Codex and ChatGPT Work, change into the installed plugin
root after adding the plugin and run `npm ci` to provision the locked registry
dependencies.

The plugin depends on published `@agentguard-run/spend ^0.20.0` and
`@agentguard-run/burn ^0.3.27`. It uses no sibling links. Burn's lockfile
entries include an optional native canvas package for each platform; npm
installs only the one this machine runs, and the dependency check accepts the
others as absent while still checking any that are present. Codex's Git
marketplace installation does not install Node dependencies automatically, so
its explicit `npm ci` step provisions this package and its persistent
dependency copy. Local-directory Claude marketplaces do not install those
dependencies either. When the dependencies are missing, session start says so
and names the plugin folder to run `npm ci` in.
Dependency setup may access npm; the hooks make no network requests.

Keep npm lifecycle scripts enabled for the Codex step. In a Codex cache installation,
the postinstall script also provisions the locked dependencies in the plugin's
persistent data directory. Codex 0.154 can replace its installation cache when
a session starts; the runtime uses this persistent copy if the cache no longer
contains dependencies. A changed lockfile requires running `npm ci` again.
Source checkouts keep their usual local dependencies. For a managed or custom
installation, set `PLUGIN_DATA` to the runtime's private data directory when
provisioning. No dependency downloads happen during a tool call.

#### Codex hook trust

Start a new session, open **`/hooks`**, inspect the session startup and end
commands, both pre-tool gates and the post-tool receipt command, and trust
their definitions. Installing or
enabling the plugin does not perform this review. Trust is pinned to each
definition's current hash, so changed definitions require review again.
User hooks can take precedence over conflicting plugin decisions, and other
matching hooks run alongside these hooks.

See [hook review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

#### Claude Code installation and trust

The Claude marketplace selects the repository root through
`.claude-plugin/marketplace.json`. It loads `.claude-plugin/plugin.json`,
the shared skills and runtime, native `hooks/hooks.json`, and `.mcp.json`.
The generated Codex hook configuration uses the same scripts and omits the
Claude-only failure event.

Review the marketplace and plugin source before installing. Accept the normal
workspace trust prompt only for a directory you trust. Claude Code's `/hooks`
menu is a read-only view of loaded hooks; it does not use Codex's per-hook
hash trust action. Restart the session or use `/reload-plugins` after changing
plugin definitions. Normal tool permission prompts remain in effect.
The shared skills include separate commands for each host. Claude substitutes
its exact path and session placeholders when loading a skill; Bash does not
inherit those plugin variables. Keep the skill's explicit environment
assignments when running activation or local verification helpers. Use the
read-only MCP tools when available.
See [Claude plugin installation](https://code.claude.com/docs/en/discover-plugins)
and [the hooks menu](https://code.claude.com/docs/en/hooks#the-hooks-menu).

Each host uses its own persistent data location. Set the documented plugin
data environment variable explicitly when provisioning a custom installation.
See the [Claude Code adapter and fixture notes](docs/CLAUDE_CODE.md) for field
mapping, coverage and the two-host test commands.

#### Codex 0.154 compatibility

The canonical package follows the portable manifest documentation. Codex
CLI 0.154.0, however, skips hook sources for portable manifests in its
[released loader](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core-plugins/src/loader.rs#L954).
A portable installation can expose MCP tools while its hooks never run.

The public marketplace selects the generated installation at
`compat/codex-0.154/agentguard`. It contains `.codex-plugin/plugin.json` and
`.mcp.json`, with the same hook code, policy, skills, and assets. It omits
the portable root manifest because adding a legacy overlay alongside that
manifest would not change the loader's behavior.

For unchanged inputs, Codex 0.154's
[hook response parser](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/engine/output_parser.rs#L441)
accepts an empty success object but rejects an explicit allow without rewritten
input. Generated compatibility hooks use that empty response for allowed calls.
Denials and signed ledger decisions retain their original values. The portable
hooks retain the documented explicit allow response.

The legacy MCP entry uses a relative working directory because the
[released parser](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/codex-mcp/src/plugin_config.rs)
does not expand plugin environment variables. Its read-only launcher derives
the hooks' data directory from the validated installation cache path using
the [released store layout](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core-plugins/src/store.rs#L131),
or accepts an explicit `PLUGIN_DATA`. It creates no directories.

`npm run build:compat` regenerates the compatibility installation after
canonical source changes. `npm run check:compat` and the tests reject stale
copies. Do not install the canonical portable directory directly into this
CLI release when you expect hooks to run. Future host versions and ChatGPT
Work require their own end-to-end validation.

#### Private workspace marketplace

A firm can use its own marketplace to distribute a reviewed copy internally.
Use `.agents/plugins/marketplace.json` with an `agentguard` entry pointing to
the compatibility installation, register the marketplace with Codex, then
install the plugin from that source. If its marketplace is also named
`agentguard`, the selector remains `agentguard@agentguard`; otherwise use the
firm's marketplace name.

In the desktop app, select that marketplace in the Plugins Directory and
install the plugin in a new chat. Scripts, dependencies, and Node must exist
wherever Work executes them. Surface availability varies; see
[marketplaces and packaging](https://developers.openai.com/plugins/build/plugins).

Making a repository public does not submit the plugin to the universal
directory. Workspace-wide publication through the administrative Plugins
interface is also a separate administrator action.

### Built-in guard pack

Every installation includes 19 default-on deterministic local rules across remote shell
execution, broad recursive deletion, Git history, infrastructure changes,
credential writes and secret arguments, system security, package sources,
secret sends, disk wipes, authentication-file changes, database wipes and
recursive deletion of home subfolders or shared server data.
Shadow mode reports WARN with the rule ID. Free and paid enforce mode report
STOP by default. Raw arguments stay in the hook process. Matching rule IDs
and scan-status reasons join the existing content-free metadata sent to the
local worker and signed records. Errors allow the tool with a reason. The optional
`inbox-reset-codes` rule denies email and messaging connector searches for
authentication codes or account access links. It is off by default and on in
the careful and strict presets.

GP004 (a hard reset) stops when the branch is known to be shared and warns
when the hook cannot tell, which is the default on a fresh checkout, a
detached head or a repository the hook cannot read. A static scan cannot
know whether the discarded commits exist anywhere else, and on the public
coding corpus the shape is almost always a local cleanup of the agent's own
work (24 warnings across 32,161 successful runs, none a shared branch), so a
hard stop by default would cost far more interrupted sessions than it would
save; the git-history incident it maps to was recoverable by the reporter's
own account. An org that wants a hard stop sets `"GP004":"stop"`, and the
careful preset maps an unknown branch to a stop.

An org policy or shared team file can set, for example,
`"guardPack":{"rules":{"GP003":"warn","GP014":"off"}}`. Only the fixed
IDs and `stop`, `warn`, `off` values are accepted; GP020 also accepts `ask`. Personal-only downgrades have
no effect; an omitted org rule remains STOP. Lower files may tighten a downgrade.
See [the rules, merge behavior and matching limits](docs/GUARD_PACK.md).

From the source checkout, run `node scripts/measure-benign.cjs` for the corpus
result and `node scripts/measure-overhead.cjs` for 1,000 real command-policy PreToolUse
invocations over six fixed synthetic calls. The latter includes Node startup,
file IPC and signing, and excludes one worker warmup, the separate Burn hook
and session startup. Model calls and sockets are forbidden. Measured reports
are in `docs/guard-pack-benign.json` and `docs/overhead.json`.

Run `node scripts/verify-dangerous-actions.cjs` from the source checkout to replay
the 93 synthetic decision-model cases through the Free engine. Inputs are never
executed. The updated guards allowed zero of the 30 DENY cases and stopped none
of the 34 ALLOW cases. These results describe this corpus only. Read-only Node
inspection of the bundled default policy is allowed; the operator's policy
commands and policy writes remain protected.

### Configure policy

The runtime reads `policy.json` in the host's plugin data directory. Codex
supplies `PLUGIN_DATA`; Claude Code supplies `CLAUDE_PLUGIN_DATA`. The legacy
Codex MCP launcher derives that same Codex path. When both are explicitly set,
`PLUGIN_DATA` keeps its existing precedence. Each host keeps its own data
unless the operator deliberately points them at a shared directory.
A paid operator can set `teamPolicyFile` in that file, or launch the host with
`AGENTGUARD_PLUGIN_POLICY`, to load a shared team policy. Relative team file
paths resolve from the host plugin data directory. The local license key remains local;
free sessions use the local policy without the shared rules. A missing policy
uses the packaged default: local decisions with no configured monetary charge
or cap. The license gate controls paid features and selects shadow on a failed key; hook
processes only read its local snapshot. Existing license/cache files remain
under the user's configured AgentGuard home. A corrupt policy causes a
recorded fail-open, not a guessed policy.
Burn continues using its existing user policy and ledger under
`AGENTGUARD_HOME` or `~/.agentguard`; this plugin does not run Burn init or
enforce commands. When the plugin enforces and that directory has no
`burn-policy.json`, it writes Burn's shipped policy in enforce mode there once,
before the first spawn it gates; an existing file is never changed. See
[Sub-agent STOP and override](#sub-agent-stop-and-override).

### Customize your policy

Run `node runtime/policy-cli.cjs` from the installed plugin directory with the
current host's plugin data environment. The policy skill supplies those paths.
A new session gives the preset hint once per installation, as a command you
can paste with this installation's absolute paths, for example
`! CLAUDE_PLUGIN_DATA="<data directory>" node "<plugin root>/runtime/policy-cli.cjs" preset careful`
in Claude Code (`PLUGIN_DATA` in Codex). A `!` command runs in your own shell,
which does not carry the plugin's variables, so the command names the data
directory itself.

- `preset solo-dev`: original defaults, no cap, inbox guard off.
- `preset careful`: block force pushes, recognized deploys and rm outside the workspace; $15 daily cap; inbox guard on.
- `preset website`: careful limits with approval before deploys and package publishing, shell page deletion blocked, and page guard GP020 on. Deploys ask instead of the careful preset's block.
- `preset strict`: $5 daily cap; ask for network, deploy or package publish; retain the force push and outside-workspace rm blocks; inbox guard on.
- `show`: effective policy in plain words, including its source and cap basis.
- `set-cap 15 per_day` or `set-cap 5 per_session`: set a dollar cap.
- `block '\bgit\s+push\b[^;\n]*\bmain\b'`: block shell commands matching a JavaScript regular expression.
- `allow '<pattern>'`: allow that command pattern within the current command-rule layer. Built-in guards and Team restrictions still apply.
- `explain inbox-reset-codes` or another rule ID: explain the effective rule.
- `explain page-guard` or `explain GP020`: explain the page guard.
- `push`: explicitly sync policy configuration to your Solo machines.
- `pending`: list the Codex calls that are held for approval, with their tokens, in the operator's own terminal.
- `approve <token>`: approve one exact held Codex call after operator confirmation, in the operator's own terminal.
- `quiet on`: permanently dismiss the weekly STOP invitation, monthly Burn summary, per-version announcement and the tip from your last session on this machine.

Writes validate before an atomic replacement and print a before and after
diff. Presets replace mode, caps, command rules and guard settings, preserving
licenseKey and unrelated fields. Daily caps use UTC; session caps persist by
host session ID. They count configured tool prices, not provider bills;
unpriced tools still count as zero. Matching is deterministic, not a shell
sandbox or analysis of arbitrary programs and aliases.

Strict asks for all shell and connector calls because they can open a network
connection. Claude Code uses its native approval prompt. Codex's hook API does
not support ask, so the call is held and the model is told that the operator
decides. The token is not shown to the model. The operator runs `pending` and
then `approve <token>` in their own terminal. Approval expires in five minutes,
is consumed once, and is bound to the exact session, tool, input hash and
policy. GP020 also binds approval to the scanned file state. Other rules and caps still apply. Only the exact packaged `show` and
`explain` commands, run by the same Node binary with no wrapper, assignment or
quoting, are exempt from the strict ask.

What this guarantees on Codex: approval comes only from the operator's own
terminal. The agent's shell cannot run `approve`, `pending`, `preset`,
`set-cap`, `block`, `allow`, `push` or `quiet`, and any shell command or file
write that reaches the plugin's data directory, the Burn home or the hook IPC
directory is stopped on every host before policy runs. The stop recognizes the
helper and those paths as the shell would see them: after backslash removal,
brace and glob expansion, the current user's tilde form and real-path
resolution with canonical case, in any spelling of a variable that names them,
in a node one-liner, and whenever a command names the policy modules. A
pattern the scan will not walk (a recursive or deep wildcard) is judged by the
directory it starts from. It does not analyze arbitrary programs: a program
that assembles the path at run time from parts the command never spells out is
outside what a hook can see, as is any tool the hooks never see. When a
command cannot be fully parsed, the built-in categories fall back to a
conservative raw-text pass that can over-match ordinary text, and the decision
records scan_incomplete. Keep the data directory outside the workspace and
rely on the host sandbox for that boundary.

`push` uploads a Solo policy through the detached worker. Free prints:

```text
Policy sync is part of Solo: your policy on up to three machines. agentguard.run/pricing
```

The request is `PUT https://agentguard.run/api/org/policy`, with
`Authorization: Bearer <Solo key>`, `Content-Type: application/json`, and
`{"policy":{...}}`. Only allowed configuration fields are selected; licenseKey,
local paths, unrelated settings, receipts, prompts, tool calls and file contents
are excluded. The payload limit is 64 KB. The server returns the existing
`{version,published_at,sha256,policy}` envelope. The CLI and hooks open no sockets.

Solo machines pull from the existing bodyless Bearer GET at session start and
every fifth five-minute heartbeat. The verified snapshot replaces personal
policy settings while preserving machine-local licensing and preferences.
The on-disk local policy is retained for fallback; failed, invalid or unavailable
Solo sync selects it. A sync error itself never denies a call. Failed licenses
still retain their original shadow behavior. The dashboard shows the synced
configuration and each machine's last reported hash. A hash is not proof of
enforcement. After local changes, push again to update the synced policy.

### Website preset and page guard

Run `node runtime/policy-cli.cjs preset website` in your own terminal with the
host's plugin data environment. It retains careful's $15 daily cap, inbox guard,
force push block and outside-workspace deletion block. The `deploy`,
`website-publish` and `package-publish` rules ask before recognized publishing:
Vercel, Netlify deploy, Wrangler deploy or pages, Firebase deploy, gh-pages,
Git pushes to main, master or production, and package publish commands.
Pushes with an implicit destination or all branches also ask.
The `page-delete` rule blocks rm, git rm, unlink, trash tools and moves to Trash
for `.html`, `.htm`, `.md`, `.mdx`, `.astro`, `.vue`, `.svelte`, `.jsx`, `.tsx`,
`.njk` and `.liquid`. Directory operands are checked with a bounded scan.
Website command blocks set `allowOnce: true` and name the rule and the
operator's one-use approval commands. A hard block from another policy layer
still wins. Existing presets keep their original block behavior.
Other built-in guards and caps still apply after approval.

GP020 is off by default and asks in website. It reads a page's current bytes,
reconstructs Write, Edit, MultiEdit, text-editor replacements or a Codex
apply_patch edit in memory, and compares the before and after. It asks when
forms, tables, iframes, video, audio, embeds, objects, images, JSON-LD scripts,
canonical links, capitalized custom components or h1 to h3 headings disappear.
Changing a canonical href also asks. Removing at least three internal links
in one call asks. Markdown headings, tables, images and links are included.
Additions and changes to ordinary text do not ask.

Any change to `robots.txt`, `sitemap*.xml`, `.htaccess`, `_redirects`,
`vercel.json` or `netlify.toml` asks, including creation. The person sees a list
such as "This edit removes: 1 form, 1 table, the <Quiz /> component, 4 internal
links." Removed link destinations appear only in the hook's displayed message.
The signed records and worker messages keep counts by element type and digests,
never page content, component names or URLs. Claude Code uses its native prompt.
Codex holds the call until you run `pending` and `approve <token>` in your own
terminal, then retry the exact edit within five minutes.

Configure independently with
`"guardPack":{"rules":{"GP020":"ask"},"pageGuard":{"internalLinkThreshold":3}}`.
The threshold is a positive integer; the smallest explicitly configured value
across policy layers wins. `show` displays it. GP020 also accepts `warn`, `stop`
and `off` under the usual guard policy merge rules.

Limits: this is lightweight string scanning, not a browser or a full language
parser. It checks the agent's edit tools; shell rewrites such as sed are not
parsed. Unknown editor formats, generated markup, JavaScript runtime behavior
and same-type element replacements can evade a count comparison. Internal
links are relative destinations, excluding fragments, query-only links and
absolute URLs. Files over 2 MB are skipped with a notice. Symlinks, unreadable
files, unsupported edits, ambiguous replacements and scan limits fail open
with a notice and a content-free event. A call checks at most 32 files with a
100 ms scan budget. Concurrent changes after the hook returns are outside its
control. The website profile in `scripts/measure-overhead.cjs` measures real
hooks, including a 2 MB page, IPC and signing, against a 250 ms warm p95 budget.
See the [1,000-call measurement](docs/website-overhead.json), including the maximum
wall time and source hashes. Use the documented native Node.js 22 runtime.

### Published org policy

Team (three or more seats) and 50-seat owners can publish a versioned policy in the
[dashboard](https://agentguard.run/dashboard/org-policy). Solo has no published
org policy. The detached worker fetches the root policy at session start,
alongside license refresh, and every fifth five-minute heartbeat. Hooks,
lifecycle helpers, activation helpers and status reads never open a socket.

The worker validates the shared field allowlist and SHA256 of recursively
key-sorted JSON, then atomically saves the last good envelope in
`${PLUGIN_DATA}/org-policy.json`, bound to the license fingerprint. Failed
fetches keep that copy, including through the existing seven-day grace,
and select shadow with a reason. No tool is denied because licensing or
org state is unavailable. A successful 204 means this license has no org
policy; any retained copy on disk is ignored.

- `allowedTools`: A tool must match an expression in every supplied list. An absent list adds no restriction; an empty list matches nothing.
- `deniedTools`, `ethicalWall`: Union of patterns, at root and within each session.
- `maxCapability`: Lowest ceiling across layers; session ceilings also apply.
- `caps`: Append all caps. Matching root and session caps apply together.
- `mode`: Org enforce, including its default, cannot be lowered locally. A lower layer may tighten org shadow to enforce. Licensing and failures still select shadow.
- `toolRules`: Local, then team, then org; matching org fields win.
- Identity and payment classification: Org values and its documented tenant/payment defaults are authoritative. Org default matter and explicit session mappings cannot be redirected locally.

For example, publish:

```json
{"version":1,"mode":"enforce","allowedTools":["^mcp__documents__.*$"],"deniedTools":["^mcp__documents__delete$"],"maxCapability":"data_write","caps":[{"window":"per_day","amountCents":500}]}
```

A local policy asking for shadow, `allowedTools: [".*"]`, no denies,
`maxCapability: "payment_execute"` and a larger cap does not loosen this
root. With healthy licensing, only matching document tools pass the
allowlists, delete remains denied, the ceiling remains data write, and both
caps apply. If a refresh fails, the same rules can record what they would
have blocked, but the call is allowed in shadow.

The published policy uses only the documented identifiers, expressions,
enums and numeric settings. `licenseKey` and `teamPolicyFile` remain local
and are rejected in published policies. Unknown fields at every level are
rejected. Identifier length is at most 128, expressions at most 512, and
lists or session maps at most 256 entries. See the
[wire contract](docs/ORG_FEATURES_CONTRACT.md).

AgentGuard's server is a control plane for policy, not data. It stores the policy your admin writes, which seats are licensed, and which policy version each seat last reported. It never receives a tool call, a prompt, a file, or a receipt.

Heartbeats contain exactly the license key, machine fingerprint, derived
process identifier and loaded org policy hash. An admin can label a machine
on the server, invite a teammate by license email, or revoke and restore a
seat. Labels are never sent to the machine. Revocation selects
`seat_revoked` shadow on the next heartbeat, never a denied call.
A matching hash does not attest enforcement. Pending invites cannot be
attributed to a person using a shared license key.

Use `agentguard-policy` to author policy examples. These are illustrative
configuration amounts, not measured charges:

```json
{
  "version": 1,
  "tenantId": "example-firm",
  "mode": "enforce",
  "maxCapability": "data_write",
  "defaultMatterId": "matter-example",
  "allowedTools": ["^mcp__imanage__(search_documents|read_document|save_document)$", "^update_plan$"],
  "deniedTools": ["^Bash$"],
  "ethicalWall": ["^mcp__restricted_matter__.*$"],
  "toolRules": [
    {"pattern": "^mcp__imanage__save_document$", "capability": "data_write", "unitCostCents": 2}
  ],
  "caps": [
    {"selector": {"taskId": "matter-example"}, "window": "per_day", "amountCents": 500, "action": "block"},
    {"selector": {"agentId": "reviewer-example"}, "window": "per_day", "amountCents": 100, "action": "block"}
  ],
  "sessions": {
    "session-example": {
      "matterId": "matter-example",
      "agentId": "reviewer-example",
      "ethicalWall": ["^mcp__other_matter__.*$"],
      "caps": [{"selector": {"sessionId": "session-example"}, "window": "per_day", "amountCents": 50, "action": "block"}]
    }
  }
}
```

Tool patterns are case-insensitive JavaScript regular expression strings; anchor names when
exact matching matters. `paymentPattern` is a configurable case-insensitive
expression matched against the MCP server/tool names or a local tool name.
Matching calls claim `payment_initiate`; Bash and file-changing tools claim
`data_write`. `toolRules[].capability` can raise a call's classification,
`requiredCapability` sets a required tier, and `maxCapability` limits the
session's permitted tier. Explicit denies, ethical-wall entries, and
allowlists are independent policy checks. The default monetary cost of an
unpriced tool is zero: a cap cannot constrain unknown third-party charges.

For `mcp__imanage__save_document`, the call's provider is `imanage` and model is
`save_document`. `actor.taskId` carries the matter identifier and
`actor.sessionId` carries the host session ID. Agent attribution uses a host
`agent_id` when present, then an operator session mapping, then the session
ID. A host that provides no subagent identity cannot produce independent
per-subagent accounting without an operator mapping. Policies contain
identifiers and patterns only; never paste documents, prompts, client names,
or provider credentials into them. The activation helper's `licenseKey` is
the sole credential exception and is never copied into the ledger. Protect policy files from agent modification when
they serve as firm controls.

### Records and optional MCP server

The signed decision chain is stored at
`${PLUGIN_DATA}/ledger/decisions.ndjson` in Codex and
`${CLAUDE_PLUGIN_DATA}/ledger/decisions.ndjson` in Claude Code. Records include the tool name,
input SHA-256, encoded input/output byte counts, actor identifiers, decision,
and outcome. They never include `tool_input` or tool output text. Outcomes
link to the pre-tool decision ID. Duration uses host timing when supplied;
otherwise it is elapsed pre/post time and includes scheduling delay.
Explicit error flags and structured exit codes determine success or failure.
Codex 0.154's unified Bash hook sends only raw output, omitting its exit code;
those receipts record `status: "unknown"` and `success: null`. The plugin never
parses command output to guess success. See the
[released hook response implementation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/context.rs#L404).

Before replying, the worker signs and writes each complete plugin ledger row
to the operating system; a later asynchronous sync confirms a durable chain
head, so a crash or power loss can lose an unconfirmed tail. On restart it
verifies surviving rows against that head, discards only an incomplete final
row beyond it, and appends a signed integrity event when surviving evidence
shows an unconfirmed tail or sync failure; complete invalid rows are never
silently repaired.

An existing ledger without a durability checkpoint receives one conservative
integrity event on its first startup. Its original signed rows stay intact.
Integrity events appear separately from tool decisions in status reports.

#### AgentGuard Verified

Run `node runtime/attest.cjs` in the installed plugin folder to create a signed
public summary of the last 30 days, or ask the policy skill to `attest my agent`.
Free includes this command. It verifies the entire retained ledger before
selecting the host's period, reads the effective local policy and signs with
the existing Ed25519 key. It opens no network connection or worker and does
not change the ledger, policy or keys.

<pre><code>node runtime/attest.cjs &#45;&#45;days 7 &#45;&#45;label "Public Team" &#45;&#45;out attestation.json
node runtime/attest.cjs verify attestation.json
</code></pre>

The days option accepts only 7 or 30. A label is optional and deliberately
public: 1 to 60 ASCII letters, digits, spaces or hyphens, with no blank label.
Without the out option, the command prints JSON. With it, the command creates
a new file and refuses to overwrite an existing file. Verification is offline,
prints facts in plain words and exits nonzero on an invalid schema or signature.

These are the exact JSON fields. All are required except `label`; unknown
fields are rejected at every level.

- Bundle: `schema`, `pluginVersion`, `host`, `windowStart`, `windowEnd`,
  `createdAt`, optional `label`, `limits`, `counts`, `chain`, `publicKeyHex`,
  `signerFingerprint`, `signature`.
- `limits`: `mode`, `preset`, `caps`, `subAgentLimits`, `guardRules`.
- Each `limits.caps` item: `window`, `amountCents`, `action`, `scope`.
- `limits.subAgentLimits`: `mode`, `spawnRate`, `fanout`, `maxDepth`,
  `launchMaxDepth`, `sessionTokenLimit`.
- `limits.subAgentLimits.spawnRate`: `count`, `windowActiveMinutes`, `enforced`.
- `limits.subAgentLimits.fanout`: `count`, `windowActiveMinutes`.
- Each `limits.guardRules` item: `id`, `action`.
- `counts`: `allowed`, `asked`, `approved`, `denied`, `failOpen`.
- `chain`: `firstSequence`, `lastSequence`, `entries`, `ok`.

The schema value is `agentguard.attestation.v1`. Times are UTC with milliseconds.
The signature covers every other field in recursively key-sorted canonical
JSON. Counts and sequence bounds cover only the selected host and period;
sequence bounds can contain gaps from excluded rows. Approved counts are a
subset of asks linked to recorded outcomes. Denied counts are policy stops,
never guessed human refusals. Scoped caps omit their selectors and session
names. Only fixed built-in guard identifiers are published. No commands,
paths, filenames, session IDs, usernames, prompts or model text are included.

**What it proves and what it does not:** the local signer attests that the
retained record is intact and the listed limits were in force at creation.
The offline verifier proves the summary has not changed under the included
public key. The private ledger is not included, so the recipient cannot
independently repeat its chain check. This does not prove the work was good,
the signer's identity, complete activity capture, continuous enforcement,
or unchanged policy throughout the reporting period. Shadow remains shadow;
enabled rules do not imply enforcement while in shadow mode.

The pure synchronous export is `verifyAttestation(bundle)` from
`runtime/attestation-schema.cjs`, also re-exported by `runtime/attest.cjs`.
It returns a boolean, reads no files or clock and makes no network calls. A
Node-based site can reuse it directly. See the
[attestation reference](docs/ATTESTATION.md) for count definitions and limits.

#### Get your free AgentGuard Score

If your agent pays for things or gets paid, AgentGuard Score checks whether it
has four basic controls: an accountable human, funds behind controls the agent
cannot change, transaction limits and an audit trail. Ask for the
`agentguard-score` skill: five questions, about a minute, and you get a score
out of 100, the specific fixes, and, only if you ask for one, a hosted report
link you can show a payment provider or a marketplace, free. It scores what
you report and verifies nothing.

Local policy enforcement and decision records stay on your machine. AgentGuard
Score is the only MCP tool that makes a hosted request. Paid licensing, seat
renewal and optional policy sync are separate network features. Score requests
do not include your local policy, decision ledger or signing key. The skill
names the exact service origin before you agree, and the report link is a
separate choice: it stores your answers and score on the service and is visible
to anyone who has the link.

The optional local MCP server exposes only:

- `get_status`: report license tier, seat count, limit, storage and verification status, expiry, effective mode and reason alongside today's decisions, configured spend, blocks, integrity events, and fail-open health.
- `list_decisions`: read a bounded page of signed entries.
- `verify_chain`: verify chain hashes and signatures on every tier.
- `export_receipts`: with a valid paid license, return a bounded JSON bundle for the caller to save.
- `get_work_receipt`: return a finished session's [work receipt](#work-receipts) (the latest by default) with its signature and the chain status. Offline.
- `agent_score_questions`: return the AgentGuard Score questionnaire and `serviceOrigin`, the validated address the answers would go to, so the agent can ask the user first. Offline.
- `agent_score`: with the user's explicit consent, send the five questionnaire answers to the AgentGuard Score service at that origin and return the score, tier, breakdown and recommendations, plus a report link only when `createShare` is true. This is the only MCP tool that makes a hosted request, and it is not read-only: a requested report link is stored by the service.

AgentGuard Score is a self-reported check of four controls around an agent
that moves money: an accountable human, where the funds sit, transaction
limits and an audit trail. The `agentguard-score` skill asks the five
questions, asks separately about a report link, asks for consent naming the
service origin, and calls `agent_score`. Score requests do not include the
local policy, the decision ledger or the signing key. By default the call goes
to https://agentguard.run. Set `AGENTGUARD_SCORE_URL` to an https origin with
no path to point it elsewhere; anything else makes the tool refuse rather than
fall back. The request refuses redirects, sends no credentials or referrer, and
reads at most 64 KB of response under one timeout. A result that is not a
complete, well-formed score is refused, and a refused or failed call is
returned as a tool error with its reason. A network failure is reported as
"no usable result was received"; the tool never retries on its own.

The server does not change policies, write exports, or operate tools on your
behalf. In Codex, disable it while retaining the hooks through the plugin-scoped
setting for the installed plugin (for this marketplace, `agentguard@agentguard`):

```toml
[plugins."agentguard@agentguard".mcp_servers.agentguard]
enabled = false
```

Status reports signed UTC-day fail-open events separately from pending audit
recovery. Pending counts cover all dates and can include duplicates from a
partly recovered batch; they are unsigned/unverified, not an additional
verified failure total.

Status also reports fail-open count and rate over the last hour and since
the worker started. Each pre-tool gate invocation counts once, including
an allow when that gate does not govern the tool; post-tool calls are reported
separately. A client timeout and a late worker response share one request ID.
Either rate above 5 percent produces a one-line warning naming a known cause.
These operational counters are unsigned and may lag the signed ledger; status
labels an incomplete or truncated denominator instead of treating it as exact.

Use `agentguard-status` for the UTC day summary and `agentguard-verify` for a
custodian export. Preserve the verification public key through a trusted
channel separate from the bundle. A self-contained key proves consistency
with that key, not who controlled it. Exporting the chain does not export the
signing private key.

### Managed installation and fail-closed firms

See [Enterprise installation](docs/ENTERPRISE_INSTALL.md) for reviewed config
trust and managed hook delivery examples.

OpenAI supports administrator-managed hook configuration in
`requirements.toml`, with `features.hooks = true`,
`allow_managed_hooks_only = true`, and an absolute `hooks.managed_dir` (or
`windows_managed_dir` for a separately supported implementation). This
package currently uses the macOS/Linux path. MDM must distribute the reviewed scripts, Node, and
dependencies; Codex does not distribute them. Managed hooks are trusted by
policy and cannot be disabled through the user hook browser. Setting managed
hooks only excludes plugin hooks, so the administrator must install the
equivalent managed hook entries. See the
[managed hook configuration](https://learn.chatgpt.com/docs/hooks#managed-hooks-from-requirementstoml)
and [managed configuration documentation](https://developers.openai.com/codex/enterprise/managed-configuration).

The administrator installs the reviewed package and Node 22 through MDM,
then configures two `PreToolUse` commands and one `PostToolUse` command with
matcher `.*`. Use absolute script paths under the managed directory, and
set `PLUGIN_ROOT` plus a private per-user `PLUGIN_DATA` directory for each
command. Managed commands do not inherit plugin-specific paths simply
because they invoke these scripts. The reviewed commands are
`hooks/burn-gate.cjs`, `hooks/spend-gate.cjs`, and `hooks/receipt.cjs`.

License resolution also needs the reviewed session startup command. It
uses private file IPC to ask the detached worker for the bounded license refresh
outside the hook process. Include that startup entry when delivering managed
hooks; the tool gates only consume its saved result. Include the reviewed
`SessionEnd` command so a closing session removes its local heartbeat entry.
The worker maintains seat heartbeats outside those hook processes.

Managed delivery does **not** change these scripts' fail-open contract or
make the host fail closed on crashes or timeouts. Firms requiring fail-closed
access must enforce authorization at the document/MCP/payment service or
another control outside the agent hook, with their device administrator
managing delivery and availability. Copying this plugin into MDM alone is
insufficient. No managed configuration is installed by this package.

### Validate locally

From a source checkout:

```sh
npm ci
npm run build:compat
npm run check:compat
npm test
```

The test launcher always sets notification suppression and a fresh temporary
AgentGuard home, including for spawned workers. It checks the real
`~/.agentguard` before and after the suite and fails if files, contents or
modification metadata changed. It removes its temporary home afterward.
Both `npm test` and `npm run test:claude` use this launcher.

Tests use synthetic tool contents and isolated data directories. Warm gate
timing is measured against the already-running local worker; process startup,
the first dependency load, and disk failures are distinct from a warm
decision. No hook performs network requests. Read the measured test output
for the current machine rather than treating a timing target as a guarantee.

Run `node scripts/probe-hooks.cjs 12` from a source checkout for a fresh,
isolated warm probe of both gates. It prints wall timings, fail-open counts,
load averages and signed chain verification without retrying calls. The test
suite also runs 20 warm calls per gate while delaying disk operations by
40 ms; zero fail-opens is required. Synthetic policies and license snapshots
stay in scratch directories, and the probe makes no network requests.

### Publishing

The maintainer source checkout is the source of truth. Make changes there,
regenerate the compatibility installation, and run the tests before syncing.
Set `PUBLIC_CHECKOUT` to the local public checkout's root directory:

```sh
npm run build:compat
npm test
scripts/sync-public.sh "$PUBLIC_CHECKOUT"
```

Review the public checkout's diff and run its tests before committing. The
sync command prepares the public files; publication is the maintainer's
separate signed commit and push to
[agentguard-run/agentguard-codex-plugin](https://github.com/agentguard-run/agentguard-codex-plugin).
Do not edit generated compatibility copies directly. Repository distribution
does not run npm publish, deploy a service, or submit a directory listing.

### Packaging choices

The canonical `plugin.json` uses the portable Agent Plugins schema with OpenAI settings in
`extensions.com.openai`. `mcp.json` declares a local stdio transport. The
empty `.app.json` reserves the registered-app mapping without claiming a
registered external server. `Productivity` is the documented category used
for this governance workflow; the cited packaging page provides no dedicated
security category. Asset sizes are listed in [assets/README.md](assets/README.md).

The license terms are the same as the Spend package; see [LICENSE](LICENSE).

Say yes once to the full visual report and it opens in your browser the moment the score is ready: the score ring, the breakdown bars and every fix, at an agentguard.run address. Nothing opens unless you said yes, and `AGENTGUARD_NO_BROWSER=1` turns it off.

## Sub-agent STOP and override

Burn's limits apply from the first session. Burn's own first-run default is shadow, so without a policy file it would record each STOP and refuse none. When this plugin enforces and `burn-policy.json` is missing from `AGENTGUARD_HOME` (default `~/.agentguard`), the plugin writes Burn's shipped policy there in enforce mode, once, before the first spawn it gates: file mode 0600, directory 0700, recorded as one `burn_policy_seeded` row in the plugin's signed ledger. An existing policy file is never replaced, so a machine where you chose shadow (`npx agentguard-burn shadow`) stays in shadow until you run `npx agentguard-burn enforce`. The shipped limits are 15 sub-agents in any 15 active minutes, 40 in any 120 active minutes, 5B tokens in one session, and sub-agents at most two levels deep.

What happens at a limit depends on where the session runs:

- Claude Code in default, accept edits, auto or plan mode: the launch waits behind Claude Code's own permission prompt. The prompt names the one limit that fired, the session so far, and asks "Allow this one launch? If you say no, nothing starts." Claude Code shows that text to you, not to Claude, and since Claude Code 2.1.211 auto mode cannot approve it on its own. The plugin's signed decision is a block with `asked: true` and the permission mode; if you say yes, the launch's outcome links to it.
- Claude Code in bypass permissions or don't ask mode, print mode, and Codex: the launch is refused with Burn's STOP box, which names the limit with its real number and window, the session so far, what to do, and how to continue once. `"stopStyle": "deny"` in `burn-policy.json` refuses outright in every mode.

To continue once, you run Burn's override yourself, exactly as the box prints it: `npx agentguard-burn resume` for one launch, with your reason. In Claude Code the box puts `!` in front; a `!` command runs in your own shell and never passes through a hook. In Codex, run it in a terminal. Both work on a plugin-only install, which never puts `agentguard-burn` on your PATH. Every override is written to Burn's decisions ledger with its reason, and the line after the launch names the limit it passed.

The agent cannot lift a STOP itself. While Burn enforces, the plugin refuses an agent shell command that runs Burn's `resume`, `shadow` or `calibrate` in any form (through `npx`, `agentguard-burn`, or node running Burn's `cli.js`, including quoted, wrapped and nested forms), or that names `override.json` or `burn-policy.json` in the AgentGuard home, and any file tool write to those two files. The agent is told to ask you to run the override yourself. The command text stays in the hook process; the signed row records only `burn_override:command` or `burn_override:file`. With Burn in shadow there is no STOP to lift, and the AgentGuard home stays protected as plugin state as before.

## Local STOP notifications

On macOS, AgentGuard can show a local notification for an enforced STOP. A recognized Burn limit gets the title "AgentGuard stopped a sub-agent launch"; a spend cap or policy rule gets "AgentGuard stopped a tool call". The subtitle explains the reason. Burn limits and known spend windows use plain words, such as "Too many sub-agents at once" or "Daily spend cap reached". Policy stops use the engine's summary with the leading STOP label removed, or a generic safety or policy reason if no summary is available. Some policy summaries can still contain technical reason codes.

The body points you to the terminal for details and gives the next step for that kind of stop:

- Burn limit: the notification asks you to type <code>! npx agentguard-burn resume &#45;&#45;once &#45;&#45;reason "why"</code> to allow one launch. Supply your own reason and type the command yourself. The agent cannot lift the STOP for you.
- Spend cap: raise the cap in your AgentGuard policy, or wait for it to reset.
- Policy rule: if the stopped action was intended, change the rule in your AgentGuard policy.

Alerts are limited to one every 10 minutes for each plugin data folder. Further stops during that cooldown are counted; the next eligible STOP alert says how many more stops occurred. There is no scheduled catch-up alert when the 10 minutes end. Stops while alerts are muted or turned off are not added to the count. With the notifier app, a new alert replaces the previous one.

The app offers **Mute 10 minutes**, **Mute 5 minutes**, **Mute 30 minutes**, **Mute 1 hour** and **Turn off AgentGuard alerts**. macOS shows the first action as a button and the others under Options. Your choice is saved in `notify-state.json` in the plugin data folder. Muting does not shorten the 10-minute cooldown. Setting `notifyOnStop: false` in the plugin policy disables both the app and AppleScript alerts; the policy default is `true`. These choices leave enforcement unchanged.

The notifier is a small app built from the bundled source on your Mac into `~/Library/Application Support/AgentGuard/AgentGuard.app`. The first eligible STOP starts the build in the background if the Xcode command line tools are available. Until a current build is ready, or without those tools, the existing AppleScript notification shows the same words, with the reason and next step together in the body. That fallback has no AgentGuard buttons or replacement identifier. The app requests macOS notification permission. The notifier and its build make no network requests.

A launch waiting for your answer in Claude Code does not notify: the prompt is already in front of you. Shadow decisions and other platforms do not notify. Repeated delivery of the same signed decision does not notify again. Test runs never post desktop notifications: `NODE_TEST_CONTEXT` with a value or `AGENTGUARD_NOTIFY_SUPPRESS=1` suppresses real notification calls.

Free upgrade moments are local display only. After an enforced STOP, one Solo line can appear separately from the block reason, at most once in a rolling seven-day window. Burn status shows UTC month-to-date local counts and one Team invitation per month. SessionStart announces each plugin version once, and once per machine says AgentGuard is on, what the limits are and how to see where a session went (`! npx agentguard-burn why`); that line waits while this machine is in shadow or the plugin's dependencies are missing. When a session ends, a detached process reads its transcript with Burn and keeps the one tip `npx agentguard-burn why` would end it with, except that where `why` points to this plugin the tip names the action a STOP gives instead ("Give related work to one sub-agent instead of several."); the next new session (a startup or `/clear`, not a resume or compaction) shows it once, after every other line, as "AgentGuard tip from your last session: ...". The same words are not shown twice within a day, and the hooks themselves never read a transcript. If Burn ignores `burn-policy.json` (bad JSON, no "mode", no "thresholds"), enforcement is off, so session start says so first, in Burn's own words, even with `quiet on`, and the "AgentGuard is on" line waits until the file is fixed. `quiet on` shares a permanent local marker with Burn under `AGENTGUARD_HOME` or the default AgentGuard home; presets do not reset it. No request, decision reason or receipt contains upgrade copy.

## AgentGuard Live in Claude Code

In Claude Code 2.1.287 and later, the plugin also loads a Claude Code mod, `live/agentguard-live.mjs`, with nothing more to install. A band above the prompt shows how close the session is to its limits, for example:

```text
AgentGuard  sub-agents 12 of 15 · tokens 1.2B of 5B · weekly 76% · /agentguard
```

The band leads with the sub-agent window closer to its limit (15 in 15 active minutes, or 40 in 120), then the session's tokens against the 5B limit, the share of tokens that went to sub-agents once one has run, and the highest plan limit Claude Code reports. A count turns into a yellow pill at 70% of its limit and a red one at the limit. Under each sub-agent launch in the conversation, AgentGuard stamps its word on Claude Code's own row from the gate's signed ledger row: ALLOWED, ASKED YOU, YOU SAID YES or YOU SAID NO, or STOPPED, with the count at launch and the row's number, and while Claude works the spinner carries the sub-agent count. `/agentguard` opens a pane with both windows, this session's sub-agent launches, asks and stops, newest first, each one a row in the signed ledger, and a key that verifies every signature in the ledger on this machine.

The mod reads and draws; it decides nothing (see "The mod: what it decides, changes, runs and sends" above). The numbers come from `runtime/mod-status.cjs`, which reads Burn's own session state with Burn's own window sums and this plugin's ledger through the read-only reader, and changes no file. Enforcement stays in the hooks above, so Codex, older Claude Code and `claude -p` behave exactly as without the mod. Where nothing is drawn (`claude -p`, the VS Code chat panel) the mod does no work. To turn the band and pane off, set `AGENTGUARD_LIVE=0`; the limits still apply. Anthropic can also turn installed mods off remotely; while it does, Claude Code skips the mod, and the hooks keep enforcing the same limits. `claude plugin validate` lists every event the mod hooks and every call it makes, and `claude plugin test` runs its tests.

## Work receipts

AI pricing is moving from paying per token to paying per result, and a deal priced on results needs a record of what an agent did that both sides can trust. At the end of each session, AgentGuard adds one row to its signed ledger, a work receipt (`session_receipt`), that sums the session up in counts. It is signed and hash-chained like every other row, so changing or removing it breaks verification.

A receipt holds:

- the session id, on the row as on every other row of the session;
- `firstActivityAt` and `lastActivityAt`: the first and last activity in the session, from AgentGuard's own rows and the model responses Burn read;
- `tokens`: the tokens Burn recorded for the session. Claude child transcripts are included. Codex totals cover the delivered session transcript and carry `tokenCoverage: estimated`; other child threads can be absent;
- `subagents`: `started` (each sub-agent transcript of the session), `finished`, and `endedWithoutFinishing` (failed, killed or stopped, and never completed or resumed), as Burn reads them;
- `decisions`: AgentGuard's decisions on the session's tool calls, one per call, by result: `allowed` (let through without asking), `asked` (held for your answer), `saidYes` (asked, and the call then ran), `saidNo`, and `stopped` (refused);
- `burnPolicyMode`: the mode in Burn's policy file, `enforce` or `shadow`, when the file exists;
- `pluginVersion`.

It never holds a prompt, file path, file name, command, repository name, tool output or any other content. The worker builds it from counts it already keeps and from Burn's counts, and the reader refuses a receipt with any other field. A count AgentGuard cannot prove is left out, never guessed and never set to 0:

- Claude Code does not tell hooks when you refuse a prompt, so `saidNo` appears only when every ask ran, and it is then 0. Otherwise `asked` minus `saidYes` is the number of asks that never ran: refused, or the session ended first.
- In Codex, recorded token totals carry estimated coverage. Missing usage and sub-agent completion counts remain absent. Tree can discover child usage outside the transcript delivered to hooks, so its total may be larger.
- Without a readable transcript, or for a session this plugin never read that is too large to read in one short pause (over 8 MB), `tokens` and `subagents` are left out.

Example, the row's `plugin.receipt`:

```json
{
  "version": 1,
  "firstActivityAt": "2026-10-03T16:55:19.378Z",
  "lastActivityAt": "2026-10-03T17:05:20.744Z",
  "tokens": 2325,
  "subagents": {"started": 1, "finished": 1, "endedWithoutFinishing": 0},
  "decisions": {"allowed": 2, "asked": 0, "saidYes": 0, "saidNo": 0, "stopped": 0},
  "burnPolicyMode": "enforce",
  "pluginVersion": "0.3.19"
}
```

The SessionEnd hook asks the running worker for the receipt as it ends the session, and the worker signs it before it answers. The hook waits at most one second for that answer, prints nothing, and always lets the session end. Resumed activity adds a fresh cumulative summary with `previousReceiptId` linking to the last summary. Repeated ends without changed counts or activity add nothing, including after a worker restart. If no worker is running when the session ends, the request waits in the plugin's data folder (the session id and the time it ended, never where the transcript is) and the next worker to start writes the receipt from the ledger alone, so `tokens` and `subagents` are left out.

Receipts stay on your computer, in the same ledger file as every other row (`ledger/decisions.ndjson` in the plugin's data folder). Nothing is sent anywhere.

To check one:

- `get_work_receipt` returns a session's receipt (pass `sessionId`, or nothing for the latest) with its row's signature, whether that signature is valid, and whether the whole chain verifies against the public key in the plugin's data folder.
- `verify_chain`, the v key in the `/agentguard` pane, or `node runtime/verify.cjs` in the plugin folder checks every signature and hash link, receipts included. Changing one count in a receipt makes its signature and the chain fail.
- `list_decisions` lists receipts as `session_receipt` rows with their counts, and `export_receipts` (paid) exports them with the rest of the chain. `get_status` does not count them as decisions.
- In Claude Code, the `/agentguard` pane shows the last finished session's receipt, for example "Work receipt, last finished session (17:05): 2.3K tokens · 1 sub-agent · 2 decisions · signed #6".


## Optional Team daily counts

Count sharing stays off by default. A valid Team license, registered seat,
local `AGENTGUARD_TEAM_COUNTS=1` flag and `node runtime/counts-sync.cjs on`
opt-in are required. The detached worker tries after the closing receipt is
durable and retries at most once per minute. The hook reply does not wait for
network access. The production Team view flag remains off.

Each locally opted-in installation for the same license contributes its
verified receipts, including separate Claude Code and Codex data directories.
A shared machine lock and one pinned existing receipt signer prevent duplicate
uploads. A resumed session contributes only the increment since an earlier
completion day. Conflicting copies, missing receipts, missing usage and changed
already-sent days stop that aggregate. Nothing is silently overwritten.

Only the allowlisted signed daily aggregate leaves this machine, never prompts,
code, files, session IDs or individual receipt rows. Read the exact fields and
retention at [Team count sharing](https://agentguard.run/docs/team-counts/).

Codex 0.160.0 `exec` suppressed both SessionStart output and the tested SessionEnd
`systemMessage`. Run `agentguard-burn tally SESSION_ID` after `exec` to see the
numeric tally. This does not depend on the model repeating a hook message.

## Optional Team efficiency (weekly waste causes)

The person sees their own week on their machine first. A seat is one machine,
not a person. Weeks run from Monday 00:00 UTC to the next Monday 00:00 UTC,
matching daily counts' completed UTC days. Run these commands in the plugin folder:

```sh
node runtime/counts-sync.cjs week
node runtime/counts-sync.cjs week 2026-09-28
node runtime/counts-sync.cjs waste status
node runtime/counts-sync.cjs waste totals
node runtime/counts-sync.cjs waste seat
node runtime/counts-sync.cjs waste off
```

Alternatively, view a week with <code>agentguard-burn week [&#45;&#45;week YYYY-MM-DD]</code>.
If the installed Burn does not yet support it, the plugin prints
`burn_update_required` and the command `npx agentguard-burn@latest week`.

- `off` (default): no weekly contribution. Turning it off requests deletion of this seat's stored weekly rows.
- `totals`: counts toward team totals only; the server never shows this seat on its own.
- `seat`: counts toward team totals; the manager view may show this seat's top waste cause and its fix, never this seat's shares, tokens or dollars. Shares appear only for the team as a whole.

The setting is `<plugin data>/team-waste.json`, separate from daily counts and
org policy. Only the person changes it locally. A repeated choice retains its
timestamp. Turning sharing on applies at the next upload. The local feature flag
`AGENTGUARD_TEAM_WASTE=1`, a valid Team license and registered seat are required
for weekly figures. With the flag off, the worker does no weekly work. The `off`
command still attempts removal immediately, even with the flag off or an expired
license. It needs the configured bearer key and pinned receipt signer. Failed
removals are retried while the worker runs with the flag on and sharing off.

The worker reads only `<AGENTGUARD_HOME>/week/YYYY-MM-DD.json` (home defaults to
`~/.agentguard`), never transcripts. Burn writes that file after showing its
exact figures locally. Burn saves only complete, nonempty weeks started within
28 days; uploads accept saved weeks started within 91 days. The oldest unsent
week goes first, at most one per call. A shared machine lock and the existing
receipt key pinned in `team-counts/<seatId>/owner.json` prevent duplicate uploads
across hosts. Changed figures after an upload return `changed_after_sync` and are
never sent again. A newer acknowledged local choice takes precedence over an
older choice in another host installation.

The two request envelopes have exactly `payload`, `publicKey` (64 hex) and
`signature` (128 hex). Ed25519 signs canonical JSON with sorted object keys.
Both use the license key as bearer, a five second timeout, reject redirects and
limit the entire body to 4096 bytes. The destination is
`https://agentguard.run/api/team/waste`. Only these payload fields are allowed:

- Weekly: `schema: "agentguard.team-waste.v1"`, Monday `weekStart`, the existing hashed `seatId` (64 hex), and every figures key below at payload top level.
- Share change: `schema: "agentguard.team-waste-share.v1"`, `seatId`, `share` (`off`, `totals` or `seat`) and `setAt` (UTC ISO timestamp with milliseconds).
- Figures: `tokens` and `usdMicros`, each with exactly `total`, `useful`, `waste`, `unattributed`; `causes` with exactly `history_resent`, `reread_files`, `subagent_fanout`, `reloads`, each holding `tokens` and `usdMicros`; `reloadsByCause` with exactly `idle`, `model_switch`, `other`, each holding `tokens` and `usdMicros`; `subagentTokens`; `wrongModel` with exactly `tokens`, `usdMicros`, `smallerUsdMicros`; `topCause`; and `basis: "estimated_api_list_price"`.
- `topCause`: `history_resent`, `reread_files`, `subagent_fanout`, `wrong_model`, `reloads_idle`, `reloads_model_switch`, `reloads`, or null. Fix sentences are looked up from this code on each side and never uploaded.

Every integer is from zero through 10 trillion and is safe in JSON's numeric
representation. Total equals useful plus waste plus unattributed. Waste equals
the sum of the four causes; reload causes sum to reloads. The main-model overlay
is a subset of sub-agent tokens, which are at most total tokens. Every dollar
field is either an integer micro-dollar or every dollar field is null, including
both overlay prices. Repricing cannot exceed the overlay's original price.
All dollar identities match the token identities. Unknown keys are rejected.

Shares lead with API list price, not a bill. Cache reads typically cost about a
tenth of fresh input, so raw tokens can exaggerate re-sent history's spend.
Any unpriced response nulls all dollars and switches shares to tokens. Burn
rounds the midpoint of each leaf bucket's price range once to micro-dollars,
then sums rounded leaves into useful, waste, reload and overall totals.
Useful work is instruction stack, tool output, conversation and output.
Unattributed usage remains separate. The main-model overlay is never added to
the partition; its only counterfactual reprices those turns on `claude-haiku-5-5`.
There is no savings promise: the headline says "spent on waste causes".

The top cause must follow the same rule in Burn and the plugin: fan-out at 20%
of tokens, reloads at 15% of known spend, re-sent history at 30% of tokens and
re-read files at 10%. Among stand-outs, the largest dollar amount wins, or tokens
if dollars are null, with ties in that order. Fan-out becomes `wrong_model` when
at least half of sub-agent tokens belong to the overlay. Reloads use the largest
reload cause, preferring idle, model switch, then other on ties. With no
stand-out, `topCause` is null.

Five hard lines:

1. Content-free. No prompts, completions, file contents, file names, paths, usernames, project names, session ids, model ids or free text leave. Only the exact signed fields above leave; Burn's `local` diagnostics and `viewedAt` stay here.
2. No per-person measures or comparisons of effort or productivity. No composite measures, grades, percentiles, ordering of people, team-average comparisons, session counts, active hours, commits or tokens per commit. <code>why &#45;&#45;commits</code> stays local. Manager per-seat detail contains only shares and cause, never absolute tokens or dollars.
3. Waste causes describe where tokens went and what to change, never rate people.
4. Per-seat detail requires the person's local `seat` opt-in, and is limited to the top waste cause and its fix: never shares, tokens or dollars for one seat. `totals` contributes only to team totals. `off` is the default and requests deletion immediately. Org policy cannot change the choice; enabling sharing applies from the next upload.
5. Nothing is uploaded for a week until that exact week was shown on this machine by Burn. The plugin uploads the saved figures exactly, without recomputing them.

Read [Team efficiency privacy](https://agentguard.run/legal/privacy#team-efficiency).
The manager view and server enforcement are delivered separately from this plugin.

## Status line fields

The status line always starts with AgentGuard. Its default items remain sub-agent launches, session tokens, the token share sent to sub-agents when known, and plan usage when the host reports it. Optional fields use the same formatter in Burn and the Claude Code plugin. They read local transcripts, host usage and signed Spend files only. Codex has no external status slot.

Set `status_fields` to `pace,cost,cache,spend` in the plugin settings. Burn accepts the same comma list in `AGENTGUARD_STATUS_FIELDS`, or through the fields flag, which takes precedence even when empty. Unknown names are ignored, with one warning in the plugin panel. The default is empty.

Plan usage is read from Claude Code every 20 seconds, including while idle. A failed read keeps the last good value and shows its age after 60 seconds. This age measures the last successful local read; Claude Code does not expose the server observation time. The panel lists every plan limit the host reports, with its percent and reset time. Optional fields drop in this order when space runs out: spend, cache, cost, pace.

The panel has Fable, Opus, Sonnet and Haiku 5.5 buttons with the f, o, s and h hotkeys. Add up to nine extra model ids with the non-sensitive `quick_models` comma list; those use hotkeys 1 through 9. A button only fills `/model <id>` into the prompt. You press Enter to switch. The Haiku 5.5 button uses the verified id `claude-haiku-5-5`; the other built-in buttons use Claude Code's aliases, which can follow provider or managed overrides.

At each crossing of 80 percent on the highest reported plan limit, AgentGuard suggests the next lower built-in model family once. Custom models with unknown prices get buttons but no price-based suggestion. On a model switch, the host's catalog estimate is shown as API list price, not a bill. Managed-price and unknown-model estimates are labeled unavailable instead of being called list prices. These controls do not change helper routing: helpers still use the existing `helper_models` policy in the launch engine.

- `pace` projects the time until the reported plan limit, using at least two rising samples from the last ten minutes, only when that limit would be reached before reset.
- `cost` estimates this session at Burn's API list prices, including recorded child sessions, and remains opt-in even without host plan limits.
- `cache` shows cache-write tokens attributed by Burn to large prefix rewrites in this session and their API list price estimate when available.
- `spend` shows today's signed local spend against an unscoped daily policy cap, only when both the local JSON policy and its verified ledger can be read.

Examples on a wide terminal:

```text
AgentGuard  sub-agents 2 of 40 · tokens 686M of 5B · 33% to sub-agents · 5-hour 44% · limit in ~1h40m · /agentguard
AgentGuard  sub-agents 2 of 40 · tokens 686M of 5B · 33% to sub-agents · 5-hour 44% · ≈$12.40 list · /agentguard
AgentGuard  sub-agents 2 of 40 · tokens 686M of 5B · 33% to sub-agents · 5-hour 44% · cache waste 42M (≈$9.00 list) · /agentguard
AgentGuard  sub-agents 2 of 40 · tokens 686M of 5B · 33% to sub-agents · 5-hour 44% · spend $3.20 of $10.00 list today · /agentguard
```

Dollar figures are API list price estimates, not a bill. Spend displays the cents recorded by the local policy, which may use configured unit prices. Pace rounds to ten minutes, always starts with `~`, and turns yellow below thirty minutes. Usage turns yellow at 70% and red at 90%, including daily spend. Optional fields are removed in this order when space runs out: pace, cost, cache, spend. Default labels then shorten so the line fits without wrapping. Open `/agentguard` for full values, reset times, enabled fields and any unknown-name warning. Extremely narrow slots clip the row; all values remain in the panel.

The Claude usage API reports context, rate-limit windows and a host cost value. Its API-key window behavior is not guaranteed by the reference or the installed host implementation, so cost does not become an automatic default. The cost field uses Burn's local price table, not that host cost value. Daily spend reads a local scope-wide JSON policy, verifies its signed ledger and uses UTC day boundaries. Selector-only caps, unreadable ledgers or failed signature checks and policies held only by a remote or in-memory application stay unavailable.
