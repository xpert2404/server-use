# Changelog

All notable changes to server-use. The format follows [Keep a Changelog](https://keepachangelog.com/), versions
follow [Semantic Versioning](https://semver.org/); before 1.0 minor versions may change behavior.

## Unreleased (0.2)

### Added

- `check` with per-server thresholds, backup freshness and new/resolved attention diffs (exit 10), plus `watch`
  cron monitoring with ntfy/Telegram/signed webhook notifications, debounce, mute, HTTP probes and heartbeat.
- `job wait`, `job start --wait` and `--max-time`: completion waits survive daemon restart and disconnects,
  release SSH channels between probes, return the job exit code and bound runaway process groups.
- `runbook`, `run` and `permissions`: one-time approvals pin script/verification, enumerated parameters,
  server destinations, sudo and rate limits; durable attempt reservations prevent concurrent/restart bypasses.
- Read-only `doctor` incident snapshots with ranked evidence, recent changes and unavailable probes.
- MCP tools `check`, `watch`, `doctor`, `runbook`, `run` and `permissions`; existing `TOOLS`, `callTool` and
  `DaemonClient` exports stay compatible for native integrations.
- Unit and real-sshd end-to-end coverage for the 0.2 feature set.
- Documentation: [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), [testing](docs/TESTING.md),
  [roadmap](docs/ROADMAP.md) and [contributing](CONTRIBUTING.md).
- Verified setup for Codex (plugin, MCP in the `workspace-write` sandbox, approval mode, old Windows builds).

### Fixed

- Validate generated Ed25519 pairs before use or persistence, retrying malformed draws from ssh2's DER
  conversion. This also removes the intermittent fixture host-key failure seen in CI.

## 0.1.0 (2026-10-03)

First release.

### Added

- Background daemon holding one pooled SSH connection per server, shared by every agent on the machine; mutual
  HMAC authentication on the local pipe/socket.
- Inventory (`servers.yaml`) with pinned host keys (TOFU, import from `~/.ssh/known_hosts`), OS-keychain secrets
  with a 0600 file fallback, per-server policy `open`/`confirm`/`readonly`, audit log.
- Onboarding: `add` installs a key from a password and forgets the password; `import ssh-config`; `harden`
  (`--lock-password`, `--agent-user`).
- Operations: fleet `exec` (parallel, per-host blocks, clipped output with full logs, `--script`, `--sudo`),
  `status`, `logs`, `put`/`get`, `job` (survives disconnects), `cron` (marked crontab block, `flock`), `env`,
  `notes`, `facts`, `audit`.
- `deploy`: git releases with a `current` symlink, build detection (compose, npm, python/uv), systemd service or
  detached job, health check with automatic rollback, manual rollback, deploy keys, `--watch` pull-check
  auto-deploy.
- Integrations: Claude Code plugin and marketplace, Codex/agent-plugins manifest, `server-use mcp` (7 tools),
  `server-use skills install`, five skills (`server-use`, `add-server`, `deploy-repo`, `server-cron`,
  `server-doctor`).
- CI on Ubuntu, Windows and macOS (Node 22 and 24) plus an end-to-end job against a Debian sshd container.

### Security

- A host key of a different type than the pinned one counts as changed (exit 4); `trust --reset` also overrides a
  stale entry in `~/.ssh/known_hosts`.
- `harden --agent-user` installs keys as the target user and never follows paths the user controls as root.
- A client that disconnects before its command starts never causes the command to run; a connection lost mid-run
  is reported as `DISCONNECTED` and never retried.
- The MCP transfer tool cannot read or write server-use's own state, the SSH trust files or the login keys of
  inventory servers.
