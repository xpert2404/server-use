# Roadmap

server-use stays free and open (MIT, no accounts, no paid tiers, no telemetry) and aims at one thing: giving an AI
agent safe, useful hands on your own VPSes. Features are ranked by *real value to VPS users, times how much an
agent benefits, divided by effort*, and by what can be tested end to end. The list below is a plan, not a promise;
what shipped is in the [changelog](../CHANGELOG.md).

## 0.1 (released)

Persistent pooled connections, inventory with pinned host keys and keychain secrets, onboarding that turns a
password into a key, fleet `exec`, `status`, `logs`, `put`/`get`, `job`, `cron`, `env`, git `deploy` with
health-checked rollback and pull-check auto-deploy, `harden`, a Claude Code plugin, a Codex/agent-plugins manifest
and an MCP server.

## 0.2: autonomy you can trust (implemented, unreleased)

The theme is "let the agent run unattended without losing control". Implementation and fixture acceptance are
tracked in [ACCEPTANCE.md](ACCEPTANCE.md); release tagging and downstream version pins are still separate work.

| Feature | What it gives you |
|---|---|
| `check` | One cheap call that answers "does anything need me?": disk, memory, failed units, containers, certificates, stale backups, failed cron runs and jobs, with a new/resolved diff. Exit 10 when something needs attention. An autonomous or scheduled agent starts here. |
| `job wait`, `job start --wait/--max-time` | The agent is woken when a long run ends instead of polling; time-boxed jobs. |
| `runbook` / `run` / `permissions` | The escape hatch for `confirm` servers: you approve a fix script once (pinned by hash, parameters validated, rate limited), and the agent can then run it unattended, for example at 03:00. Also prints a ready-made allowlist for Claude Code/Codex. |
| `watch` | `check` installed on the server as a cron entry, with push notifications (ntfy, Telegram, webhook) and a heartbeat, so a full disk at 03:00 reaches you or your agent even when no chat is open. |
| `doctor` | A one-round-trip incident snapshot with ranked findings, evidence and recent changes (deploys, cron, package updates), instead of 150 unranked lines. |

## 0.3: change safely, go live, never lose data

| Feature | What it gives you |
|---|---|
| `guard` | Config edits (nginx, Caddy, sshd, units, crontab, compose files) with a checkpoint, a verify step and automatic revert; a server-side dead-man timer for changes that could lock you out (sshd, firewall); `undo`. An opt-in policy `guarded` lets such edits through without a prompt because they are reversible. |
| `site` | Domain plus HTTPS for an app in one verb (Caddy, or nginx with certbot): checks DNS first (A/AAAA, Cloudflare proxy), writes only its own files, validates, reloads, verifies from outside, reverts on failure. `deploy --domain` runs it after a healthy deploy. |
| `backup` | Scheduled, database-aware snapshots (Postgres, MySQL/MariaDB, SQLite, volumes, paths), optional append-only offsite copies to another server in your inventory, `verify --deep` that restores into a throwaway container, and a guarded `restore`. Backups are the safety net that makes bigger autonomous changes acceptable. |

## Later

Ideas we like but have not scheduled; each needs a design that fits the agentless model and a way to test it:

- `init`: baseline for a fresh VPS (swap, log caps, unattended upgrades, firewall), lock-out proof via `guard`.
- `update`: patch windows with reboot detection and a before/after diff.
- `tunnel`: reach dashboards (Streamlit, Jupyter, Grafana) on localhost without opening ports.
- Directory `get`/`put`; an `apps` overview and `deploy rm`; drift detection; `discover` for existing servers;
  a security sweep in `doctor`; restic/rclone/S3 targets for `backup`; provider bridges (snapshots, power, cost).
- Other platforms as a *server*: only Linux VPSes are in scope today.

## Not planned

Interactive PTY sessions, a bastion/ProxyJump layer, Windows servers, Ansible-style playbooks, a web UI, and shared
multi-user inventories. Each can be revisited when someone has a concrete need. See
[CONTRIBUTING.md](../CONTRIBUTING.md) if you want to take one on.
