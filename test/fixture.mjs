// An in-process SSH server that plays "the remote server" in the local tests: password and publickey auth
// (authorized_keys is re-read on every attempt), exec requests run as `sh -c <command>` with HOME and cwd set to
// a temp dir, exit codes and signals are passed back. Git Bash's sh on Windows, /bin/sh elsewhere.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const WIN = process.platform === 'win32'
const METHODS = ['publickey', 'password']

/** The shell exec requests run in; undefined when there is none (the integration tests then skip). */
export const SH = findSh()
function findSh() {
  if (process.env.SU_TEST_SH) return process.env.SU_TEST_SH
  if (!WIN) return '/bin/sh'
  // Git\cmd or Git\bin on PATH → Git\usr\bin\sh.exe (the real one, next to cat, awk, ...)
  const dirs = (process.env.PATH || '').split(';').filter(Boolean)
  return [...dirs.flatMap((d) => [join(d, '..', 'usr', 'bin', 'sh.exe'), join(d, 'sh.exe')]), String.raw`C:\Program Files\Git\usr\bin\sh.exe`]
    .find(existsSync)
}

export const newHostKey = () => utils.generateKeyPairSync('ed25519').private

/**
 * Start a fixture server on 127.0.0.1. `password = null` refuses password logins.
 * @param {{user?: string, password?: string | null, hostKey?: string, port?: number}} [o]
 */
export async function startFixture(o = {}) {
  const fx = new Fixture(o)
  await fx.listen(o.port || 0)
  return fx
}

class Fixture {
  /** @param {{user?: string, password?: string | null, hostKey?: string}} o */
  constructor({ user = 'tester', password = null, hostKey = newHostKey() }) {
    this.user = user
    this.password = password
    this.hostKey = hostKey
    this.home = mkdtempSync(join(tmpdir(), 'su fx-'))
    this.port = 0
    /** SSH connections accepted so far (each one is a full handshake). */
    this.handshakes = 0
    /** @type {Set<any>} */ this.clients = new Set()
    /** @type {Set<import('node:child_process').ChildProcess>} */ this.children = new Set()
    /** @type {any} */ this.server = null
    // Windows: only Git's tools on PATH, so System32 (sudo.exe, find.exe, ...) cannot shadow the POSIX ones.
    this.env = WIN
      ? { PATH: [dirname(SH), join(dirname(SH), '..', '..', 'mingw64', 'bin')].join(';'), HOME: this.home, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP }
      : { PATH: process.env.PATH, HOME: this.home }
  }

  /** @param {number} port */
  listen(port) {
    this.server = new Server({ hostKeys: [this.hostKey] }, (client) => this.accept(client))
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve(undefined)
      })
    })
  }

  /** Drop every connection and listen again on the same port, optionally with another host key. */
  async restart(/** @type {{hostKey?: string}} */ o = {}) {
    await this.stop()
    if (o.hostKey) this.hostKey = o.hostKey
    await this.listen(this.port)
  }

  async close() {
    await this.stop()
    rmSync(this.home, { recursive: true, force: true })
  }

  async stop() {
    for (const c of this.children) kill(c)
    for (const c of this.clients) c.end()
    await new Promise((r) => this.server.close(r))
  }

  accept(/** @type {any} */ client) {
    this.handshakes++
    this.clients.add(client)
    client.on('close', () => this.clients.delete(client))
    client.on('error', () => { /* close follows */ })
    client.on('authentication', (/** @type {any} */ ctx) => {
      if (ctx.username !== this.user) return ctx.reject(METHODS)
      if (ctx.method === 'password' && this.password !== null && ctx.password === this.password) return ctx.accept()
      if (ctx.method === 'publickey' && this.authorized(ctx)) return ctx.accept()
      ctx.reject(METHODS)
    })
    client.on('ready', () => client.on('session', (/** @type {any} */ acceptSession) => {
      const session = acceptSession()
      /** @type {import('node:child_process').ChildProcess | undefined} */ let child
      session.on('signal', (/** @type {any} */ ok, /** @type {any} */ _no, /** @type {{name: string}} */ info) => {
        ok?.()
        if (child) kill(child, info.name)
      })
      session.once('exec', (/** @type {any} */ ok, /** @type {any} */ _no, /** @type {{command: string}} */ info) => {
        const stream = ok()
        child = this.run(stream, info.command)
      })
    }))
  }

  /** Publickey: the key must be in ~/.ssh/authorized_keys and, when the client signs, the signature must verify. */
  authorized(/** @type {any} */ ctx) {
    let text = ''
    try { text = readFileSync(join(this.home, '.ssh', 'authorized_keys'), 'utf8') } catch { return false }
    for (const line of text.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/)
      const i = f.findIndex((x) => /^(ssh-|ecdsa-|sk-)/.test(x)) // skips an options prefix
      if (i < 0 || !f[i + 1]) continue
      const key = utils.parseKey(`${f[i]} ${f[i + 1]}`)
      if (key instanceof Error || !key.getPublicSSH().equals(ctx.key.data)) continue
      return !ctx.signature || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true
    }
    return false
  }

  run(/** @type {any} */ stream, /** @type {string} */ command) {
    const child = spawn(/** @type {string} */ (SH), ['-c', command], { cwd: this.home, env: this.env, detached: !WIN, windowsHide: true })
    this.children.add(child)
    stream.on('error', () => { /* the client went away */ })
    child.on('error', (e) => { stream.stderr.write(`fixture: ${e.message}\n`) })
    child.stdin?.on('error', () => { /* the command stopped reading */ })
    stream.pipe(child.stdin)
    child.stdout?.pipe(stream, { end: false })
    child.stderr?.pipe(stream.stderr, { end: false })
    child.on('close', (code, sig) => {
      this.children.delete(child)
      if (code !== null) stream.exit(code)
      else stream.exit(String(sig || 'KILL').replace(/^SIG/, ''), false, '')
      stream.end()
    })
    stream.on('close', () => kill(child))
    return child
  }
}

/** Kill a command and everything it started (Windows: the process tree; elsewhere: its process group). */
function kill(/** @type {import('node:child_process').ChildProcess} */ child, sig = 'KILL') {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else try { process.kill(-child.pid, /** @type {NodeJS.Signals} */ (`SIG${sig.replace(/^SIG/, '')}`)) } catch { /* gone */ }
}
