// @ts-check
// `server-use` command line. Thin: parses arguments, asks the daemon, prints agent-friendly text.
import { parseArgs } from 'node:util'
import { readFileSync, existsSync, cpSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, join, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { call, DaemonClient, startDaemon } from './client.mjs'
import { VERSION, ROOT, home } from './paths.mjs'
import { EXIT, UsageError, parseDuration } from './util.mjs'
import { formatResults, formatStatus, worst, table } from './format.mjs'
import { formatCheck } from './checkfmt.mjs'
import { bareWait, jobTimes, waitCall } from './jobcli.mjs'

const HELP = {
  _: `server-use ${VERSION} — let your agent use your servers (persistent SSH, fleet exec, cron, jobs, deploy)

Targets: name | a,b | tag:<tag> | all
Servers:  add, import, ls, show, set, rm, trust, facts, notes, disconnect
Run:      exec, status, check, doctor, logs, put, get, job, run
Operate:  cron, env, deploy, harden, watch
Other:    runbook, permissions, audit, daemon, skills, mcp, help <verb>, --version
Global:   --json (machine-readable), exit codes: 0 ok · 2 usage/unknown server · 3 needs --yes (ask the user)
          4 host key changed · 5 unreachable · 6 auth failed · 7 readonly · 8 sudo password missing · 124 timeout
          10 check: something needs a look (not an error)`,
  add: `server-use add <name> <user@host[:port]> [--password-stdin | --ask] [--key <path>] [--tag t]... [--policy open|confirm|readonly]
  Pins the host key, logs in, collects facts. With a password it installs this machine's key, proves key login
  and then deletes the password (kept as sudo password for non-root users whose sudo needs one).
  --keep-password  keep the login password   --no-install-key  don't install a key   --note "<text>"   --force  replace
  Example: printf '%s' 'PASSWORD' | server-use add trading-1 root@1.2.3.4 --password-stdin --tag trading`,
  import: `server-use import [ssh-config] [--path ~/.ssh/config] [--dry-run] [--user root] [--force]
  Imports Host entries from your OpenSSH config (wildcards skipped).`,
  ls: 'server-use ls — inventory with connection state',
  show: 'server-use show <name> — details, stored secret kinds (never values), connection, notes',
  set: `server-use set <name> key=value ...        keys: host port user key auth policy tags note check
server-use set <name> password|sudo-password|passphrase --stdin   (value from stdin; empty deletes)`,
  rm: 'server-use rm <name> — removes server and its secrets (pinned host key and notes stay)',
  trust: 'server-use trust <name> --reset — forget the pinned host key (only after the user verified the change!)',
  facts: 'server-use facts [targets] — re-collect OS/tooling facts (stored in the inventory)',
  notes: `server-use notes <name> [--append "<text>"] — the server's memory: what runs where, ports, paths.
  Read it before working on a server; append what you set up.`,
  disconnect: 'server-use disconnect <name> — close the pooled connection (reconnects on next use)',
  exec: `server-use exec <targets> '<command>' [--sudo] [--cwd <dir>] [--env K=V]... [--timeout 10m] [--yes] [--full] [--raw]
server-use exec <targets> --script <file|-> [...]      script via stdin/file, runs in bash (or sh)
  Quote the command as ONE argument. Anything with quotes, pipes or several lines: use --script - with a heredoc.
  Flags after a literal -- belong to the remote command. Output: per-host header, first 50 + last 150 lines
  (full output path shown when cut). Exit 3 = policy "confirm" hit something destructive: ask the user, then --yes.
  Runs longer than a few minutes: use "job start" instead.`,
  status: 'server-use status [targets] — one line per server: uptime, load, memory, disk, failed units, containers, reboot',
  logs: 'server-use logs <target> <unit|container|/path/file> [-n 200] [--since 1h] [--sudo]',
  put: 'server-use put <targets> <local-file> <remote-path> [--mode 640] [--sudo] [--yes]   (remote dir if it ends with /)',
  get: 'server-use get <targets> <remote-path> <local-path> [--sudo]   (several targets: local is a dir, files <host>_<name>)',
  job: `server-use job start <target> <name> '<command>' | --script <file|-> [--wait[=30m]] [--max-time 4h]
server-use job wait <target> <name> [--timeout 30m] [-n 40]
server-use job ls <target> | job status|logs|stop <target> <name> [-n 100]
  Jobs survive disconnects and closed laptops. wait blocks until the job ends and prints "<name> exited <code> after
  <time>" plus the log tail; its exit code is the job's. Still running at --timeout: exit 124 ("still running"), just
  call wait again. start --wait is start + wait. --max-time needs timeout -k; TERM at the limit, KILL after
  30 seconds, exit 124 or 137 recorded. Without that utility, the job is not started.
  A final state/log snapshot may take up to one extra second beyond the wait deadline.
  Jobs run with a raised oom_score_adj, so the OOM killer takes them before sshd or your app.`,
  cron: `server-use cron add <target> <name> '<schedule>' '<command>' [--no-lock]   (or --script <file|->)
server-use cron ls <target> | cron rm|run|logs <target> <name>
  Real crontab entries in a server-use block; foreign lines are never touched. flock prevents overlap.
  Check the server time zone (cron ls shows it) before choosing the schedule.`,
  env: `server-use env ls <target> <app>
server-use env set <target> <app> KEY           value from stdin (or KEY=value, visible in shell history)
server-use env rm <target> <app> KEY           [--base <dir>]   file: <app base>/shared/.env (mode 600)`,
  deploy: `server-use deploy <target> <repo> [--name n] [--ref main] [--base /opt/<name>] [--build '<cmd>'] [--run '<cmd>']
                  [--health '<cmd>'] [--watch 5m] [--sudo] [--yes]
server-use deploy ls|rollback <target> <name>        deploy key <target> <name>  (for private repos)
  repo: owner/repo, github.com/owner/repo or any git URL. Releases in <base>/releases, <base>/current symlink,
  shared/.env linked in. Build is detected (compose, npm, python/uv) unless --build. --run makes a systemd
  service (or a background job without root). Failed --health rolls back automatically. --watch = pull check via cron.`,
  harden: `server-use harden <targets> [--check | --install-key | --lock-password | --agent-user [name]] [--yes]
  --lock-password disables SSH password login only after a fresh key-only login worked (reverts otherwise).
  --agent-user creates a user without sudo and adds it to the inventory as <name>-<user>.`,
  check: `server-use check [targets, default all] [--changed] [--sudo] [--json]
  One read-only call: does anything need attention? "all N servers ok" (exit 0), or one block per affected server
  (exit 10) with the next command for each item. --changed: exit 10 only when the crit/warn items differ from the
  previous check of those hosts (new, worse or resolved). Info items never set 10. --sudo reads journal, docker and
  certificates as root. Per-server thresholds: server-use set <name> check='disk=95 inodes=95 mem=98 cert=7 skip=updates,ssh'`,
  watch: `server-use watch on <targets> [--every 5m] [--notify ntfy | ntfy:<https://host/topic> | telegram:<chat_id> | webhook:<url>]
                  [--stdin] [--url <url>[=<code>]]... [--heartbeat <url>]
server-use watch ls|test|off <targets>      server-use watch mute <target> <kind:id|all> --for 2h   (--for 0 clears)
  Puts check on the server as a cron entry and notifies only on changes (an item must fail twice in a row; again
  every 6 h; resolved after two clean runs). ntfy (default, free, no account) makes a private topic and prints where
  to subscribe. --stdin carries the one secret: Telegram bot token, ntfy access token or webhook HMAC key; it never
  goes into argv, the inventory, the crontab or the audit log. --url adds an HTTP probe (2xx/3xx, or the code after =),
  --heartbeat pings a dead-man's-switch URL after each run. Re-run "watch on" after changing check= thresholds.`,
  doctor: `server-use doctor <targets> [--since 2h] [--deep] [--sudo] [--json]
  One read-only incident snapshot with ranked findings, evidence, next commands and recent changes.
  --since accepts 1s through 7d. --deep measures large directories on nearly full mounts; missing probes stay visible.`,
  runbook: `server-use runbook add <targets> <name> --script <file|-> [--verify '<command>'] [--param key=value1,value2]... [--limit 3/1h] [--sudo] --yes
server-use runbook ls | runbook show|rm <name>
  Show the user the script, verification, target destinations, parameters, sudo and rate limit before approval.
  The hash pins this approval; new tagged servers and changed destinations require reapproval.`,
  run: `server-use run <targets> <runbook> [key=value ...] [--dry-run]
  Executes only the approved script, destinations and enumerated parameters; readonly and rate limits remain enforced.
  --dry-run shows the approved plan. Increase a rate limit by reapproving the runbook.`,
  permissions: `server-use permissions [--format claude|codex] [--json]
  Prints configuration rules for reading commands and named approved runs. Review and merge them into the agent's configuration.`,
  audit: 'server-use audit [-n 20] — what server-use did (agent, host, command, exit)',
  daemon: 'server-use daemon status|start|stop|restart — the background process holding the connections',
  skills: 'server-use skills install [--dir ~/.agents/skills] — copy the agent skills for agents without the plugin',
  mcp: 'server-use mcp — MCP server on stdio (tools: servers, exec, transfer, logs, cron, job, deploy, check, doctor, watch, runbook, run, permissions)',
}

const OUR_EXEC_FLAGS = { '--sudo': 0, '--yes': 0, '--json': 0, '--full': 0, '--raw': 0, '--timeout': 1, '--cwd': 1, '--env': 1, '--script': 1, '--help': 0 }

/** @param {string[]} argv */
export async function main(argv) {
  const [verb, ...rest] = argv
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') return print(HELP[/** @type {keyof HELP} */ (rest[0])] || HELP._)
  if (verb === '--version' || verb === 'version' || verb === '-v') return print(VERSION)
  if (rest.includes('--help') && verb !== 'exec') return print(HELP[/** @type {keyof HELP} */ (verb)] || HELP._)
  const handler = VERBS[verb]
  if (!handler) throw new UsageError(`unknown command "${verb}"\n\n${HELP._}`)
  return handler(rest)
}

/** @param {string[]} args @param {Record<string, {type: 'string'|'boolean', short?: string, multiple?: boolean}>} options */
function parse(args, options = {}) {
  try {
    const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' }, ...options }, allowPositionals: true, strict: true })
    return { v: /** @type {Record<string, any>} */ (values), p: positionals }
  } catch (e) {
    // unknown flag or missing value: usage (exit 2), not mistaken for the remote command's exit 1
    throw new UsageError(/** @type {Error} */ (e).message)
  }
}

/** @type {Record<string, (args: string[]) => Promise<number|void>>} */
const VERBS = {
  async add(args) {
    const { v, p } = parse(args, {
      'password-stdin': { type: 'boolean' }, ask: { type: 'boolean' }, key: { type: 'string' }, tag: { type: 'string', multiple: true },
      policy: { type: 'string' }, 'keep-password': { type: 'boolean' }, 'no-install-key': { type: 'boolean' }, note: { type: 'string' }, force: { type: 'boolean' },
    })
    if (p.length !== 2) throw new UsageError(HELP.add)
    let password
    if (v['password-stdin']) password = (await readStdin()).replace(/\r?\n$/, '')
    else if (v.ask) password = await askHidden(`Password for ${p[1]}: `)
    const r = await call('servers.add', {
      name: p[0], address: p[1], password, key: v.key ? resolve(v.key) : undefined, tags: splitTags(v.tag), policy: v.policy,
      keepPassword: v['keep-password'], installKey: !v['no-install-key'], note: v.note, force: v.force,
    })
    if (v.json) return json(r)
    print([
      `added ${r.name}: ${r.user}@${r.host}:${r.port} · auth ${r.auth} · policy ${r.policy}${r.tags?.length ? ` · tags ${r.tags.join(',')}` : ''}`,
      `host key ${r.hostkey.fingerprint} (${r.hostkey.status === 'new' ? 'new — pinned now' : r.hostkey.status})`,
      r.keyInstalled ? 'key installed and key login verified' : '',
      r.secretStored !== 'none' ? `stored ${r.secretStored} in ${r.secretBackend}` : '',
      `facts: ${Object.entries(r.facts || {}).map(([k, x]) => `${k}=${x}`).join(' ')}`,
      ...(r.hints || []).map((/** @type {string} */ h) => `hint: ${h}`),
    ].filter(Boolean).join('\n'))
  },

  async import(args) {
    const { v, p } = parse(args, { path: { type: 'string' }, 'dry-run': { type: 'boolean' }, user: { type: 'string' }, force: { type: 'boolean' } })
    if (p.length && p[0] !== 'ssh-config') throw new UsageError(HELP.import)
    const r = await call('servers.import', { path: v.path ? resolve(v.path) : undefined, dryRun: v['dry-run'], defaultUser: v.user, force: v.force })
    if (v.json) return json(r)
    print([`from ${r.path}:`, ...r.servers.map((/** @type {any} */ s) => `  ${s.action.padEnd(18)} ${s.name}  ${s.user}@${s.host}:${s.port}${s.key ? `  key ${s.key}` : ''}`), r.hint].join('\n'))
  },

  async ls(args) {
    const { v } = parse(args)
    const r = await call('servers.list')
    if (v.json) return json(r)
    if (!r.servers.length) return print('inventory is empty — add a server: server-use add <name> <user@host> [--password-stdin]')
    const rows = r.servers.map((/** @type {any} */ s) => [s.name, `${s.user}@${s.host}:${s.port}`, s.policy, s.auth, s.connection, (s.tags || []).join(','), s.os || ''])
    print(table([['NAME', 'ADDRESS', 'POLICY', 'AUTH', 'CONN', 'TAGS', 'OS'], ...rows]))
  },

  async show(args) {
    const { v, p } = parse(args)
    if (p.length !== 1) throw new UsageError(HELP.show)
    const r = await call('servers.show', { name: p[0] })
    if (v.json) return json(r)
    const s = r.server
    print([
      `${s.name}: ${s.user}@${s.host}:${s.port}`,
      `policy ${s.policy} · auth ${s.auth}${s.key ? ` (${s.key})` : ''} · tags ${(s.tags || []).join(',') || '-'} · added ${s.added || '?'}`,
      `connection ${r.connection.state}${r.connection.since ? ` since ${new Date(r.connection.since).toLocaleTimeString()}` : ''}`,
      `secrets (${r.secretBackend}): ${r.secrets.join(', ') || 'none'}`,
      s.note ? `note: ${s.note}` : '',
      `facts: ${Object.entries(s.facts || {}).map(([k, x]) => `${k}=${x}`).join(' ') || '-'}`,
      r.notes ? `\n${r.notes.trim()}` : `notes: none yet (${r.notesPath})`,
    ].filter(Boolean).join('\n'))
  },

  async set(args) {
    const { v, p } = parse(args, { stdin: { type: 'boolean' } })
    if (p.length < 2) throw new UsageError(HELP.set)
    const [name, ...pairs] = p
    if (['password', 'sudo-password', 'passphrase'].includes(pairs[0])) {
      if (!v.stdin) throw new UsageError(`secrets are only read from stdin: printf '%s' '...' | server-use set ${name} ${pairs[0]} --stdin`)
      const value = (await readStdin()).replace(/\r?\n$/, '')
      await call('servers.set', { name, secret: { kind: pairs[0], value } })
      return print(value ? `stored ${pairs[0]} for ${name}` : `deleted ${pairs[0]} for ${name}`)
    }
    /** @type {Record<string, string>} */
    const fields = {}
    for (const kv of pairs) {
      const i = kv.indexOf('=')
      if (i < 1) throw new UsageError(`expected key=value, got "${kv}"`)
      fields[kv.slice(0, i)] = kv.slice(i + 1)
    }
    const r = await call('servers.set', { name, fields })
    if (v.json) return json(r)
    print(`${name}: ${Object.entries(fields).map(([k, x]) => `${k}=${x}`).join(' ')}`)
  },

  async rm(args) {
    const { v, p } = parse(args)
    if (p.length !== 1) throw new UsageError(HELP.rm)
    const r = await call('servers.rm', { name: p[0] })
    if (v.json) return json(r)
    print(`removed ${r.removed} (kept: ${r.kept.join('; ')})`)
  },

  async trust(args) {
    const { v, p } = parse(args, { reset: { type: 'boolean' } })
    if (p.length !== 1 || !v.reset) throw new UsageError(HELP.trust)
    const r = await call('trust.reset', { name: p[0] })
    if (v.json) return json(r)
    print(`forgot ${r.forgotten} pinned key(s) for ${r.name}; ${r.next}`)
  },

  async facts(args) {
    const { v, p } = parse(args)
    const r = await call('facts', { targets: p[0] || 'all' })
    if (v.json) return json(r)
    return results(r.results.map((/** @type {any} */ x) => x.error ? x : { host: x.host, exit: 0, ms: 0, stdout: { text: Object.entries(x.facts).map(([k, y]) => `${k}=${y}`).join('\n') } }))
  },

  async notes(args) {
    const { v, p } = parse(args, { append: { type: 'string' } })
    if (p.length !== 1) throw new UsageError(HELP.notes)
    const r = await call('notes', { name: p[0], append: remote(v.append) })
    if (v.json) return json(r)
    print(r.notes.trim() || `no notes yet (${r.path})`)
  },

  async disconnect(args) {
    const { p } = parse(args)
    if (p.length !== 1) throw new UsageError(HELP.disconnect)
    await call('disconnect', { name: p[0] })
    print(`disconnected ${p[0]}`)
  },

  async exec(args) {
    /** @type {Record<string, any>} */ const v = { env: [] }
    /** @type {string[]} */ const pos = []
    let dashdash = false
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (!dashdash && a === '--') { dashdash = true; continue }
      const flag = a.split('=')[0]
      if (!dashdash && flag in OUR_EXEC_FLAGS) {
        const name = flag.slice(2)
        if (OUR_EXEC_FLAGS[/** @type {keyof OUR_EXEC_FLAGS} */ (flag)] === 0) { v[name] = true; continue }
        const val = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i]
        if (val === undefined) throw new UsageError(`${flag} needs a value`)
        if (name === 'env') v.env.push(val)
        else v[name] = val
        continue
      }
      pos.push(a)
    }
    if (v.help) return print(HELP.exec)
    const [targets, ...cmd] = pos
    if (!targets) throw new UsageError(HELP.exec)
    const script = v.script !== undefined ? await readScript(v.script) : undefined
    if (script === undefined && !cmd.length) throw new UsageError('nothing to run: pass the command as one quoted argument, or --script <file|->')
    /** @type {Record<string, string>} */ const env = {}
    for (const e of v.env) { const i = e.indexOf('='); if (i < 1) throw new UsageError(`--env expects K=V, got "${e}"`); env[e.slice(0, i)] = remote(e.slice(i + 1)) }
    const r = await call('exec', {
      targets, command: cmd.length ? cmd.map(remote).join(' ') : undefined, script, sudo: v.sudo, cwd: remote(v.cwd), env,
      timeoutMs: v.timeout ? parseDuration(v.timeout) : undefined, yes: v.yes, full: v.full,
    })
    if (v.json) return json(r, r.results)
    return results(r.results, { raw: v.raw })
  },

  async status(args) {
    const { v, p } = parse(args)
    const r = await call('status', { targets: p[0] || 'all' })
    if (v.json) return json(r, r.results)
    const { text, code } = formatStatus(r.results)
    process.stdout.write(text)
    return code
  },

  async logs(args) {
    const { v, p } = parse(args, { lines: { type: 'string', short: 'n' }, since: { type: 'string' }, sudo: { type: 'boolean' } })
    if (p.length !== 2) throw new UsageError(HELP.logs)
    const r = await call('logs', { target: p[0], source: remote(p[1]), lines: v.lines, since: v.since, sudo: v.sudo })
    if (v.json) return json(r, r.results)
    return results(r.results)
  },

  async put(args) {
    const { v, p } = parse(args, { mode: { type: 'string' }, sudo: { type: 'boolean' }, yes: { type: 'boolean' } })
    if (p.length !== 3) throw new UsageError(HELP.put)
    const r = await call('put', { targets: p[0], local: resolve(p[1]), remote: remote(p[2]), mode: v.mode, sudo: v.sudo, yes: v.yes })
    if (v.json) return json(r, r.results)
    return results(r.results.map((/** @type {any} */ x) => x.error ? x : { ...x, stdout: { text: x.exit === 0 ? `uploaded ${x.bytes} bytes → ${x.remote}` : x.stdout.text } }))
  },

  async get(args) {
    const { v, p } = parse(args, { sudo: { type: 'boolean' } })
    if (p.length !== 3) throw new UsageError(HELP.get)
    // resolve() drops a trailing separator, which tells get "into this directory" (even one that does not exist yet).
    const r = await call('get', { targets: p[0], remote: remote(p[1]), local: resolve(p[2]) + (/[\\/]$/.test(p[2]) ? sep : ''), sudo: v.sudo })
    if (v.json) return json(r, r.results)
    return results(r.results.map((/** @type {any} */ x) => x.error ? x : { ...x, stdout: { text: x.exit === 0 ? `downloaded ${x.bytes} bytes → ${x.local}` : '' } }))
  },

  async job(args) {
    const { v, p } = parse(bareWait(args), {
      script: { type: 'string' }, lines: { type: 'string', short: 'n' }, sudo: { type: 'boolean' }, yes: { type: 'boolean' },
      wait: { type: 'string' }, 'max-time': { type: 'string' }, timeout: { type: 'string' },
    })
    const [action, target, name, ...cmd] = p
    if (!action || !target || (action === 'wait' && !name)) throw new UsageError(HELP.job)
    const t = jobTimes(action, v)
    if (action === 'wait') {
      const r = await waitCall({ target, name, lines: v.lines, sudo: v.sudo, timeoutMs: /** @type {number} */ (t.timeoutMs) })
      if (v.json) return json(r, r.results)
      return results(r.results)
    }
    const r = await call('job', {
      action, target, name, command: cmd.length ? cmd.map(remote).join(' ') : undefined,
      script: v.script !== undefined ? await readScript(v.script) : undefined, lines: v.lines, sudo: v.sudo, yes: v.yes, maxTimeMs: t.maxTimeMs,
    })
    if (t.waitMs === undefined) {
      if (v.json) return json(r, r.results)
      return results(r.results)
    }
    // start --wait: hosts that started are waited for (their "started" line adds nothing; a "note:" does), the others show why not
    const ok = r.results.filter((/** @type {any} */ x) => !x.error && x.exit === 0)
    const failed = r.results.filter((/** @type {any} */ x) => !ok.includes(x))
    const w = ok.length ? await waitCall({ target: ok.map((/** @type {any} */ x) => x.host).join(','), name, lines: v.lines, sudo: v.sudo, timeoutMs: t.waitMs }) : { results: [] }
    for (const x of w.results) {
      const notes = (ok.find((/** @type {any} */ s) => s.host === x.host)?.stdout?.text || '').split('\n').filter((/** @type {string} */ l) => l.startsWith('note:'))
      if (notes.length && x.stdout) x.stdout.text = notes.join('\n') + '\n' + x.stdout.text
    }
    if (v.json) return json({ start: r.results, wait: w.results }, [...failed, ...w.results])
    return results([...failed, ...w.results])
  },

  async cron(args) {
    const { v, p } = parse(args, { script: { type: 'string' }, 'no-lock': { type: 'boolean' }, lines: { type: 'string', short: 'n' }, sudo: { type: 'boolean' }, yes: { type: 'boolean' }, timeout: { type: 'string' } })
    const [action, target, name, schedule, ...cmd] = p
    if (!action || !target) throw new UsageError(HELP.cron)
    const r = await call('cron', {
      action, target, name, schedule, command: cmd.length ? cmd.map(remote).join(' ') : undefined,
      script: v.script !== undefined ? await readScript(v.script) : undefined, lock: !v['no-lock'], lines: v.lines, sudo: v.sudo, yes: v.yes,
      timeoutMs: v.timeout ? parseDuration(v.timeout) : undefined,
    })
    if (v.json) return json(r, r.results)
    return results(r.results)
  },

  async env(args) {
    const { v, p } = parse(args, { base: { type: 'string' }, sudo: { type: 'boolean' } })
    const [action, target, app, keyArg] = p
    if (!action || !target || !app) throw new UsageError(HELP.env)
    let key = keyArg
    let value
    if (action === 'set') {
      if (keyArg?.includes('=')) { key = keyArg.slice(0, keyArg.indexOf('=')); value = keyArg.slice(keyArg.indexOf('=') + 1) }
      else value = (await readStdin()).replace(/\r?\n$/, '')
    }
    const r = await call('env', { action, target, app, key, value, base: remote(v.base), sudo: v.sudo })
    if (v.json) return json(r, r.results)
    return results(r.results)
  },

  async deploy(args) {
    const { v, p } = parse(args, {
      name: { type: 'string' }, ref: { type: 'string' }, base: { type: 'string' }, build: { type: 'string' }, run: { type: 'string' },
      health: { type: 'string' }, watch: { type: 'string' }, keep: { type: 'string' }, sudo: { type: 'boolean' }, yes: { type: 'boolean' },
    })
    const sub = ['ls', 'rollback', 'key'].includes(p[0]) ? p.shift() : 'deploy'
    const [target, second] = p
    if (!target || !second) throw new UsageError(HELP.deploy)
    const r = await call('deploy', {
      action: sub, target, repo: sub === 'deploy' ? remote(second) : undefined, name: sub === 'deploy' ? v.name : second,
      ref: v.ref, base: remote(v.base), build: remote(v.build), run: remote(v.run), health: remote(v.health), watch: v.watch, keep: v.keep ? Number(v.keep) : undefined, sudo: v.sudo, yes: v.yes,
    })
    if (v.json) return json(r, r.results)
    return results(r.results.map((/** @type {any} */ x) => x.watch ? { ...x, stdout: { ...x.stdout, text: `${x.stdout.text}watch: ${x.watch}\n` } } : x))
  },

  async harden(args) {
    const { v, p } = parse(args, { check: { type: 'boolean' }, 'install-key': { type: 'boolean' }, 'lock-password': { type: 'boolean' }, 'agent-user': { type: 'boolean' }, user: { type: 'string' }, yes: { type: 'boolean' } })
    if (p.length < 1) throw new UsageError(HELP.harden)
    const action = v['lock-password'] ? 'lock-password' : v['agent-user'] ? 'agent-user' : v['install-key'] ? 'install-key' : 'check'
    const r = await call('harden', { target: p[0], action, user: v.user || p[1], yes: v.yes })
    if (v.json) return json(r, r.results)
    return results(r.results)
  },

  async check(args) {
    const { v, p } = parse(args, { changed: { type: 'boolean' }, sudo: { type: 'boolean' } })
    if (p.length > 1) throw new UsageError(HELP.check)
    const r = await call('check', { targets: p[0] || 'all', changed: v.changed, sudo: v.sudo })
    if (v.json) { print(JSON.stringify(r, null, 2)); return r.code }
    process.stdout.write(formatCheck(r))
    return r.code
  },

  async watch(args) {
    const { v, p } = parse(args, { every: { type: 'string' }, notify: { type: 'string' }, stdin: { type: 'boolean' }, url: { type: 'string', multiple: true }, heartbeat: { type: 'string' }, for: { type: 'string' }, yes: { type: 'boolean' } })
    const [sub, target, key] = p
    if (!['on', 'ls', 'test', 'off', 'mute'].includes(sub) || !target || p.length > (sub === 'mute' ? 3 : 2)) throw new UsageError(HELP.watch)
    const secret = v.stdin ? (await readStdin()).replace(/\r?\n$/, '') : undefined
    const r = await call('watch', { sub, targets: target, every: v.every, notify: v.notify, secret, urls: v.url, heartbeat: v.heartbeat, key, for: v['for'], yes: v.yes })
    if (v.json) return json(r, r.results)
    return results(r.results)
  },

  async doctor(args) {
    const { v, p } = parse(args, { since: { type: 'string' }, deep: { type: 'boolean' }, sudo: { type: 'boolean' } })
    if (p.length !== 1) throw new UsageError(HELP.doctor)
    const r = await call('doctor', { targets: p[0], since: v.since, deep: v.deep, sudo: v.sudo })
    if (v.json) return json(r, r.results)
    return results(r.results)
  },

  async runbook(args) {
    const { v, p } = parse(args, { script: { type: 'string' }, verify: { type: 'string' }, param: { type: 'string', multiple: true }, limit: { type: 'string' }, sudo: { type: 'boolean' }, yes: { type: 'boolean' } })
    const [sub, first, name] = p
    if (!['add', 'ls', 'show', 'rm'].includes(sub) || (sub === 'ls' ? p.length !== 1 : sub === 'add' ? p.length !== 3 || v.script === undefined : p.length !== 2)) throw new UsageError(HELP.runbook)
    const r = await call('runbook', { sub, targets: sub === 'add' ? first : undefined, name: sub === 'add' ? name : first, script: sub === 'add' ? await readScript(v.script) : undefined, verify: v.verify, params: v.param, limit: v.limit, sudo: v.sudo, yes: v.yes })
    print(JSON.stringify(r, null, 2))
    return 0
  },

  async run(args) {
    const { v, p } = parse(args, { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' } })
    const [target, runbook, ...values] = p
    if (!target || !runbook) throw new UsageError(HELP.run)
    const params = Object.create(null)
    for (const value of values) {
      const i = value.indexOf('=')
      if (i < 1 || Object.hasOwn(params, value.slice(0, i))) throw new UsageError('run parameters must be unique key=value pairs')
      params[value.slice(0, i)] = value.slice(i + 1)
    }
    const r = await call('run', { target, runbook, params, dryRun: v['dry-run'], yes: v.yes })
    if (v.json) return json(r, r.results)
    return results(r.results)
  },

  async permissions(args) {
    const { v, p } = parse(args, { format: { type: 'string' } })
    if (p.length) throw new UsageError(HELP.permissions)
    const r = await call('permissions', { format: v.format })
    print(v.json ? JSON.stringify(r, null, 2) : r.text + '\n' + r.note)
    return 0
  },

  async audit(args) {
    const { v } = parse(args, { lines: { type: 'string', short: 'n' } })
    const r = await call('audit.tail', { n: v.lines || 20 })
    if (v.json) return json(r)
    print(r.entries.map((/** @type {any} */ e) => `${e.ts.slice(0, 19).replace('T', ' ')} ${String(e.agent).padEnd(11)} ${String(e.op).padEnd(14)} ${e.host || ''} ${e.cmd ? JSON.stringify(e.cmd) : ''}${e.exit !== undefined ? ` exit ${e.exit}` : ''}`).join('\n') || 'nothing yet')
  },

  async daemon(args) {
    const { p } = parse(args)
    const sub = p[0] || 'status'
    if (sub === 'run') return (await import('./daemon.mjs')).runDaemon().then(() => new Promise(() => {}))
    if (sub === 'start') { const c = await DaemonClient.connect(); const r = await c.request('ping'); c.close(); return print(`running: pid ${r.pid}, version ${r.version}`) }
    if (sub === 'status') {
      try {
        const c = await DaemonClient.connect({ autostart: false })
        const r = await c.request('ping')
        c.close()
        const conns = Object.entries(r.connections).map(([n, x]) => `${n}(${/** @type {any} */ (x).state})`).join(' ') || 'none'
        return print(`running: pid ${r.pid} · version ${r.version} · up ${Math.round(r.uptimeMs / 1000)}s · connections: ${conns} · home ${home()}`)
      } catch (e) {
        if (/** @type {any} */ (e).code === 'NO_DAEMON') { print(`not running (starts automatically on first use) · home ${home()}`); return 1 }
        throw e
      }
    }
    if (sub === 'stop' || sub === 'restart') {
      try {
        const c = await DaemonClient.connect({ autostart: false })
        await c.request('shutdown')
        c.close()
        await waitDaemonGone()
      } catch (e) {
        if (/** @type {any} */ (e).code !== 'NO_DAEMON') throw e
      }
      if (sub === 'restart') { startDaemon(); return VERBS.daemon(['start']) }
      return print('stopped')
    }
    throw new UsageError(HELP.daemon)
  },

  async skills(args) {
    const { v, p } = parse(args, { dir: { type: 'string' } })
    if (p[0] !== 'install') throw new UsageError(HELP.skills)
    const dir = resolve(v.dir || join(homedir(), '.agents', 'skills'))
    mkdirSync(dir, { recursive: true })
    const names = readdirSync(join(ROOT, 'skills'))
    for (const n of names) cpSync(join(ROOT, 'skills', n), join(dir, n), { recursive: true })
    print(`installed ${names.length} skills into ${dir}: ${names.join(', ')}`)
  },

  async mcp() {
    await (await import('./mcp.mjs')).runMcp()
    return new Promise(() => {})
  },
}

async function waitDaemonGone() {
  for (let i = 0; i < 100; i++) {
    try { const c = await DaemonClient.connect({ autostart: false }); c.close() } catch { return }
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ---- output ----

const print = (/** @type {string} */ s) => { process.stdout.write(s + '\n') }
/** @param {any[]} list @param {{raw?: boolean}} [o] */
function results(list, o = {}) {
  const { text, code } = formatResults(list, o)
  process.stdout.write(text)
  return code
}
function json(/** @type {any} */ r, /** @type {any[]} */ list) {
  print(JSON.stringify(r, null, 2))
  return list ? worst(list) : 0
}
const splitTags = (/** @type {string[]|undefined} */ t) => (t || []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)

// ---- input ----

/**
 * Git Bash (MSYS) rewrites POSIX-looking arguments before we see them: "/etc/x" arrives as
 * "C:/Program Files/Git/etc/x", "/tmp/x" as the Windows temp dir, "/c/x" as "C:/x". Arguments meant for the
 * server get that undone; local paths (put source, --script, --key) keep the conversion, which is what we want there.
 */
const MSYS = process.platform === 'win32' && process.env.MSYSTEM ? msysPrefixes() : null
function msysPrefixes() {
  const roots = new Set()
  if (process.env.EXEPATH) roots.add(dirname(process.env.EXEPATH))
  const usrBin = /[\\/]usr[\\/]bin[\\/]?$/i
  for (const d of (process.env.PATH || '').split(';')) if (usrBin.test(d)) roots.add(d.replace(usrBin, ''))
  const norm = (/** @type {string} */ p) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() + '/'
  /** @type {[string, string][]} */
  const out = [...roots].map((r) => [norm(r), '/'])
  if (process.env.TEMP) out.push([norm(process.env.TEMP), '/tmp/'])
  return out
}
/** @template {string|undefined} T @param {T} s @returns {T} */
function remote(s) {
  if (!MSYS || typeof s !== 'string') return s
  const f = s.replace(/\\/g, '/')
  const low = f.toLowerCase()
  for (const [from, to] of MSYS) {
    if (low.startsWith(from)) return /** @type {T} */ (to + f.slice(from.length))
    if (low === from.slice(0, -1)) return /** @type {T} */ (to.length > 1 ? to.slice(0, -1) : to)
  }
  const drive = /^([A-Za-z]):\/(.*)$/.exec(f)
  return /** @type {T} */ (drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : s)
}

async function readStdin() {
  if (process.stdin.isTTY) throw new UsageError('expected input on stdin')
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function readScript(/** @type {string} */ src) {
  if (src === '-' || src === '') return readStdin()
  if (!existsSync(src)) throw new UsageError(`no such script file: ${src}`)
  return readFileSync(src, 'utf8')
}

/** Prompt without echo (for humans running `add --ask` in their own terminal). */
function askHidden(/** @type {string} */ prompt) {
  if (!process.stdin.isTTY) throw new UsageError('--ask needs a terminal; agents should use --password-stdin')
  return new Promise((res) => {
    process.stderr.write(prompt)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    let pw = ''
    stdin.on('data', function onData(/** @type {Buffer} */ d) {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); return res(pw) }
        if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') pw = pw.slice(0, -1)
        else pw += ch
      }
    })
  })
}

export function exitCodeFor(/** @type {any} */ e) {
  return EXIT[/** @type {keyof EXIT} */ (e?.code)] ?? 1
}
