# Security

server-use can run anything on your servers, including destroying them. This document says which protections are
real boundaries and which are speed bumps, so you can choose your setup knowingly. The short version is also in
the [README](../README.md#security-model).

## Layers, strongest first

1. **Your agent's approval prompt (a real boundary, on your machine).** Every `server-use` call goes through the
   agent's Bash or MCP approval. Allow only reading verbs without asking, for example in Claude Code
   `Bash(server-use ls *)`, `Bash(server-use status *)`, `Bash(server-use logs *)`, `Bash(server-use show *)`.
2. **A least-privilege user on the server (a real boundary, on the server).** `server-use harden <server>
   --agent-user` creates a user without sudo, installs the key and adds it to the inventory as `<server>-<user>`.
   Use that for production.
3. **Per-server policy (a speed bump, not a boundary).** `confirm` (the default) stops commands that look
   destructive with exit 3 until `--yes` is passed; the skills tell the agent to ask you first. `readonly` allows
   only reading operations. `open` lets everything through. The destructive check is a regex heuristic and will
   miss things. An agent that is determined to bypass it can; the layers above are what stop it.
4. **Host-key pinning (a real boundary against man-in-the-middle).** The first connection pins the key (or takes
   it from `~/.ssh/known_hosts`). *Any* key on file for a host binds, whatever its type: presenting a different
   key type does not get around the pin. A changed key stops everything with exit 4. Only `server-use trust
   <server> --reset`, after you verified the change, clears it.
5. **Audit log.** Every operation is appended to `~/.server-use/audit.jsonl` with the calling agent.

## Secrets

The intended workflow does not give login credentials to an AI provider: the user onboards through existing
SSH keys or the masked `server-use add --ask` prompt in their own terminal. Authentication happens between the
local daemon and the server; server-use has no hosted backend or telemetry. A cloud-backed agent can still send
prompts, tool arguments and command results to its provider. Do not put secrets in those channels.

- Passwords, sudo passwords and key passphrases go into the OS keychain (Windows Credential Manager, macOS
  Keychain, Secret Service). Without one (headless Linux, containers, `SERVER_USE_SECRETS=file`) they go into
  `~/.server-use/secrets.json` with mode 0600, the same trust level as `~/.ssh/id_*`.
- Credentials supplied through dedicated local input channels are not included by server-use in argv (local or
  remote), `ls`/`show` output, the audit log or error messages. Sudo gets its password on stdin. This guarantee does
  not sanitize arbitrary commands or stdout/stderr: a secret embedded in a generated command or printed by a
  server can reach the transcript, audit or saved output.
- A password typed into an agent chat reaches the model provider and stays in the transcript. `add` therefore
  installs this machine's key at once, proves key login on a fresh connection and deletes the password (it keeps
  it only if key login could not be set up, or as the sudo password of a non-root user). Change the password
  afterwards, or approve locking password login with `server-use harden <server> --lock-password`. Use local
  onboarding as the default for every agent; `--password-stdin` is not private if the password is embedded in the
  agent's generated shell command. Native clients can optionally provide a separate masked local credential UI.
- Public stdio MCP does not advertise a login-password field or `deploy.env_set`/`value`. It rejects explicit
  credential payloads for inventory/watch and `.env` value writes before connecting to the daemon. Existing local
  SSH keys and ssh-agent still work for MCP onboarding. Set sudo passwords, passphrases, notification tokens and
  application secrets through CLI stdin from a trusted local source.
- Exported `callTool` and daemon APIs are privileged local integration APIs. They retain credential support for
  adapters that collect secrets outside the model. Such adapters must enforce their own model-input boundary;
  the stdio checks do not automatically protect native integrations or arbitrary shell tools.

## Approved operations and monitoring (0.2)

Runbook approval binds the script hash, verification command, resolved host/user/port destinations, enumerated
parameters, sudo flag and attempt quota. Adding or replacing a runbook requires explicit approval even on an
`open` server. Execution refuses changed destinations or scripts and `readonly` servers; `--yes` cannot override
a quota. Attempts are reserved durably before remote execution, including failures and interrupted attempts, so
concurrent calls and daemon restarts do not reset the limit. These checks depend on the owner's private local
state; an attacker running as that owner remains outside the threat model.

Watch mutations require approval on `confirm` servers. Notification tokens/HMAC keys enter through CLI stdin,
are stored in a private server-side config and are not exposed in crontab, audit or inspection output. The MCP
tool rejects credential arguments. Before root installs monitoring, it rejects symlinked or lower-user-controlled
state/log paths. Doctor redacts recognized credential patterns before data leaves the server and repeats that
redaction locally; it cannot identify every possible application-specific secret, so choose log sources carefully.

## The local daemon

The daemon listens on a named pipe or Unix socket. Client and daemon authenticate each other with an HMAC
challenge over a token that only your user can read, so another local user cannot use your daemon, and cannot
impersonate it to collect secrets. A local attacker running as *you* is outside the model: they could read the
token and your keys anyway.

## Lock-out protection

`harden --lock-password` disables password login only after a fresh key-only login in a second connection worked
and `sshd -t` passed; if the check after the change fails, it re-enables password login and says so. The
`--agent-user` path installs keys as the target user, never following paths that user controls as root.

## What is installed where

Nothing on the servers beyond what is listed in [ARCHITECTURE.md](ARCHITECTURE.md#server-side-scripts). On your
machine: the CLI and `~/.server-use/`.

## Reporting a vulnerability

Please report security issues privately: use GitHub's *Report a vulnerability* on the repository's Security tab.
If that is not available to you, open an issue that asks for a private channel and contains no details. We aim to
acknowledge within a few days. Fixes ship as patch releases with a note in the [changelog](../CHANGELOG.md).

## Known limits

- The destructive-command heuristic is incomplete by design (see above).
- Whoever can run `server-use` as your user can use every server in your inventory. In shared environments give
  agents their own `SERVER_USE_HOME` with only the servers they need, and least-privilege users on those servers.
- A compromised server can read what runs on it, including `.env` files and deploy keys that server-use placed
  there. Keep production secrets per server and rotate after an incident.
