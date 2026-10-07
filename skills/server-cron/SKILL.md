---
name: server-cron
description: >-
  Create and manage cron jobs on the user's servers with server-use: recurring scripts, scheduled data fetches,
  nightly backtests, backups, reports; list, test-run, read logs, remove. Use for: cron, cronjob, schedule this,
  run every day, every hour, on weekdays, recurring task. German: Cronjob anlegen, jeden Morgen um 6, regelmäßig
  ausführen, zeitgesteuert, täglich, nächtlicher Lauf.
---

# server-cron

When the installed version offers watch (0.2), prefer `server-use watch on <target> --every 5m --notify ntfy` after approval
(`--yes` only after the user agrees), rather than writing a polling cron script. It preserves foreign cron
entries, debounces findings, supports mute/HTTP probes/heartbeat, and notifies without an open chat.
Keep notification tokens out of chat and argv; `watch --stdin` reads them from trusted local input.

server-use writes real crontab entries, so the system cron runs them and no agent or daemon has to stay
alive. It manages its own marked block in the crontab and never touches other lines. Each job runs through
a wrapper that writes a log and holds a `flock`, so a slow run can't overlap with the next one. If
`server-use` is missing, see the server-use skill.

## Commands

```
server-use cron ls <target>                                        # server time zone + time, managed jobs, count of other lines
server-use cron add <target> <name> '<schedule>' '<command>'       # [--no-lock]
server-use cron add <target> <name> '<schedule>' --script -        # the command as a script on stdin (heredoc)
server-use cron run <target> <name>                                # run now in the foreground, print the new log lines
server-use cron logs <target> <name> -n 50
server-use cron rm <target> <name>
```

- Adding a job under an existing name replaces that job.
- Each run writes a start line and an exit-code line to `~/.server-use/logs/cron-<name>.log` on the server.
- The schedule is either 5 fields (`0 6 * * 1-5`) or a keyword like `@daily`, `@hourly` or `@reboot`.
  Weekday 1-5 means Monday to Friday, and 0 or 7 is Sunday.
- Jobs land in the login user's crontab.

## Workflow

1. **Look first**: run `server-use notes <target>` and `server-use cron ls <target>` to see existing jobs and
   the server's time zone.
2. **Time zone**: cron uses the server's time zone (the `tz=` line in `cron ls`), but the user means their
   own local time. So "um 6 Uhr" probably means Europe/Berlin. On a UTC server, either:
   - convert the time and tell the user about daylight saving time: 06:00 Berlin is 04:00 UTC in summer and
     05:00 UTC in winter, or
   - make the job DST-proof (see the example below): schedule both hours and let the job check the local
     hour itself.
   Changing the server's time zone (`timedatectl set-timezone`) affects everything on it, so do it only when
   the user asks.
3. **Write the command for cron**. Cron starts with no login shell, a minimal PATH, and the home directory
   as the working directory.
   - Use absolute paths, e.g. `/opt/trading/current/.venv/bin/python`, never plain `python` or
     `source venv/bin/activate`. The `current` symlink stays valid across deploys.
   - `cd` into the app directory first when the code uses relative paths.
   - Cron doesn't load `.env`. Load it with `set -a; . /opt/trading/shared/.env; set +a`, or let the app load
     it itself.
   - `%` is safe here, because the command lives in a file, not in the crontab line.
   - If the command has quotes, several lines or `$(…)`, pass it with `--script -`.
4. **Overlap**: the `flock` is on by default. If the previous run is still busy, the new run is skipped, and
   the log says so. Use `--no-lock` only when parallel runs are intended.
5. **Test it**: run `server-use cron run <target> <name>`. The default timeout is 10 minutes; raise it with
   `--timeout 30m`. Fix the job until the run passes, because a job that never ran is untested. For long
   jobs, test a shorter variant (e.g. a smaller date range), or start the same command once with
   `server-use job start` and follow `job logs`.
6. **Report** the schedule in the user's time and in server time, plus where the log is. server-use adds the
   job to the notes by itself. Add the reason with `server-use notes <target> --append "…"`.

## Examples (trading system)

Fetch market data every weekday at 06:00 (the server runs in Europe/Berlin):

```
server-use cron add trading-1 fetch-quotes '0 6 * * 1-5' 'cd /opt/trading/current && .venv/bin/python -m jobs.fetch'
server-use cron run trading-1 fetch-quotes
```

The same job on a UTC server, DST-proof. The server needs tzdata, so check once that
`TZ=Europe/Berlin date` shows Berlin time:

```
server-use cron add trading-1 fetch-quotes '0 4,5 * * 1-5' --script - <<'EOF'
[ "$(TZ=Europe/Berlin date +%H)" = 06 ] || exit 0
cd /opt/trading/current && .venv/bin/python -m jobs.fetch
EOF
```

A nightly backtest at 02:00 that loads `.env` and writes a dated results file:

```
server-use cron add trading-1 nightly-backtest '0 2 * * *' --script - <<'EOF'
cd /opt/trading/current || exit 1
set -a; . /opt/trading/shared/.env; set +a
mkdir -p /opt/trading/results
.venv/bin/python -m backtest.run --out "/opt/trading/results/$(date +%F).json"
EOF
server-use cron logs trading-1 nightly-backtest -n 20      # after the first run
```

A deployed tool that runs once and exits (e.g. TradingAgents via deploy-repo), every weekday evening:

```
server-use cron add lab tradingagents '30 22 * * 1-5' --script - <<'EOF'
cd /opt/tradingagents/current || exit 1
set -a; . /opt/tradingagents/shared/.env; set +a
.venv/bin/python main.py
EOF
```

Always use absolute paths for `.env`: `../shared/.env` from inside `current` resolves through the symlink
into `releases/` and misses the file.

## Pitfalls

- The job runs as the login user, so check that this user can read the files and write the output dirs.
- `crontab` missing (`crontab=no` in `server-use show`): ask the user, then install `cron` or `cronie` with
  `exec … --sudo`.
- Remove jobs you replaced or no longer need: `server-use cron rm <target> <name>`.
- Other people's crontab lines (outside the block) are not yours to edit. Don't use `crontab -e`, `crontab -r`,
  or a hand-written `crontab -` for them.
