# Decisions

The decisions behind server-use, with the reason, so that nobody has to re-derive them. Change one by adding a
new entry that supersedes it.

| # | Decision | Why |
|---|---|---|
| D1 | **Name `server-use`.** CLI `server-use`, no short alias, NEXUS tools `server_*`, skills `server-use`, `add-server`, `deploy-repo`, `server-cron`, `server-doctor`. | Same pattern as browser-use and computer-use; models and people understand "an agent operates X" without explanation. No `su` alias: it collides with Unix `su`. |
| D2 | **Targets are written `web1`, `web1,web2`, `tag:prod`, `all`**, never `@prod`. | In PowerShell `@name` is splatting and would be swallowed. |
| D3 | **Node >= 22, plain ESM JavaScript with `// @ts-check`, no build step, `ssh2` as the SSH client.** | Same runtime as the NEXUS Harness; plugins install straight from git; `ssh2` works the same on Windows, macOS and Linux. |
| D4 | **A background daemon with a connection pool instead of OpenSSH `ControlMaster`.** | Win32-OpenSSH has no ControlMaster, and the main developer is on Windows. A daemon also shares inventory, host keys and audit log between all agents. |
| D5 | **Primary surface is CLI plus Skills; MCP is secondary; NEXUS gets native tools.** | The CLI costs no tool schemas per request, works in any agent with a shell, and the skills carry the know-how. MCP exists for clients without a shell or inside sandboxes (Codex). |
| D6 | **Agentless.** Server-side logic is small POSIX `sh` scripts streamed over stdin. | Nothing to install, update or secure on the servers; testable against a real sshd in CI. |
| D7 | **Secrets in the OS keychain, falling back to a 0600 file.** | The file has the same trust level as `~/.ssh/id_*`; encrypting it with a key on the same disk would add nothing. |
| D8 | **Default policy `confirm`; policies are speed bumps, the real boundaries are the agent's approval prompt and a least-privilege server user.** | A regex cannot be a security boundary; the docs say so instead of pretending. |
| D9 | **Passwords become keys at once.** `add` installs this machine's key, proves key login on a fresh connection and deletes the password. | A password typed into a chat reaches the model provider; the sooner it is useless the better. |
| D10 | **Host keys: trust on first use, any key type binds, a change stops with exit 4.** | Prevents a man in the middle from getting in with a key of another type; `trust --reset` is a human decision. |
| D11 | **Deploys are git clones into `releases/`, a `current` symlink, a health check with automatic rollback; auto-deploy is a server-side pull check.** | No open ports, no secrets in GitHub; push-based deploys via GitHub Actions stay a documented variant. |
| D12 | **A running command is never retried after a lost connection**, it is reported as `DISCONNECTED`. | It may have had effects. |
| D13 | **Free and open source for good** (MIT, no accounts, no paid tiers, no telemetry). | Owner's direction: genuinely useful for VPS users. |
| D14 | **The AI attaches servers to a conversation itself; no blanket access.** CLI agents: only when a server command runs. NEXUS: `server_connect`, with a user switch to forbid it (default allowed). | A chat about something else must not be able to touch production; the AI decides when a task needs a server and says which. |
| D15 | **Unattended fixes go through runbooks the user approved once** (0.2), not through blanket `--yes`. | Keeps `confirm` meaningful while letting an agent repair a known problem at 03:00. |
| D16 | **Not building:** interactive PTY sessions, ProxyJump/bastion, Windows servers, Ansible-style playbooks, a web UI, shared multi-user inventories. | Not needed yet; each can come back with a concrete use case. |
