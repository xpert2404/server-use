# AGENTS.md: start here (for AI agents and new contributors)

This file is the hand-over. After reading it you should be able to continue the work without the previous
conversation. Keep it current: when you finish something, change the *Status* section in the same commit.

## What this is

**server-use** gives an AI agent persistent SSH hands on the user's own servers (VPSes): inventory, pooled
connections held by a daemon, fleet exec, status, logs, files, jobs, cron, `.env`, git deploys with rollback.
CLI plus Agent Skills plus an MCP server; works in Claude Code, Codex, NEXUS Harness, Cursor, Gemini CLI, Hermes.
Agentless: servers need only `sshd` and a POSIX shell. Repo: https://github.com/xpert2404/server-use (public, MIT).
Owner: Tyron Carlomagno.

## Product direction (decided by the owner, binding)

1. **Free and open source.** MIT, no accounts, no paid tiers, no telemetry. It must be genuinely useful for
   people who run VPSes; prefer features with concrete VPS value over polish.
2. **The AI uses it autonomously, but a chat must not get all servers automatically.** The AI attaches the servers
   a task needs when it judges it fits, visible to the user. In CLI agents this is what the skills do (a server
   is only touched when a server command runs). In NEXUS it is the `server_connect` tool plus a user override
   switch, see [docs/NEXUS.md](docs/NEXUS.md).
3. **Safety is not negotiable**: policies (`confirm` default), host-key pinning, secrets never in argv, logs or
   model-visible output, no root actions on paths a lower-privileged user controls. See
   [docs/SECURITY.md](docs/SECURITY.md).

## Read next

| Need | File |
|---|---|
| Commands and install | [README.md](README.md) |
| How the pieces fit (daemon, pool, protocol, scripts) | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Threat model, what is a real boundary | [docs/SECURITY.md](docs/SECURITY.md) |
| Running the tests, CI, benchmark | [docs/TESTING.md](docs/TESTING.md) |
| What shipped, what is next | [CHANGELOG.md](CHANGELOG.md), [docs/ROADMAP.md](docs/ROADMAP.md) |
| Why it is built this way | [docs/DECISIONS.md](docs/DECISIONS.md) |
| What is verified and what is not | [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) |
| The NEXUS Harness integration | [docs/NEXUS.md](docs/NEXUS.md) |
| Contract of each server-side script | [remote/README.md](remote/README.md) |
| How to add a verb | [CONTRIBUTING.md](CONTRIBUTING.md) |

`PLAN.md` and `GATES.md` may exist in the owner's checkout. They are **git-ignored internal German planning
notes** (they describe private infrastructure) and are not part of the repo. Everything you need is in the files
above; do not copy content from those two files into the repo.

## Status

- **0.1.0 released** on 2026-10-03: tag `v0.1.0`, GitHub release, CI green on Ubuntu/Windows/macOS x Node 22/24 and
  the Debian-sshd e2e job. Claude Code plugin install and Codex (0.160) plugin + MCP verified, see
  [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
- **0.2 implemented, unreleased** (2026-10-07): `check`, `watch`, `job wait`/`--max-time`, `runbook`/`run`/
  `permissions` and `doctor` are integrated through CLI, daemon and MCP, with unit and real-sshd e2e tests,
  reviewed policy/secret boundaries, README/skill updates and changelog entries. See
  [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for exact commands and counts. The interrupted draft work is resolved.
  Package and plugin versions stay 0.1.0 until an explicit release; installer pins in NEXUS still target v0.1.0.
- **CI follow-up fixes (2026-10-07):** daemon socket errors are handled across connect, authentication and
  requests instead of causing an unhandled EPIPE. Mutating requests are not replayed; job waits keep their
  existing reconnect path. Deadline tests distinguish a fresh running snapshot from unknown state when a probe
  times out, and verify that waiting never stops the detached job. See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
- **0.3 planned**: `guard`, `site`, `backup`.
- **NEXUS integration publication reconciled (2026-10-09):** overlay `4ed854a` is included in the remote
  `nexus-harness/main` (`0387a67`). That branch pins published fork `e62b16ee79`, which preserves the server
  contracts from the original local `c01bbf28a9`; its guard source matches the generated runtime manifest.
  When `servers` is off, `connectorDenial` also denies direct `server-use`
  commands in `bash`/`pwsh` (case insensitive). Fork tests and regenerated `runtime/product` are verified.
  This is a tool guard; aliases/dynamic commands/other process tools still depend on shell approvals.
  No further NEXUS push is needed for this integration. The shared local Harness checkout still has an older
  pointer; coordinate with other sessions before updating it. Both GitHub Desktop safety stashes are retained.
- **Server-use CI verified (2026-10-09):** implementation commit `e54559c` passed all seven CI jobs
  (Ubuntu/Windows/macOS x Node 22/24 and Debian-sshd e2e); subsequent documentation commit `2471c9b` also passed.
- **NEXUS integration** lives in the sibling repo `nexus-harness` (private org repo, `../nexus-harness` next to
  this checkout). Status and file map in [docs/NEXUS.md](docs/NEXUS.md).
- **Not on the npm registry yet.** Install with `npm i -g github:xpert2404/server-use`. If npm resolves the
  `github:` shorthand over SSH and fails with `Permission denied (publickey)`, use the https tarball
  `npm i -g https://github.com/xpert2404/server-use/archive/refs/tags/v0.1.0.tar.gz`.

## Things only the owner can do (do not attempt, ask)

- `npm login` / `npm publish` (credentials; never type or store them).
- A **lab VPS** for the real latency numbers, an end-to-end run from the Windows client, and the TradingAgents use
  case. Until then the latency target (warm `exec` about 150 ms p50 at 30 ms RTT) is unverified: the local
  fixture is distorted (see below).
- Device acceptance of the NEXUS desktop app, container and phone UI.
- Re-login of the `claude` CLI (the session on the dev machine had an expired OAuth login, so no real Claude Code
  session could be driven headlessly).

## Working agreements

- Commit to `main`, small commits, explicit `git add <files>`. Commit trailer used so far:
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>`. Push only what is green; for the release flow below
  tag after CI is green.
- Sub-agents that edit in parallel must not run git commands that change state and must not run the e2e suite
  concurrently (one shared sshd). One integrator runs the full suite serially.
- Report test results with the exact command and counts. A feature is not done because it compiles.
- Language: code, comments, docs and commits in English; the owner talks German.

## Development environment (Windows dev machine) and its traps

- Node 24, Git Bash, PowerShell. No Docker locally. The e2e fixture is a **WSL distro `server-use-test`**
  (Ubuntu 24.04, sshd on port 2222, users root/alice/bob as in `test/e2e/Dockerfile`, cron, git, python3).
  Setup details: [docs/TESTING.md](docs/TESTING.md). Run the e2e suite with
  `SU_E2E_HOST=127.0.0.1 SU_E2E_PORT=2222 npm test`.
- The WSL distro **stops when idle**. Keep it alive for the duration of a run with a background
  `wsl -d server-use-test -- sleep 5400`, and wait until `127.0.0.1:2222` accepts connections.
- The Claude Code tool **sandbox blocks TCP to localhost**; run e2e commands with the sandbox disabled.
- WSL's localhost relay adds about 48 ms per round trip, so latency numbers from this fixture are distorted. In
  WSL itself a warm command over a multiplexed connection costs 11 ms.
- A **daemon of an older protocol** left running by an earlier checkout blocks new clients: the error names its
  pid (`taskkill /PID <pid> /F` on Windows, `kill <pid>` elsewhere).
- Codex: the globally installed 0.48 is too old for current models and has no `plugin` command; test with a
  temporary `npm i --prefix <tmp> @openai/codex@latest`. Codex on Windows starts MCP servers without `SYSTEMROOT`
  (Node crashes) and needs `default_tools_approval_mode = "approve"` for `codex exec`; both are in the README.
- `package.json` `files` decides what ships to npm/git installs (`bin`, `src`, `remote`, `skills`, the plugin
  manifests, README, LICENSE). A new runtime directory or script must be added there; check with
  `npm pack --dry-run` (0.1.0: 41 files, 88 kB). Tests and `docs/` do not ship.

## Release process

1. Everything green: `npm test` (without e2e), the e2e suite (serially, with a live fixture), `claude plugin
   validate .`, `npm pack --dry-run`.
2. Bump the version in **`package.json`, `plugin.json` and `.claude-plugin/plugin.json`** (the runtime version is
   read from `package.json`; the two manifests must match). Move *Unreleased* in `CHANGELOG.md` under the new
   version with the date.
3. Commit, push `main`, wait for CI (`gh run watch <id> --exit-status`).
4. `git tag -a vX.Y.Z -m "server-use X.Y.Z"`, `git push origin vX.Y.Z`, then
   `gh release create vX.Y.Z --title "server-use X.Y.Z" --notes-file <notes>` (end the notes with the Claude Code
   attribution line used for PRs).
5. Smoke test the tag: `npm i -g --prefix <tmp> github:xpert2404/server-use#vX.Y.Z` then `<tmp>/server-use --version`;
   `claude plugin marketplace add xpert2404/server-use` + `claude plugin install server-use@server-use --scope
   project` in a temp project, then run the cached launchers (`~/.claude/plugins/cache/server-use/...`).
6. Downstream: bump the pinned tag in `nexus-harness` (`scripts/install-local.ps1`, `docker/Dockerfile`) and run
   `node scripts/sync-server-use.mjs` there to re-vendor the skills.

## Kleine Pakete, schnelle Integration und Patchauslieferung

- Nach jedem kleinen, sinnvoll nutzbaren und passend geprüften Paket Code und den bestehenden aktuellen Plan, Abnahme-/GATES-Nachweis und Status gemeinsam aktualisieren, selektiv committen und pushen. Die vorhandenen Plan- und Statusdateien nutzen; keine parallele Planquelle anlegen.
- Geprüfte Pakete zeitnah in den maßgeblichen Hauptzweig integrieren. Den vorhandenen Release-/Deployprozess für häufigere echte kleine Patchreleases beziehungsweise die passende Auslieferung nutzen, statt fertige Arbeit für ein Sammelrelease zurückzuhalten. Ein Commit oder Push allein belegt weder Release noch Installer oder Deployment.
- Tyron je Paket den konkreten testbaren Stand mit Commit, Version soweit vorhanden, Zugang und sichtbaren Änderungen nennen. Bestandene Prüfungen, offene Punkte sowie Geräte- und Deploymentgrenzen getrennt ausweisen; offene Prüfungen nicht als bestanden melden.
- Parallele Chats, Forks, Versionen, Releasepins und Feeds vor Integration und Auslieferung koordinieren. Fremde Arbeit erhalten und ausschließlich eigene Pfade versionieren.
