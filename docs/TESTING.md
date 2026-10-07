# Testing

Three layers, all runnable on a developer machine. CI runs them on every push and pull request.

| Layer | What it covers | Needs |
|---|---|---|
| Unit and integration | inventory, guard, host keys, secrets, formatting, pool, daemon lifecycle, CLI end to end against in-process SSH servers | Node 22+, a POSIX `sh` (Git for Windows is enough) |
| End to end | the real `remote/*.sh` scripts on a real sshd: add, harden, exec, sudo, jobs, cron, env, deploy with rollback | a Debian sshd container (or any Linux box with sshd, cron, sudo, git, python3) |
| Benchmark | warm vs cold latency, fan-out | any reachable server in your inventory |

## Unit and integration

```
npm install
npm test
```

`node --test` runs `test/**/*.test.mjs`. The CLI and daemon tests start `ssh2` servers inside the test process on
random ports (`test/fixture.mjs`), so no network and no Docker are needed. Each test sandbox gets its own
`SERVER_USE_HOME`, file-based secrets and an empty `~/.ssh`, so your real inventory is never touched. Tests that
need platform features (file modes on Windows, the headless-Linux secret store) skip themselves with a reason.

## End to end

The fixture is a Debian container with `sshd`, `cron`, `sudo`, `git`, `python3` and three users (`root` with
password login, `alice` whose sudo asks for a password, `bob` with passwordless sudo):

```
docker build -t server-use-e2e test/e2e
docker run -d --init --name su-e2e -p 127.0.0.1:2222:22 server-use-e2e
SU_E2E_HOST=127.0.0.1 SU_E2E_PORT=2222 npm test
```

Without `SU_E2E_HOST` the e2e tests are skipped. Use `--init` so detached jobs are reaped. The passwords default to
the ones in `test/e2e/Dockerfile` (`SU_E2E_ROOT_PASSWORD`, `SU_E2E_ALICE_PASSWORD`, `SU_E2E_BOB_PASSWORD`
override them). Any Linux machine you may break works too: create the same users, enable root password login, and
point `SU_E2E_HOST`/`SU_E2E_PORT` at it. Run the e2e files serially (`--test-concurrency=1`, which `npm test`
already sets); they share one server.

The e2e tests assert, among others: key login after a password `add` and no leftover secret anywhere
(`assertNoLeak`), hardening that never locks you out, cron that leaves foreign crontab lines byte-identical,
jobs that survive a disconnect, deploys whose failing health check restores the previous release, and a pull-check
auto-deploy that deploys exactly once per new commit. The 0.2 suites also exercise check diffs and fleet failures,
watch cron installation and signed webhook deliveries, job waiting and timeboxes, pinned runbooks with attempt
quotas, and doctor evidence/redaction on the real server. Watch webhook tests start a temporary Python HTTP
fixture on the server and clean up its process and managed cron entry.

To run only the SSH suites after the unit tests, use:

```
SU_E2E_HOST=127.0.0.1 SU_E2E_PORT=2222 node --test --test-concurrency=1 "test/e2e/*.test.mjs"
```

## Benchmark

```
node bench/latency.mjs --target <server> --runs 50
node bench/latency.mjs --target <server> --fanout a,b,c
```

Reports cold (new handshake each time), warm (pooled connection) and CLI-process latency, plus fan-out against the
slowest single host. Measure against a real VPS: a local container hides the round-trip time that the pool saves.
Targets of the design: warm `exec 'true'` about 150 ms p50 at 30 ms RTT, fan-out to 10 hosts at most 1.5x the time
of one.

## Continuous integration

`.github/workflows/ci.yml`: unit tests on Ubuntu, Windows and macOS with Node 22 and 24, and an e2e job against
the Debian container. The Claude Code plugin manifest can be checked locally with `claude plugin validate .`.
