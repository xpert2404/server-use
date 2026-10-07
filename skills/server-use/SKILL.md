---
name: server-use
description: >-
  Operate the user's own servers over SSH with the server-use CLI: run commands on one or many servers, status,
  logs, files, long-running jobs, cron, .env, deploys. Use whenever a task touches a remote server, VPS or host
  (run on the server, check trading-1, all servers, ssh into; German: auf dem Server ausführen, schau auf dem
  Server nach, alle Server, VPS, per SSH). Read this before the specific skills add-server, deploy-repo,
  server-cron, server-doctor.
---

# server-use

`server-use` gives you hands on the user's servers. A local daemon (starts by itself) keeps one SSH
connection per server, so after the first call every command costs one round trip. Nothing gets installed
on the servers. Full options for one verb: `server-use help <verb>`.

## Is it installed?

Run `server-use --version`. If that fails, the plugin's `bin/` isn't on your PATH (Codex, Hermes, Cursor,
Gemini CLI, …). Ask the user, then run `npm i -g github:xpert2404/server-use` (Node ≥ 22). Don't use
`npx server-use`: the package is not on the npm registry, so npx would fetch an unrelated package of that name.
In a sandbox without network access, every server comes back unreachable (exit 5). If that happens, tell the
user to allow network access for commands or to use `server-use mcp`.

## Before you touch a server

```
server-use ls                 # names, address, policy, tags, connection
server-use notes trading-1    # the server's memory: what runs where, ports, paths, past deploys/cron/jobs
server-use show trading-1     # facts (os, tz, docker, python3, sudo, …): no need to probe them again
server-use status all         # ✓ ok · ! warning · ✗ unreachable/error
server-use logs web-1 nginx -n 100 --since 1h    # systemd unit, docker container or file path
```

## Targets

`web-1` · `web-1,web-2` · `tag:prod` · `all` (never `@prod`). Several targets run in parallel. Each host gets
its own block, followed by a summary like `3 ok · 1 failed (lab)`. Think twice before you send a changing
command to `all` or to a tag.

## Running commands

For a simple command, pass the whole command as **one** quoted argument:

```
server-use exec web-1 'df -h /'
server-use exec tag:prod 'systemctl is-active nginx'
server-use exec web-1 'apt-get update' --sudo --timeout 20m
```

If the command has quotes, pipes or several lines, send it as a script on stdin. Quote the heredoc
delimiter (`<<'EOF'`) so your local shell expands nothing:

```
server-use exec web-1 --script - <<'EOF'
set -e
cd /opt/app/current
grep -c "ERROR" logs/app.log || true
EOF
```

The script runs in bash, or in sh when bash is missing. If your shell has no heredoc (PowerShell), write
the script to a file with LF line endings and pass `--script ./fix.sh`.
Options: `--sudo` (login user isn't root), `--cwd <dir>`, `--env K=V`, `--timeout 10m` (default 10m),
`--raw` (one host, stdout only), `--json`. Every call starts a fresh shell, so `cd` and `export` don't carry
over to the next call. Use `--cwd` or put the steps in one script.

## Output

Each host gets a header line like `── web-1 · exit 0 · 0.18s`, then its stdout, then `[stderr]` and its stderr.
Long output keeps only the first 50 and last 150 lines. When that happens, the header shows
`full stdout: <path>`. That path is a local file, so grep or tail it instead of rerunning with `--full`.
Better still, cut the output down on the server (`| tail -n 50`, `grep`, `logs --since`).

## Exit codes

| Exit | Meaning | What you do |
|---|---|---|
| 0 | ok | |
| 1 or other | the remote command's own exit code | read stdout/stderr |
| 2 | usage error or unknown server | fix the call; `server-use ls`, `server-use help <verb>` |
| 3 | policy `confirm`: the command looks destructive | **stop and ask the user** (see below) |
| 4 | host key changed | stop and tell the user: this may be a MITM attack or a reinstalled server. Only after the user has checked it and explicitly agrees may you do what the error names (`server-use trust <name> --reset`, or for an address that isn't in the inventory, removing its pinned key) |
| 5 | unreachable | the server is down or rebooting, the IP/port is wrong, or a firewall blocks it. Check `show <name>` and retry once. Don't loop |
| 6 | authentication failed | the key isn't accepted or the password changed. Ask the user (add-server skill) |
| 7 | server is `readonly` | don't change the policy yourself; ask the user |
| 8 | sudo needs a password that isn't stored | the user stores it: `printf '%s' '…' \| server-use set <name> sudo-password --stdin` |
| 124 | timeout | use `job start`, or set a larger `--timeout` |

Exit codes 2–8 can also be the remote command's own status. The host line tells you which one it is:
`── web-1 · CONFIRM: …` comes from server-use, while `── web-1 · exit 3` comes from the command. With several
hosts, the first failing host sets the exit code, so read every block.

**Exit 3 (confirm):** tell the user exactly what will run, on which server and why. Repeat the command with
`--yes` only after the user clearly says yes. Never add `--yes` in advance. The policy is only a heuristic.
Anything destructive (deleting data, restarts on prod, reboots, firewall changes) needs the user's OK even
when no exit 3 shows up. Change a server's policy (`server-use set <name> policy=…`) only when the user asks.

## Long runs: use jobs

Use a job for anything that may take more than a few minutes, such as builds, backtests, backups or big
downloads. A job survives dropped connections and a closed laptop.

```
server-use job start trading-1 backtest 'cd /opt/trading/current && .venv/bin/python -m backtest.run'
server-use job start trading-1 backtest --script ./backtest.sh     # or --script - with a heredoc
server-use job status trading-1 backtest
server-use job logs trading-1 backtest -n 50
server-use job ls trading-1
server-use job stop trading-1 backtest
```

Use `server-use job wait trading-1 backtest --timeout 30m` instead of polling. It returns the job's exit code
and log tail; exit 124 with "still running" means wait again. `job start ... --wait=30m` combines start and
wait; `--max-time 4h` needs `timeout -k`, sends TERM at the limit and KILL after a 30-second grace period,
recording 124 or 137. It refuses to start without that utility. A dropped connection or daemon restart does not
lose job state. For recurring runs, use the server-cron skill.

## Autonomous checks and approved fixes

These commands require the unreleased 0.2 implementation. On an installed 0.1.0, inspect `help check`, `help
doctor` or `help job` before use; fall back to status/logs and the existing job commands if unavailable.

Start unattended fleet work with `server-use check <targets> --changed --json`. Exit 10 means warnings changed
(including resolutions); 0 means no attention change. Inspect findings and use `server-use doctor <target>
--since 2h` for ranked incident evidence. Both are read-only; unavailable probes are explicitly reported.

For persistent monitoring, `server-use watch on <target> --every 5m --notify ntfy` requests confirmation on
confirm-policy servers; repeat with `--yes` only after approval. `watch ls` reads, `test|mute|off` also require
approval. Notification credentials come from trusted local input with `--stdin`, never chat or argv.
`--url URL[=CODE]` adds probes and `--heartbeat URL` pings a dead man's switch. Watch needs cron/curl/flock.

An already approved fix uses `server-use run <target> <name> key=value`; inspect it first with `runbook show`
and `run ... --dry-run`. To approve a new fix, show the complete script, verify command, enumerated parameters,
resolved server destinations, sudo and rate limit, then ask the user. Only after agreement use
`runbook add <targets> <name> --script ./fix.sh --param unit=app --verify 'systemctl is-active app' --limit 3/1h --yes`.
The script reads `$SU_P_unit`. Approval pins hash and target host/port/user. Do not alter runbooks.yaml or widen
approval rules to get around a refusal. Modified scripts, parameters, destinations and readonly are refused;
rate exhaustion needs time or explicit reapproval with a higher limit. `--yes` never bypasses the run limit.
`server-use permissions --format claude|codex` prints reviewable read/run rules without installing them.

## Files: get and put, not cat

```
server-use get web-1 /etc/nginx/sites-available/app ./app.conf
# edit ./app.conf locally
server-use put web-1 ./app.conf /etc/nginx/sites-available/app --sudo   # writes under /etc stop with exit 3 → ask
server-use exec web-1 'nginx -t && systemctl reload nginx' --sudo
```

get and put copy exact bytes, with no quoting trouble, and the file doesn't flood your context. If the remote
path ends with `/`, it's treated as a directory. Use `--mode 640` to set permissions. put and get handle single
files only; for a directory, tar it on the server first. With several targets, get needs a local directory
and names the files `<host>_<file>`. A one-line `sed -i` inside a script is fine; for bigger edits, use
get, then edit locally, then put.

## Secrets

- Never print secret values. Don't `cat` a `.env`, don't run `env`/`printenv`, and don't show private keys
  or `/etc/shadow`. `server-use env ls` shows only the keys.
- Secret values go in on stdin (`env set`, `set … --stdin`, `add --password-stdin`). Never put them in the
  command, in `--env` or in notes. The command line ends up in the remote process list, the audit log and
  this transcript.
- If the user pastes a secret into the chat, use it once via stdin and don't repeat it in your replies.

## Notes: the server's memory

deploy, cron and job add their own entries. When you set something up by hand, add one line saying what it
is, where it lives, which ports it uses and why:

```
server-use notes web-1 --append "nginx proxy app.example.com → :8000, config /etc/nginx/sites-available/app"
```

`server-use audit -n 20` shows what server-use ran recently: agent, host, command and exit code.

More specific skills: add-server (onboarding), deploy-repo (deploys, .env, rollback), server-cron (scheduled jobs),
server-doctor (triage when something is slow, down or full).
