---
name: add-server
description: >-
  Add a server to server-use: pin the host key, switch password login to key login, collect facts, set tags and
  policy, import ~/.ssh/config. Use when the user gives an IP or host and a user, or says add
  server, new VPS, connect to my server, import my ssh config. German: füge Server hinzu, neuer Server, Server
  anlegen, verbinde dich mit meinem Server, hier sind die Zugangsdaten. Also use it to retag or remove servers
  and to store a sudo password.
---

# add-server

First run `server-use --version`. If the command is missing, ask the user, then `npm i -g github:xpert2404/server-use`
(see the server-use skill).

## 1. Name, tags, policy

- **Name**: short, lowercase, role plus number, e.g. `trading-1`, `web-1`, `db-prod`, `lab`. Allowed are
  letters, digits, `.`, `_` and `-`, and the name can't be `all`. If the context doesn't give you a name,
  propose one and tell the user which name you chose.
- **Tags** group servers, so `tag:prod` later hits all of them. Use things like `prod`, `staging`, `lab` or
  a project name such as `trading`. Pass them as `--tag trading --tag prod` or `--tag trading,prod`.
- **Policy**: `confirm` is the default. It pauses commands that look destructive until the user agrees.
  Use `--policy open` only when the user asks for it, typically for a throwaway lab box. Use `--policy
  readonly` for "look, but never change anything".

## 2a. Existing SSH keys

```
server-use add web-1 deploy@198.51.100.7 --tag web
server-use add web-1 deploy@198.51.100.7 --key ~/.ssh/id_ed25519_work
```

Without `--key`, server-use tries the ssh-agent and `~/.ssh/id_ed25519`, `id_ecdsa` and `id_rsa`. Load
encrypted keys into the ssh-agent locally first. Pass only the key path, never read or request its contents.
For another port, write `deploy@198.51.100.7:2222`.

## 2b. Password onboarding stays local

Never ask for a password in chat or tool arguments. Have the user run this in **their own terminal**,
outside your shell tool:

```
server-use add trading-1 root@203.0.113.10 --ask --tag trading
```

`--ask` prompts for the password without showing it. It needs a real terminal and fails inside your shell
tool. Once the user is done, you continue with `server-use show trading-1`.

The local CLI pins the host key, collects facts, installs this machine's key and proves a fresh key-only
login. It deletes the login password after success, except when needed for a non-root user's sudo or when
`--keep-password` was explicitly requested. Failed key setup retains password login and reports a hint.
Tell the user the resulting login method and fingerprint; have them compare it with their provider's console.

`--password-stdin` is for trusted local secret sources, not a password embedded in a generated command.
Public MCP `servers(add)` supports existing local keys; it rejects password arguments. If a user already
pasted a secret into chat, do not repeat it or pass it into more tool calls. Explain that it reached the model
provider, recommend rotating it locally, and continue once local access is ready. Disabling password login
with `server-use harden trading-1 --lock-password --yes` still requires approval and a verified key login.

## 2c. Import ~/.ssh/config

```
server-use import ssh-config --dry-run      # show what would be imported
server-use import ssh-config                # --user root for entries without User; --force overwrites
server-use status all                       # first contact; host keys come from ~/.ssh/known_hosts if listed
```

Imported servers get the tag `imported` and the policy `confirm`. Retag them with
`server-use set <name> tags=prod,web`.

## 3. After adding

```
server-use show trading-1
server-use status trading-1
server-use notes trading-1 --append "Hetzner CX22, Ubuntu 24.04, runs the trading system"
server-use harden trading-1 --check     # read-only security report: root login, password auth, firewall, ports
```

For prod servers, offer a user with fewer rights. Once the user agrees, run
`server-use harden trading-1 --agent-user --yes`. That creates the user `agent` without sudo and adds it to the
inventory as `trading-1-agent`.

## Errors

- **exit 5 (unreachable)**: the IP or port is wrong, a firewall blocks it, or the server is still booting.
  Check the address with the user.
- **exit 6 (auth failed)**: the password is wrong, or the server doesn't allow root to log in with a
  password (`PermitRootLogin prohibit-password`). Ask for a key or a non-root user.
- **exit 4 (host key changed)**: this address presented a different key before, for example because the
  server was reinstalled. Stop and ask the user to verify the new fingerprint. For a server that is already
  in the inventory, `server-use trust <name> --reset` runs only with the user's OK.
- **"already exists"**: pick another name, or add `--force` to replace the entry.
- **exit 8 later (sudo)**: the user is non-root and sudo needs a password. Have the user store it through
  `server-use set trading-1 sudo-password --stdin` from a trusted local secret source in their own terminal.
  Do not ask them to paste it into chat or read the stored value back.

## Change or remove

```
server-use set trading-1 tags=trading,prod
server-use set trading-1 host=203.0.113.11 port=2222
server-use set trading-1 policy=open          # only when the user asks for it
server-use rm trading-1                       # ask first; notes and the pinned host key stay
```
