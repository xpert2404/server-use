---
name: server-doctor
description: >-
  Diagnose a slow, broken or unreachable server or app with server-use, using a triage checklist: status, logs,
  disk and inodes, memory and OOM kills, failed systemd units, containers, load, recent deploys. Use for: server
  down, site not reachable, slow, 502, disk full, out of memory, service crashed, what's wrong with the server.
  German: Server langsam, Server down, geht nicht mehr, Platte voll, Speicher voll, Dienst abgestürzt, was ist
  los mit dem Server.
---

# server-doctor

**Diagnose first, and change nothing until you know the cause.** Everything below only reads. You finish
with a report and a proposed fix, and you apply the fix only after the user agrees or through a previously
approved, unchanged runbook whose scope and parameters cover this fix. That goes for restarts,
deleting files, pruning and reboots alike. If `server-use` is missing, see the server-use skill.

## 0. Context

```
server-use notes <target>      # what runs there; dated deploys, cron jobs and jobs
server-use doctor <target> --since 2h  # ranked snapshot, evidence, recent changes and unavailable probes
server-use status <target>     # uptime, load, memory, disk, failed units, containers, reboot required
server-use audit -n 30         # what agents recently ran through server-use
```

- `status` marks each server: `!` means disk ≥ 90 %, memory ≥ 95 % or failed units.
- `✗` with exit 5, 6 or 4 means you can't get in at all. For those exit codes, see the table in the
  server-use skill. If the server itself is down, the user has to use the provider's console.
- Several servers: run `server-use status all` to see which ones are affected, then run the checks below
  with `tag:…` or `a,b`.

## 1. Checklist (one round trip)

Use `doctor` first when offered by the installed version (0.2); on 0.1.0 use the manual checklist below.
Add `--sudo` when needed to read privileged logs and `--deep` to measure directories on nearly
full disks. It makes no changes and redacts known credential patterns; missing probes are not proof of health.
For an unattended fleet, `server-use check <targets> --changed` is cheaper and returns 10 when attention changes.
Use the manual checklist below only for details the snapshot did not answer.

If the login user isn't root, add `--sudo`, otherwise journal, dmesg and docker may show nothing:

```
server-use exec <target> --script - <<'EOF'
echo "== uptime";   uptime
echo "== disk";     df -h -x tmpfs -x devtmpfs -x overlay 2>/dev/null || df -h
echo "== inodes";   df -i -x tmpfs -x devtmpfs -x overlay 2>/dev/null | awk 'NR==1 || $5+0 >= 80'
echo "== memory";   free -m; swapon --show 2>/dev/null
echo "== top cpu";  ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu 2>/dev/null | head -n 8
echo "== top mem";  ps -eo pid,user,%mem,rss,comm --sort=-%mem 2>/dev/null | head -n 8
echo "== failed";   systemctl --failed --no-legend 2>/dev/null
echo "== oom";      { journalctl -k --since "2 days ago" --no-pager 2>/dev/null || dmesg 2>/dev/null; } | grep -iE "out of memory|oom-kill|killed process" | tail -n 5
echo "== errors";   journalctl -p err --since "2 hours ago" --no-pager -n 30 2>/dev/null
echo "== docker";   docker ps -a --format "{{.Names}}\t{{.Status}}" 2>/dev/null | head -n 20
echo "== ports";    ss -tlnp 2>/dev/null | head -n 20
EOF
```

## 2. Follow the symptom

**Disk full**
- Find the biggest directories: `du -xh --max-depth=1 / 2>/dev/null | sort -h | tail -n 15`, then drill down.
- The usual suspects:
  - the journal (`journalctl --disk-usage`)
  - docker (`docker system df`)
  - `/var/log`
  - old releases in `/opt/*/releases`
  - app logs
  - core dumps
- If inodes are full, many tiny files are the cause (cache, sessions, mail queue). Count them per directory:
  `find /var /tmp -xdev -type f 2>/dev/null | cut -d/ -f2-3 | sort | uniq -c | sort -n | tail`.

**Memory / OOM**
- The OOM line names the killed process. Check its RSS in `top mem`, the swap, and container limits
  (`docker stats --no-stream`).
- A leak shows up as memory that grows after every restart. Compare the service's uptime with its RSS.

**High load**
- Is it CPU (`top cpu`) or IO wait? Run `vmstat 1 5` and look at the `wa` column.
- Check whether a cron job or a job runs at that moment: `server-use cron ls`, `server-use job ls`.

**Service down or crashing**
```
server-use logs <target> <unit> -n 100 --since 1h
server-use exec <target> 'systemctl status <unit> --no-pager -l'
```

`systemctl status` exits 3 for a stopped unit. The header then reads `exit 3`, not `CONFIRM`, so that 3 comes
from the command, not from the policy.

- Compare the time the problem started with the last deploy in the notes. Then run
  `server-use deploy ls <target> <name>`. A rollback is a candidate fix; propose it, don't run it
  (deploy-repo skill).

**Container**
```
server-use logs <target> <container> -n 100
server-use exec <target> --script - <<'EOF'
docker inspect -f "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}" <container>
EOF
```

**Site not reachable, but the service runs**
- Is the port bound? Check `ss -tlnp`.
- Does it answer locally? Run `curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:<port>/` in a
  script.
- For the firewall and open ports, run `server-use harden <target> --check`. It only reads. Don't call
  `ufw`/`iptables` directly, because the confirm guard flags them.
- Also check the reverse proxy config (get it with `server-use get`) and its logs.

**Reboot required** (`REBOOT REQUIRED` in `status`): mention it. Reboot only with the user's OK.

## 3. Report

Keep it short, in the user's language:

- **Symptom**: what the user sees.
- **Findings**: the evidence, i.e. numbers and 1–3 log lines, not whole dumps.
- **Cause**: or your best hypothesis plus what would confirm it.
- **Proposed fix**: the exact commands, what they affect, and the risk. Then wait for the user's OK.
  - Typical fixes:
    - `journalctl --vacuum-size=500M`
    - `docker system prune` (exit 3, needs the OK anyway)
    - `apt-get clean`
    - restart the unit
    - roll back the deploy
    - add swap
    - raise a memory limit
- **Prevention**, if it fits: log rotation, `SystemMaxUse=` for journald, a disk-check cron job
  (server-cron skill).

After the fix, check again with `status` and the relevant part of the checklist. Then record it in the
notes:

```
server-use notes <target> --append "disk full: journal 18G → SystemMaxUse=2G in /etc/systemd/journald.conf"
```
