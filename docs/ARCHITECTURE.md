# Architecture

server-use is a thin client, a background daemon, and a set of small POSIX shell scripts that are streamed to the
servers over the SSH connection the daemon already holds. No remote agent or package is required; jobs, cron,
watch and deploys create managed files described below.

```
 Claude Code ─┐                                          ┌── web1
 Codex ───────┤ server-use CLI / mcp                     │
 MCP client ──┼──────────────> daemon (one per user) ────┼── web2    one SSH connection per server,
 any agent ───┘  named pipe or Unix socket + token       │           up to 8 channels on each
                                                         └── db1
```

## Why a daemon

An SSH handshake costs 6-10 round trips plus a key exchange. Agents run many short commands, so paying that per
command is slow and noisy. OpenSSH's `ControlMaster` would solve it, but Win32-OpenSSH does not support it, and
most of the people we build for sit on Windows. A small in-process client (`ssh2`) works the same on Windows,
macOS and Linux, supports password and keyboard-interactive login, and lets one daemon share the pool, inventory,
pinned host keys and audit log between every agent on the machine.

## Components

| Path | Role |
|---|---|
| `bin/server-use`, `bin/server-use.cmd`, `bin/server-use.mjs` | Launchers. The Claude Code plugin puts `bin/` on the Bash tool's PATH. |
| `src/cli.mjs` | Verb dispatch, argument parsing, `help <verb>`. Loads only `node:net` and the client, so it starts fast; `ssh2` is loaded by the daemon only. |
| `src/client.mjs` | Connects to the daemon (starting it if needed), performs the mutual authentication, sends NDJSON requests. |
| `src/daemon.mjs` | The op table (`exec`, `put`, `get`, `status`, `logs`, `job`, `cron`, `env`, `deploy`, `servers.*`, ...), connection lifecycle, version switch, lock file. |
| `src/pool.mjs` | One `ssh2` connection per server, channel limits, keepalive, reconnect, idle close. |
| `src/ops/*.mjs` | The operations: `exec.mjs` (commands, fan-out, timeouts, kill of the remote process group), `transfer.mjs` (SFTP put/get), `scripts.mjs` (status, logs, jobs, cron, env, deploy, harden), `servers.mjs` (add, import, facts, trust). |
| `src/remote.mjs` | Runs a script from `remote/` on a server (`sh -s`, or `sudo sh -s`). |
| `src/hostkeys.mjs`, `src/inventory.mjs`, `src/secrets.mjs`, `src/audit.mjs`, `src/guard.mjs` | Pinned host keys, inventory, secret storage, audit log, per-server policy. |
| `src/mcp.mjs` | `server-use mcp`: a hand-written stdio MCP server over the same daemon. Exports `TOOLS` and `callTool` so other adapters (for example NEXUS) offer exactly what MCP offers. |
| `remote/*.sh` | Server-side logic, see below. |
| `skills/*/SKILL.md` | Agent Skills that teach the model when and how to use the CLI. |

## The local protocol

- Transport: a named pipe (`\\.\pipe\server-use-<hash>`) on Windows, `~/.server-use/daemon.sock` elsewhere (a
  shorter path under the temp directory when the socket path would exceed the OS limit).
- Authentication (protocol 2): client and daemon each prove that they know the token in
  `~/.server-use/daemon.token` with an HMAC over the other side's nonce. The token never crosses the pipe, the
  client sends nothing secret before the daemon proved itself (an attacker squatting the pipe name gets nothing),
  and a connection that fails the proof is dropped before any request is served.
- Framing: newline-delimited JSON. A request is `{t:'req', id, op, args}`, the answer `{t:'res', id, ok, result}`.
- Versioning: the `hello` carries the client version and protocol. A newer client makes an older daemon exit once
  it is idle (never in the middle of a request); the client then starts a fresh daemon.
- Lifetime: the first call starts the daemon detached; it exits after 12 hours without requests. A lock file keeps
  two daemons from running.

## The connection pool

- One connection per server, opened on first use, keepalive every 15 s, closed after 30 minutes idle.
- At most 8 channels per server (sshd's default `MaxSessions` is 10; the rest stays free for SFTP) and 32 overall.
  A refused channel lowers the cap for that connection instead of dropping it.
- Fan-out runs the hosts in parallel; output is buffered per host and reported as one block per host, so lines
  never interleave.
- A command that was running when the connection dropped is reported as `DISCONNECTED` and never retried: it may
  have had effects.
- A caller that disconnects (Ctrl-C, tool timeout) aborts its operations. A command that already runs gets its
  remote process group killed; one that has not started never starts.

## Server-side scripts

Everything beyond a plain command is a small POSIX `sh` script in [`remote/`](../remote/), streamed over stdin
(`sh -s`). Arguments arrive as shell variable assignments in front of the script (`SU_ACTION=...`), never as argv,
so they do not show up in `ps`; payloads (commands, scripts, `.env` values) are base64-encoded. Scripts must run on
dash and busybox. Because the script itself arrives on stdin, scripts put their logic in functions and start
children (build tools, health checks, services) with stdin from `/dev/null`, so no child process can swallow the
rest of the script.

`check` emits structured findings without changing remote state; the daemon keeps previous findings locally for
diffs. `doctor` redacts a read-only snapshot on the server and ranks its evidence locally. `watch` installs its own
cron wrapper, private notification configuration and debounce state under the SSH user's `~/.server-use/`.
Job waiters use short probes and release channels between them; disconnecting a waiter leaves the detached job
running. Approved runbooks stay local and stream their pinned script only when invoked.

What server-use leaves behind is visible and removable: `~/.server-use/` of the SSH user (job output and exit
codes, cron wrappers and logs), a marked block in the user's crontab, deploys under `/opt/<name>` or `~/apps/<name>`,
`server-use-<name>.service` units when `--run` is used as root, and this machine's public key in
`authorized_keys` after `add` with a password. See [`remote/README.md`](../remote/README.md) for the contract of
each script.

## Local state

`~/.server-use/` (override with `SERVER_USE_HOME`):

```
servers.yaml     inventory, no secrets
known_hosts      pinned host keys (OpenSSH format)
id_ed25519(.pub) this machine's key, comment server-use@<machine>
daemon.token     shared secret of the local protocol (private)
secrets.json     only when no OS keychain is available (mode 0600)
notes/<name>.md  what runs where, written by agents and humans
runs/            full output of clipped commands, kept 7 days
audit.jsonl      every operation: time, agent, host, command, exit
runbooks.yaml    approved script, hash, destinations, parameters, verification and limit (mode 0600)
state/check.json previous fleet findings for new/ongoing/resolved diffs
```

## Exit codes

`0` ok, `2` usage or unknown server, `3` needs `--yes` (ask the user), `4` host key changed, `5` unreachable,
`6` auth failed, `7` readonly, `8` sudo password missing, `10` check attention, `124` timeout, `130` aborted. Otherwise the remote exit
code of the first failing host. The skills teach the model what each means.

## Integrations

- **Claude Code**: `.claude-plugin/` (plugin + marketplace); skills become `/server-use:<skill>`, `bin/` lands on PATH.
- **Codex / agent plugins**: `plugin.json` and `.agents/plugins/marketplace.json`; in the verified Codex 0.160 setup,
  the plugin does not add `bin/`, so the CLI comes from `npm i -g` and local stdio MCP provides server access.
- **MCP**: `server-use mcp`, thirteen tools (`servers`, `exec`, `transfer`, `logs`, `cron`, `job`, `deploy`,
  `check`, `doctor`, `watch`, `runbook`, `run`, `permissions`).
- **Other shell/skills clients**: use the same CLI and install the skills in the client's configured directory.
  Client-specific installations beyond the recorded Claude Code/Codex checks remain unverified.
- **NEXUS Harness**: the `nexus-server-use` plugin in that repository registers the MCP tool table as native
  `server_*` tools with real approval dialogs, and the AI attaches servers to a conversation itself.
