# Built-in guard pack

Every installation includes these deterministic rules. The hook inspects tool
arguments in memory, emits matching rule IDs into local worker IPC, and discards
the arguments. Neither the scanner nor the hook opens a socket or calls a model.
The existing metadata hashes and byte counts remain content-free.

Effective shadow mode produces WARN with the rule ID. Enforce mode on every
tier, including Free without a key, produces STOP by default. An incomplete
scan retains recovered rule matches and records its scan reason. Unknown
branch context warns for GP003 and GP004 without demoting other rules or
tool policy. Policy, license and worker failures retain their existing shadow
or fail-open behavior when local storage is writable.
An off rule produces no warning. Existing tool policy and Burn checks still
apply independently.

| ID | Category | Matching operation | Human reason |
| --- | --- | --- | --- |
| GP001 | Remote shell | curl/wget handed to a shell or Python through a pipe, substitution or process substitution | A downloaded response is being executed by a shell or Python. |
| GP002 | Recursive deletion | Recursive rm/Remove-Item on root, home, current/parent directory or a shallow wildcard | Recursive deletion targets a root, home, current directory or shallow wildcard. |
| GP003 | Git history | Force or force-with-lease push to main/master | A force push targets the shared main or master branch. |
| GP004 | Git history | Hard reset on main/master or unknown branch | A hard reset targets a shared branch or a branch whose state is unknown. |
| GP005 | Git history | git clean with f, d and x, excluding dry runs | Git clean would remove untracked directories and ignored files. |
| GP006 | Infrastructure | terraform apply/destroy with auto-approve enabled | Terraform would apply infrastructure changes without interactive approval. |
| GP007 | Infrastructure | kubectl delete namespace/ns, excluding dry runs | Kubernetes would delete a namespace. |
| GP008 | Infrastructure | aws/gcloud delete, terminate or disable verbs | A cloud command would delete, terminate or disable a resource. |
| GP009 | Sensitive writes | Writes to environment, credentials, private-key, wallet and credential-directory paths | A write targets a credential, private-key, wallet or environment file. |
| GP010 | Secret arguments | AWS, GitHub, Stripe, OpenAI or Anthropic key shapes in argument names or values | An argument contains a known secret-key format. |
| GP011 | System security | chmod 777/0777 | Permissions would allow every local user to write and execute the target. |
| GP012 | System security | Recognized firewall disable, stop or flush commands | A command would turn off or flush a local firewall. |
| GP013 | System security | Writes to /etc/hosts, /etc/sudoers or /etc/sudoers.d | A write targets host resolution or sudo authorization settings. |
| GP014 | Package source | Package install from URL or Git source, excluding registry/index options | A package install uses a URL or Git source rather than a registry version. |
| GP015 | Secret send | Credential paths uploaded by curl, wget, scp, rsync, rclone, cloud storage commands, FTP or SFTP; secret data piped to SSH, netcat or socat; inline Node or Python sends, HTTP or browser tools and explicit delegated secret uploads | An upload or send targets credentials, private keys or a secret store. |
| GP016 | Disk wipe | mkfs, dd to a disk device, diskutil erase operations or mutating wipefs options | A command would format, erase or overwrite a disk or filesystem. |
| GP017 | System authentication | Writes or permission changes to sudoers, password databases, PAM, security configuration or sshd configuration | A write or permission change targets system authentication files. |
| GP018 | Database wipe | Executed TRUNCATE, DROP DATABASE, DROP TABLE, Redis FLUSHALL or FLUSHDB; explicit delegated live datastore wipes | An action would clear a database, table or Redis store. |
| GP019 | Home and server data | Recursive rm, find deletion, inline fs.rmSync or shutil.rmtree on home subfolders or shared server data | Recursive deletion targets a home subfolder or shared server data. |
| GP020 | Page guard, opt-in | Edit and write tools remove page elements, change a canonical href or modify indexing and redirect files | This page edit needs your approval. |

The rule catalog and matching implementation, including each ID and default
severity, are in `runtime/guard-pack.cjs`; the new operation checks are in `runtime/guard-dangerous.cjs`. Command tokenization preserves quoted operators
and separates heredoc data from surrounding commands. Shell consumers and
unquoted substitutions are scanned as executable input. Incomplete shell
parsing also runs the catalog patterns over raw command text conservatively.
Registry/index option values are not interpreted as package sources. Path
normalization is lexical and does not follow symlinks.

## Credential uploads and env templates

GP015 also protects GnuPG keys in `.gnupg`, Kubernetes credentials in `.kube`,
gcloud credentials in `.config/gcloud`, Docker credentials in `.docker`, npm
credentials in `.npmrc`, PyPI credentials in `.pypirc`, Git passwords in
`.git-credentials` and GitHub credentials in `.config/gh`, including `hosts.yml`.
Standalone `id_rsa`, `id_ed25519`, PEM and PKCS12 key files are protected too.
Copying a credential directory to a remote destination counts as an upload.
These operations still produce STOP by default.

The rule recognizes rclone copy and sync, S3 copy and sync, gsutil copy, gcloud
storage copy, Azure storage uploads, FTP URL uploads and literal FTP or SFTP
batch input. It also recognizes curl upload and multipart file arguments,
and secret archives piped into SSH or netcat. Read-only commands such as
`gpg --list-keys`, `ls ~/.gnupg` and `kubectl get pods` stay allowed. Public
SSH key files, ordinary report uploads and SSH identity options do not by
themselves count as secret uploads.

GP009 allows `cp .env.example .env` and `cp .env.sample .env.local`. This narrow
exception accepts two literal relative paths within the current project,
with an example, sample, template, dist, default or defaults env source name.
It rejects parent paths, absolute paths, credential directories and commands
that change the working directory. Redirects and other writes still receive
their own checks. A subsequent upload of the real env file still stops.
File names identify templates here: the scanner does not read their contents
or resolve symlinks, and cannot prove that a renamed file contains no secrets.

The credential regression adds 40 dangerous probes and 40 safe lookalikes,
plus shell rewrites checked by a separate syntax parser. The source command
`node scripts/verify-dangerous-actions.cjs --fresh` replays the unchanged 20
synthetic Jev cases. The GnuPG upload miss and env template false stop are both
closed: zero dangerous cases allowed out of 10 and zero false stops out of 10
safe cases. The original 93 cases still allow zero of 30 DENY cases and falsely
stop zero of 34 ALLOW cases. Commands in both sets are data only, never executed.

## Administrative policy

The root-level `guardPack` object accepts `rules` and `pageGuard`.
Rule keys are GP001 through GP020 and inbox-reset-codes. Actions are `stop`,
`warn` or `off`; GP020 also accepts `ask`. GP020 and inbox-reset-codes default
off. `pageGuard.internalLinkThreshold` is a positive integer, default 3.
Custom expressions and additional text are rejected.

```json
{"version":1,"guardPack":{"rules":{"GP003":"warn","GP014":"off"}}}
```

Only a shared team file or published org policy can authorize a downgrade.
An omitted org rule retains its default, so a lower file cannot relax that default.
A lower file can tighten an explicit administrative downgrade. Personal-only
WARN or OFF settings cannot authorize a downgrade. The existing org merge
rules for capabilities, allowlists, denied tools, caps and mode remain in force.

## Boundaries and verification

GP020 reads only edit targets and reconstructs the proposed change in the hook
process. Raw findings are added to the human message after the worker replies.
Only fixed element counts, scan status and digests cross IPC or reach receipts.
Codex approval is bound to the input, policy and scanned before state. See
[website preset and page guard](../README.md#website-preset-and-page-guard)
for configuration, supported tools, the 2 MB limit and fail-open behavior.
Shell rewrites and arbitrary generated markup are outside GP020's coverage.

This is a bounded literal-command check, not a complete shell interpreter.
It resolves bounded literal assignments, but cannot resolve arbitrary environment
variables, aliases, program-generated commands or symlink targets. Shell wrappers cover sh/bash/zsh `-c`, common sudo and env
options, and tool inputs named command, cmd or script. Other executable
languages and remote command transports can hide an operation from matching.
Known secret-key formats are checked across argument names and string values.

For Git, shared branch means main or master. The scanner reads local `.git/HEAD`
including worktree pointers and honors `git -C`. Detached HEAD, unsupported Git
directory overrides and unreadable branch evidence produce a WARN in shadow.
No branch name or working-directory path is added to guard-pack metadata.
Scans are limited to 262,144 characters, 1,024 nodes and 12 nested levels;
incomplete scans allow the call with a reason. These checks do not establish
that an unmatched action is safe.

From the source checkout, `node scripts/measure-benign.cjs` scans the checked-in
command corpus without executing it and writes `docs/guard-pack-benign.json`. The report records the
exact count, matches, source hashes, date, Node version and machine. A result
of zero matches describes that corpus only, not a universal false-positive rate.

The source command `node scripts/verify-dangerous-actions.cjs` replays the unchanged
synthetic test corpus from research commit 937a220 through a fresh Free engine.
No action is executed and no transcript is opened. Before these changes the
engine allowed 20 of 30 DENY cases; afterward it allowed zero. Both runs produced
zero false stops among 34 ALLOW cases. The regression checks the source file's
hash as well as the outcomes. The independent benign command corpus has 356
commands and zero matches. Its report hashes both rule implementation files.

These are literal operation checks. Quoted documentation, SELECT strings,
read-only device inspection and ordinary workspace build cleanup stay unmatched.
Existing cache, temporary-directory and generated build cleanup exceptions also
remain, including cache entries and project build folders under the home folder.
The policy guard also allows standalone Node reads of literal policy JSON paths
in its narrow read grammar. An added statement, preload or redirect removes that
exception. Arbitrary scripts are not declared read-only merely because they call
readFileSync somewhere.

From the source checkout, `node scripts/measure-overhead.cjs` measures 1,000 real command-policy PreToolUse
invocations using six fixed synthetic calls. It includes Node startup, file IPC
and signing; it excludes one worker warmup and the separate Burn hook and
session startup. Model calls and sockets are forbidden during measurement.
The measured report is `docs/overhead.json`.

The optional `inbox-reset-codes` rule matches email and messaging connector searches for verification codes, one-time codes, password reset and sign-in links. It is off in solo-dev and on in careful and strict. Normal invoice and code-review searches remain unmatched. As with other rules, only the matched ID leaves hook memory.
