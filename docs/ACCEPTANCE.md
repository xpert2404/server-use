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

## Verified (0.2 implementation, unreleased, 2026-10-07)

The version/manifests remain 0.1.0; these results cover the working implementation on `main`, not a new release.
The Windows runs below use Node 24. Unit runs unset `SU_E2E_HOST`/`SU_E2E_PORT`; the SSH run sets them to
`127.0.0.1` and `2222`. All SSH files run serially against the live WSL fixture.

| Area | Claim | Evidence |
|---|---|---|
| Unit/integration | Existing behavior and all 0.2 interfaces pass | `node --test --test-reporter=tap --test-concurrency=1 "test/**/*.test.mjs"`: 182 tests, 179 pass, 3 platform-specific skips, 0 fail. SSH suites are separately disabled in this run. |
| Real SSH | Complete script/CLI/daemon acceptance passes | `SU_E2E_HOST=127.0.0.1 SU_E2E_PORT=2222 node --test --test-reporter=tap --test-concurrency=1 "test/e2e/*.test.mjs"`: 61 tests, 61 pass, 0 skipped, 0 fail. |
| Check/watch | Findings and diffs, incomplete probes, notification lifecycle and credential handling | `test/check.test.mjs`, `test/watch.test.mjs`, `test/e2e/checkwatch.test.mjs`: disk/backup/failed-cron findings, new/resolved changes, dead-host fleet behavior; real cron installation, HTTP failure/recovery debounce, mute, heartbeat and exact signed webhook deliveries. Unit cases also reject root-owned state beneath unsafe parents/leaves. |
| Job wait/timebox | Completion/exit/log reporting survives transport loss and daemon restart; waiters leave SSH slots free | `test/jobwait.test.mjs`, `test/e2e/jobwait.test.mjs`: exit 0/nonzero, deadlines, disappeared/restarted runners, nine concurrent waits, MCP pending replies and detached process groups. A requested timebox is refused before job creation when `timeout -k` is unavailable. |
| Runbooks | Approval scope, hash, enumerated parameters, readonly and durable attempt quotas remain enforced | `test/runbook.test.mjs`, `test/e2e/runbook.test.mjs`: approved destructive fixes plus verification; changed script/destination/target rejection; injection rejection, dry run, revocation, concurrent admission and daemon-restart quota retention. `--yes` cannot bypass the limit. |
| Doctor | Read-only snapshot with ranked evidence, recent changes, missing probes and recognized secret redaction | `test/doctor.test.mjs`, `test/e2e/doctor.test.mjs`: actual file error counts, complete local-state leak scan, quoted/escaped/unterminated secrets, pressure ranking and RPM/apt timestamp handling. File-tail evidence is labelled separately from time-filtered journal/container evidence. |
| MCP | Explicit remote targets and native approval/error semantics stay compatible | `node --test --test-reporter=tap test/mcp-ops.test.mjs`: 5/5; credentials are rejected before watch transport, approved run fields cannot widen scope, runbook `CONFIRM` propagates, mixed completed/pending job waits stay valid replies. |
| Key generation | Invalid generated Ed25519 pairs never reach a new key file or fixture host | `node --test --test-reporter=tap test/keygen.test.mjs test/unit.test.mjs`: 28/28; deterministic malformed-first/valid-next and exhaustion controls, pair/type mismatch rejection, stable persisted keys and POSIX modes. The prior intermittent CI failure was traced to ssh2 1.17's DER leading-zero conversion. |
| Daemon transport | Socket failure cannot crash the client or replay a mutating request | `node --test --test-reporter=tap test/client.test.mjs`: 9/9; deterministic EPIPE at connection/hello/auth/request handoffs, multiple pending requests, closed-client refusal and authentication privacy. `node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern='a fake daemon squatting\|a connection without the right token\|the daemon restarting during a wait' test/daemon.test.mjs test/jobwait.test.mjs`: 3/3. A separate deterministic deadline test proves earlier running state is not misreported as current after a later probe stalls. |
| Packaging | New runtime files ship; plugin manifest stays valid | `npm pack --dry-run --json`: 52 files, including all new remote scripts/operations and `src/keygen.mjs`; `claude plugin validate .`: validation passed. |
| NEXUS | Native attachments, approvals, masked credentials and direct-shell switch denial tested | Plugin 19/19, real dsh composition 6/6, settings-controller 62/62, preset/project 11/11, runtime 9/9, approval/password UI 18/18, connector-policy browser 5/5; isolated build passes, Svelte check 0 errors/24 warnings, scoped lint passes. Commands are in the sibling `nexus-harness/docs/SERVER-USE.md`; fork `c01bbf28a9` and overlay `4ed854a` are local, with both pushes awaiting explicit owner approval. |

Independent runtime review found no remaining blockers after the wait deadline, doctor redaction/file-tail,
watch root-path and timebox corrections. Separate reviews verified the final key-generation helper and daemon
transport error handling, including authentication order and rejection without request replay.

## Not verified yet

| Area | What is missing |
|---|---|
| Latency target | Warm `exec` at about 30 ms RTT <= 150 ms p50 and warm <= cold / 3. Local fixture: cold 237 ms, warm 96 ms (2.5x); with 30 ms simulated RTT cold 753 ms, warm 227 ms (3.3x). The WSL localhost relay adds about 48 ms per round trip (WSL itself: 11 ms warm), so the real value needs a real VPS. |
| End to end on a real VPS | `add` with a password, key login, `exec`, `status`, driven from Claude Code on the Windows machine, with latencies noted. |
| Real Claude Code session | A headless `claude -p` run using the plugin (the dev machine's login had expired). |
| TradingAgents use case | `deploy lab github.com/TauricResearch/TradingAgents`, a `cron add` analysis run, a result in the log. |
| 0.2 release | Tag/release installation smoke tests and downstream installer pins are pending an explicit release. The implementation/fixture results above do not claim real-VPS acceptance. |
| NEXUS | Everything in [NEXUS.md](NEXUS.md) marked as open (real approval dialog, connector switch per session, masked password, Server rubric on the phone, dogfooding the owner's deploy script). |
