# Acceptance: what is verified, and how

A claim counts only if somebody ran the check and saw the result. "Evidence" below is what was actually observed;
nothing is taken from release notes or estimates. Update this file when you verify something new, and say which
command you ran.

Test environment of the evidence below: Windows 11 dev machine (Node 24), WSL Ubuntu 24.04 sshd fixture on port
2222 (see [TESTING.md](TESTING.md)), GitHub Actions for the CI matrix.

## Verified (v0.1.0, 2026-10-03)

| Area | Claim | Evidence |
|---|---|---|
| Tests | Unit, integration and e2e pass | `SU_E2E_HOST=127.0.0.1 SU_E2E_PORT=2222 npm test`: 109 tests, 107 pass, 2 skipped (platform-specific on Windows), 0 fail. CI run on the `v0.1.0` commit: Ubuntu, Windows, macOS x Node 22 and 24 plus the Docker e2e job all green. |
| Fan-out | 10 hosts in parallel, output kept apart | One `exec` over 10 aliases: slowest single host 1217 ms, all at once 1253 ms (factor 1.03); 10 header lines, "10 ok". |
| Daemon | Survives sshd restarts and version switches; a command cut off by a restart is reported, not repeated | Tests "reconnects on its own after the server restarts", "a newer client makes the daemon exit", "a command cut off by the restart is reported as aborted and not run again". |
| Local interface | Only the owner's user can use the daemon, and it cannot be impersonated | Test "a connection without the right token is dropped", plus the mutual HMAC handshake tests. |
| Secrets | The test password appears nowhere (argv, audit, runs, `ls`/`show`, errors) | `secret leak` tests in unit, cli, daemon and every e2e file. |
| Host keys | A changed or different-type key stops with exit 4; `trust --reset` recovers | Unit and e2e tests "hostkey change". |
| Policy | `confirm` stops destructive commands (exit 3), `readonly` refuses `exec` (exit 7) | cli and e2e policy tests. |
| Onboarding | Password to key login without locking out; `harden --lock-password` only after a fresh key login | e2e "add-server ..." and "harden ..." tests. |
| `import ssh-config` | Takes the existing entries | `server-use import ssh-config --dry-run` on the dev machine listed all hosts with user and port. |
| Cron / jobs / deploy | Idempotent cron that leaves foreign lines byte-identical; jobs survive a disconnect; failed health check rolls back; pull-check deploys exactly once per new commit | e2e tests in `test/e2e/ops.test.mjs` and `test/e2e/deploy.test.mjs`. |
| Claude Code plugin | Valid, installs from the marketplace, launchers run in Git Bash and cmd | `claude plugin validate .` passes; `claude plugin marketplace add xpert2404/server-use` and `claude plugin install server-use@server-use --scope project` succeeded; the cached `bin/server-use --version` and `bin\server-use.cmd --version` print 0.1.0; all 5 skills present. |
| Codex | Plugin installs; server reachable through MCP in the default sandbox | Codex 0.160: `codex plugin marketplace add` + `codex plugin add server-use@server-use`; `codex exec --sandbox workspace-write` listed the skills and ran `servers list` and `exec` through MCP against the fixture. |
| npm install from GitHub | Works | `npm i -g --prefix <tmp> github:xpert2404/server-use#v0.1.0` and the tarball URL both give `server-use --version` = 0.1.0. |

## Not verified yet

| Area | What is missing |
|---|---|
| Latency target | Warm `exec` at about 30 ms RTT <= 150 ms p50 and warm <= cold / 3. Local fixture: cold 237 ms, warm 96 ms (2.5x); with 30 ms simulated RTT cold 753 ms, warm 227 ms (3.3x). The WSL localhost relay adds about 48 ms per round trip (WSL itself: 11 ms warm), so the real value needs a real VPS. |
| End to end on a real VPS | `add` with a password, key login, `exec`, `status`, driven from Claude Code on the Windows machine, with latencies noted. |
| Real Claude Code session | A headless `claude -p` run using the plugin (the dev machine's login had expired). |
| TradingAgents use case | `deploy lab github.com/TauricResearch/TradingAgents`, a `cron add` analysis run, a result in the log. |
| 0.2 features | `check`, `watch`, `job wait`, `runbook`, `doctor`: see [ROADMAP.md](ROADMAP.md) and the changelog. |
| NEXUS | Everything in [NEXUS.md](NEXUS.md) marked as open (real approval dialog, connector switch per session, masked password, Server rubric on the phone, dogfooding the owner's deploy script). |
