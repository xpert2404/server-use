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
`5` unreachable, `6` auth failed, `7` readonly, `8` sudo password missing, `124` timeout. Otherwise the remote exit
code of the first failing host.

Deploys clone the repo into `<base>/releases/<time>-<sha>`, switch a `current` symlink, link `shared/.env`, build
what they find (compose, npm, python/uv) unless `--build` is given, run `--run` as a systemd service (or a background
job without root), and roll back automatically when `--health` fails. `--watch 5m` adds a cron pull check that
deploys new commits. `deploy key` creates a deploy key for private repos.

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

## Development

```
npm install
npm test
npm run bench
```

## License

MIT
