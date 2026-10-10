// @ts-check
// One SSH connection per server, kept open and shared by every caller of the daemon.
// Commands open a channel on it instead of paying a new handshake each time.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import * as inventory from './inventory.mjs'
import * as hostkeys from './hostkeys.mjs'
import { getSecret } from './secrets.mjs'
import { file, sshDir } from './paths.mjs'
import { SuError, keyType, fingerprint, expandPath, readSmall, realPath, keyFailure, KEY_MAX } from './util.mjs'

const { Client, utils } = ssh2

export const PER_HOST = 8 // sshd MaxSessions defaults to 10; leave room
const IDLE_MS = Number(process.env.SERVER_USE_IDLE_MS || 30 * 60_000)
const READY_TIMEOUT = Number(process.env.SERVER_USE_CONNECT_TIMEOUT_MS || 15_000)
// Host key algorithms ssh2 supports, in its preference order. connect() offers the types already on file first
// (like OpenSSH), so a server that also has a key of another type doesn't look changed, and one that lost the
// pinned type presents another and fails as HOSTKEY_CHANGED, not as a handshake error.
// rsa-sha2-* are signatures made with the same ssh-rsa key; ssh-dss only when pinned (ssh2's defaults omit it).
const HOSTKEY_ALGS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss']
const algsFor = (/** @type {string[]} */ types) => HOSTKEY_ALGS.filter((a) => types.includes(a.startsWith('rsa-sha2-') ? 'ssh-rsa' : a))

/**
 * @typedef {{client: import('ssh2').Client, name: string, key: string, state: string, since: number,
 *   lastUsed: number, active: number, queue: (() => void)[], cap?: number, sudo?: string, hostStatus?: object}} Conn
 */

export class Pool {
  /** @type {Map<string, Conn>} */ conns = new Map()
  /** @type {Map<string, Promise<Conn>>} */ connecting = new Map()

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  /** Connection identity: reconnect when the inventory entry changed. */
  static key(/** @type {inventory.Server} */ s) {
    return `${s.user}@${s.host}:${s.port || 22}`
  }

  /** @returns {Promise<Conn>} */
  async get(/** @type {string} */ name) {
    const server = inventory.get(name)
    const key = Pool.key(server)
    const c = this.conns.get(name)
    if (c && c.state === 'ready' && c.key === key) return c
    if (c) this.drop(name)
    let p = this.connecting.get(name)
    if (!p) {
      p = connect(server).then((client) => {
        const conn = { client, name, key, state: 'ready', since: Date.now(), lastUsed: Date.now(), active: 0, queue: [] }
        client.on('close', () => { if (this.conns.get(name) === conn) { conn.state = 'closed'; this.conns.delete(name) } })
        client.on('error', () => { /* 'close' follows */ })
        this.conns.set(name, conn)
        return conn
      }).finally(() => this.connecting.delete(name))
      this.connecting.set(name, p)
    }
    return p
  }

  /**
   * Run fn with a channel slot on the server's connection. Retries once on a fresh connection if the
   * channel could not even be opened (dead connection not yet noticed) — nothing ran, so that is safe.
   * @template T
   * @param {string} name
   * @param {(conn: Conn) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async with(name, fn) {
    let retried = false
    for (;;) {
      const conn = await this.get(name)
      await acquire(conn)
      try {
        if (conn.state !== 'ready') continue // dropped while we queued for a slot
        return await fn(conn)
      } catch (err) {
        const e = /** @type {any} */ (err)
        // The server refused the channel (sshd MaxSessions below PER_HOST; a refusal carries a reason, a dead
        // connection doesn't). The connection is fine: wait for a slot on it instead of dropping it under the others.
        if ((e.channelRefused || (e.channelOpenFailed && e.reason != null)) && conn.active > 1) { conn.cap = conn.active - 1; continue }
        if (!retried && e.channelOpenFailed) {
          retried = true
          if (this.conns.get(name) === conn) this.drop(name)
          continue
        }
        throw err
      } finally {
        release(conn)
      }
    }
  }

  /** Take over an already authenticated client (used by `add`, so the first command needs no new handshake). */
  adopt(/** @type {string} */ name, /** @type {import('ssh2').Client} */ client) {
    this.drop(name)
    const server = inventory.get(name)
    const conn = { client, name, key: Pool.key(server), state: 'ready', since: Date.now(), lastUsed: Date.now(), active: 0, queue: [] }
    client.on('close', () => { if (this.conns.get(name) === conn) { conn.state = 'closed'; this.conns.delete(name) } })
    client.on('error', () => { /* 'close' follows */ })
    this.conns.set(name, conn)
  }

  drop(/** @type {string} */ name) {
    const c = this.conns.get(name)
    if (!c) return
    this.conns.delete(name)
    c.state = 'closed'
    c.client.end()
  }

  closeAll() {
    clearInterval(this.sweeper)
    for (const name of [...this.conns.keys()]) this.drop(name)
  }

  sweep() {
    const now = Date.now()
    for (const [name, c] of this.conns) if (c.active === 0 && now - c.lastUsed > IDLE_MS) this.drop(name)
  }

  states() {
    /** @type {Record<string, {state: string, since?: number, lastUsed?: number, active?: number}>} */
    const out = {}
    for (const [name, c] of this.conns) out[name] = { state: c.state, since: c.since, lastUsed: c.lastUsed, active: c.active }
    for (const name of this.connecting.keys()) out[name] = { state: 'connecting' }
    return out
  }
}

function acquire(/** @type {Conn} */ c) {
  c.lastUsed = Date.now()
  if (c.active < (c.cap ?? PER_HOST)) { c.active++; return Promise.resolve() }
  return new Promise((res) => c.queue.push(() => { c.active++; res(undefined) }))
}
function release(/** @type {Conn} */ c) {
  c.active--
  c.lastUsed = Date.now()
  if (c.active < (c.cap ?? PER_HOST)) c.queue.shift()?.()
}

/**
 * Open and authenticate one SSH connection.
 * @param {inventory.Server & {name: string}} server
 * @param {{password?: string, passphrase?: string, keyOnly?: boolean}} [opts] password and passphrase override the
 *   stored ones (used by `add`); keyOnly proves key login works without any password (used before locking password login).
 * @returns {Promise<import('ssh2').Client & {hostkey: any, authMethod?: string, proven: string[]}>} proven fills in
 *   after login with the fingerprints of all host keys an OpenSSH server proves it holds on this very connection
 *   (signed with this session's id, so a forwarder can't fake them; other servers announce none).
 */
export function connect(server, opts = {}) {
  const port = server.port || 22
  const types = hostkeys.knownTypes(server.host, port)
  const pinned = algsFor(types)
  const serverHostKey = pinned.length ? [...pinned, ...HOSTKEY_ALGS.filter((a) => a !== 'ssh-dss' && !pinned.includes(a))] : []
  return new Promise((resolve, reject) => {
    const { attempts, skipped } = authAttempts(server, opts)
    const client = new Client()
    /** @type {any} */ let host
    /** @type {string[]} */ const tried = []
    /** @type {string[]} */ const proven = []
    client.on('hostkeys', (/** @type {any[]} */ keys) => { for (const k of keys) proven.push(fingerprint(k.getPublicSSH())) })
    client.on('ready', () => {
      client.setNoDelay(true)
      resolve(Object.assign(client, { hostkey: host, authMethod: tried.at(-1), proven }))
    })
    client.on('error', (err) => reject(classify(err, server, host, tried, skipped)))
    client.connect({
      host: server.host,
      port,
      username: server.user,
      readyTimeout: READY_TIMEOUT,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      ...(serverHostKey.length ? { algorithms: { serverHostKey } } : {}),
      hostVerifier: (/** @type {Buffer} */ blob) => {
        host = { ...hostkeys.verify(server.host, port, blob), type: keyType(blob) }
        return host.ok
      },
      authHandler: (/** @type {string[]|null} */ methodsLeft, /** @type {boolean|null} */ _partial, /** @type {Function} */ next) => {
        while (attempts.length) {
          const a = attempts.shift()
          const method = a.type === 'agent' ? 'publickey' : a.type
          if (methodsLeft && !methodsLeft.includes(method)) continue
          tried.push(a.label)
          return next(a.method)
        }
        return next(false)
      },
    })
  })
}

/**
 * Ordered auth attempts: the explicit key, server-use's own key, the ssh-agent, then the default ~/.ssh keys (the agent
 * goes first so the files do not burn MaxAuthTries when it holds the right key), then the password. Password servers
 * try the password first. `skipped` lists the keys that exist but cannot be used (an explicit key also when missing),
 * so a failed login can say why instead of just "tried".
 * @param {inventory.Server & {name: string}} server
 * @param {{password?: string, passphrase?: string, keyOnly?: boolean}} opts
 */
export function authAttempts(server, opts) {
  const username = server.user
  const passphrase = opts.passphrase ?? getSecret(server.name, 'passphrase')
  /** @type {{type: string, label: string, method: object}[]} */
  const keys = []
  /** @type {{path: string, reason: string, explicit: boolean}[]} */
  const skipped = []
  const seen = new Set()
  const addKey = (/** @type {string} */ path, /** @type {boolean} */ explicit) => {
    const r = readSmall(path, KEY_MAX)
    if (!r.buf) {
      if (explicit) skipped.push({ path, reason: String(r.reason), explicit })
      return
    }
    const real = realPath(path)
    if (seen.has(real)) return
    seen.add(real)
    const parsed = utils.parseKey(r.buf, passphrase)
    const key = Array.isArray(parsed) ? parsed[0] : parsed
    const why = key instanceof Error ? keyFailure(key) : !key ? 'unreadable' : key.isPrivateKey() ? '' : 'not a private key'
    if (why) skipped.push({ path, reason: why, explicit })
    // the parsed key goes to ssh2 as is: an encrypted key is not decrypted (bcrypt) a second time
    else keys.push({ type: 'publickey', label: path, method: { type: 'publickey', username, key } })
  }
  if (server.key) addKey(expandPath(server.key), true)
  addKey(file('id_ed25519'), false)
  const agent = agentPath()
  if (agent) keys.push({ type: 'agent', label: 'ssh-agent', method: { type: 'agent', username, agent } })
  for (const n of ['id_ed25519', 'id_ecdsa', 'id_rsa']) addKey(join(sshDir(), n), false)
  if (opts.keyOnly) return { attempts: keys, skipped }
  const password = opts.password ?? getSecret(server.name, 'password')
  const pw = password === undefined ? [] : [
    { type: 'password', label: 'password', method: { type: 'password', username, password } },
    {
      type: 'keyboard-interactive', label: 'keyboard-interactive', method: {
        type: 'keyboard-interactive', username,
        prompt: (/** @type {any} */ _n, /** @type {any} */ _i, /** @type {any} */ _l, /** @type {{prompt: string}[]} */ prompts, /** @type {Function} */ finish) => finish(prompts.map(() => password)),
      },
    },
  ]
  return { attempts: server.auth === 'password' ? [...pw, ...keys] : [...keys, ...pw], skipped }
}

/** The ssh-agent to ask: SSH_AUTH_SOCK, else the Windows OpenSSH agent pipe; undefined when there is none. */
export function agentPath() {
  if ('SSH_AUTH_SOCK' in process.env) return process.env.SSH_AUTH_SOCK || undefined // explicit "" disables the agent
  if (process.platform === 'win32' && existsSync(String.raw`\\.\pipe\openssh-ssh-agent`)) return String.raw`\\.\pipe\openssh-ssh-agent`
  return undefined
}

function classify(/** @type {any} */ err, /** @type {inventory.Server & {name: string}} */ server, /** @type {any} */ host, /** @type {string[]} */ tried, /** @type {{path: string, reason: string, explicit: boolean}[]} */ skipped) {
  const where = `${server.name} (${server.user}@${server.host}:${server.port || 22})`
  if (host && !host.ok) {
    // trust --reset forgets the inventory address of the name, so it only helps when that is the address that failed
    // (not for `add` of a new name or of another address).
    const s = inventory.load()[server.name]
    const reset = s && s.host === server.host && (s.port || 22) === (server.port || 22)
      ? `run: server-use trust ${server.name} --reset` : hostkeys.forgetHint(server.host, server.port || 22)
    return new SuError('HOSTKEY_CHANGED',
      `HOST KEY CHANGED for ${where}: expected ${host.expected}, got ${host.fingerprint}. ` +
      `Possible man-in-the-middle or a reinstalled server. Ask the user; only they may ${reset}`,
      { expected: host.expected, got: host.fingerprint })
  }
  if (err.level === 'client-authentication') {
    // An encrypted key we could not open is the likely reason, unless a password was tried too (then it is merely one
    // of several unused default keys): say so, so the caller can ask for the passphrase instead of giving up.
    const need = skipped.find((s) => s.explicit && ['encrypted', 'bad passphrase'].includes(s.reason))
      ?? (tried.includes('password') ? undefined : skipped.find((s) => s.reason === 'encrypted'))
    if (need) {
      const port = server.port || 22
      const fix = inventory.load()[server.name] ? `server-use set ${server.name} passphrase --stdin`
        : `server-use add ${server.name} ${server.user}@${server.host}${port === 22 ? '' : ':' + port}${need.explicit ? ` --key ${need.path}` : ''} --ask-passphrase`
      return new SuError('PASSPHRASE_REQUIRED',
        `authentication failed for ${where}: key ${need.path} ${need.reason === 'encrypted' ? 'is passphrase-protected' : 'is protected by another passphrase than the one given'}: ssh-add it, or store the passphrase (${fix})`,
        { key: need.path })
    }
    const why = skipped.length ? `; skipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}` : ''
    return new SuError('AUTH', `authentication failed for ${where} (tried: ${tried.join(', ') || 'nothing — no key, agent or password available'}${why})`)
  }
  if (err.level === 'client-timeout' || /timed out/i.test(err.message)) return new SuError('UNREACHABLE', `${where}: connection timed out`)
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(err.code)) {
    return new SuError('UNREACHABLE', `${where}: ${err.code}`)
  }
  return new SuError('UNREACHABLE', `${where}: ${err.message}`)
}
