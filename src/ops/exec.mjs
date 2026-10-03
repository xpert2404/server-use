// @ts-check
// Running commands: one channel per command on the pooled connection, parallel across servers.
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { file } from '../paths.mjs'
import * as inventory from '../inventory.mjs'
import { getSecret } from '../secrets.mjs'
import { check } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { SuError, clip, shq } from '../util.mjs'

const HEAD_CAP = 64 * 1024
const TAIL_CAP = 256 * 1024
const SPILL_AT = 16 * 1024
export const DEFAULT_TIMEOUT_MS = 10 * 60_000
const GLOBAL_MAX = 32

/** Keeps the start and the end of a stream in memory; spills everything to a log file once it gets long. */
class Collector {
  /** @param {string} logPath */
  constructor(logPath) {
    this.logPath = logPath
    /** @type {Buffer[]} */ this.head = []
    /** @type {Buffer[]} */ this.tail = []
    this.headBytes = 0
    this.tailBytes = 0
    this.dropped = 0
    this.total = 0
    /** @type {number | null} */ this.fd = null
    this.done = false
  }
  push(/** @type {Buffer} */ chunk) {
    // Data still in flight after a timeout/abort: the fd is closed and its number may already belong to another file.
    if (this.done) return
    this.total += chunk.length
    if (this.fd === null && this.total > SPILL_AT) {
      mkdirSync(join(this.logPath, '..'), { recursive: true })
      this.fd = openSync(this.logPath, 'w', 0o600)
      for (const b of [...this.head, ...this.tail]) writeSync(this.fd, b)
    }
    if (this.fd !== null) writeSync(this.fd, chunk)
    if (this.headBytes < HEAD_CAP) { this.head.push(chunk); this.headBytes += chunk.length; return }
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes > TAIL_CAP && this.tail.length > 1) {
      const b = /** @type {Buffer} */ (this.tail.shift())
      this.tailBytes -= b.length
      this.dropped += b.length
    }
  }
  finish(full = false) {
    this.done = true
    if (this.fd !== null) closeSync(this.fd)
    const mid = this.dropped ? `\n… ${this.dropped} bytes cut …\n` : ''
    const text = Buffer.concat(this.head).toString() + mid + Buffer.concat(this.tail).toString()
    const c = full ? { text, cut: this.dropped ? 1 : 0 } : clip(text)
    let log = this.fd !== null
    // Cut by line count while under SPILL_AT: nothing was spilled, but the full log is promised, and head holds it all.
    if (c.cut > 0 && !log) {
      mkdirSync(join(this.logPath, '..'), { recursive: true })
      writeFileSync(this.logPath, Buffer.concat([...this.head, ...this.tail]), { mode: 0o600 })
      log = true
    }
    return { text: c.text, bytes: this.total, truncated: c.cut > 0, log: log ? this.logPath : undefined }
  }
}

/**
 * Run one command string on an open connection. Rejects with channelOpenFailed=true when no channel
 * could be opened (the pool then retries on a fresh connection; nothing has run yet).
 * @param {import('../pool.mjs').Conn} conn
 * @param {{command: string, stdin?: Buffer|string|import('node:stream').Readable|null, stdinPrefix?: string,
 *   sink?: import('node:stream').Writable, timeoutMs?: number, signal?: AbortSignal, logBase?: string, full?: boolean, wrap?: Wrap}} o
 *   stdin may be a stream (put); sink receives raw stdout instead of the collector (get); wrap = sudo wrapper used (for kills).
 */
export function rawExec(conn, { command, stdin = null, stdinPrefix, sink, timeoutMs = DEFAULT_TIMEOUT_MS, signal, logBase, full, wrap }) {
  const started = Date.now()
  const out = new Collector((logBase || file('runs', 'tmp', conn.name)) + '.log')
  const err = new Collector((logBase || file('runs', 'tmp', conn.name)) + '.err.log')
  // The remote shell reports its PID first (on stderr, stripped below). sshd makes that shell a session and
  // process-group leader, so on timeout/abort we can kill the whole group over a second channel — OpenSSH
  // keeps the channel open until every child is gone, and signal requests only reach the shell itself.
  const marked = PID_MARK + command
  return new Promise((resolve, reject) => {
    // Aborted while queued, connecting or probing sudo: an already-aborted signal never fires 'abort' again.
    if (signal?.aborted) {
      return resolve({ exit: 130, ms: 0, stdout: out.finish(), stderr: err.finish(),
        error: { code: 'ABORTED', message: 'caller disconnected before the command started; not run' } })
    }
    conn.client.exec(marked, (e, stream) => {
      if (e) return reject(Object.assign(e, { channelOpenFailed: true }))
      /** @type {number | null} */ let pid = null
      /** @type {Buffer | null} */ let head = Buffer.alloc(0)
      let settled = false
      const finish = (/** @type {number|null} */ code, /** @type {string|undefined} */ sig, /** @type {{code: string, message: string}} */ [error] = []) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        // head stays: a pid still to come after a stop gets its kill (stderr handler).
        if (head?.length) err.push(head)
        resolve({
          exit: error?.code === 'TIMEOUT' ? 124 : error?.code === 'ABORTED' ? 130 : code ?? 255,
          signal: sig || undefined,
          ms: Date.now() - started,
          stdout: out.finish(full),
          stderr: err.finish(full),
          ...(error ? { error } : {}),
        })
      }
      const stop = (/** @type {string} */ code, /** @type {string} */ message) => {
        killRemote(conn, pid, wrap)
        try { stream.signal('KILL') } catch { /* unsupported */ }
        stream.close()
        // Data keeps arriving until the server confirms the close; the caller ends the sink as soon as we resolve.
        if (sink) stream.unpipe(sink).resume()
        finish(null, undefined, [{ code, message }])
      }
      const timer = setTimeout(() => stop('TIMEOUT', `timed out after ${Math.round(timeoutMs / 1000)}s; remote process group killed. Use "server-use job start" for long runs.`), timeoutMs)
      const onAbort = () => stop('ABORTED', 'caller disconnected; remote command killed')
      signal?.addEventListener('abort', onAbort, { once: true })
      if (sink) stream.pipe(sink, { end: false })
      else stream.on('data', (/** @type {Buffer} */ d) => out.push(d))
      stream.stderr.on('data', (/** @type {Buffer} */ d) => {
        if (head === null) return err.push(d)
        head = Buffer.concat([head, d])
        const m = /\x1eSUPID(\d+)\x1e\n/.exec(head.toString('latin1'))
        if (m) {
          pid = Number(m[1])
          const rest = Buffer.concat([head.subarray(0, m.index), head.subarray(m.index + m[0].length)])
          head = null
          if (rest.length) err.push(rest)
          // Stopped before the shell reported its pid (abort during the open): kill it now.
          if (settled) killRemote(conn, pid, wrap)
        } else if (head.length > 8192) { err.push(head); head = null }
      })
      // Neither exit status nor signal: the connection died mid-run. Never retried — it may have had effects.
      stream.on('close', (/** @type {number|null} */ code, /** @type {string|undefined} */ sig) => finish(code, sig,
        code == null && !sig ? [{ code: 'DISCONNECTED', message: 'connection lost while the command was running; not retried — check whether it took effect' }] : []))
      // Aborted during the open round trip: the command has just started. Stop it before it gets any stdin.
      if (signal?.aborted) return onAbort()
      if (stdinPrefix) stream.write(stdinPrefix)
      if (stdin && typeof stdin === 'object' && 'pipe' in stdin) stdin.pipe(stream)
      else if (stdin !== null && stdin !== undefined) stream.end(stdin)
      else stream.end()
    })
  })
}

const PID_MARK = String.raw`printf '\036SUPID%s\036\n' "$$" >&2` + '\n'

/** TERM the remote command, KILL it 3 s later. Best effort, on a separate channel. */
function killRemote(/** @type {import('../pool.mjs').Conn} */ conn, /** @type {number | null} */ pid, /** @type {Wrap | undefined} */ wrap) {
  if (!pid || conn.state === 'closed') return
  // Children and the shell get TERM individually first: sudo only relays signals that do not come from its own
  // process group. Then the whole group, then KILL.
  const cmd = `pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; kill -TERM -${pid} 2>/dev/null; sleep 3; pkill -KILL -P ${pid} 2>/dev/null; kill -KILL -${pid} 2>/dev/null; true`
  const w = wrap ? wrap(cmd) : { command: cmd, prefix: '' }
  try {
    conn.client.exec(w.command, (e, s) => { if (!e) { s.on('data', () => {}); s.stderr.on('data', () => {}); s.end(w.prefix) } })
  } catch { /* connection gone */ }
}

/** How sudo works on this connection: root | nopasswd | password. Cached per connection. */
export async function sudoMode(/** @type {import('../pool.mjs').Conn} */ conn, /** @type {inventory.Server} */ server) {
  if (conn.sudo) return conn.sudo
  if (server.user === 'root') return (conn.sudo = 'root')
  const r = await rawExec(conn, { command: 'sudo -n sh -c true 2>/dev/null && echo nopasswd || echo password', timeoutMs: 20_000 })
  return (conn.sudo = r.stdout.text.trim() === 'nopasswd' ? 'nopasswd' : 'password')
}

/**
 * Wrap a remote shell text for sudo. The password goes to stdin, never into argv.
 * `wrap` is returned too, so a timeout can kill the command as root (sudo runs with real uid 0; the user can't signal it).
 * @returns {Promise<{command: string, prefix: string, wrap?: Wrap}>}
 */
export async function withSudo(/** @type {import('../pool.mjs').Conn} */ conn, /** @type {inventory.Server & {name: string}} */ server, /** @type {string} */ inner) {
  const mode = await sudoMode(conn, server)
  if (mode === 'root') return { command: inner, prefix: '' }
  /** @type {Wrap} */ let wrap
  if (mode === 'nopasswd') wrap = (s) => ({ command: `sudo -n sh -c ${shq(s)}`, prefix: '' })
  else {
    const pw = getSecret(server.name, 'sudo') ?? getSecret(server.name, 'password')
    if (pw === undefined) {
      throw new SuError('SUDO', `${server.name}: sudo needs a password and none is stored. Store it with: server-use set ${server.name} sudo-password --stdin`)
    }
    // sudo reads the password line only if it prompts; a NOPASSWD rule or PAM trust skips that, and the line would
    // reach the command (run by `sh -s`, echoed in its errors, written by put). So root's shell first reads up to a
    // marker line: past the password whether or not sudo took it.
    wrap = (s) => ({ command: `sudo -k -S -p '' sh -c ${shq(`while IFS= read -r l && [ "$l" != ${PW_END} ]; do :; done; unset l\n${s}`)}`, prefix: `${pw}\n${PW_END}\n` })
  }
  return { ...wrap(inner), wrap }
}
/** @typedef {(s: string) => {command: string, prefix: string}} Wrap */
const PW_END = '__server_use_sudo_pw_end__'

/**
 * Shell text for a command or a script (script arrives on stdin; bash if the server has it).
 * @param {{command?: string, script?: string, cwd?: string, env?: Record<string, string>}} o
 */
export function shellText({ command, script, cwd, env }) {
  let pre = ''
  for (const [k, v] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new SuError('USAGE', `bad env name "${k}"`)
    pre += `export ${k}=${shq(v)}\n`
  }
  if (cwd) pre += `cd -- ${shq(cwd)} || exit 1\n`
  if (script !== undefined) return { text: pre + 'if command -v bash >/dev/null 2>&1; then exec bash -s; else exec sh -s; fi', stdin: script }
  if (!command) throw new SuError('USAGE', 'nothing to run: pass a command or --script')
  return { text: pre + command, stdin: undefined }
}

let running = 0
/** @type {(() => void)[]} */ const waiting = []
async function globalSlot() {
  if (running < GLOBAL_MAX) { running++; return }
  await new Promise((r) => waiting.push(() => { running++; r(undefined) }))
}
function freeSlot() { running--; waiting.shift()?.() }

/**
 * Run fn(name) on every target in parallel; errors become per-host results instead of failing the batch.
 * @template T
 * @param {string[]} names
 * @param {(name: string) => Promise<T>} fn
 */
export async function fanOut(names, fn) {
  return Promise.all(names.map(async (name) => {
    await globalSlot()
    try {
      return await fn(name)
    } catch (e) {
      const err = /** @type {any} */ (e)
      return /** @type {any} */ ({ host: name, exit: null, error: { code: err.code || 'INTERNAL', message: err.message, ...(err.extra || {}) } })
    } finally {
      freeSlot()
    }
  }))
}

/**
 * op "exec": {targets, command?, script?, sudo?, cwd?, env?, timeoutMs?, yes?, full?}
 * @param {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} ctx
 * @param {any} a
 */
export async function exec(ctx, a) {
  const names = inventory.resolveTargets(a.targets)
  const { text, stdin } = shellText(a)
  const results = await fanOut(names, async (name) => {
    const server = inventory.get(name)
    check(server, 'exec', { text: (a.command || '') + '\n' + (a.script || ''), yes: a.yes })
    const r = await ctx.pool.with(name, async (conn) => {
      const wrapped = a.sudo ? await withSudo(conn, server, text) : { command: text, prefix: '' }
      const input = wrapped.prefix || stdin !== undefined ? wrapped.prefix + (stdin ?? '') : null
      return rawExec(conn, {
        command: wrapped.command, stdin: input, timeoutMs: a.timeoutMs || DEFAULT_TIMEOUT_MS, signal: ctx.signal,
        logBase: file('runs', ctx.runId, name), full: a.full, wrap: wrapped.wrap,
      })
    })
    audit({ agent: ctx.agent, op: 'exec', host: name, cmd: a.command ?? `[script ${Buffer.byteLength(a.script || '')} bytes]`, sudo: !!a.sudo, exit: r.exit, ms: r.ms })
    return { host: name, ...r }
  })
  return { results }
}
