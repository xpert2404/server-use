// @ts-check
// Talks to the daemon, starting it when needed. Loads only node built-ins so the CLI starts fast.
// Also the public API for integrations (MCP adapter, NEXUS Harness): `import { DaemonClient } from 'server-use'`.
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, existsSync, openSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { file, home, socketPath, VERSION, ROOT } from './paths.mjs'
import { detectAgent, SuError } from './util.mjs'

export const PROTOCOL = 2
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))
const connectionClosed = () => new SuError('INTERNAL', 'daemon connection closed')

// Handshake proofs: HMAC with the daemon token over the peer's nonce. The label keeps a daemon proof from being
// replayed as a client proof. The token itself never goes over the pipe.
export const mac = (/** @type {string | Buffer} */ token, /** @type {string} */ label, /** @type {string} */ nonce) =>
  createHmac('sha256', token).update(`${label}:${nonce}`).digest('hex')
export function proves(/** @type {string | Buffer} */ token, /** @type {string} */ label, /** @type {string} */ nonce, /** @type {unknown} */ got) {
  const want = Buffer.from(mac(token, label, nonce))
  const g = Buffer.from(String(got ?? ''))
  return g.length === want.length && timingSafeEqual(g, want)
}

export class DaemonClient {
  /** @param {net.Socket} sock */
  constructor(sock) {
    this.sock = sock
    this.seq = 0
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map()
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new SuError(msg.error?.code || 'INTERNAL', msg.error?.message || 'daemon error', msg.error))
      }
    })
    sock.on('error', () => this.#disconnect())
    sock.on('close', () => this.#disconnect())
  }

  #disconnect() {
    const error = connectionClosed()
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
    this.sock.destroy()
  }

  /**
   * Connect to the daemon (starting it if needed) and authenticate.
   * @param {{agent?: string, autostart?: boolean}} [o]
   */
  static async connect({ agent = detectAgent(), autostart = true } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let sock = await tryConnect()
      if (!sock) {
        if (!autostart) throw new SuError('NO_DAEMON', 'daemon is not running')
        startDaemon()
        // long enough for a previous daemon to drain (up to 10 s) before the new one gets the lock
        sock = await waitConnect(20_000)
        if (!sock) throw new SuError('INTERNAL', `daemon did not start — see ${file('daemon.log')}`)
      }
      let hello
      try { hello = await handshake(sock, agent) } catch (e) { sock.destroy(); throw e }
      if (hello.ok) return new DaemonClient(sock)
      sock.destroy()
      // An older daemon is making way for us (or is busy and will once idle): wait until it is gone, then start ours.
      await waitGone(10_000)
    }
    // A daemon of an older protocol can't be asked to step aside; name its pid so the user can stop it.
    let pid = ''
    try { pid = readFileSync(file('daemon.lock'), 'utf8').trim() } catch { /* no lock */ }
    const stop = pid ? ` (pid ${pid}: stop it with ${process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`} and retry)` : ''
    throw new SuError('INTERNAL', `could not get a matching daemon: one of another version or protocol is running${stop}`)
  }

  /** @returns {Promise<any>} */
  request(/** @type {string} */ op, /** @type {object} */ args = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      if (this.sock.destroyed || !this.sock.writable) return reject(connectionClosed())
      // Serialize before registering: invalid/circular arguments must not leave a pending request behind.
      const text = JSON.stringify({ t: 'req', id, op, args }) + '\n'
      this.pending.set(id, { resolve, reject })
      try {
        this.sock.write(text, (error) => { if (error) this.#disconnect() })
      } catch { this.#disconnect() }
    })
  }

  close() {
    // destroy, not end(): all responses are in, and a graceful pipe shutdown costs ~50 ms on Windows
    this.sock.destroy()
  }
}

/** One request on a fresh connection. */
export async function call(/** @type {string} */ op, /** @type {object} */ args = {}, /** @type {{agent?: string, autostart?: boolean}} */ o = {}) {
  const c = await DaemonClient.connect(o)
  try {
    return await c.request(op, args)
  } finally {
    c.close()
  }
}

/** @returns {Promise<net.Socket | null>} */
function tryConnect() {
  return new Promise((resolve) => {
    const s = net.connect(socketPath())
    s.once('connect', () => resolve(s))
    // Keep a listener across connect/handshake/client handoffs: a peer can close in any of those gaps.
    s.on('error', () => { s.destroy(); resolve(null) })
  })
}

async function waitConnect(/** @type {number} */ ms) {
  const end = Date.now() + ms
  for (let d = 20; Date.now() < end; d = Math.min(d * 2, 200)) {
    const s = await tryConnect()
    if (s && existsSync(file('daemon.token'))) return s
    s?.destroy()
    await sleep(d)
  }
  return null
}

async function waitGone(/** @type {number} */ ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const s = await tryConnect()
    if (!s) return
    s.destroy()
    await sleep(100)
  }
}

/**
 * Mutual auth. Anyone can listen on a pipe name (or a socket in /tmp) first, so the daemon must prove it holds the
 * token before we send our proof or any request (which can carry passwords).
 * @returns {Promise<{ok: boolean, restart?: boolean, version: string}>}
 */
function handshake(/** @type {net.Socket} */ sock, /** @type {string} */ agent) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let challenged = false
    let settled = false
    const token = readFileSync(file('daemon.token'), 'utf8').trim()
    const nonce = randomBytes(16).toString('hex')
    const done = () => { sock.off('data', onData); sock.off('error', onError); sock.off('close', onClose); clearTimeout(timer) }
    const finish = (/** @type {unknown} */ error, /** @type {any} */ result) => {
      if (settled) return
      settled = true
      done()
      if (error) reject(error)
      else resolve(result)
    }
    const onError = () => { finish(connectionClosed(), undefined); sock.destroy() }
    const onClose = () => finish(connectionClosed(), undefined)
    const write = (/** @type {object} */ msg) => {
      try { sock.write(JSON.stringify(msg) + '\n', (error) => { if (error) onError() }) } catch { onError() }
    }
    const onData = (/** @type {Buffer} */ d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        /** @type {any} */ let msg
        try { msg = JSON.parse(buf.slice(0, i)) } catch (e) { finish(e, undefined); sock.destroy(); return }
        buf = buf.slice(i + 1)
        if (challenged) { finish(undefined, msg); return }
        if (msg?.t !== 'challenge' || !proves(token, 'daemon', nonce, msg.proof)) {
          finish(new SuError('INTERNAL', `daemon identity check failed: whatever listens on ${socketPath()} does not know the token in ${file('daemon.token')} (another user squatting it?)`), undefined)
          sock.destroy()
          return
        }
        challenged = true
        write({ t: 'auth', mac: mac(token, 'client', String(msg.nonce)) })
      }
    }
    const timer = setTimeout(() => { finish(new SuError('INTERNAL', 'daemon handshake timed out'), undefined); sock.destroy() }, 5000)
    sock.on('data', onData)
    sock.on('error', onError)
    sock.once('close', onClose)
    write({ t: 'hello', nonce, version: VERSION, protocol: PROTOCOL, agent })
  })
}

/** Start the daemon detached, logging to daemon.log. */
export function startDaemon() {
  mkdirSync(home(), { recursive: true, mode: 0o700 })
  const log = openSync(file('daemon.log'), 'a', 0o600)
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'server-use.mjs'), 'daemon', 'run'], {
    detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env,
  })
  child.unref()
}
