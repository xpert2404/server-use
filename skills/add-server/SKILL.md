---
name: add-server
description: >-
  Add a server to server-use: pin the host key, switch password login to key login, collect facts, set tags and
  policy, import ~/.ssh/config. Use when the user gives an IP or host, a user and maybe a password, or says add
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

## 2a. The user gave you a password in the chat

```
printf '%s' 'THE-PASSWORD' | server-use add trading-1 root@203.0.113.10 --password-stdin --tag trading
```

- Use `printf '%s'`, not `echo`, and wrap the password in single quotes (write a `'` inside it as `'\''`).
  Never pass the password as an argument or put it in `--note`.
- For another port, write `root@203.0.113.10:2222`.

What happens:
1. The host key gets pinned on first contact. The output shows `host key SHA256:… (new — pinned now)`.
2. server-use logs in with the password and collects facts (OS, docker, time zone, sudo, …).
3. It installs this machine's key (`~/.server-use/id_ed25519`) and proves that a fresh key-only login works.
4. It deletes the password. Two exceptions: a non-root user whose sudo needs a password keeps it as the sudo
   password, and `--keep-password` keeps it on purpose. If key login fails, the password stays too, and a
   `hint:` line says so.
5. The connection stays open in the daemon, and a notes file gets created.

Then tell the user, in their language and briefly:
- The server is added, it now logs in with a key, and here is the host key fingerprint. They can compare the
  fingerprint with their provider's console.
- **The password went through this chat**, so it now sits in the transcript and at the model provider.
  Recommend one of two things. Either they change it themselves (`passwd` on the server, so you never see
  the new password), or they turn off password login completely. The second needs the user's yes first:
  `server-use harden trading-1 --lock-password --yes`. That command first proves a fresh key-only login and
  undoes the change if anything fails.

## 2b. Better: keep the password away from the model

If the user is about to paste a password, suggest this instead. They run the command in **their own
terminal**, not through you:

```
server-use add trading-1 root@203.0.113.10 --ask --tag trading
```

`--ask` prompts for the password without showing it. It needs a real terminal and fails inside your shell
tool. Once the user is done, you continue with `server-use show trading-1`.

## 2c. Key access already works

```
server-use add web-1 deploy@198.51.100.7 --tag web
server-use add web-1 deploy@198.51.100.7 --key ~/.ssh/id_ed25519_work
```

Without `--key`, server-use tries the ssh-agent and `~/.ssh/id_ed25519`, `id_ecdsa` and `id_rsa`. Load
encrypted keys into the ssh-agent first.

## 2d. Import ~/.ssh/config

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
- **exit 8 later (sudo)**: the user is non-root and sudo needs a password. The user stores it:
  `printf '%s' '…' | server-use set trading-1 sudo-password --stdin`.

## Change or remove

```
server-use set trading-1 tags=trading,prod
server-use set trading-1 host=203.0.113.11 port=2222
server-use set trading-1 policy=open          # only when the user asks for it
server-use rm trading-1                       # ask first; notes and the pinned host key stay
```
