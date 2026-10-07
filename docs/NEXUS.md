# NEXUS Harness integration

server-use is a neutral product. NEXUS Harness (a private fork/overlay of DeepSeek Harness, "dsh") is its first
full user. This file is the map for anyone (human or agent) who continues that integration. The code lives in the
NEXUS repositories, not here; the German counterpart for people working in that repo is `docs/SERVER-USE.md` in
`nexus-harness`.

## Where things live

| Repo | Path (relative to the NEXUS workspace) | Branch |
|---|---|---|
| server-use (this repo) | `server-use/` | `main` |
| NEXUS overlay (presets, plugins, UI, scripts, Docker) | `nexus-harness/` | `main` |
| NEXUS fork of dsh (TypeScript monorepo, git submodule of the overlay) | `nexus-harness/upstream/` | `nexus` |

Rule of the NEXUS owner: one branch per repo (`main` / `nexus`), no feature branches or worktrees. After changing
the fork, the overlay's submodule pointer must be committed too. Another agent session works in `nexus-harness`
at the same time; use `git pull --rebase` before committing, stage files explicitly, and never use `git stash`
(GitHub Desktop, which the owner uses, also stashes silently: a rebuilt tree can come back with changes hidden in
`git stash list`).

## The three levels

**N1: CLI plus skills in the Coding rubric (no harness code).**
`server-use` is installed globally (`scripts/install-local.ps1`, `docker/Dockerfile`, pinned to a release tarball
of this repo; in the container `SERVER_USE_HOME=/dsh-home/.server-use` so inventory and keys live on the volume).
The five skills are vendored into `presets/coding/skills/` by `node scripts/sync-server-use.mjs` (drift check:
`--check`, exit 1 on drift). The Coding rubric has a shell, so the agent runs `server-use ...`.

**N2: native tools with real approvals (`packages/nexus-server-use`).**
A plain-JS dsh plugin that registers `server_list`, `server_exec`, `server_transfer`, `server_logs`, `server_cron`,
`server_job`, `server_deploy`, `server_add` and `server_connect`:

- It loads `src/mcp.mjs` (`TOOLS`, `callTool`) and `src/client.mjs` (`DaemonClient`) from the global npm install
  (`SERVER_USE_DIR`, the plugin config `serverUseDir`, or `npm root -g`), so **those two exports are an API: keep
  them stable** (they are listed in the CHANGELOG when they change). The `yes` parameter is removed from the
  schema the model sees.
- Approvals: a call runs without `yes`; hosts answering `CONFIRM` open a real approval dialog
  (`ctx.approval.request`), and only after "allow once" the call repeats for those hosts with `yes`. With the
  approval policy `never` (danger-full-access) the call is refused with a hint to switch to a mode that asks.
- `server_add` asks for the password with a **masked question** (`ctx.userQuestions.ask`, question id
  `secret:server-password`); the answer goes straight to the daemon op `servers.add`, never through tool
  arguments, results, the session log or the model.
- **Attachment (D14):** a conversation starts with no servers. The model calls `server_connect` with the servers
  the task needs (a name, `a,b`, `tag:x`); all other `server_*` tools (except listing and showing) work only on
  attached servers, subagents share their root conversation's attachments, and `server_add` attaches the new
  server. Attachments live in plugin memory per root session; after a host restart the model connects again.

**N3: the "Server" rubric.**
`presets/server/` is a shell-less preset (server tools, web, todo, questions, skills) meant for ops from a phone
through the web instance. It uses the same vendored skills; its persona maps the CLI wording of the skills to the
`server_*` tools.

## Contracts shared by the pieces

- **Connector flag `servers`** (fork: `upstream/packages/api/settings-controller/src/nexus-capabilities.ts`,
  `ConnectorFlags`): boolean, default **on** ("the AI may connect servers to this chat"). When off, the global
  tool guard `connectorDenial` denies every tool named `server_*`, `mcp__server-use*` or `mcp__server_use*`,
  including `server_connect`. Subagents inherit; a parent's `false` wins. The UI toggle is in
  `nexus-ui` (`ComposerTools.svelte`); the wire codec in `runtime/product/settings-controller/` is **generated**
  (`node scripts/runtime-product.mjs prepare`) and checked by `scripts/runtime-product.test.mjs`.
- **Masked questions are plugin-only.** Question ids starting with `secret:` are rendered by `nexus-ui` as a
  password input (never stored or echoed). The model must not be able to create one, so the same guard denies the
  model's `ask_user_question` tool when any question id starts with `secret:`; `presets/restrict-global-tools.mjs`
  mirrors that for hosts without the policy service.
- **Staging in the desktop EXE:** `upstream/apps/desktop/scripts/package-target.ts` copies
  `packages/nexus-server-use` into the bundle and `src/nexus-setup.ts` stages it into `$DSH_HOME/nexus/packages/`
  (required, like `nexus-coding`, because the Coding and Server presets load it by relative path). The EXE does not
  ship the server-use CLI itself: without a global install the plugin logs a warning and registers no tools.
- **Rubric id `server`** appears in: `nexus-ui` rubric metadata/i18n/icon, `install-local.ps1`,
  `docker/entrypoint.sh`, `upstream/apps/desktop/src/nexus-setup.ts` (workspace folders) and the smoke scripts.

## Tests (run from `nexus-harness` unless noted)

```
node --test packages/nexus-server-use/index.test.mjs
NEXUS_DSH_ROOT="$APPDATA/npm/node_modules/@deepseek-ai/dsh" node --test packages/nexus-server-use/composition.test.mjs
node scripts/sync-server-use.mjs --check
node --test nexus-ui/tests/preset-filter.test.mjs nexus-ui/tests/projects.test.mjs
(cd nexus-ui && npx vitest run && npm run check)
NEXUS_UPSTREAM_DIR="$PWD/upstream" node --test scripts/runtime-product.test.mjs
(cd upstream && node_modules/.bin/vitest run packages/api/settings-controller)
```

In `upstream`, call `node_modules/.bin/vitest` and `node_modules/.bin/tsc` directly: `pnpm exec` starts an
automatic install that fails there. Lint is oxlint (`CI=true node node_modules/oxlint/bin/oxlint --format=unix
<paths>`), not ESLint.

## Open items

See the *Open* part of `nexus-harness/docs/SERVER-USE.md` for the current list. At the time of writing: the
approval dialog, the per-session switch, the masked password and the Server rubric have unit/composition tests but
no run in the real desktop app, container or phone UI (device acceptance by the owner); `tests/cursor-css.test.mjs`
fails on a clean `main` for a reason unrelated to server-use; nothing of this has been pushed to the NEXUS
repositories yet.
