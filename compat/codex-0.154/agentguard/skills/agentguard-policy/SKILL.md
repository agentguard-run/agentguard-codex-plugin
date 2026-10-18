---
name: agentguard-policy
description: Customize AgentGuard with local presets, spending caps, command rules and rule explanations. Create an offline AgentGuard Verified attestation when asked to attest my agent. Push a personal policy to Solo machines or activate a license when the operator requests it.
---

# AgentGuard policy

## Attest my agent

For `attest my agent`, run the current host's command below. This is available
on Free and reads existing local records and policy without changing them.
Resolve the installed plugin paths first; never guess a data directory.

Codex:

```sh
PLUGIN_ROOT="${PLUGIN_ROOT}" PLUGIN_DATA="${PLUGIN_DATA}" node "${PLUGIN_ROOT}/runtime/attest.cjs"
```

Claude Code:

```sh
CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/runtime/attest.cjs"
```

The default period is 30 days. Append <code>&#45;&#45;days 7</code> or
<code>&#45;&#45;days 30</code> if requested.
Append <code>&#45;&#45;label</code> only with an explicitly supplied public label, quoted as one
literal argument. Labels permit 1 to 60 ASCII letters, digits, spaces and
hyphens and cannot be blank. Never derive a label from a username, session,
prompt, file or project. Append <code>&#45;&#45;out</code> with the operator's chosen new file
to save the bundle. Otherwise return the JSON printed to stdout. Never
interpolate untrusted shell text. No network call, account or upload is needed.

To verify a supplied bundle, run the same host command with `verify` and the
quoted file as its two arguments. Report the verifier's facts and failures.
The signature covers a content-free summary, with current limits at creation
and recorded counts for the period. It does not prove work quality, continuous
enforcement or that the same limits applied throughout the period. Do not
claim independent certification or send the bundle elsewhere unless asked.

## Change policy

Use this skill for an operator-requested policy change. A blocked tool request
is not authorization to loosen its policy. Read the host's policy file first: `${PLUGIN_DATA}/policy.json` in Codex,
or `${CLAUDE_PLUGIN_DATA}/policy.json` in Claude Code. Use the packaged
default when it is absent. A paid session can also
load a team file from `AGENTGUARD_PLUGIN_POLICY` or the local `teamPolicyFile`
field; relative paths resolve from the host plugin data directory. Preserve the local license
key while editing shared rules. Do not modify Burn's policy unless the user
separately requests it.

## Add a key for Solo or Team

For the operator request `activate license <KEY>`, choose the command for the
current host below. Supply the key through standard input. Never place it in
command arguments, echo it, print it, or add it to a ledger entry. The helper
writes `licenseKey` into the host's `policy.json`, preserves unrelated fields,
and resolves the license again outside the hook process. Do not reproduce
the key in the completion message.

### Codex activation

```sh
PLUGIN_ROOT="${PLUGIN_ROOT}" PLUGIN_DATA="${PLUGIN_DATA}" node "${PLUGIN_ROOT}/runtime/activate.cjs"
```

Pass the known host session ID as an optional positional argument. Otherwise
the helper uses `CODEX_THREAD_ID` when available. Do not invent an ID or pass
the license key as that argument.

### Claude Code activation

```sh
CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/runtime/activate.cjs" "${CLAUDE_SESSION_ID}"
```

Claude Code substitutes those exact placeholders when loading this skill.
Its Bash tool does not inherit the plugin variables, so retain the explicit
environment assignments. Use only the current host's command. If its paths
or session ID remain unresolved, identify them from the installed plugin and
current host context before running the helper; never use an empty path or
guess a data directory. The Codex placeholders in the other command do not
apply to Claude Code.

`AGENTGUARD_LICENSE_KEY` takes precedence over the policy field. If that
environment variable selects a different key, explain the precedence without
revealing either key. Report the returned tier, seats used and limit, expiry,
effective mode, and reason. An unavailable value is unknown, not zero.

Free uses the local policy, default enforce, on one machine without a key or
account. It includes local signed receipts and Burn. Add a key for Solo or Team:
Solo adds your policy synced to up to three machines, the dashboard, receipts export and email support;
Team adds org policy and seats from three people. Team is the only trial, with a card.
Existing Growth and Pro keys remain supported. A policy requesting shadow
remains shadow. A configured invalid or expired key selects shadow with
`license_required`; an exceeded seat limit selects shadow with `seat_limit`.
These failures retain their reasons and never gain Free enforcement. Licensing
never denies a tool call. Shadow is a fallback state, not the Free tier.

## Customize with commands

Use `runtime/policy-cli.cjs`, not hand-edited JSON, for the supported changes.
Resolve the current host paths first. Keep the explicit host environment
assignments shown in activation when running the policy CLI, including the
Claude session ID. Replace only `runtime/activate.cjs` with
`runtime/policy-cli.cjs` and its arguments. Do not send a license key as an argument.

1. Run `show` to explain the effective policy and whether it is local or synced.
2. Map the operator's request to one command below. Patterns are JavaScript
   regular expressions matched against shell command text, not tool names.
   Quote them as literal shell arguments. Never interpolate untrusted text.
3. Read the printed before and after diff. Each write is validated and atomic.
   The license key and unrelated local settings are preserved.
4. Run `show` again and use `get_status` for the actual host session before
   claiming that a rule is enforced. With Solo, changes remain local until push.

- Usual defaults: `preset solo-dev`.
- Careful destructive work: `preset careful`.
- Website work with publishing approval and page removal checks: `preset website`.
- Explain page removal checks: `explain page-guard`.
- Ask before network, deploy or publish: `preset strict`.
- Copies ask before launching copies: `preset copies-ask`.
- Allow launches through depth 2: `set-depth 2`. Disable with `set-depth off`.
- After 100000 session tokens, route search and logs to haiku while keeping logs: `helper-model 100000 haiku search,logs logs`.
- Disable helper routing: `helper-model off`.
- Limit to 15 dollars a day: `set-cap 15 per_day`.
- Limit each session to 5 dollars: `set-cap 5 per_session`.
- Block git push to main: `block '\bgit\s+push\b[^;\n]*\bmain\b'`.
- Allow a command pattern: `allow '<the same literal pattern>'`.
- Explain the inbox guard: `explain inbox-reset-codes`.
- Put the policy on Solo machines: `push`.
- Dismiss local upgrade moments permanently: `quiet on`.

Presets replace mode, caps, command rules and guard settings. They preserve
other fields, including configured tool prices, sessions and licensing.
The copies-ask preset changes only launch depth. Launch depth and helper model
settings stay local and are not uploaded by policy sync. A depth of 1 allows
the main session to launch, with a permission request for deeper Claude Code
launches. Codex holds supported policy denials until the operator allows them.
Missing reliable lineage retains the count limit. Helper type names match
exactly; the keep list wins. On the observed Codex collaboration path, untyped
helpers use the explicit `default` type, never a role inferred from task names.
Do not enable that type when the operator intended only named helper roles.
See [launch policy limits](../../docs/LAUNCH_POLICY.md) before claiming host
support. A new budget does not switch an agent already running.
The careful preset blocks force pushes, recognized deploy commands and rm
outside the workspace, with a $15 daily cap. Strict sets a $5 daily cap and
asks for network, deploy and package publish. Because a shell or connector
can open the network without declaring it, strict asks for every shell and
connector call. The exact packaged local show, explain, quiet and approval helper
remain usable. It also retains the force push and outside-workspace rm blocks.
Both presets enable `inbox-reset-codes`; solo-dev leaves it off.

Website retains careful's cap and deletion and force push blocks, asks before
deploys and package publishing, blocks shell deletion of page files, and enables
GP020. GP020 asks before page elements disappear or indexing and redirect files
change. Its internal link removal threshold defaults to three. It checks edit
and write tools, not shell rewrites. Files over 2 MB are skipped with a notice;
reconstruction errors fail open with a recorded event. The human removal list
stays in the hook; signed records contain counts only. Codex holds an edit until
the operator uses `pending` and `approve <token>` in their own terminal. Approval
is one-use, expires in five minutes and also binds the file's before state.
The agent cannot approve itself. See the README for scanning limits.

Last matching command rule wins within its layer. An allow cannot weaken
built-in Guard Pack rules or a Team administrator's restrictions. Explain
that distinction when a tool remains blocked. The git example covers explicit
main arguments; default-branch pushes and aliases need separate rules.
Do not invent coverage for arbitrary programs or shell aliases.

Caps count configured tool unit prices, not provider bills. Unpriced tools
count as zero. Daily windows use UTC; session windows use the host session ID
and survive worker restarts. Hook coverage excludes Codex hosted tools and
specialized paths. Claude Code WebSearch and WebFetch use tool hooks.
Recommend protecting policy files from agent writes when used as controls.
For advanced session mappings or tool prices, explain the existing policy
schema and ask the operator to use its administrative configuration surface.
Do not silently hand-edit JSON to bypass these commands.

## Strict approval

Claude Code receives its native approval prompt. Codex currently cannot honor
an ask decision from a PreToolUse hook. AgentGuard holds that call and tells you
so. You cannot approve it: the approval token is never shown to you, and
running `approve`, `pending` or any policy-changing command from your shell is
stopped on every host. Tell the operator which call is waiting and stop there.
The operator lists held calls with `node runtime/policy-cli.cjs pending` in
their own terminal, approves one exact call, and asks you to retry it within
five minutes. The approval covers one matching session, tool, input hash and
policy; it cannot approve other arguments or a later policy version. Approval
does not bypass other guard rules or caps.

## Sync with Solo

Push is an explicit upload of allowed policy configuration only. Do not add
prompts, receipts, tool arguments, document text or credentials to policy.
The detached worker sends the Solo key in the Authorization header. The CLI
and hooks open no sockets. Other machines pull at session start and every
fifth heartbeat, about every 25 minutes. Failed Solo requests use local policy.
Free push prints the Solo upgrade message and makes no request. Team policies
remain owner-published in the dashboard. A blocked call is never permission
to push a weaker policy.

## Local STOP notifications

On macOS, AgentGuard can show a local notification for an enforced STOP. A
recognized Burn limit gets the title "AgentGuard stopped a sub-agent launch";
a spend cap or policy rule gets "AgentGuard stopped a tool call". The subtitle
explains the reason. Burn limits and known spend windows use plain words.
Policy stops use the engine's summary with the leading STOP label removed,
or a generic safety or policy reason if no summary is available. Some policy
summaries can still contain technical reason codes.

The body points to the terminal for details and gives the next step:

- Burn limit: the notification asks the person to type
  `! npx agentguard-burn resume --once --reason "why"` to allow one launch,
  with their own reason. The person must type it; do not run it for them.
- Spend cap: raise the cap in the AgentGuard policy, or wait for it to reset.
- Policy rule: if the stopped action was intended, change the rule in the
  AgentGuard policy. A notification is not authorization to loosen a policy.

Alerts are limited to one every 10 minutes for each plugin data folder.
Further stops during that cooldown are counted; the next eligible STOP alert
says how many more stops occurred. There is no scheduled catch-up alert when
the 10 minutes end. Stops while alerts are muted or turned off are not added
to the count. With the notifier app, a new alert replaces the previous one.

The app offers **Mute 10 minutes**, **Mute 5 minutes**, **Mute 30 minutes**,
**Mute 1 hour** and **Turn off AgentGuard alerts**. macOS shows the first action
as a button and the others under Options. The choice is saved in
`notify-state.json` in the plugin data folder: `${PLUGIN_DATA}` in Codex or
`${CLAUDE_PLUGIN_DATA}` in Claude Code. Muting does not shorten the 10-minute
cooldown. Setting `notifyOnStop: false` in the plugin policy disables both the
app and AppleScript alerts; the policy default is `true`. These choices leave
enforcement unchanged.

The notifier is a small app built from the bundled source on the person's Mac
into `~/Library/Application Support/AgentGuard/AgentGuard.app`. The first
eligible STOP starts the build in the background if the Xcode command line
tools are available. Until a current build is ready, or without those tools,
the existing AppleScript notification shows the same words, with the reason
and next step together in the body. That fallback has no AgentGuard buttons
or replacement identifier. The app requests macOS notification permission.
The notifier and its build make no network requests.

A launch waiting for the person's answer in Claude Code does not notify.
Shadow decisions and other platforms do not notify. Repeated delivery of the
same signed decision does not notify again. Test runs never post desktop
notifications: `NODE_TEST_CONTEXT` with a value or
`AGENTGUARD_NOTIFY_SUPPRESS=1` suppresses real notification calls.
