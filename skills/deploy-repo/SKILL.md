---
name: deploy-repo
description: >-
  Deploy a Git or GitHub repository to a server with server-use: releases, build detection (docker compose,
  Node, Python), systemd service, health check with automatic rollback, .env secrets, deploy keys for private
  repos, auto-deploy on push. Use for: deploy X to Y, ship it, put this repo on the server, auto deploy,
  redeploy, rollback. German: deploy das Repo, auf den Server bringen, ausrollen, Auto-Deploy einrichten,
  zurückrollen.
---

# deploy-repo

Before you start: the server is in the inventory (`server-use ls`), and you've read `server-use notes <target>`.
`server-use show <target>` lists the facts: whether docker, compose, node, python3, uv and git exist, and
which user you log in as. If `server-use` itself is missing, see the server-use skill.

## What `deploy` does

```
server-use deploy <target> <repo> [--name n] [--ref main] [--base /opt/<name>] [--build '<cmd>']
                  [--run '<cmd>'] [--health '<cmd>'] [--watch 5m] [--sudo] [--yes]
```

- **repo**: `owner/repo`, `github.com/owner/repo` or any git URL. `--name` defaults to the repo name.
- **Layout**: `<base>/releases/<time>-<sha>/`, a `<base>/current` symlink to the active release, and
  `<base>/shared/.env`, which gets linked into every release as `.env`. The base is `/opt/<name>` when you
  log in as root and `~/apps/<name>` otherwise.
- **Build**, unless you pass `--build`:
  - compose file: `docker compose -p <name> up -d --build`, which also starts it
  - `package.json`: `npm ci` and `npm run build`
  - `pyproject.toml` or `requirements.txt`: a `.venv` inside the release, using uv when installed
- **`--run '<cmd>'`** is for a long-running process. As root with systemd, it becomes the unit
  `server-use-<name>`: cwd `<base>/current`, `EnvironmentFile=<base>/shared/.env`, `Restart=on-failure`.
  Without root, it runs as a background process that logs to `<base>/.server-use/run.log`; add `--sudo` to
  get systemd. Compose apps don't need `--run`.
- **`--health '<cmd>'`** runs in `<base>/current` and retries 10 times, 3 s apart. If it keeps failing,
  `current` goes back to the previous release, the app restarts, the output says `ROLLED BACK`, and deploy
  exits 1.
- Deploy keeps the last 3 releases and adds a line to the notes. The last output line is
  `SU_RESULT base=… release=… sha=… service=…`.
- Exit 3 means the `--run`, `--build` or `--health` command looked destructive. Ask the user, then repeat
  with `--yes`.

## Steps

1. **Read the repo first**, locally or on GitHub: runtime, start command, port, required env vars
   (`.env.example`, README) and a health endpoint.
2. For a private repo, set up a deploy key (see below).
3. Set the `.env` values **before** the first deploy (see below).
4. Deploy: use `--run` unless it's a compose app, and add `--health` whenever the app can be checked.
5. Verify with `server-use logs <target> server-use-<name> -n 50` (or the container) and a curl on the server.
   Then tell the user the URL or port, the service name and how to roll back.

## Examples

```
# docker compose (starts by itself)
server-use deploy web-1 acme/shop --health 'curl -fsS http://localhost:8080/health'
# Node service
server-use deploy web-1 acme/api --run 'node dist/server.js' --health 'curl -fsS http://localhost:3000/health'
# Python service (venv at <base>/current/.venv)
server-use deploy trading-1 acme/trading --run '.venv/bin/python -m app.server' --health 'curl -fsS http://localhost:8000/health'
# Python tool without a server process: install only, then schedule it (server-cron skill)
server-use deploy lab github.com/TauricResearch/TradingAgents --name tradingagents
```

Other options: `--ref v1.4.0` for a branch or tag, and `--build 'npm ci && npm run build:prod'` for a
custom build. In cron jobs, reach the venv as `/opt/<name>/current/.venv/bin/python`; that path survives
redeploys.

## Private repositories: deploy key

`server-use deploy key <target> <name>` prints the server's public key for that app. Use the same name as the deploy (`--name`, or the
repo name by default). Add the key as a read-only deploy key:

```
server-use deploy key trading-1 trading | grep '^ssh-' > trading-deploy.pub
gh repo deploy-key add trading-deploy.pub -R acme/trading -t 'server-use trading-1'
server-use deploy trading-1 acme/trading --run '.venv/bin/python -m app.server'
```

If there's no `gh`, or it has no admin rights on the repo, give the user the `ssh-…` line and point them to
GitHub → repo → Settings → Deploy keys → Add (leave write access off). When the key exists, GitHub HTTPS URLs
get cloned over SSH automatically. On other hosts (GitLab, Gitea), pass the SSH clone URL.

## .env values (secrets)

The value always goes in on stdin, never as `KEY=value` on the command line, and never `cat` the file.

```
sed -n 's/^OPENAI_API_KEY=//p' .env | server-use env set lab tradingagents OPENAI_API_KEY   # from a local file; you never see it
printf '%s' 'VALUE-FROM-CHAT' | server-use env set lab tradingagents OPENAI_API_KEY         # if the user pasted it
server-use env ls lab tradingagents                                                         # shows keys only
server-use env rm lab tradingagents OLD_KEY
```

- The user can also run it in their own terminal, e.g. `Get-Clipboard | server-use env set …` (PowerShell)
  or `pbpaste | server-use env set …` (macOS). Offer that for sensitive keys. If a key went through the chat,
  say so and suggest rotating it.
- If the deploy used `--base`, pass the same `--base` to `env`.
- After a change, restart the app: `server-use exec web-1 'systemctl restart server-use-api'` (add `--sudo`
  when you aren't root). For compose, run `server-use exec web-1 --cwd /opt/shop/current 'docker compose -p shop up -d --force-recreate'`.
  Redeploying works too.

## Releases and rollback

```
server-use deploy ls web-1 api
server-use deploy rollback web-1 api      # switches to the previous release and restarts it
```

A rollback restarts the older release with the `--run` it was deployed with, not the latest one.

After a rollback, tell the user and find the cause (server-doctor skill).

## Auto-deploy

**A) Pull check (default).** `--watch 5m` adds a cron job `deploy-<name>` on the server. Every 5 minutes it
compares the remote SHA and deploys only when it changed, with the same `--run` and `--health`. A later deploy of the same app (with or without
`--watch`) replaces the pull check's ref, run, build and health settings. It needs no
open ports and no secrets in GitHub, but a new commit can wait up to one interval. The log is at
`<base>/.server-use/deploy.log`. To stop it, run `server-use cron rm web-1 deploy-api`; later deploys then
leave the pull check settings alone and report no watch.

```
server-use deploy web-1 acme/api --run 'node dist/server.js' --health 'curl -fsS http://localhost:3000/health' --watch 5m
```

**B) Push with GitHub Actions**, only if the user wants deploys within seconds. It needs an SSH key in
GitHub secrets, and GitHub's runners must be able to reach port 22.

```
ssh-keygen -t ed25519 -N '' -C gh-actions-api -f ./gh-actions-api
server-use put web-1 ./gh-actions-api.pub .ssh/gh-actions-api.pub
server-use exec web-1 'cat ~/.ssh/gh-actions-api.pub >> ~/.ssh/authorized_keys'
gh secret set DEPLOY_SSH_KEY -R acme/api < ./gh-actions-api
grep '^203.0.113.10 ' ~/.server-use/known_hosts | gh secret set DEPLOY_KNOWN_HOSTS -R acme/api
rm ./gh-actions-api ./gh-actions-api.pub
```

Then create `.github/workflows/deploy.yml` in the repo. It uses the same deploy flags as the manual deploy:

```yaml
name: deploy
on: { push: { branches: [main] } }
concurrency: deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm i -g github:xpert2404/server-use
      - env: { KEY: "${{ secrets.DEPLOY_SSH_KEY }}", KNOWN: "${{ secrets.DEPLOY_KNOWN_HOSTS }}" }
        run: |
          mkdir -p ~/.ssh && printf '%s\n' "$KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
          printf '%s\n' "$KNOWN" > ~/.ssh/known_hosts
          server-use add web-1 root@203.0.113.10
          server-use deploy web-1 acme/api --ref main --run 'node dist/server.js' --health 'curl -fsS http://localhost:3000/health'
```
