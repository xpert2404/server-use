// @ts-check
// `server-use mcp`: a Model Context Protocol server on stdio (newline-delimited JSON-RPC 2.0).
// A thin adapter over the daemon — the same pool, inventory, policy and audit log as the CLI.
// Hand-rolled on purpose: the protocol surface we need is five methods; the SDK would pull in a web stack.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DaemonClient } from './client.mjs'
import { formatResults, formatStatus, table } from './format.mjs'
import { ROOT, VERSION, home, sshDir } from './paths.mjs'
import { parseDuration, UsageError } from './util.mjs'
import { formatCheck } from './checkfmt.mjs'

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const target = { type: 'string', description: 'server name, "a,b", "tag:<tag>" or "all"' }
const yes = { type: 'boolean', description: 'only after the user confirmed a destructive action (policy "confirm" answered with CONFIRM)' }

/** The tool table, shared with native adapters (NEXUS `server_*`) so they offer exactly what MCP offers. */
export const TOOLS = [
  {
    name: 'servers',
    description: 'Inventory of SSH servers. list | show (details + notes: read before working on a server) | status (health line per server) | add (uses existing local SSH keys or ssh-agent and pins the host key) | notes (append what you set up) | facts (refresh OS/tool facts). For password onboarding, the user runs server-use add --ask in their own terminal; never ask for credentials in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'status', 'add', 'notes', 'facts'] },
        name: { type: 'string', description: 'server name (show, add, notes)' },
        targets: target,
        address: { type: 'string', description: 'add: user@host[:port]' },
        tags: { type: 'array', items: { type: 'string' } },
        policy: { type: 'string', enum: ['open', 'confirm', 'readonly'] },
        append: { type: 'string', description: 'notes: line to append' },
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
        timeout: { type: 'string', description: 'e.g. 90s, 10m (default 10m)' },
        yes,
      },
      required: ['targets'],
    },
  },
  {
    name: 'transfer',
    description: 'Copy a single file between this machine and servers. put: local → remote (remote path ending in / = directory). get: remote → local. Off-limits locally: server-use\'s state directory, ~/.ssh, the inventory\'s login keys, and (get) server-use\'s install directories.',
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
        schedule: { type: 'string', description: '5 fields like "0 6 * * 1-5" or @daily' }, command: { type: 'string' }, lock: { type: 'boolean' }, yes,
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
        timeout: { type: 'string', description: 'wait: how long to block, e.g. 45s or 10m (default 45s)' }, maxTime: { type: 'string', description: 'start: needs timeout -k; TERM at this limit and KILL after 30s, exit 124 or 137' }, yes,
      },
      required: ['action', 'target'],
    },
  },
  {
    name: 'deploy',
    description: 'Deploy a git repo to a server as releases with a current symlink, build detection (compose/npm/python), optional systemd service (run), health check with automatic rollback, auto-deploy via pull check (watch). Also: ls, rollback, key (deploy key for private repos), env_ls/env_rm for <base>/shared/.env. Set secret values locally through server-use env set on stdin, never through model arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['deploy', 'ls', 'rollback', 'key', 'env_ls', 'env_rm'] }, target,
        repo: { type: 'string', description: 'owner/repo, github.com/owner/repo or git URL' }, name: { type: 'string', description: 'app name (default: repo name)' },
        ref: { type: 'string' }, build: { type: 'string' }, run: { type: 'string' }, health: { type: 'string' }, watch: { type: 'string', description: 'pull-check interval, e.g. 5m' },
        key: { type: 'string', description: 'env_*: variable name' }, sudo: { type: 'boolean' }, yes,
      },
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
    name: 'watch', description: 'Install/manage cron monitoring on a server. Mutations need confirmation. Credentials must use CLI --stdin outside model arguments; this tool supports token-free notification endpoints only.',
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

/**
 * One tool call. `results` (per host, when the tool works on hosts) lets an adapter see which hosts answered CONFIRM.
 * Privileged local adapter API: callers may supply credentials obtained outside the model. The public stdio
 * endpoint rejects credential arguments before connecting; do not expose this function as an unfiltered model endpoint.
 * @param {DaemonClient} c @param {string} name @param {any} a @returns {Promise<{text: string, isError: boolean, results?: any[]}>}
 */
export async function callTool(c, name, a) {
  const res = (/** @type {any[]} */ list) => { const f = formatResults(list); return { text: f.text || '(no output)', isError: f.code !== 0, results: list } }
  switch (name) {
    case 'servers': {
      if (a.action === 'list') {
        const r = await c.request('servers.list')
        if (!r.servers.length) return { text: 'inventory is empty', isError: false }
        return { text: table([['NAME', 'ADDRESS', 'POLICY', 'AUTH', 'CONN', 'TAGS', 'OS'], ...r.servers.map((/** @type {any} */ s) => [s.name, `${s.user}@${s.host}:${s.port}`, s.policy, s.auth, s.connection, (s.tags || []).join(','), s.os || ''])]), isError: false }
      }
      if (a.action === 'show') return { text: JSON.stringify(await c.request('servers.show', { name: a.name }), null, 2), isError: false }
      if (a.action === 'status') { const f = formatStatus((await c.request('status', { targets: a.targets || 'all' })).results); return { text: f.text, isError: f.code !== 0 } }
      if (a.action === 'add') return { text: JSON.stringify(await c.request('servers.add', { name: a.name, address: a.address, password: a.password, tags: a.tags, policy: a.policy }), null, 2), isError: false }
      if (a.action === 'notes') return { text: (await c.request('notes', { name: a.name, append: a.append })).notes || '(no notes yet)', isError: false }
      if (a.action === 'facts') return res((await c.request('facts', { targets: a.targets || 'all' })).results.map((/** @type {any} */ x) => x.error ? x : { host: x.host, exit: 0, stdout: { text: Object.entries(x.facts).map(([k, v]) => `${k}=${v}`).join('\n') } }))
      break
    }
    case 'exec':
      return res((await c.request('exec', { targets: a.targets, command: a.command, script: a.script, sudo: a.sudo, cwd: a.cwd, timeoutMs: a.timeout ? parseDuration(a.timeout) : undefined, yes: a.yes })).results)
    case 'transfer': {
      if (typeof a.local !== 'string' || !isAbsolute(a.local)) throw new UsageError('local path must be absolute')
      // Check and send the same fully qualified path: a drive-less win32 path ("\Users\...") would otherwise be
      // checked on this process's drive and written on the daemon's. resolve() drops the trailing "into this dir" separator.
      const local = resolve(a.local) + (/[\\/]$/.test(a.local) ? sep : '')
      // server-use's own state (pinned host keys, policies, key, secrets) is the user's: no reading or overwriting it via the agent.
      if (inside(home(), local)) throw new UsageError(`local path is inside server-use's state directory ${home()}; use another path`)
      // Keys in ~/.ssh/known_hosts are trusted too and ~/.ssh/id_* log in: no planting a host key, no uploading a login key.
      if (inside(sshDir(), local)) throw new UsageError(`local path is inside ${sshDir()}, whose known_hosts and keys server-use trusts; use another path`)
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
      if (String(a.action).startsWith('env_')) return res((await c.request('env', { action: a.action.slice(4), target: a.target, app: a.name, key: a.key, value: a.value, sudo: a.sudo })).results)
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
          instructions: 'server-use operates the user\'s SSH servers using local credentials. Never request passwords, private keys or secret values in chat or tool arguments. Use existing SSH keys or ask the user to onboard locally with server-use add --ask. Start with servers(list); read servers(show) notes before changing a server; append what you set up with servers(notes). CONFIRM errors mean: ask the user, then repeat with yes=true.',
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
            throw new UsageError('credentials must come from a local terminal or trusted local secret source, never MCP arguments; use server-use add --ask for password onboarding')
          }
          if (name === 'deploy' && (args.action === 'env_set' || Object.hasOwn(args, 'value'))) {
            throw new UsageError('.env values must use server-use env set with local stdin, never MCP arguments')
          }
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
