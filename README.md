# server-use

Let your AI agent use your servers.

browser-use gives an agent a browser, computer-use gives it a desktop. server-use gives it your servers over SSH: an
inventory, one pooled connection per server held by a background daemon, fleet exec, status, logs, files,
long-running jobs, cron, `.env` files and git deploys with rollback.

It is a CLI plus a set of skills that teach the model when and how to use it, so it works in any agent with a shell:
Claude Code, Codex, NEXUS Harness, Cursor, Gemini CLI, OpenCode, Hermes. An MCP server is included for clients
without a shell.

Nothing is installed on your servers. They need `sshd` and a POSIX shell.

**Status: 0.1.0, alpha.** Client: Windows, macOS or Linux with Node.js 22+. Servers: Debian/Ubuntu, RHEL family,
Alpine, Arch; macOS best effort. Not on the npm registry yet: `npm i -g github:xpert2404/server-use` installs the
CLI straight from GitHub.

## Quickstart

### Claude Code

```
/plugin marketplace add xpert2404/server-use
/plugin install server-use@server-use
```

The plugin adds the skills (`/server-use:server-use`, `add-server`, `deploy-repo`, `server-cron`, `server-doctor`)
and puts `server-use` on the Bash tool's PATH (`bin/server-use` for Git Bash, `bin/server-use.cmd` for cmd). Then
ask for what you want:

> Add my server 203.0.113.10, user root, tag it prod, and show me its status.

### Codex

```
codex plugin marketplace add xpert2404/server-use
codex plugin add server-use@server-use
npm i -g github:xpert2404/server-use
codex mcp add server-use -- server-use mcp
```

The plugin brings the skills; Codex plugins have no `bin/`, hence the global install. In Codex's default
`workspace-write` sandbox, shell commands have no network access and cannot write outside the workspace, so the
CLI cannot reach your servers from there. The MCP server runs outside the sandbox, which is why the last line
registers it (tested with Codex 0.160 in `workspace-write`). For `codex exec` without a person to approve tool
calls, add `default_tools_approval_mode = "approve"` under `[mcp_servers.server-use]` in `~/.codex/config.toml`;
server-use's own per-server policy still stops destructive commands on `confirm` servers. Older Codex versions on
Windows start MCP servers without `SYSTEMROOT`, which crashes Node; there, add
`env = { SYSTEMROOT = 'C:\Windows' }` to the same section.

### NEXUS Harness and any other agent

```
npm i -g github:xpert2404/server-use
server-use skills install                      # into ~/.agents/skills
server-use skills install --dir <skills dir>   # or wherever your agent reads skills
```

In a container, point `SERVER_USE_HOME` at a persistent volume (for example `/dsh-home/.server-use`) so the
inventory, keys and pinned host keys survive restarts.

### MCP

The plugin does not register an MCP server: CLI plus skills costs no tool schemas per request. If you prefer tools,
or your client has no shell or a sandbox:

```
claude mcp add server-use -- server-use mcp
codex mcp add server-use -- server-use mcp
```

This needs `server-use` on your PATH (`npm i -g github:xpert2404/server-use`). Tools: `servers`, `exec`, `transfer`, `logs`, `cron`,
`job`, `deploy`. MCP servers run outside the Codex sandbox, so this is the way to reach servers from Codex without
loosening its sandbox.

## Command tour

Targets are `web1`, `web1,web2`, `tag:prod` or `all`. `server-use help <verb>` prints every option.

```sh
server-use add web1 root@203.0.113.10 --ask --tag prod   # pin host key, install a key, collect facts
                                              # (agents pipe the password into --password-stdin)
server-use import ssh-config                  # take Host entries from ~/.ssh/config
server-use ls                                 # inventory with connection state
server-use status all                         # one line per server: uptime, load, memory, disk, failed units
server-use exec tag:prod 'df -h /'            # runs in parallel, one output block per host
server-use exec web1 --sudo --script - <<'EOF'
apt-get update && apt-get -y upgrade
EOF
server-use logs web1 nginx --since 1h         # systemd unit, docker container or file, detected
server-use put web1 ./data.csv /srv/data/     # get works the other way round
server-use job start web1 backtest --script ./backtest.sh   # survives disconnects
server-use job logs web1 backtest
server-use job wait web1 backtest --timeout 30m  # blocks until completion, returns the job's exit code
server-use check all --changed                # attention diff, exit 10 for new/resolved warnings
server-use doctor web1 --since 2h             # ranked read-only incident snapshot
server-use cron add web1 fetch '0 6 * * 1-5' '/opt/app/current/.venv/bin/python -m jobs.fetch'
printf '%s' "$API_KEY" | server-use env set web1 app API_KEY   # <app base>/shared/.env, mode 600
server-use deploy web1 owner/repo --run 'node server.js' --health 'curl -fsS localhost:3000/health'
server-use deploy rollback web1 repo
server-use notes web1 --append 'nginx on :443 proxies the app on :3000'
server-use harden web1 --check
server-use audit                              # what server-use did: agent, host, command, exit
```

Quote the remote command as one argument. Anything with quotes, pipes or several lines goes through
`--script -` and a heredoc. Output per host is cut to the first 50 and last 150 lines; the path to the full log is
printed. `--json` gives machine-readable output.

```
── web1 · exit 0 · 0.18s
/dev/sda1  38G  11G  26G  30% /
── web2 · exit 0 · 0.21s
/dev/vda1  78G  70G  4.1G  95% /
2 ok
```

Exit codes: `0` ok, `2` usage or unknown server, `3` needs `--yes` (ask the user), `4` host key changed,
`5` unreachable, `6` auth failed, `7` readonly, `8` sudo password missing, `10` check findings or changes,
`124` timeout (or a job still running at a wait deadline). Otherwise the remote exit
code of the first failing host.

Deploys clone the repo into `<base>/releases/<time>-<sha>`, switch a `current` symlink, link `shared/.env`, build
what they find (compose, npm, python/uv) unless `--build` is given, run `--run` as a systemd service (or a background
job without root), and roll back automatically when `--health` fails. `--watch 5m` adds a cron pull check that
deploys new commits. `deploy key` creates a deploy key for private repos.

## Unattended work (0.2, unreleased)

`check [targets]` collects disk/inodes, memory, failed services, containers, certificates, backup freshness,
managed cron/jobs and other available probes in one call. `--changed` compares warning/critical findings with
the previous successful check per host; new, worsened and resolved findings return 10. Info alone returns 0.
Connection and script failures keep their normal error codes. Configure thresholds with
`server-use set web1 check='disk=95 inodes=95 mem=98 cert=7 backup=/srv/backups/db.sql:24 skip=updates,ssh'`.
Backup paths are absolute and contain no whitespace; repeated `backup=` entries are supported.

`doctor <targets> [--since 2h] [--deep] [--sudo]` reports ranked findings, evidence, next commands and recent
changes. It reads once and makes no fixes. Missing permissions/tools remain visible as unavailable probes.
Known credential patterns in diagnostic logs are redacted; avoid putting secrets into application logs.
Journal/container queries use the requested time window. Recently modified file logs use a bounded tail;
their evidence is labelled separately because it may include older or undated entries.

`job start ... --wait[=30m]` starts and waits in one call. `job wait ... --timeout 30m` waits on an existing job;
124 with "still running" means call wait again, while an exited job returns its own exit code.
`job start ... --max-time 4h` sends TERM at the limit and KILL after a 30-second grace period, recording 124 or
137. It requires `timeout` with `-k`; otherwise it refuses to start the job.
Waiters release SSH channels between probes and survive connection loss and daemon restart.
Connection/probe acquisition is bounded by the wait deadline; the final state/log snapshot has at most one
additional second. A deadline during a stalled probe reports unknown job state rather than claiming completion.

```
server-use watch on web1 --every 5m --notify ntfy --yes
server-use watch ls web1
server-use watch mute web1 all --for 2h --yes
server-use watch test web1 --yes
server-use watch off web1 --yes
```

Watch installs only its own cron entry and private scripts under the login user's home. It requires cron,
`curl` and `flock`. Notification backends are `ntfy[:https://host/topic]`, `telegram:<chat_id>` and
`webhook:<https://endpoint>` (signed webhooks additionally require Python 3). `--stdin` reads an optional
ntfy token, required Telegram bot token or webhook HMAC key; pass credentials from a trusted local secret
source, outside chat and command arguments. `--url URL[=CODE]` adds probes; `--heartbeat URL` pings a dead man's
switch after each run. Two consecutive bad/clean runs debounce alerts/resolutions; ongoing alerts repeat after
six hours. Mutations and test notifications require confirmation on confirm-policy servers. Reinstall with
`watch on` after changing thresholds.
Webhooks POST JSON `{host, message}`. With an HMAC key, `X-Server-Use-Signature` contains `sha256=<hex>` over the
exact UTF-8 request body; receivers should verify it before acting. `watch ls` and `check` expose delivery and
heartbeat failures without revealing credentials.

```
server-use runbook add web1 restart-app --script ./restart.sh --verify 'systemctl is-active app' --param unit=app --limit 3/1h --yes
server-use run web1 restart-app unit=app --dry-run
server-use run web1 restart-app unit=app
server-use permissions --format codex
```

Before `runbook add --yes`, show the user the complete script, verify command, parameters, sudo flag, target
destinations and rate limit. Approval pins their hash and the resolved server host/port/user, so future tagged
servers and repointed aliases require reapproval. Parameters arrive as quoted `SU_P_<key>` environment variables
and must be enumerated at approval. `run` can execute that approved script unattended on confirm-policy servers;
readonly, modified hashes, invalid parameters and rate limits still refuse it. Attempts count before SSH starts,
including failures and daemon restarts. Raising a limit requires reapproval; `--yes` on run does not bypass it.
`runbook ls|show|rm` manages local approval metadata. `permissions` prints rules to review and merge; it installs
nothing. The local state files remain trusted user-owned configuration, not a boundary against local file edits.

The MCP adapter exposes `check`, `doctor`, `watch`, `runbook`, `run` and `permissions` alongside existing tools.
Remote tools require an explicit target. Watch credentials use CLI stdin rather than model tool arguments.

## How the daemon works

```
Claude Code ─┐                                          ┌── web1
Codex ───────┤ server-use CLI / mcp                     │
NEXUS ───────┼──────────────> daemon (one per user) ────┼── web2    one SSH connection per server,
any agent ───┘  named pipe or Unix socket + token       │           up to 8 channels on each
                                                        └── db1
```

- The first `server-use` call starts the daemon in the background; there is nothing to set up. It exits after
  12 hours without requests. `server-use daemon status|stop|restart` for manual control.
- It holds one SSH connection per server (opened on first use, keepalive every 15 s, closed after 30 minutes idle).
  Each command opens a channel on it instead of a new handshake, so follow-up commands cost a round trip or two.
  Fan-out runs in parallel; output is buffered per host so lines never interleave.
- Clients talk to it over a named pipe (`\\.\pipe\server-use-<hash>`) on Windows or `~/.server-use/daemon.sock`
  elsewhere. Client and daemon prove to each other that they hold the token in `~/.server-use/daemon.token`
  (readable only by you) with an HMAC challenge before any request; the token itself never crosses the pipe. A
  connection that fails the proof is dropped, and a client refuses a listener that cannot prove it.
- All agents on the machine share the pool, the inventory, the pinned host keys and the audit log. A newer client
  version replaces an older daemon automatically once that daemon is idle, so running commands are not cut off.
- A connection that drops is re-established on the next command. A command that was running is reported as
  aborted, never silently retried.

State lives in `~/.server-use/` (override with `SERVER_USE_HOME`): `servers.yaml` (inventory, no secrets),
`known_hosts`, `id_ed25519` (this machine's key), `notes/<server>.md`, `runs/` (full output of cut commands, kept
7 days), `audit.jsonl`.

## Security model

server-use can run anything on your servers, including destroying them. These are the layers, and which of them
are real boundaries.

- **Your agent's approval prompt is the real boundary on your machine.** Every `server-use` call goes through the
  agent's Bash or MCP approval. Allow only reading verbs without asking, for example in Claude Code
  `Bash(server-use ls *)`, `Bash(server-use status *)`, `Bash(server-use logs *)`, `Bash(server-use show *)`.
- **A least-privilege user is the real boundary on the server.** `server-use harden <server> --agent-user` creates
  a user without sudo, installs the key and adds it to the inventory as `<server>-<user>`. Use that for
  production.
- **Policy per server is a speed bump, not a boundary.** `confirm` (the default) stops commands that look
  destructive (`rm -rf`, `mkfs`, `reboot`, `systemctl stop`, `docker ... down`, `DROP TABLE`, firewall and user
  changes, ...) with exit 3 until `--yes` is passed; the skills tell the agent to ask you first. `readonly` allows
  only reading operations and no `exec`. `open` lets everything through. The destructive check is a regex
  heuristic and will miss things.
- **Host keys are pinned on first use.** The first connection pins the key (or takes it from
  `~/.ssh/known_hosts`) and shows the fingerprint. A changed key stops everything with exit 4; only
  `server-use trust <server> --reset`, after you verified the change, clears it (for an address that is no longer
  in the inventory, the error names the line to delete).
- **Secrets stay out of the inventory, logs and process lists.** Passwords, sudo passwords and key passphrases go into the OS
  keychain (Windows Credential Manager, macOS Keychain, Secret Service). Without one (headless Linux, containers,
  or `SERVER_USE_SECRETS=file`) they go into `~/.server-use/secrets.json` with mode 0600, the same trust level as
  `~/.ssh/id_*`. They never appear in argv, `ls`/`show` output or the audit log; sudo gets its password on stdin.
- **A password typed into the chat reaches the model provider** and stays in the transcript. `add` therefore
  installs this machine's key right away, proves key login on a fresh connection and deletes the password. It keeps
  it only if key login could not be set up, or as the sudo password for a non-root user who needs one. Change the
  password afterwards, or disable password login with `server-use harden <server> --lock-password`, which only does so after a key-only login
  worked and `sshd -t` passed. To keep the password away from the model entirely, run
  `server-use add <name> <user@host> --ask` yourself in a terminal (needs `npm i -g github:xpert2404/server-use`; the plugin's
  `bin/` is only on the agent's PATH).
- **Everything is logged** to `~/.server-use/audit.jsonl` with the calling agent (Claude Code, Codex, NEXUS, ...).

## What runs on the server

Nothing gets installed. Plain commands run through the pooled SSH connection. Everything else is a POSIX `sh`
script from [`remote/`](remote/) streamed over stdin (`sh -s`, or `sudo sh -s`). Arguments arrive as shell variable
assignments in front of the script, never as argv, so they do not show up in `ps`; payloads such as commands,
scripts and `.env` values are base64-encoded.

What server-use leaves behind is visible and removable:

- `~/.server-use/` of the SSH user: job output and exit codes, cron wrappers and logs.
- A marked block in the user's crontab. Lines outside it are never touched.
- Deploys under `/opt/<name>` (root) or `~/apps/<name>`, and `server-use-<name>.service` when `--run` is used as
  root.
- This machine's public key in `~/.ssh/authorized_keys` after `add` with a password.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): daemon, pool, local protocol, server-side scripts, state
- [docs/SECURITY.md](docs/SECURITY.md): which protections are real boundaries, secrets, reporting a vulnerability
- [docs/TESTING.md](docs/TESTING.md): unit, end-to-end and benchmark; [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md): what is verified
- [docs/ROADMAP.md](docs/ROADMAP.md), [CHANGELOG.md](CHANGELOG.md), [docs/DECISIONS.md](docs/DECISIONS.md)
- [docs/NEXUS.md](docs/NEXUS.md): the NEXUS Harness integration
- [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) (hand-over for AI agents and new contributors)

## Troubleshooting

- `npm i -g github:xpert2404/server-use` fails with `Permission denied (publickey)`: npm resolved the shorthand over
  SSH. Install the tarball instead:
  `npm i -g https://github.com/xpert2404/server-use/archive/refs/tags/v0.1.0.tar.gz`.
- "could not get a matching daemon ... pid N": a daemon of an older version or protocol is still running. Stop it
  with `kill N` (Windows: `taskkill /PID N /F`) and retry.

## Development

```
npm install
npm test
npm run bench
```

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
