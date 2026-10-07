# remote/ — scripts that run on the server

The daemon streams these files over SSH as `sh -s` (or `sudo … sh -s`). Nothing is installed on the server.
Arguments arrive as shell variable assignments prepended to the script text, never as argv, so they do
not show up in `ps`. Payloads (commands, scripts, secret values) arrive base64-encoded in `SU_PAYLOAD_B64`.

## Rules for every script

- **POSIX sh only** (dash, busybox ash, bash in sh mode). No bashisms: no `[[ ]]`, arrays, `local` is OK
  (dash/ash/bash support it), no `$'…'`, no `echo -e`, no `set -o pipefail`. Use `printf`.
- Start with `set -u`. Do not use `set -e` blindly; check the commands that matter.
- Variables that may be unset must be read as `${SU_X:-}`.
- Human-readable output on stdout (the agent reads it); errors on stderr plus a non-zero exit.
- Machine-read output only where stated below (`key=value` lines, the `SU_RESULT` line).
- State on the server lives under `SU_DIR="$HOME/.server-use"` (create with `mkdir -p`, mode 700).
- Decode payloads with `su_b64d`: `base64 -d`, falling back to `base64 -D` (macOS) and `openssl base64 -d -A`.
  Every script that needs it defines this helper itself (scripts are standalone).
- Must work as root and as a normal user; if something needs root and we are not root, say so on stderr and
  exit 1 (the client may re-run with sudo).
- Target platforms: Debian/Ubuntu, RHEL/Alma/Rocky/Fedora, Alpine (busybox), Arch; macOS best effort.
- Never print secret values (env values, keys other than public keys).
- **Nothing a script starts may read the script's stdin.** The script itself arrives on stdin; where `/bin/sh` is
  bash (RHEL, Fedora, Arch), a child that reads stdin silently swallows the rest of the script and the run still
  exits 0. Start user commands, health checks, builds and package managers with `</dev/null`, or wrap the whole
  script in a function and call it as `main </dev/null` (deploy.sh does this).

## Contracts

### facts.sh — no variables
stdout: `key=value` lines. Keys (all optional, empty = unknown):
`os` (PRETTY_NAME or uname -sr), `arch`, `kernel`, `init` (systemd|openrc|other), `docker` (version|no),
`compose` (yes|no — `docker compose` plugin or `docker-compose`), `git` (version|no), `python3` (version|no),
`node` (version|no), `uv` (yes|no), `tz` (IANA name if known, else `date +%Z`), `cpus`, `mem_mb`,
`disk_root_free_gb`, `pkg` (apt|dnf|yum|apk|pacman|zypper|brew|none), `user`, `uid`, `home`,
`sudo` (root|nopasswd|password|none — `sudo -n true` decides between nopasswd and password; none = no sudo binary),
`crontab` (yes|no), `flock` (yes|no), `setsid` (yes|no).

### status.sh — no variables
stdout: `key=value` lines: `uptime_s`, `load1`, `mem_used_pct` (integer, MemAvailable-based), `disk_root_used_pct`
(integer), `failed_units` (count, or `-` without systemd), `failed_list` (comma list, max 5), `containers_running`,
`containers_total` (or `-` without docker / no permission), `reboot_required` (yes|no: /var/run/reboot-required,
or needs-restarting -r on RHEL when available).

### logs.sh — SU_SOURCE, SU_LINES (default 200), SU_SINCE (e.g. 30m, 2h, 1d; may be empty)
Decide what SU_SOURCE is, in this order: existing file path → `tail -n`; docker container name/id →
`docker logs --tail N [--since X]`; systemd unit (`X` or `X.service`) → `journalctl -u … -n N --no-pager [--since]`
(convert 2h → "2 hours ago"); otherwise exit 1 and list candidates on stderr (running containers, loaded services
whose name contains SU_SOURCE). With SU_SINCE for files: ignore it and say so on stderr.

### job.sh — SU_ACTION start|ls|logs|stop|status|wait, SU_NAME, SU_LINES (default 100), SU_PAYLOAD_B64 (start), SU_MAX_TIME
Job dir `$SU_DIR/jobs/$SU_NAME/` holding `cmd.sh`, `out.log`, `pid`, `exit`, `started`, `finished`.
- start: refuse if a job with that name is running. Write the decoded payload to `cmd.sh`. Launch detached so it
  survives the SSH channel closing: `setsid` when available, else `nohup`; stdin from /dev/null; output
  (stdout+stderr) to `out.log`; when the command ends write its exit code to `exit` and a timestamp to `finished`.
  Run `cmd.sh` with bash if available, else sh. Print `started <name> pid <pid>` and the log path.
- status: running|exited <code>|unknown, pid, started, finished, log size.
- ls: one line per job: name, state, started, exit.
- logs: `tail -n SU_LINES out.log`.
- stop: TERM the process group (setsid made it a leader), wait up to 10 s, then KILL; say what happened.
- wait: one short state probe, headed by `SU_JOB state=... code=... started=...`; `SU_TAIL=1` adds the log tail.
  The daemon waits between probes, so no SSH channel is occupied by sleeping. `SU_MAX_TIME` (seconds) on start
  requires `timeout -k`: TERM at the limit, KILL after 30 seconds, recording 124 or 137. It refuses to start if
  kill-after support is unavailable. Jobs best-effort set oom_score_adj to 500.

### check.sh — SU_CHECK
Read-only one-pass findings; the check operation decodes them and computes the previous/new/resolved diff.
Thresholds and skip categories come from validated inventory configuration. Missing tools and permissions
remain info findings. Backup freshness defaults to managed backups and accepts explicit path/hour thresholds.

### doctor.sh — SU_SINCE_MIN (default 120), SU_DEEP (default 0)
Read-only `== section` blocks and tab-separated rows for host pressure, disks, OOM, services, containers,
log signatures, changes, managed cron/jobs, certificates and unavailable probes. Output is redacted before
leaving the server. The operation validates the snapshot, ranks findings and renders next commands.

### watch.sh — installed monitoring runner and control actions
Installs check plus notification configuration in the login user's private managed directory and uses the
existing cron helper to preserve foreign entries. Tokens arrive on stdin; notification clients receive
credentials via stdin/config, never argv. A lock prevents overlapping probes. Two bad/clean probes debounce
notifications, with six-hour reminders; mute suppresses alerts and heartbeat runs after each probe.

### cron.sh — SU_ACTION ls|add|rm|run|logs, SU_NAME, SU_SCHEDULE (add), SU_PAYLOAD_B64 (add), SU_LOCK 1|0, SU_LINES
Entries live in the user's crontab inside a block:
```
# >>> server-use (managed block — edit with `server-use cron`) >>>
0 6 * * 1-5 /bin/sh /home/alice/.server-use/cron/fetch.sh # server-use:fetch
# <<< server-use <<<
```
- The command itself is stored in `$SU_DIR/cron/<name>.cmd` (decoded payload); the crontab line calls a wrapper
  `$SU_DIR/cron/<name>.sh` that: cd's to $HOME, appends a `=== <date> start` line to `$SU_DIR/logs/cron-<name>.log`,
  runs the command with bash if available else sh (under `flock -n $SU_DIR/cron/<name>.lock` when SU_LOCK=1 and flock
  exists; if the lock is held, log "skipped: previous run still active" and exit 0), then logs `=== <date> exit <code>`.
- Use the absolute home path in the crontab line (cron has no $HOME expansion guarantees... it does set HOME, but
  write the absolute path anyway). No `%` may appear unescaped in the crontab line (the wrapper avoids that).
- **Lines outside the block must stay byte-for-byte identical.** Read with `crontab -l` (treat "no crontab for" as
  empty), rebuild, install with `crontab -` from a temp file. `add` with an existing name replaces that entry.
  Remove the block entirely when it becomes empty.
- ls: print server time zone (`tz=`), current server time, then each managed entry (`name  schedule  command`
  where command is the first 80 chars of the .cmd file). Also mention how many foreign lines exist (count only).
- rm: remove entry + its .cmd/.sh/.lock files; keep the log. Exit 1 if unknown name.
- run: execute the wrapper now (foreground) and print the new log lines.
- logs: `tail -n SU_LINES` of the log.
- No crontab binary → exit 1 with a clear message (suggest installing cron / cronie).

### env.sh — SU_ACTION ls|set|rm, SU_APP, SU_KEY, SU_PAYLOAD_B64 (set), SU_BASE (optional)
App base: SU_BASE if set; else `/opt/$SU_APP` if it exists; else `$HOME/apps/$SU_APP` if it exists; else
`/opt/$SU_APP` when root, `$HOME/apps/$SU_APP` otherwise. File: `<base>/shared/.env`, created with mode 600
(umask 077). Values are written as `KEY=value` with the value single-quoted when it contains anything outside
`[A-Za-z0-9_./:@-]` (escape `'` as `'\''`). set replaces an existing KEY line in place (keep other lines and order).
ls prints keys only, never values, plus the file path. rm removes the KEY line (exit 1 if absent).

### deploy.sh — SU_ACTION deploy|ls|rollback|key|watch-check, SU_NAME, SU_REPO, SU_REF, SU_BASE, SU_BUILD,
### SU_RUN, SU_HEALTH, SU_KEEP (default 3), SU_WATCH (1 = persist for pull checks), SU_SELF_B64 (this script)
Base resolution as in env.sh. Layout: `<base>/releases/<UTC yyyymmddHHMMSS>-<shortsha>/`, `<base>/current` → symlink,
`<base>/shared/.env`, `<base>/.server-use/` (deploy.sh copy + deploy.env for watch mode + deploy.log).
- deploy: clone `SU_REPO` at `SU_REF` (default: remote default branch) with `git clone --depth 1 [--branch REF]`
  into a new release dir. If `$HOME/.ssh/server-use-deploy-$SU_NAME` exists, use it via
  `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"` and rewrite
  `https://github.com/o/r(.git)` to `git@github.com:o/r.git`. Link `shared/.env` into the release as `.env` (create
  shared/.env empty, mode 600, if missing). Build: SU_BUILD if set; else compose file (compose.yml|compose.yaml|
  docker-compose.yml|docker-compose.yaml) → `docker compose -p <name> up -d --build --remove-orphans` (this also
  starts it); else package.json → `npm ci` (or `npm install` without lockfile) and `npm run build --if-present`;
  else pyproject.toml/requirements.txt → venv in `<release>/.venv` via `uv venv` + `uv pip install` when uv exists,
  else `python3 -m venv` + pip (`pip install .` for pyproject, `-r requirements.txt` otherwise).
  Switch `current` atomically (`ln -sfn` to a temp name + `mv -T`, busybox fallback). Start: if SU_RUN is set and
  systemd is present and we are root: write `/etc/systemd/system/server-use-<name>.service`
  (WorkingDirectory=<base>/current, EnvironmentFile=-<base>/shared/.env, ExecStart=/bin/sh -c '<SU_RUN>',
  Restart=on-failure), daemon-reload, enable, restart. Without root/systemd: run SU_RUN like job.sh (detached,
  pid in `<base>/.server-use/run.pid`, log `<base>/.server-use/run.log`), stopping the previous pid first.
  Health: if SU_HEALTH is set, retry it up to 10 times, 3 s apart, in `<base>/current`. On failure: point `current`
  back to the previous release, put back the run.sh/unit file and service the previous deploy used and restart
  it (compose up in the previous release / systemctl restart / restart the job), print `ROLLED BACK`, exit 1. On success, record the release's service and a copy of its run.sh/unit file in
  `<base>/.server-use/service.<release>` and `launch.<release>` (pruned with the release). Keep the newest SU_KEEP releases (never delete current or the
  previous one). If SU_WATCH=1, or deploy.env exists and the crontab still has the `# server-use:deploy-<name>` entry
  (the last deploy's settings win; after `cron rm deploy-<name>` deploys leave deploy.env alone): write SU_SELF_B64 decoded to `<base>/.server-use/deploy.sh` and all SU_* inputs
  (except payload/self) to `<base>/.server-use/deploy.env` as `export SU_X='…'` lines.
  **Last line of stdout on success:** `SU_RESULT base=<base> release=<dir> sha=<shortsha> service=<unit|job|compose|none>`
  (single spaces, no spaces inside values).
- ls: releases newest first, mark current, show sha and date.
- rollback: switch `current` to the previous release, put back the service and run.sh/unit file recorded for it
  (stop the current service if it differs; releases without a record keep the current ones) and restart it; exit 1
  if there is none. While the pull check is active (same test as above), add the old sha to `watch-skip`.
- key: create `$HOME/.ssh/server-use-deploy-$SU_NAME` (ed25519, `ssh-keygen -N ""`) if missing; print the public
  key and the hint `gh repo deploy-key add <file> -R owner/repo` / GitHub → Settings → Deploy keys.
- watch-check (run by cron from the persisted copy): source `<base>/.server-use/deploy.env`; `git ls-remote` the
  ref; if the sha differs from the current release's sha, run a deploy (same script, SU_ACTION=deploy) and log to
  `<base>/.server-use/deploy.log`; otherwise print nothing and exit 0. The base is the directory two levels above
  the script (`<base>/.server-use/deploy.sh`).

### harden.sh — SU_ACTION install-key|lock-password|unlock-password|agent-user|check, SU_PUBKEY, SU_AGENT_USER
- install-key: append SU_PUBKEY to `$HOME/.ssh/authorized_keys` unless the exact key (type + base64) is already
  there; `~/.ssh` 700, file 600. Print `key installed` or `key already present`.
- lock-password (root): if `/etc/ssh/sshd_config` includes `sshd_config.d/*.conf`, write
  `/etc/ssh/sshd_config.d/00-server-use.conf` (sorts before e.g. 50-cloud-init.conf; first value wins) with
  `PasswordAuthentication no` and `KbdInteractiveAuthentication no`; otherwise insert the same two lines at the top of
  sshd_config after backing it up to `sshd_config.server-use.bak`. Validate with `sshd -t` (revert and exit 1 on
  failure). Reload: `systemctl reload ssh || systemctl reload sshd || service ssh reload || service sshd reload ||
  kill -HUP <sshd pid>`. Print the effective values from `sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication)'`
  and exit 1 if passwordauthentication is not `no`.
- unlock-password (root): undo exactly what lock-password did (remove the drop-in or restore the backup), `sshd -t`,
  reload.
- agent-user (root): create SU_AGENT_USER with a home dir and a login shell (`useradd -m -s /bin/bash`, busybox
  `adduser -D`), no sudo, lock its password, install SU_PUBKEY into its authorized_keys. Idempotent.
- check: report (one line each): root login setting, password auth, pubkey auth, fail2ban installed/active,
  firewall (ufw/firewalld/nft) status, unattended upgrades, pending reboot, open listening ports
  (`ss -tlnp` or `netstat -tln`). Read-only.
