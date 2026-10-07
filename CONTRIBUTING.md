# Contributing

Thanks for helping. server-use is free and MIT-licensed, and stays that way: no accounts, no paid tiers, no
telemetry. The goal is real value for people who run VPSes, used by AI agents with as little friction as possible
and without giving up safety.

## Setup

```
git clone https://github.com/xpert2404/server-use && cd server-use
npm install
npm test
```

Node 22 or newer. On Windows you need Git for Windows (the tests use its `sh`). See
[docs/TESTING.md](docs/TESTING.md) for the end-to-end suite and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how
the pieces fit.

## Conventions

- Plain ESM JavaScript with `// @ts-check` and JSDoc types. No build step, no new runtime dependencies unless there
  is no sane alternative (today: `ssh2`, `yaml`, the optional keychain binding).
- Server-side logic is POSIX `sh` in `remote/`. It must run on dash and busybox, be idempotent, never touch lines
  or files it did not create, and keep secrets out of argv and logs. `sh -n` every script you edit.
- Comments say *why*, briefly. Match the surrounding style.
- Output is read by models: keep it short, one block per host, the exit code decides success.
- Safety first: destructive operations need a policy check (`src/guard.mjs`), secrets stay out of output, and
  anything that runs as root on the server must not follow paths a less-privileged user controls.

## Adding or changing a verb

1. Server side: a script in `remote/<verb>.sh` (see `remote/README.md` for the contract), or reuse one.
2. Client side: the op in `src/ops/`, registered in the `OPS` table of `src/daemon.mjs`; the verb and its
   `help <verb>` text in `src/cli.mjs`; reading operations listed in `READ_OPS` of `src/guard.mjs` so that
   `readonly` servers allow exactly those.
3. MCP: add it to an existing tool in `src/mcp.mjs` if agents without a shell need it (keep the schema small).
4. Teach the model: update the matching `skills/*/SKILL.md` (they stay short) and the README command tour.
5. Tests: unit tests for the logic, an e2e test for anything that touches a server, including the failure path
   and a leak check for secrets.
6. Changelog: one line under *Unreleased* in [CHANGELOG.md](CHANGELOG.md).

## Pull requests

Small, focused changes with tests. Describe the problem, the behavior change and how you verified it (command and
result). If you change a security-relevant path (host keys, secrets, policy, the daemon protocol, scripts that run
as root), say so explicitly. CI must be green on all platforms.

## Reporting bugs

Include `server-use --version`, your OS and Node version, the command, and the output. Never paste passwords,
tokens or the contents of `~/.server-use/secrets.json` or `daemon.token`. Security issues: see
[docs/SECURITY.md](docs/SECURITY.md).
