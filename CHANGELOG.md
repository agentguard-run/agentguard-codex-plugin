# Changelog

## Unreleased

## 0.6.0 (2026-10-28)

- Burn 0.7.0: `agentguard-burn install` sets up every agent host on the machine from one command (plan first, then its yes flag).
- Requests from other agents are untrusted. Once another agent's message enters a session (an agent inbox tool such as Reason Network's, a file another agent sent, a Reason Network frame or notice in a prompt or a tool result, a Claude Code transcript entry from another session, or a marker another hook added to a Codex transcript), calls that move money, deploy, publish, delete, send or launch sub-agents wait for the owner: Claude Code asks in its own permission prompt, Codex holds the call for `policy-cli approve`. Only evidence that the owner is back clears the mark: in Claude Code a prompt the transcript records as the owner's, on both hosts an approved held call that runs, or `policy-cli clear-origin`. A new UserPromptSubmit hook tests prompts in memory and never stores them. Configure it with the `untrustedOrigin` policy block (`ask` by default, `block` or `off`).
- An agent network's own send (Reason Network's `send_message`) runs as a plain reply to the agent that last messaged the session; with files, a notification or another recipient it waits for the owner. An `ask_user` answer never counts as the owner's approval.
- Each mark starts with a signed, chained `delegation` row (what brought the message in, a keyed digest of the sender's address when known, the session and agent), and each clear is an `origin_cleared` row. Decision rows written while marked link to the delegation with `origin` and `delegation_entry_hash`; a held call that then runs records `approved_by: "owner"`. Work receipts count `delegations`. No message content is stored. The session transcript is now protected plugin state.
- Decision rows carry a keyed input digest (`inputDigest`, HMAC-SHA256 under a local key in `digest-key.hex`, 0600, that hooks create and the agent cannot read) in place of an unkeyed SHA-256 of the tool input, which a short input lets anyone recover by guessing. Older rows keep `inputSha256` and still verify; approval tickets bind to the keyed digest, and `pending` shows it.
- Add the `payment` command match: a shell command that can move money, today `stripe pay` with its yes flag or with no review flag (a dry run, JSON or agent review run stays allowed). The careful and strict presets ask before it, and requests from other agents hold it as money. The default `paymentPattern` also covers refunds, payouts, finalized invoices, dispute updates and subscription cancellations, and no longer classifies read-only list, retrieve, get and search tools as payments.

## 0.5.0 (2026-10-18)

- The band and the pane count down to Claude Code's auto-compaction point: "28% to auto-compact" after the token figure, yellow at 30% of context left and red at 10%, from Claude Code's own figures (the session usage read with the summary breakdown, once per two minutes; nothing is shown when the host reports no compaction point or auto-compaction is off). At 10% left, one toast and one native notification say so, armed again once a compaction has brought the context back down. Display only: nothing is decided or blocked.
- A session past its token ceiling no longer reads "tokens 24B of 5B". The band says "tokens 24B, past the 5B limit: sub-agents wait for your yes" ("past the 5B limit" beside "watching only" in shadow mode), and the pane explains the same, in English, Spanish and Portuguese.
- Add Free offline AgentGuard Verified attestations for 7 or 30 days, current policy limits, content-free counts, whole-ledger verification, Ed25519 signing with the existing local key, an offline verify command and a reusable pure verifier. Map "attest my agent" through the policy skill.
- Add separate local weekly sharing choices: off, team totals only, or a per-seat top waste cause. Both sharing choices upload the same signed weekly figures under a hashed seat id (tokens and list-price dollars by cause, no text); the choice decides what the manager view may show for the seat, and it never shows a seat's shares, tokens or dollars. Only previously viewed Burn figures can be uploaded, with signed content-free payloads, strict arithmetic and the shared pinned receipt signer.
- Send a signed removal request immediately when weekly sharing turns off, and retry failed removals in the worker. Add local week viewing and keep daily sync results unchanged.
- Add the website preset: careful limits, approval before deploys and package publishing, and shell page deletion blocks with operator one-use approval.
- Add opt-in page guard GP020 for edit and write tools, with human removal lists, canonical and indexing checks, configurable internal link thresholds, content-free counts, bounded scans and file-state-bound Codex approvals.
- Measure the website preset through real warm hooks, including a 2 MB page, with a 250 ms budget regression.
- Stop credential directory and private key uploads through more file transfer tools. Allow project template copies into environment files while keeping other credential writes and uploads guarded.
- Add GP015 through GP019 for secret sends, disk wipes, system authentication changes, database wipes and recursive home or server-data deletion. Recognize downloaded process substitutions and allow read-only policy inspection.
- Add model buttons that fill the prompt, one suggestion per plan-limit crossing and an observational model-switch cache price notice.
- Refresh host plan usage every 20 seconds, retain readings on error, label stale readings and list all reported limits in the panel.
- Add optional pace, API list cost, prefix rewrite and daily Spend status fields with a shared formatter, width fitting, panel details and localized Burn labels.

## 0.4.0 - 2026-10-06

New in 0.4.0:

- Add opt-in launch depth with the Copies ask before launching copies preset,
  host lineage, native Claude Code permission requests and signed depth records.
- Route selected helper launches through Spend's token budget downgrade policy,
  preserving keep types and recording the requested and selected models.
- Recognize Codex 0.160 collaboration launch hooks and its cumulative usage
  record through Burn as the sole usage owner. Document missing lineage and role limitations.
- Sign fresh linked summaries after resumed activity and ingest standalone Burn
  admissions only after checking their signatures, call IDs, chain and head.
- Run optional Team daily count sync in the detached worker after durable
  receipts, combining opted-in host directories under one machine lock.
- The session tip after a finished session can lead with that session's verified tally.
- `npm test` and `npm run test:claude` run through a launcher that gives every
  test and spawned worker a fresh temporary AgentGuard home with notifications
  suppressed, and fails the run if the real `~/.agentguard` changed.
- Depend on Spend 0.21.0 and Burn 0.4.0.

Also in 0.4.0, the changes made for the review by Anthropic's plugin directory
in 0.3.20 and 0.3.21 (details under those versions below):

- The mod (AgentGuard Live) lives in its own folder, `live/agentguard-live.mjs`,
  named by `live/agentguard-live.json`, which `.claude-plugin/plugin.json` loads
  with its `hooks` field. `hooks/hooks.json` holds only command hooks, and
  nothing else in the plugin points at the `live` folder. The mod is unchanged
  by the 0.4.0 features: depth limits and helper routing live in the hooks.
- The mod's one permission hook (`tool.check` on Task and Agent launches)
  refreshes the counts and then returns `next(e)`; it and `classic.SessionStart`
  pass the event on unchanged if anything in them fails. A launch's stamp comes
  only from the gate's signed ledger row.
- In Claude Code, a paid license key can be set as the sensitive plugin option
  `license_key`, which comes before `AGENTGUARD_LICENSE_KEY` and the key saved by
  activation. It is also the key the optional Team counts upload uses.
- `assets/logo.svg` is a plain SVG and is the manifest icon.
- The public plugin does not ship `scripts/sync-public.sh`, nor the two 0.4.0
  maintainer scripts `scripts/canary-launch-policy.cjs` (it drives the `claude`
  and `codex` command lines) and `scripts/stage-branch-spend.cjs` (it works only
  inside the source repository). Nothing in the plugin runs them; they stay in
  the source repository.
- README: "What this plugin runs, sends and decides" now also covers the 0.4.0
  additions: the optional Team daily counts upload behind its flag, the depth
  limit's ask or deny, and helper model routing, which changes only the `model`
  field of a launch it routes.

## 0.3.21 - 2026-10-06

Changes for the review by Anthropic's plugin directory.

- The public plugin no longer ships `scripts/sync-public.sh`. It is the maintainers' tool for copying a reviewed release into this repository, it writes the plugin's files including the mod, and nothing in the plugin runs it. It stays in the source repository.

## 0.3.20 - 2026-10-06

Changes for the review by Anthropic's plugin directory.

- The mod's one permission hook (`tool.check` on Task and Agent launches) now refreshes the counts first and then returns Claude Code's decision with `return next(e)`, so its code shows that the permission decision always stays with Claude Code and you. Its `classic.SessionStart` hook and this one also pass the event on unchanged if anything in them fails.
- The stamp under a sub-agent launch now comes only from the gate's signed ledger row. A launch with no signed row (for example while the ledger cannot be read) gets no stamp, where before it showed Claude Code's own decision.
- The mod moved from `hooks/agentguard-live.mjs` to its own folder, `live/agentguard-live.mjs`, named by `live/agentguard-live.json`, which `.claude-plugin/plugin.json` loads with its `hooks` field. `hooks/hooks.json` now holds only the settings hooks. Nothing else in the plugin points at the `live` folder. Codex is unchanged.
- In Claude Code, a paid license key can now be set as the plugin option `license_key`, which Claude Code keeps in the system credential store and hands to the hooks and the MCP server. It comes before `AGENTGUARD_LICENSE_KEY` and the key saved by activation, which keep working as before.
- `assets/logo.svg` is now a plain SVG (the fill is written on the shape, with no style block), and `.claude-plugin/plugin.json` names it as the directory icon.
- README: a new section, "What this plugin runs, sends and decides", lists every network request with its destination, every program the plugin runs and why, what each hook decides and changes, and what the mod runs and sends (nothing). It links to agentguard.run for docs and pricing.

## 0.3.19 - 2026-10-05

- macOS STOP notifications now name what was stopped: a sub-agent launch for a recognized Burn limit, or a tool call for a spend cap or policy rule. Burn limits and known spend windows have reasons in plain words; policy stops use the engine's summary, which can still contain technical reason codes. The body gives the next step: the person types Burn's resume command for one launch with a reason, raises a spend cap or waits for its reset, or changes the policy rule if the action was intended.
- Alerts are limited to one every 10 minutes per plugin data folder. Stops suppressed by that cooldown are counted in the next eligible STOP alert. There is no scheduled catch-up alert, and stops while muted or turned off are not counted. The notifier app replaces its previous alert instead of stacking another.
- The app offers Mute 10 minutes, Mute 5 minutes, Mute 30 minutes, Mute 1 hour and Turn off AgentGuard alerts. macOS puts the actions after the first under Options. The choice is saved in `notify-state.json` in the plugin data folder. Muting leaves the 10-minute cooldown in place. `notifyOnStop: false` still disables both notification paths; notification settings do not change enforcement.
- The small notifier app is built from bundled source on the person's Mac into `~/Library/Application Support/AgentGuard/AgentGuard.app`. The first eligible STOP starts a background build when the Xcode command line tools are available. Until a current build is ready, or without the tools, AppleScript shows the same words with the reason and next step together, without the app's buttons or replacement identifier. The app requests macOS notification permission. The notifier and its build make no network requests.
- Test runs no longer post desktop notifications or write into the real `~/.agentguard`. `NODE_TEST_CONTEXT` with a value or `AGENTGUARD_NOTIFY_SUPPRESS=1` suppresses real notification calls, and the suite gives tests and their subprocesses temporary homes and plugin data folders.

## 0.3.18 - 2026-10-03

- Work receipts. At the end of each session, AgentGuard adds one signed, hash-chained row to its ledger that sums the session up in counts only: first and last activity time, the tokens Burn recorded, sub-agents started, finished and ended without finishing, AgentGuard's decisions by result (allowed, asked, said yes, said no, stopped), Burn's policy mode and the plugin version. No prompts, paths, commands or other content, and a count that cannot be proved is left out, never guessed. One receipt per session, kept on your computer. See "Work receipts" in the README.
- New read-only MCP tool `get_work_receipt`: a session's receipt (the latest by default) with its signature and the chain status. `verify_chain`, `list_decisions` and `export_receipts` cover receipts, the reader refuses a receipt with any field outside its schema, and `get_status` does not count receipts as decisions.
- The `/agentguard` pane shows the last finished session's receipt.
- SessionEnd asks the running worker for the receipt as it ends the session and waits at most one second. With no worker running, the request waits for the next worker, which writes the receipt from the ledger alone. Codex runs the same hook; its receipts leave out tokens and sub-agent counts for now.

## 0.3.17 - 2026-10-02

- AgentGuard Live in color: AgentGuard's name is a teal pill in the band, and a sub-agent count turns into a yellow pill near its limit and a red one at it.
- Under each sub-agent launch in the conversation, AgentGuard stamps its word on Claude Code's own row: ALLOWED, ASKED YOU, YOU SAID YES or YOU SAID NO, or STOPPED, with the sub-agent count at launch and the number of its signed ledger row. Rows of other tools are left as Claude Code draws them.
- While Claude works, the spinner carries the sub-agent count, for example "Thinking · sub-agents 9/15…".
- The /agentguard pane shows each launch, ask and stop as the same pills, with its ledger row number.
- Runs Burn 0.3.27 (the plugin now depends on `@agentguard-run/burn ^0.3.27`). When AgentGuard asks before the next sub-agent launch, the question now also says how many of this session's sub-agents ended without finishing and how many tokens they used, next to what the finished ones averaged. Burn also reads a session file over 256 MB in pieces, so a very long session no longer stops it.

## 0.3.16 - 2026-10-02

- AgentGuard Live, for Claude Code 2.1.287 and later: the plugin now ships a Claude Code mod, so there is nothing more to install. A band above the prompt shows how close the session is to its sub-agent limits (15 in 15 active minutes, 40 in 120) and its 5B token limit, the share of tokens that went to sub-agents, and your plan limit, for example "AgentGuard  sub-agents 12 of 15 · tokens 1.2B of 5B · weekly 76% · /agentguard". A count turns yellow at 70% of its limit and red at the limit.
- `/agentguard` opens a pane with this session's sub-agent launches, asks and stops, newest first, each a row in AgentGuard's signed ledger, and a key that verifies every signature on this machine.
- The mod reads the numbers the gates decide on, with Burn's own window sums, and decides nothing itself: enforcement stays in the plugin's hooks, so Codex, older Claude Code and `claude -p` behave as before, and where nothing is drawn the mod does no work. `AGENTGUARD_LIVE=0` turns the band and pane off.
- Verification and the MCP tools now read every kind of row the gates write in Claude Code: a launch with its permission mode, an asked launch, the Burn policy seeded by the first enforced launch, and an agent's attempt to lift a STOP. Any other field is still refused.

## 0.3.15 - 2026-09-27

- Runs Burn 0.3.21 (the plugin now depends on `@agentguard-run/burn ^0.3.21`).
- In Claude Code, the tokens your sub-agents use now count toward "Session so far" and toward the session's token limit (5B by default), as they do in Burn's own hook. Before, only the main conversation counted: a session Burn put at 4.0M tokens showed 102K here, so the 5B limit came later than it should.
- The plugin reads each sub-agent's transcript beside the session's own, each from where it stopped last time, so a later tool call reads only new lines. A worker that restarts picks up where the last one stopped.
- When a STOP holds a launch for your yes, or refuses it, the prompt and the box now end with Burn's line about the session's finished sub-agents, word for word as Burn prints it, for example: "The 3 sub-agents that finished in this session averaged 1.3M tokens each ($1.70 at API prices, not a bill). This one could differ."
- When a session ends, the plugin keeps the one tip `npx agentguard-burn why` would end it with, and the next new session shows it once, for example: "AgentGuard tip from your last session: sub-agents used 48.9% of this session's tokens. Give related work to one sub-agent instead of several." Where `why` would point you to this plugin, which you already run, the tip names that action instead, the one a STOP shows for too many sub-agents. A separate process reads the transcript after the session ends (with its sub-agents in Claude Code, the rollout in Codex), so ending or starting a session waits for nothing: session start reads one small file. The tip shows only when there is one, only in a new session (a startup or `/clear`, not a resume or a compaction), after every other startup line, and never the same words twice within a day. `quiet on` hides it.
- If Burn ignores your `burn-policy.json` because of a mistake (bad JSON, no "mode", no "thresholds"), it falls back to defaults that only watch, so enforcement is off. Session start now says so first, in Burn's words, even with `quiet on`, for example: "AgentGuard ignored ~/.agentguard/burn-policy.json: it has no "mode". Using the defaults, which only watch. Add "mode": "enforce" to turn limits back on." The "AgentGuard is on" line waits until the file is fixed.
- The sub-agent counting is for Claude Code; the tip and the policy line work in Claude Code and Codex.
- Known limit: the tips use `why`'s words, which are written for Claude Code, so after a Codex session a tip can say "Claude" or name `/compact` and `/clear`.

## 0.3.14 - 2026-09-27

- Runs Burn 0.3.20 (the plugin now depends on `@agentguard-run/burn ^0.3.20`). `npx agentguard-burn calendar` shows tokens per day for every Claude Code and Codex session on this machine, and `npx agentguard-burn why` now ends with the one change that matters most for that session.
- Burn's help and version flags work: `npx agentguard-burn help` prints the help and `npx agentguard-burn -v` prints the version, and both exit cleanly.
- A new social card, which says AgentGuard asks before runaway sub-agents start.

## 0.3.13 - 2026-09-27

- Claude Code installs the plugin's dependencies by itself, so installing there is now just the two `claude plugin` commands. If AgentGuard says its dependencies are missing, run `npm ci` in the plugin folder it names. Codex and ChatGPT Work still need `npm ci` after installing.
- When the plugin's dependencies are missing, session start says "AgentGuard can't start: its dependencies are missing." and names the plugin folder to run `npm ci` in. The once-per-machine lines wait until the dependencies are installed.
- The README now opens with what AgentGuard does, how to install it in each app and what it sends over the network, and its Burn commands use the short `npx agentguard-burn` name.
- The first time AgentGuard starts on a machine, the "AgentGuard is on" line now comes first, ahead of the longer preset command, and says "Your sessions stay on this machine."
- The plugin and package descriptions are now plain language, and the author and developer name are AgentGuard.
- The package no longer ships a video file. The AgentGuard Burn clip is at agentguard.run/burn.

## 0.3.12 - 2026-09-27

- A fresh install now enforces the sub-agent limits. Burn's own first-run default is shadow, so a machine with no Burn policy file recorded every STOP and refused none. When the plugin enforces and `burn-policy.json` is missing from the AgentGuard home, it writes Burn's shipped policy there in enforce mode, once, before the first spawn it gates (file 0600, directory 0700), and records that in its signed ledger. An existing policy file is never changed: if you chose shadow, you keep shadow.
- In Claude Code's default, accept edits, auto and plan modes, a launch past a limit now waits for your yes in Claude Code's own permission prompt. The prompt names the one limit that fired and the session so far; Claude Code shows it to you, not to Claude. Say no and nothing starts. Bypass permissions, don't ask, print mode and Codex refuse with the STOP box, and `"stopStyle": "deny"` in `burn-policy.json` refuses everywhere. The signed decision records that it asked and in which permission mode.
- The STOP box is Burn 0.3.19's: the limit that fired with its real number and window, the session so far, what to do, and how to continue once with `npx agentguard-burn resume` and your reason, typed with `!` in front in Claude Code or run in a terminal for Codex. It works on a plugin-only install, which never puts `agentguard-burn` on your PATH. The box keeps its lines instead of being folded into one line and cut short.
- The agent cannot lift a STOP itself. While Burn enforces, an agent shell command that runs Burn's `resume`, `shadow` or `calibrate` in any form, or names `override.json` or `burn-policy.json` in the AgentGuard home, is refused, and so is a file tool writing either file. The agent is told to ask you. Your own `!` command never passes through a hook. The command text stays in the hook; the ledger records only which kind of attempt it was.
- After you override a STOP, the line that follows names the limit it passed. It used to quote the first finding in the list, which could be a different limit.
- Session start: the preset hint is a command you can paste, with this installation's absolute paths. Once per machine, a line says AgentGuard is on, lists the limits and shows `! npx agentguard-burn why`; it respects quiet and waits while the machine is in shadow.
- Depends on `@agentguard-run/burn ^0.3.19` (was ^0.2.3). The lockfile lists Burn's optional native canvas package for every platform; npm installs the one for your machine, and the dependency check accepts the others as absent.
- The macOS STOP notification ends with the override command the box prints. `npx agentguard-burn` is Burn's short unscoped launcher on npm: it works on a plugin-only install, and it has no "@" for X to turn into a mention when you quote it.

## 0.3.11 - 2026-09-24

- The weekly line after a refused action on a free machine now says Free stays enforced there and points at Solo (the same policy on up to three machines, signed receipts export) instead of Team, and says how to dismiss it.

## 0.3.10 - 2026-09-24

- One yes, then it just happens: when the user asks for the full visual report, the score tool opens it in the default browser the moment the score is ready, through the platform opener with the report address as a single argument. Only on request, only on the consented origin, never on a failure; AGENTGUARD_NO_BROWSER=1 turns it off and a Linux session without a display never tries.
- The terminal keeps the summary; the browser carries the full report.

## 0.3.9 - 2026-09-24

- After an AgentGuard Score, the skill offers to open the full visual report in the browser (score ring, breakdown bars, every fix) at the agentguard.run report address, and opens nothing unless asked.
- The report question says what the link shows and where it is stored; the probe-mode note no longer points at a page that does not exist.

## 0.3.8 - 2026-09-24

- AgentGuard Score names its real destination. `agent_score_questions` returns `serviceOrigin`, the validated origin the answers would go to (https only, no credentials, path, query or fragment; https://agentguard.run unless `AGENTGUARD_SCORE_URL` is set), the consent wording in the skill names that origin, and an unusable `AGENTGUARD_SCORE_URL` makes `agent_score` refuse with `invalid_origin` instead of falling back.
- A hosted report link is a separate choice. `agent_score` takes `createShare` (default false), forwards it in the request, and returns `shareUrl` only when the user asked for a link and it is on the consented origin.
- The request refuses redirects, sends no credentials or referrer, reads at most 64 KB of response, and keeps one timeout across the request and the body read. A result is accepted only when it is complete and well formed (ok, an integer score from 0 to 100, a known tier, integer breakdown values, well-typed factors, parseable dates); anything else is `service_error` with no result to display. `assessmentType`, `questionnaireVersion` and `rubricVersion` pass through when present.
- Failure semantics: a network failure reports that no usable result was received and the service may have processed the request, and the tool never retries on its own. "Nothing was sent" is said only for refusals before any request (origin, consent, answers). Every refused or failed score call is returned as an MCP tool error with its structured reason, and a missing consent produces a score-specific message.
- Privacy wording: local policy enforcement and decision records stay on your machine; AgentGuard Score is the only MCP tool that makes a hosted request; paid licensing, seat renewal and optional policy sync are separate network features; score requests do not include your local policy, decision ledger or signing key.
- `get_status` reports `displayPreferences.quiet`, and the status skill never mentions the score when quiet is on or unknown. The free invitation is once per install and waits for a session start with nothing else to say. Version announcements are keyed by version.
- The questionnaire asks about four controls in plain words (an accountable human, where the money sits, limits the agent cannot change, a log the agent cannot edit), the wallet options cover custodial accounts, multi-sig, virtual cards and card-issuing APIs, bank accounts, personal wallets and none yet, and every question must be answered before anything is sent. The plugin collects no email address.
- The directory submission pack names the shipped version and all four skills.

## 0.3.7 - 2026-09-24

- Add AgentGuard Score to the plugin: a new `agentguard-score` skill and two MCP tools. `agent_score_questions` returns the five-question payment-readiness questionnaire offline; `agent_score` sends the answers, with the user's explicit consent, to the hosted AgentGuard Score service and returns the score, tier, category breakdown, factors with recommendations and a share link.
- `agent_score` is the only tool in the package that transmits anything off the machine. It refuses without `consent: true`, refuses answers outside the published questions and options before any request, reads no ledger, policy or key, writes nothing, and returns an error object rather than an estimated score when the service cannot be reached.
- Tool annotations mark `agent_score` open-world and non-idempotent; the other five tools keep their offline read-only annotations.

## 0.3.6 - 2026-09-23

- Add local policy presets, validated CLI customization, plain-language status and a once-only setup hint on both hosts.
- Add the optional inbox-reset-codes guard and strict approval for network-capable tools, with native Claude prompts and an operator-approved single call on Codex.
- Add Solo personal policy push and pull using the existing Team contract, hash, endpoint and refresh cadence. Sync state lives in one status file for the hook and the worker: a refused push touches nothing, a failed upload selects the local policy on both sides, and a pushed personal policy can only tighten Guard Pack rules.
- Add a weekly Free STOP invitation outside block reasons, one announcement per plugin version, and permanent quiet dismissal shared with the local Burn monthly summary.
- Held Codex calls are approved only from the operator's own terminal: a new policy-cli pending command lists them, the approval token is never shown to the model, and the show and explain helpers stay usable under strict only in their exact packaged form.
- A built-in STOP on every host covers tool calls that reach the plugin's own data directory, the Burn home or the hook IPC directory, and policy-cli commands that change policy or approvals.
- Command rules keep working when a command cannot be fully parsed: pattern rules run on the raw text, built-in matches use a conservative fallback, and the scan is recorded as scan_incomplete.
- Command patterns are validated as linear (no backreferences, nested quantifiers or quantified alternations) and the scanned text is capped, so a pattern can never take a hook past its budget.
- Built-in command matches cover more ordinary spellings: force-push flag clusters and the mirror flag, timeout, nohup, exec, time, xargs and eval prefixes, cd with a tilde or HOME, the env and sudo change-directory options, subshells, pushd, find with delete, unlink, rmdir, vercel with a path, vc, bunx vercel, firebase deploy, npm run deploy, bun publish and gh release create.
- Burn joins unsigned gateway decisions to their plugin mirror once and carries the monthly Team line on the summary so a JSON status prints what it consumed.
- Preserve failed-license fallbacks, paid receipt export and Team authority. Hooks and the policy CLI remain offline.
- Benchmark mode applies only with the operator's signed consent for the run (policy-cli benchmark on <run-id> writes one signed ledger row; the hook verifies it and falls through to normal enforcement otherwise). The environment switch alone never weakens Enforce.
- hookBudgetMs is validated at 250 ms or more and floored in the warm deadline, so a policy file cannot make every hook time out and fail open.
- A policy the worker cannot read keeps a definite built-in STOP as a stop; a block already decided survives a ledger append failure (the row is kept beside the ledger); MCP move, copy and rename tools count as writes for the plugin-state stop.
- Org policy refresh: a 204 after a ready snapshot withdraws to shadow with a reason instead of unbinding; an older version with a different hash and a published_at from the future are refused.
- The command-rule validator refuses a repeated group whose inner quantifier can consume its own separator (the (?:.*,)* family), and keeps ordinary idioms valid.
- Guard pack scanner: reserved words and wrapper commands on one line no longer hide the command; command substitutions and backticks stay inside their word and are scanned as nested commands, including inside double quotes and as arguments to a shell, eval or interpreter (the installer one-liner shape is GP001); here-strings feeding a shell are scanned; ANSI-C quoting is decoded; a carriage return stays in a word so CRLF heredocs close; nested shell bodies held in a literal variable resolve; long inputs are bounded and linear.
- GP002 resolves variable-built delete targets (HOME, PWD, pwd, mktemp, literals assigned earlier in the command); an unknown expansion is read both as a path component and as nothing, so a bare variable stops while a deep literal suffix is allowed; a wildcard confined to a generated build or cache directory, or over a generated-artifact extension, is cleanup.
- GP009 treats credentials.<code extension> as source and .env.example, .env.sample, .env.template and .env.dist as templates; every other env and credential file stays protected.
- GP010 requires a token boundary before a secret shape (sk- inside task-rest is an identifier) and ignores documented placeholders (EXAMPLE keys, runs of one character); realistic tokens anywhere still stop.
- GP014 treats a local path or an editable install as a local source; owner/repo shorthand is a GitHub source for the npm family only.
- Editor tools (str_replace_editor, str_replace_based_edit_tool and any tool named ...editor or ...edit_tool) are write tools; their view command is a read.
- Evals tooling (scripts/evals, never shipped in the package): the round-two harness, a release mapping in the replay, 236 red-team probes and a metamorphic suite as regression tests, and a freeze manifest at evals/manifest-round2.json.

## 0.3.5 - 2026-09-22

- Parse shell heredoc delimiters and bodies while scanning the surrounding commands, including nested shell calls.
- Retain local guard rule enforcement when incomplete parsing recovers a match. Clean command and patch data remain allowed.
- Add heredoc regression cases and measure decisions against pinned public Next.js eval transcripts.

## 0.3.4 - 2026-09-22

- On an enforced STOP on macOS, post a local notification with the rule ids and the resume command (policy flag notifyOnStop, default true; no-op elsewhere; never network). The notifier is detached so the hook never waits on it; AGENTGUARD_NOTIFY_SUPPRESS=1 silences it for tests and rehearsals.
- Team licenses carry the Stripe seat quantity: three or more seats, validated, cached and registered as paid seats.

## 0.3.2

## 0.3.3 - 2026-09-21

- Free Enforce follows the local policy on one machine with no account or key.
- Solo adds up to three machines, dashboard, receipts export and email support.
- Failed configured keys, seat denials and refresh failures retain shadow fallback and their reasons. Paid export and Team org policy gates remain.
- Update both hosts, status guidance and the Codex compatibility build for the new ladder.


- Add 14 built-in local guard rules across seven categories. Raw arguments stay in hook memory; signed records contain rule IDs and applied modes. Free/shadow warns, paid enforce stops, and only org/team policy can authorize downgrades.
- Measure hook overhead locally with scripts/measure-overhead.cjs; the result is written to docs/overhead.json for the site.

## 0.3.1

- Fetch the organization policy published in the dashboard through the detached worker and merge it as the root layer above team and local policy files; org enforce cannot be loosened locally.
- Report the loaded org policy hash in the seat heartbeat so admins can see which seats run the current policy. Heartbeats carry only license, machine, process and policy-hash identifiers.
- Revoked seats select shadow with seat_revoked at the next heartbeat; restoring a seat takes effect on a successful heartbeat.
- Team licenses cover ten seats.

## 0.3.0

- Add Claude Code packaging and host metadata to the shared runtime, signed decisions and status.
- Record failed Claude Code tools, preserve native permission prompts on allowed calls, and defer spawn accounting when a standalone Burn hook owns the call.
- Keep the Codex repository and package names, compatibility installation, license split and existing signed chains.

## 0.2.2

- Add directory review metadata, reproducible positive and negative cases, and public policy links. MCP status omits private worker fingerprints while preserving license and seat evidence.

- Count live seats across machines in the shared license KV store, with a fifteen minute active window and twenty four hour key expiry.
- Renew each live session every five minutes from the worker. Hook processes never send heartbeats, and heartbeat failures never change the current mode.
- Report seats used, the limit, storage and verification state through status and MCP. Memory fallback counts are marked unverified.
- Retain the startup seat limit check and a stable machine plus session process identity. Stop renewal on SessionEnd or host exit, with an activity lease when the host cannot be identified.

## 0.2.1

- Reply after signing and writing each plugin ledger row, then sync asynchronously and reconcile unconfirmed tails with signed integrity events on restart.
- Raise the warm response budget to 250 ms and accept `hookBudgetMs`, capped at 1900 ms below the host timeout; preserve the 1500 ms cold budget.
- Keep the Burn gateway inside that budget because its public API combines decisions, reservations and receipt writes.
- Report fail-open counts, rates and causes over the last hour and since worker start, with a warning above 5 percent.
- Reject every unexpected fail-open in normal hook tests and add isolated warm probes with delayed disk operations.

## 0.2.0

- Keep free sessions in signed shadow mode and license paid enforcement, team policies, and receipt export.
- Resolve licenses outside tool hooks with a two second deadline, cached offline grace, and existing seat metering.
- Report license tier, seats, expiry, effective mode, and shadow reasons in status tools.
- Replace local socket IPC with private files while retaining bounded fail-open hooks and signed recovery events.

## 0.1.1

- Adapt allowed hook responses to Codex 0.154 without changing signed decisions.
- Refresh the plugin version so existing installs can receive the compatibility fix.

## 0.1.0

- Preserve explicitly provisioned registry dependencies across Codex cache refreshes.

- Add public standalone distribution, portable packaging tests, and a reviewed sync workflow.
- Require the published Spend 0.20 series for actor attribution and per-agent cap selectors.

- Add local Codex and ChatGPT Work tool policy hooks, Burn delegation, signed content-free records, read-only MCP inspection, and operator skills.
