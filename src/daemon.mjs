// @ts-check
// The background daemon: one per user, holds the SSH connection pool and serves NDJSON requests on a
// named pipe (Windows) or Unix socket. Daemon and client prove to each other that they know the token in daemon.token.
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, statSync, rmSync, openSync, closeSync } from 'node:fs'
import { file, ensureHome, socketPath, VERSION } from './paths.mjs'
import { PROTOCOL, mac, proves } from './client.mjs'
import { Pool } from './pool.mjs'
import { tail } from './audit.mjs'
import * as exec from './ops/exec.mjs'
import * as servers from './ops/servers.mjs'
import * as transfer from './ops/transfer.mjs'
import * as scripts from './ops/scripts.mjs'

const IDLE_EXIT_MS = Number(process.env.SERVER_USE_DAEMON_IDLE_MS || 12 * 3_600_000)
const MAX_LINE = 32 * 1024 * 1024

/** @type {Record<string, (ctx: any, args: any) => any>} */
const OPS = {
  ping: (ctx) => ({ version: VERSION, protocol: PROTOCOL, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000), connections: ctx.pool.states() }),
  'servers.list': servers.list,
  'servers.show': servers.show,
  'servers.add': servers.add,
  'servers.set': servers.set,
  'servers.rm': servers.rm,
  'servers.import': servers.importSshConfig,
  'trust.reset': servers.trustReset,
  facts: servers.refreshFacts,
  notes: servers.notes,
  exec: exec.exec,
  put: transfer.put,
  get: transfer.get,
  status: scripts.status,
  logs: scripts.logs,
  job: scripts.job,
  cron: scripts.cron,
  env: scripts.env,
  deploy: scripts.deploy,
  harden: scripts.harden,
  'audit.tail': (_ctx, a) => ({ entries: tail(Number(a?.n || 20)) }),
  disconnect: (ctx, a) => { ctx.pool.drop(a.name); return { dropped: a.name } },
}

/** Newer client version → this daemon should make way. */
function newer(/** @type {string} */ a, /** @type {string} */ b) {
  const pa = String(a).split(/[.-]/).map(Number)
  const pb = String(b).split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

function pidAlive(/** @type {number} */ pid) {
  try { process.kill(pid, 0); return true } catch (e) { return /** @type {any} */ (e).code === 'EPERM' }
}

/** Single-instance lock. Returns false when another live daemon holds it. */
export function takeLock() {
  const lock = file('daemon.lock')
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e
      let pid, age
      try {
        pid = Number(readFileSync(lock, 'utf8').trim())
        age = Date.now() - statSync(lock).mtimeMs
      } catch (err) {
        if (/** @type {any} */ (err).code === 'ENOENT') continue // released meanwhile
        throw err
      }
      // Empty: the holder is between open and write, unless it died there (then the lock is old).
      if (!pid && age < 5_000) return false
      if (pid && pid !== process.pid && pidAlive(pid)) return false
      rmSync(lock, { force: true })
    }
  }
  return false
}

/** Is a daemon listening? (On Windows this blocks while a closed one still drains its connections.) */
const serving = () => new Promise((resolve) => {
  const s = net.connect(socketPath())
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})

function cleanRuns() {
  const dir = file('runs')
  if (!existsSync(dir)) return
  const cutoff = Date.now() - 7 * 86_400_000
  for (const d of readdirSync(dir)) {
    const p = file('runs', d)
    try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

let seq = 0
const runId = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + (++seq).toString(36) + randomBytes(2).toString('hex')

export async function runDaemon() {
  ensureHome()
  // A previous daemon may still be draining (restart, version switch; capped at 10 s): wait for its lock instead of
  // quitting, or the client that started us finds no daemon. Give up as soon as another daemon serves.
  let locked = takeLock()
  for (const end = Date.now() + 15_000; !locked && Date.now() < end && !(await serving()); locked = takeLock()) await new Promise((r) => setTimeout(r, 200))
  if (!locked) {
    console.error(`[${new Date().toISOString()}] another daemon is running; exiting`)
    return
  }
  const tokenFile = file('daemon.token')
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 })
  const token = Buffer.from(readFileSync(tokenFile, 'utf8').trim())
  cleanRuns()

  const pool = new Pool()
  const sockets = new Set()
  let active = 0
  let lastActivity = Date.now()
  let stopping = false

  const sock = socketPath()
  if (process.platform !== 'win32' && existsSync(sock)) unlinkSync(sock) // we hold the lock, so it is stale

  const server = net.createServer((conn) => {
    sockets.add(conn)
    const abort = new AbortController()
    let authed = false
    /** @type {any} */ let hello = null
    let nonce = ''
    let agent = 'cli'
    let buf = ''
    const send = (/** @type {object} */ m) => { if (!conn.destroyed) conn.write(JSON.stringify(m) + '\n') }
    const helloTimer = setTimeout(() => { if (!authed) conn.destroy() }, 5000)
    conn.on('close', () => { sockets.delete(conn); abort.abort(); clearTimeout(helloTimer) })
    conn.on('error', () => { /* close follows */ })
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => {
      buf += chunk
      if (buf.length > MAX_LINE) return conn.destroy()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) handle(line)
      }
    })

    async function handle(/** @type {string} */ line) {
      /** @type {any} */ let msg
      try { msg = JSON.parse(line) } catch { return conn.destroy() }
      if (!authed) {
        // hello → our proof over the client's nonce plus a nonce of ours → the client's proof over it (once per connection)
        if (msg?.t === 'hello' && !hello) {
          hello = msg
          nonce = randomBytes(16).toString('hex')
          return send({ t: 'challenge', proof: mac(token, 'daemon', String(msg.nonce)), nonce })
        }
        if (!hello || msg?.t !== 'auth' || !proves(token, 'client', nonce, msg.mac)) return conn.destroy()
        authed = true
        clearTimeout(helloTimer)
        agent = String(hello.agent || 'cli').slice(0, 40)
        // Only switch while idle, so running work (a deploy) is never cut off. Until then a same-protocol client
        // is served here; one of another protocol is turned away and retries.
        const compatible = hello.protocol === PROTOCOL
        const restart = active === 0 && (!compatible || newer(hello.version, VERSION))
        send({ t: 'hello', ok: compatible && !restart, version: VERSION, protocol: PROTOCOL, pid: process.pid, restart })
        if (restart) stop(`client ${hello.version} (protocol ${hello.protocol}) replaces daemon ${VERSION}`)
        return
      }
      if (msg.t !== 'req') return
      const fn = OPS[msg.op]
      if (!fn) return send({ t: 'res', id: msg.id, ok: false, error: { code: 'USAGE', message: `unknown op "${msg.op}"` } })
      if (stopping) return send({ t: 'res', id: msg.id, ok: false, error: { code: 'RESTARTING', message: 'daemon is restarting, retry' } })
      active++
      lastActivity = Date.now()
      try {
        const result = await fn({ pool, agent, signal: abort.signal, runId: runId() }, msg.args || {})
        send({ t: 'res', id: msg.id, ok: true, result })
      } catch (e) {
        const err = /** @type {any} */ (e)
        if (!err.code || err.code === 'ERR_INTERNAL') console.error(err)
        send({ t: 'res', id: msg.id, ok: false, error: { code: err.code && /^[A-Z_]+$/.test(err.code) ? err.code : 'INTERNAL', message: err.message, ...(err.extra || {}) } })
      } finally {
        active--
        lastActivity = Date.now()
      }
      if (msg.op === 'shutdown') stop('shutdown requested')
    }
  })
  OPS.shutdown = () => ({ stopping: true, pid: process.pid })

  function stop(/** @type {string} */ why) {
    if (stopping) return
    stopping = true
    console.error(`[${new Date().toISOString()}] stopping: ${why}`)
    server.close()
    const finish = () => {
      pool.closeAll()
      for (const s of sockets) /** @type {net.Socket} */ (s).destroy()
      // socket first: once the lock is gone, a successor may already be listening on that path
      if (process.platform !== 'win32') try { unlinkSync(sock) } catch { /* ignore */ }
      try { rmSync(file('daemon.lock'), { force: true }) } catch { /* ignore */ }
      process.exit(0)
    }
    const wait = setInterval(() => { if (active === 0) { clearInterval(wait); finish() } }, 50)
    setTimeout(finish, 10_000).unref()
  }

  const idle = setInterval(() => { if (active === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) stop('idle') }, 60_000)
  idle.unref()
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('uncaughtException', (e) => console.error(`[${new Date().toISOString()}] uncaught`, e))

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sock, () => resolve(undefined))
  }).catch((e) => {
    rmSync(file('daemon.lock'), { force: true })
    throw e
  })
  console.error(`[${new Date().toISOString()}] server-use daemon ${VERSION} pid ${process.pid} on ${sock}`)
}
