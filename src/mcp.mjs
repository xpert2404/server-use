// @ts-check
// `server-use mcp`: a Model Context Protocol server on stdio (newline-delimited JSON-RPC 2.0).
// A thin adapter over the daemon — the same pool, inventory, policy and audit log as the CLI.
// Hand-rolled on purpose: the protocol surface we need is five methods; the SDK would pull in a web stack.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DaemonClient } from './client.mjs'
import { formatAudit, formatImport, formatKeys, formatResults, formatStatus, table } from './format.mjs'
import { ROOT, VERSION, home, sshDir } from './paths.mjs'
import { parseDuration, SuError, UsageError } from './util.mjs'
import { formatCheck } from './checkfmt.mjs'

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const target = { type: 'string', description: 'server name, "a,b", "tag:<tag>" or "all"' }
const yes = { type: 'boolean', description: 'only after the user confirmed a destructive action (policy "confirm" answered with CONFIRM)' }

/** The tool table, shared with native adapters (NEXUS `server_*`) so they offer exactly what MCP offers. */
export const TOOLS = [
  {
    name: 'servers',
    description: 'Inventory of SSH servers. list | show (details + notes: read before working on a server) | status (health line per server) | notes (append what you set up) | facts (refresh OS/tool facts) | keys (private keys on this machine: path, type, encrypted?, fingerprint, which servers use them, ssh-agent identities; never contents) | import (Host entries of ~/.ssh/config: dryRun first, then import; nothing is connected) | add (user@host with an existing key: key=<path>, or ssh-agent / default keys; pins the host key) | set (non-secret fields: host port user key auth policy tags note check) | rm | trust (forget a pinned host key after the user verified a change) | disconnect | version | audit (what server-use ran). rm, trust, set of policy/host/port/user/key/auth, and force need yes=true after the user confirmed. A readonly server cannot be unlocked or removed here. Existing keys: keys, then import or add with key=<path>. Never put passwords, passphrases or key contents into arguments: an encrypted key needs ssh-agent or a passphrase the user enters locally (the host\'s masked prompt, or server-use add --ask-passphrase in their terminal).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'status', 'add', 'notes', 'facts', 'import', 'keys', 'set', 'rm', 'trust', 'disconnect', 'version', 'audit'] },
        name: { type: 'string', description: 'server name (show, add, notes, set, rm, trust, disconnect; audit: only this server)' },
        targets: target,
        address: { type: 'string', description: 'add: user@host[:port]' },
        key: { type: 'string', description: 'add: path of an existing private key file (~ or absolute); the path only, never the key contents' },
        note: { type: 'string', description: 'add: short description of the server' },
        tags: { type: 'array', items: { type: 'string' } },
        policy: { type: 'string', enum: ['open', 'confirm', 'readonly'] },
        append: { type: 'string', description: 'notes: line to append' },
        fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'set: host, port, user, key (path), auth (key|agent|password), policy, tags (a,b), note, check; "" deletes a field. No credentials.' },
        path: { type: 'string', description: 'import: another OpenSSH config file (default ~/.ssh/config)' },
        dryRun: { type: 'boolean', description: 'import: only show what would be imported' },
        defaultUser: { type: 'string', description: 'import: user for entries without User (default root)' },
        force: { type: 'boolean', description: 'import/add: replace existing entries (needs yes; never lifts readonly)' },
        n: { type: 'number', description: 'audit: number of lines (default 20)' },
        yes,
      },
      required: ['action'],
    },
  },
  {
    name: 'exec',
    description: 'Run a shell command (or a multi-line script) on one or more servers over the pooled SSH connection. Output is cut to the first 50 + last 150 lines per server (full log path given). Use job for runs longer than a few minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: target,
        command: { type: 'string', description: 'one shell command line' },
        script: { type: 'string', description: 'multi-line script (runs in bash, else sh) — use instead of command for quotes, pipes, several lines' },
        sudo: { type: 'boolean' },
        cwd: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'environment variables for this command (visible to the model provider: no secrets)' },
        full: { type: 'boolean', description: 'return the whole output instead of the first 50 + last 150 lines (can be large)' },
        timeout: { type: 'string', description: 'e.g. 90s, 10m (default 10m)' },
        yes,
      },
      required: ['targets'],
    },
  },
  {
    name: 'transfer',
    description: 'Copy a single file between this machine and servers. put: local → remote (remote path ending in / = directory). get: remote → local. Off-limits locally: server-use\'s state directory, ~/.ssh (except put of one public key file *.pub there), the inventory\'s login keys, and (get) server-use\'s install directories.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['put', 'get'] },
        targets: target,
        local: { type: 'string', description: 'absolute local path' },
        remote: { type: 'string' },
        mode: { type: 'string', description: 'put: octal mode like 640' },
        sudo: { type: 'boolean' },
        yes,
      },
      required: ['direction', 'targets', 'local', 'remote'],
    },
  },
  {
    name: 'logs',
    description: 'Recent logs of a systemd unit, docker container or file on a server (auto-detected).',
    inputSchema: {
      type: 'object',
      properties: { target, source: { type: 'string' }, lines: { type: 'number' }, since: { type: 'string', description: 'e.g. 30m, 2h' }, sudo: { type: 'boolean' } },
      required: ['target', 'source'],
    },
  },
  {
    name: 'cron',
    description: 'Manage cron jobs on a server (real crontab, own marked block, other lines untouched, flock against overlap). Check the time zone shown by ls before choosing a schedule; test with run.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['ls', 'add', 'rm', 'run', 'logs'] }, target, name: { type: 'string' },
        schedule: { type: 'string', description: '5 fields like "0 6 * * 1-5" or @daily' }, command: { type: 'string' },
        script: { type: 'string', description: 'add: multi-line script instead of command' }, lock: { type: 'boolean' }, sudo: { type: 'boolean' }, yes,
      },
      required: ['action', 'target'],
    },
  },
  {
    name: 'job',
    description: 'Long-running background jobs on a server that survive disconnects (data processing, backtests, builds). Do not poll: start, then wait (blocks up to `timeout`, answers with the exit code and the log tail when the job ends; "still running" is not an error, call wait again). maxTime stops a runaway job.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'ls', 'status', 'logs', 'stop', 'wait'] }, target, name: { type: 'string' }, command: { type: 'string' }, script: { type: 'string' }, lines: { type: 'number' },
        timeout: { type: 'string', description: 'wait: how long to block, e.g. 45s or 10m (default 45s)' }, maxTime: { type: 'string', description: 'start: needs timeout -k; TERM at this limit and KILL after 30s, exit 124 or 137' }, sudo: { type: 'boolean' }, yes,
      },
      required: ['action', 'target'],
    },
  },
  {
    name: 'deploy',
    description: 'Deploy a git repo to a server as releases with a current symlink, build detection (compose/npm/python), optional systemd service (run), health check with automatic rollback, auto-deploy via pull check (watch). Also: ls, rollback, key (deploy key for private repos), env_ls/env_rm for <base>/shared/.env. .env values are never model arguments: the user sets them locally (server-use env set on stdin) or through a masked prompt of the host.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['deploy', 'ls', 'rollback', 'key', 'env_ls', 'env_rm'] }, target,
        repo: { type: 'string', description: 'owner/repo, github.com/owner/repo or git URL' }, name: { type: 'string', description: 'app name (default: repo name)' },
        ref: { type: 'string' }, build: { type: 'string' }, run: { type: 'string' }, health: { type: 'string' }, watch: { type: 'string', description: 'pull-check interval, e.g. 5m' },
        base: { type: 'string', description: 'install directory (default /opt/<name> as root, else ~/apps/<name>); env_*: the same base' }, keep: { type: 'number', description: 'deploy: releases to keep (default 3)' },
        key: { type: 'string', description: 'env_*: variable name' }, sudo: { type: 'boolean' }, yes,
      },
      required: ['action', 'target'],
    },
  },
  {
    name: 'harden',
    description: 'Server hardening. check (read-only report: root login, password auth, firewall, ports) | install-key (installs the server-use key of this machine) | lock-password (turns SSH password login off, only after a fresh key-only login worked) | agent-user (creates a user without sudo and the inventory alias <name>-<user>). lock-password and agent-user answer CONFIRM per server: ask the user, then repeat with yes=true.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['check', 'install-key', 'lock-password', 'agent-user'] }, target, user: { type: 'string', description: 'agent-user: name of the new user (default agent)' }, yes },
      required: ['action', 'target'],
    },
  },
  {
    name: 'check', description: 'Read-only fleet attention check with new/resolved findings. code 10 means attention, not a transport error; changed reports only changes.',
    inputSchema: { type: 'object', properties: { target, changed: { type: 'boolean' }, sudo: { type: 'boolean' } }, required: ['target'] },
  },
  {
    name: 'doctor', description: 'Read-only incident snapshot with ranked evidence, next commands, recent changes and unavailable probes.',
    inputSchema: { type: 'object', properties: { target, since: { type: 'string', description: '1s through 7d, default 2h' }, deep: { type: 'boolean' }, sudo: { type: 'boolean' } }, required: ['target'] },
  },
  {
    name: 'watch', description: 'Install/manage cron monitoring on a server. Mutations need confirmation. Notification tokens are set by the user locally (CLI --stdin), never as model arguments; this tool supports token-free notification endpoints only.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off', 'ls', 'test', 'mute'] }, target, every: { type: 'string' }, notify: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } }, heartbeat: { type: 'string' }, key: { type: 'string' }, for: { type: 'string' }, yes }, required: ['action', 'target'] },
  },
  {
    name: 'runbook', description: 'Approve a hash-pinned fix script once for fixed server destinations, enumerated parameters and rate limit. Add always requires user approval. ls/show/rm are local metadata operations.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'ls', 'show', 'rm'] }, target, name: { type: 'string' }, script: { type: 'string' }, verify: { type: 'string' }, params: { type: 'array', items: { type: 'string' } }, limit: { type: 'string' }, sudo: { type: 'boolean' }, yes }, required: ['action'] },
  },
  {
    name: 'run', description: 'Execute a previously approved runbook only on pinned destinations with approved parameters. Hash, readonly and rate limits cannot be bypassed; dryRun previews the plan.',
    inputSchema: { type: 'object', properties: { target, runbook: { type: 'string' }, params: { type: 'object', additionalProperties: { type: 'string' } }, dryRun: { type: 'boolean' } }, required: ['target', 'runbook'] },
  },
  {
    name: 'permissions', description: 'Print reviewable Claude CLI permissions or Codex prefix rules for reading operations and named approved runbooks. Does not install or grant permissions.',
    inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['claude', 'codex'] } } },
  },
]

/** Inventory fields `servers(set)` may change. Credentials are not among them: they never travel as tool arguments. */
const SET_FIELDS = ['host', 'port', 'user', 'key', 'auth', 'policy', 'tags', 'note', 'check']
/** Fields that change where or how server-use connects, or its policy: they need the user's yes. */
const SET_GATED = ['policy', 'key', 'host', 'port', 'user', 'auth']

const res = (/** @type {any[]} */ list) => { const f = formatResults(list); return { text: f.text || '(no output)', isError: f.code !== 0, results: list } }
const ok = (/** @type {string} */ text) => ({ text, isError: false })
const confirm = (/** @type {any} */ a, /** @type {string} */ who, /** @type {string} */ what) => {
  if (a.yes !== true) throw new SuError('CONFIRM', `${who} (policy confirm): "${what}" needs confirmation. Ask the user, then repeat with yes=true.`)
}

/** A model-supplied file path: never key contents, never a UNC or device path (Windows would send NTLM credentials to it). Nothing is echoed. */
function plainPath(/** @type {string} */ what, /** @type {unknown} */ v) {
  if (typeof v !== 'string' || !v || v.length > 1024) throw new UsageError(`${what} must be a file path`)
  if (/-----BEGIN|[\r\n\0]/.test(v)) throw new UsageError(`${what} must be a file path, never key contents`)
  if (/^[\\/]{2}/.test(v)) throw new UsageError(`${what}: UNC and device paths are not allowed`)
}

/**
 * Pure checks of model-supplied inventory arguments: key and import paths, and the fields of `servers(set)`.
 * The stdio endpoint runs them before it starts a daemon; callTool repeats them for native adapters.
 */
export function checkArgs(/** @type {string} */ name, /** @type {any} */ a) {
  if (name !== 'servers') return
  for (const k of ['key', 'path']) if (a[k] != null && a[k] !== '') plainPath(k, a[k])
  if (a.fields == null) return
  if (typeof a.fields !== 'object' || Array.isArray(a.fields)) throw new UsageError('fields must be an object of strings')
  for (const [k, v] of Object.entries(a.fields)) {
    if (/pass(word|phrase)|secret|token|private/i.test(k)) throw new UsageError("fields: credentials are not inventory fields and never go through tool arguments (the host's masked prompt, or server-use set <name> <kind> --stdin in the user's terminal)")
    if (!SET_FIELDS.includes(k)) throw new UsageError(`fields: unknown field (allowed: ${SET_FIELDS.join(', ')})`)
    if (typeof v !== 'string' && typeof v !== 'number') throw new UsageError(`fields: ${k} must be a string`)
    if (k === 'key' && v !== '') plainPath('fields.key', v)
  }
}

/** Per-server readonly is the user's own decision: tools never lift it, not even with yes. Unknown servers pass (the operation reports them). */
async function keepReadonly(/** @type {DaemonClient} */ c, /** @type {string} */ name, /** @type {string} */ what) {
  let server
  try { server = (await c.request('servers.show', { name })).server } catch (e) { if (/** @type {any} */ (e).code === 'UNKNOWN_SERVER') return; throw e }
  if (server.policy === 'readonly') throw new SuError('READONLY', `${name} is readonly: ${what} is not allowed through tools, only the user may change that (server-use set ${name} policy=confirm)`)
}

const needName = (/** @type {any} */ a) => {
  if (typeof a.name !== 'string' || !a.name) throw new UsageError(`servers ${a.action} requires name`)
  return a.name
}

/** The `servers` tool. @param {DaemonClient} c @param {any} a */
async function servers(c, a) {
  checkArgs('servers', a)
  switch (a.action) {
    case 'list': {
      const r = await c.request('servers.list')
      if (!r.servers.length) return ok('inventory is empty')
      return ok(table([['NAME', 'ADDRESS', 'POLICY', 'AUTH', 'CONN', 'TAGS', 'OS'], ...r.servers.map((/** @type {any} */ s) => [s.name, `${s.user}@${s.host}:${s.port}`, s.policy, s.auth, s.connection, (s.tags || []).join(','), s.os || ''])]))
    }
    case 'show': return ok(JSON.stringify(await c.request('servers.show', { name: a.name }), null, 2))
    case 'status': { const f = formatStatus((await c.request('status', { targets: a.targets || 'all' })).results); return { text: f.text, isError: f.code !== 0 } }
    case 'add':
      if (a.force) { await keepReadonly(c, a.name, 'replacing it'); confirm(a, a.name, 'add --force: replace the existing entry') }
      return ok(JSON.stringify(await c.request('servers.add', { name: a.name, address: a.address, password: a.password, passphrase: a.passphrase, key: a.key || undefined, note: a.note, tags: a.tags, policy: a.policy, force: a.force }), null, 2))
    case 'notes': return ok((await c.request('notes', { name: a.name, append: a.append })).notes || '(no notes yet)')
    case 'facts': return res((await c.request('facts', { targets: a.targets || 'all' })).results.map((/** @type {any} */ x) => x.error ? x : { host: x.host, exit: 0, stdout: { text: Object.entries(x.facts).map(([k, v]) => `${k}=${v}`).join('\n') } }))
    case 'keys': return ok(formatKeys(await c.request('servers.keys'), 'servers import (dryRun first), or servers add with name, address and key=<path>'))
    case 'import':
      if (a.force && !a.dryRun) confirm(a, 'inventory', 'import --force: overwrite existing entries')
      return ok(formatImport(await c.request('servers.import', { path: a.path || undefined, dryRun: a.dryRun, force: a.force, defaultUser: a.defaultUser })))
    case 'set': {
      const name = needName(a)
      const fields = Object.fromEntries(Object.entries(a.fields || {}).map(([k, v]) => [k, String(v)]))
      if (!Object.keys(fields).length) throw new UsageError(`set requires fields (${SET_FIELDS.join(', ')})`)
      if (fields.policy !== undefined && fields.policy !== 'readonly') await keepReadonly(c, name, 'changing its policy')
      const gated = SET_GATED.filter((k) => Object.hasOwn(fields, k))
      if (gated.length) confirm(a, name, `set ${gated.join(', ')}`)
      await c.request('servers.set', { name, fields })
      return ok(`${name}: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    }
    case 'rm': {
      const name = needName(a)
      await keepReadonly(c, name, 'removing it')
      confirm(a, name, 'rm: remove the server and its stored secrets from the inventory')
      const r = await c.request('servers.rm', { name })
      return ok(`removed ${r.removed} (kept: ${r.kept.join('; ')})`)
    }
    case 'trust': {
      const name = needName(a)
      confirm(a, name, 'trust reset: forget the pinned host key (the next connection pins whatever the server presents)')
      const r = await c.request('trust.reset', { name })
      return ok(`forgot ${r.forgotten} pinned key(s) for ${r.name}; ${r.next}`)
    }
    case 'disconnect': await c.request('disconnect', { name: needName(a) }); return ok(`disconnected ${a.name}`)
    case 'version': {
      const r = await c.request('ping')
      return ok(`server-use ${VERSION} · daemon ${r.version} (protocol ${r.protocol}, pid ${r.pid}, up ${Math.round(r.uptimeMs / 1000)}s)\ntools: ${TOOLS.map((t) => t.name).join(', ')}`)
    }
    case 'audit': {
      const n = Math.min(Math.max(Math.trunc(Number(a.n)) || 20, 1), 200)
      // the daemon returns the newest lines of the whole log: for one server fetch more, then filter
      const { entries } = await c.request('audit.tail', { n: a.name ? 2000 : n })
      return ok(formatAudit(a.name ? entries.filter((/** @type {any} */ e) => e.host === a.name).slice(-n) : entries))
    }
  }
  throw Object.assign(new Error(`unknown tool or action: servers ${a.action ?? ''}`), { rpc: -32602 })
}

/**
 * One tool call. `results` (per host, when the tool works on hosts) lets an adapter see which hosts answered CONFIRM.
 * A thrown CONFIRM (code "CONFIRM") means: ask the user, then call again with yes=true.
 * Privileged local adapter API: callers may supply credentials obtained outside the model. The public stdio
 * endpoint rejects credential arguments before connecting; do not expose this function as an unfiltered model endpoint.
 * @param {DaemonClient} c @param {string} name @param {any} a @returns {Promise<{text: string, isError: boolean, results?: any[]}>}
 */
export async function callTool(c, name, a) {
  switch (name) {
    case 'servers': return servers(c, a)
    case 'exec':
      return res((await c.request('exec', { targets: a.targets, command: a.command, script: a.script, sudo: a.sudo, cwd: a.cwd, env: a.env, full: a.full, timeoutMs: a.timeout ? parseDuration(a.timeout) : undefined, yes: a.yes })).results)
    case 'transfer': {
      if (typeof a.local !== 'string' || !isAbsolute(a.local)) throw new UsageError('local path must be absolute')
      // Check and send the same fully qualified path: a drive-less win32 path ("\Users\...") would otherwise be
      // checked on this process's drive and written on the daemon's. resolve() drops the trailing "into this dir" separator.
      const local = resolve(a.local) + (/[\\/]$/.test(a.local) ? sep : '')
      // server-use's own state (pinned host keys, policies, key, secrets) is the user's: no reading or overwriting it via the agent.
      if (inside(home(), local)) throw new UsageError(`local path is inside server-use's state directory ${home()}; use another path`)
      // Keys in ~/.ssh/known_hosts are trusted too and ~/.ssh/id_* log in: no planting a host key, no uploading a login key.
      // Only one public key file may go up (authorized_keys setups), which cannot be a private key renamed.
      if (inside(sshDir(), local) && !(a.direction === 'put' && publicKeyFile(local))) throw new UsageError(`local path is inside ${sshDir()}, whose known_hosts and keys server-use trusts; use another path`)
      // Same for login keys the inventory names elsewhere (add --key, IdentityFile from import ssh-config).
      const keys = (await c.request('servers.list')).servers.filter((/** @type {any} */ s) => s.key).map((/** @type {any} */ s) => String(s.key).replace(/^~(?=$|[\\/])/, homedir()))
      if (keys.some((/** @type {string} */ k) => inside(k, local))) throw new UsageError('local path is the login key of a server in the inventory; use another path')
      // Nor replacing the code that enforces policies and pins (it runs at the next daemon start). Any copy, not only this
      // one: the daemon, or the CLI that starts the next one, may run from another install (plugin cache vs npm global).
      const inst = a.direction === 'get' && (inside(ROOT, local) ? ROOT : install(local))
      if (inst) throw new UsageError(`local path is inside server-use's install directory ${inst}; download elsewhere`)
      return res((await c.request(a.direction === 'get' ? 'get' : 'put', { targets: a.targets, local, remote: a.remote, mode: a.mode, sudo: a.sudo, yes: a.yes })).results
        .map((/** @type {any} */ x) => x.error ? x : { ...x, stdout: { text: x.exit === 0 ? `${a.direction === 'get' ? 'downloaded' : 'uploaded'} ${x.bytes} bytes → ${x.local || x.remote}` : x.stdout?.text } }))
    }
    case 'logs':
      return res((await c.request('logs', a)).results)
    case 'cron':
      return res((await c.request('cron', a)).results)
    case 'job': {
      const out = res((await c.request('job', { ...a, timeoutMs: a.action === 'wait' ? parseDuration(a.timeout || '45s') : undefined, maxTimeMs: a.maxTime ? parseDuration(a.maxTime) : undefined })).results)
      // exit 124 of a wait while the job still runs is an answer, not a failure
      if (a.action === 'wait' && out.results?.length && out.results.every((/** @type {any} */ r) => !r.error && (r.waitState === 'running' || r.waitState === 'exited' && r.exit === 0))) out.isError = false
      return out
    }
    case 'check': {
      if (!a.target) throw new UsageError('check requires target')
      const r = await c.request('check', { targets: a.target, changed: a.changed, sudo: a.sudo })
      return { text: formatCheck(r), isError: r.code !== 0 && r.code !== 10, results: r.results }
    }
    case 'doctor':
      if (!a.target) throw new UsageError('doctor requires target')
      return res((await c.request('doctor', { targets: a.target, since: a.since, deep: a.deep, sudo: a.sudo })).results)
    case 'harden':
      if (!a.target) throw new UsageError('harden requires target')
      return res((await c.request('harden', { target: a.target, action: a.action, user: a.user, yes: a.yes })).results)
    case 'watch':
      if (!a.target) throw new UsageError('watch requires target')
      if (['secret', 'token', 'password'].some(k => Object.hasOwn(a, k))) throw new UsageError('watch credentials must use CLI --stdin, never model arguments')
      return res((await c.request('watch', { sub: a.action, targets: a.target, every: a.every, notify: a.notify, urls: a.urls, heartbeat: a.heartbeat, key: a.key, for: a.for, yes: a.yes })).results)
    case 'runbook': {
      const r = await c.request('runbook', { sub: a.action, targets: a.target, name: a.name, script: a.script, verify: a.verify, params: a.params, limit: a.limit, sudo: a.sudo, yes: a.yes })
      return { text: JSON.stringify(r, null, 2), isError: false }
    }
    case 'run':
      return res((await c.request('run', { target: a.target, runbook: a.runbook, params: a.params, dryRun: a.dryRun })).results)
    case 'permissions': {
      const r = await c.request('permissions', { format: a.format })
      return { text: r.text + '\n' + r.note, isError: false }
    }
    case 'deploy': {
      if (String(a.action).startsWith('env_')) return res((await c.request('env', { action: a.action.slice(4), target: a.target, app: a.name, key: a.key, value: a.value, base: a.base, sudo: a.sudo })).results)
      return res((await c.request('deploy', a)).results)
    }
  }
  throw Object.assign(new Error(`unknown tool or action: ${name} ${a.action ?? ''}`), { rpc: -32602 })
}

/** Real path as far as it exists (symlinks, 8.3 names, case, trailing dots resolved), the missing rest appended. */
function real(/** @type {string} */ p) {
  /** @type {string[]} */ const rest = []
  for (;;) {
    try { return join(realpathSync.native(p), ...rest) } catch { /* not there yet: go up */ }
    if (dirname(p) === p) return join(p, ...rest)
    rest.unshift(basename(p))
    p = dirname(p)
  }
}
/** Is `p` the directory `dir` or anything below it? By real path, else by file identity: realpath keeps aliases like \\localhost\C$\... */
function inside(/** @type {string} */ dir, /** @type {string} */ p) {
  const rel = relative(real(dir), real(resolve(String(p))))
  if (!isAbsolute(rel) && rel.split(sep)[0] !== '..') return true
  const id = (/** @type {string} */ q) => { try { const s = statSync(q, { bigint: true }); return s.ino ? `${s.dev}:${s.ino}` : '' } catch { return '' } }
  const want = id(dir)
  for (let q = resolve(String(p)); want; q = dirname(q)) {
    if (id(q) === want) return true
    if (dirname(q) === q) break
  }
  return false
}

const PUBLIC_KEY_LINE = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/

/** Is `p` a regular *.pub file directly in ~/.ssh that holds exactly one public-key line? (A private key renamed .pub is not.) */
function publicKeyFile(/** @type {string} */ p) {
  try {
    const rel = relative(real(sshDir()), real(p))
    if (!/\.pub$/i.test(p) || !rel || rel === '..' || /[\\/]/.test(rel)) return false
    const st = lstatSync(p) // not a symlink either
    return st.isFile() && st.size <= 8192 && PUBLIC_KEY_LINE.test(readFileSync(p, 'utf8').replace(/\r?\n$/, ''))
  } catch { return false }
}

/** The server-use install (a directory with bin/server-use.mjs) that `p` is in, else ''. */
function install(/** @type {string} */ p) {
  for (let q = real(p); ; q = dirname(q)) {
    if (existsSync(join(q, 'bin', 'server-use.mjs'))) return q
    if (dirname(q) === q) return ''
  }
}

export async function runMcp() {
  /** @type {DaemonClient | null} */ let client = null
  let agent = 'mcp'
  const daemon = async () => {
    if (!client || client.sock.destroyed) client = await DaemonClient.connect({ agent })
    return client
  }
  const send = (/** @type {object} */ m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')

  /** @param {any} msg */
  async function handle(msg) {
    const { id, method, params } = msg
    if (id === undefined) return // notifications (initialized, cancelled) need no answer
    try {
      if (method === 'initialize') {
        agent = `mcp:${String(params?.clientInfo?.name || 'client').slice(0, 30)}`
        const v = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0]
        return send({ id, result: {
          protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'server-use', version: VERSION },
          instructions: 'server-use operates the user\'s SSH servers using local credentials. Never request passwords, passphrases, private keys or secret values in chat or tool arguments, and never read private key files. Existing keys are used by path: servers(keys) lists them (path, type, fingerprint, never contents), servers(import) takes the Host entries of ~/.ssh/config (dryRun first), servers(add, key=<path>) uses one key. An encrypted key needs ssh-agent or a passphrase the user enters locally (a masked prompt of the host, or server-use add --ask-passphrase in their terminal). Start with servers(list); read servers(show) notes before changing a server; append what you set up with servers(notes). CONFIRM errors mean: ask the user, then repeat with yes=true.',
        } })
      }
      if (method === 'ping') return send({ id, result: {} })
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS } })
      if (method === 'tools/call') {
        let out
        try {
          const name = params?.name
          const args = params?.arguments || {}
          if (['servers', 'watch'].includes(name) && ['password', 'sudoPassword', 'sudo-password', 'passphrase', 'privateKey', 'secret', 'token'].some(k => Object.hasOwn(args, k))) {
            throw new UsageError('credentials must come from a local terminal or trusted local secret source, never MCP arguments; use server-use add --ask (password) or --ask-passphrase (encrypted key) in your own terminal')
          }
          if (name === 'deploy' && (args.action === 'env_set' || Object.hasOwn(args, 'value'))) {
            throw new UsageError('.env values must use server-use env set with local stdin, never MCP arguments')
          }
          checkArgs(name, args) // before a daemon is started: a rejected argument touches no local state
          out = await callTool(await daemon(), name, args)
        } catch (e) {
          const err = /** @type {any} */ (e)
          if (err.rpc) throw err
          out = { text: `${err.code || 'ERROR'}: ${err.message}`, isError: true }
        }
        return send({ id, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } })
      }
      send({ id, error: { code: -32601, message: `method not found: ${method}` } })
    } catch (e) {
      const err = /** @type {any} */ (e)
      send({ id, error: { code: err.rpc || -32603, message: err.message } })
    }
  }

  /** @type {Set<Promise<void>>} */ const inflight = new Set()
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); continue }
      const p = handle(msg).finally(() => inflight.delete(p))
      inflight.add(p)
    }
  })
  process.stdin.on('end', async () => {
    await Promise.allSettled([...inflight])
    client?.close()
    process.exit(0)
  })
}
