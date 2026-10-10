// @ts-check
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { readFileSync, realpathSync, statSync } from 'node:fs'

/** "~", "%d" (OpenSSH's local home) and "${HOME}" in a path. */
export function expandPath(/** @type {string} */ p) {
  const h = homedir()
  return String(p).replace(/^~(?=$|[\\/])/, () => h).replaceAll('%d', () => h).replaceAll('${HOME}', () => h)
}

/** UNC and device paths (\\host\share, \\.\pipe\x): opening one on Windows makes the OS authenticate to the host it names. */
export const unsafePath = (/** @type {string} */ p) => process.platform === 'win32' && /^[\\/]{2}/.test(p)

/** Largest private key file we look at; real keys are 0.4 to 4 KB. */
export const KEY_MAX = 64 * 1024

/**
 * Read a small regular file. A reason instead of an exception, and no filesystem call at all for a UNC/device path;
 * FIFOs, devices and directories are refused before opening (opening a FIFO blocks).
 * @returns {{buf?: Buffer, reason?: string}}
 */
export function readSmall(/** @type {string} */ path, /** @type {number} */ max) {
  if (unsafePath(path)) return { reason: 'UNC and device paths are not allowed' }
  try {
    const st = statSync(path)
    if (!st.isFile()) return { reason: 'not a regular file' }
    if (st.size > max) return { reason: `larger than ${max >> 10} KB` }
    return { buf: readFileSync(path) }
  } catch (e) {
    const code = /** @type {any} */ (e).code
    return { reason: code === 'ENOENT' ? 'not found' : `unreadable (${code})` }
  }
}

/** Canonical path of an existing file (symlinks, drive-letter case), for telling two spellings of one key apart. */
export function realPath(/** @type {string} */ p) {
  if (unsafePath(p)) return p
  try { return realpathSync.native(p) } catch { return p }
}

/** Why ssh2 could not use a key, in terms a person can act on. */
export function keyFailure(/** @type {Error} */ err) {
  const m = err.message
  return /no passphrase given/i.test(m) ? 'encrypted' : /bad passphrase/i.test(m) ? 'bad passphrase' : /unsupported/i.test(m) ? 'unsupported format' : 'unreadable'
}

/** POSIX single-quote a string for a remote shell. */
export const shq = (/** @type {string} */ s) => "'" + String(s).replaceAll("'", String.raw`'\''`) + "'"

/** Shell variable assignments that prefix a remote script (values never reach argv / ps). */
export function shVars(/** @type {Record<string, unknown>} */ vars) {
  let out = ''
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null) continue
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad variable name ${k}`)
    out += `${k}=${shq(String(v))}\n`
  }
  return out
}

/** OpenSSH-style fingerprint of a raw public key blob. */
export const fingerprint = (/** @type {Buffer} */ blob) =>
  'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')

/** Key type ("ssh-ed25519", ...) from a raw SSH public key blob. */
export function keyType(/** @type {Buffer} */ blob) {
  const len = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + len).toString('latin1')
}

/** "90s", "5m", "2h", "1d" or plain seconds → milliseconds. */
export function parseDuration(/** @type {string|number} */ v) {
  if (typeof v === 'number') return v * 1000
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(String(v).trim())
  if (!m) throw new UsageError(`bad duration "${v}" (use e.g. 90s, 5m, 2h)`)
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || 's']
  return Math.round(Number(m[1]) * mult)
}

/** Which agent is calling us — only for the audit log. */
export function detectAgent(/** @type {NodeJS.ProcessEnv} */ env = process.env) {
  if (env.SERVER_USE_AGENT) return env.SERVER_USE_AGENT
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code'
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex'
  if (Object.keys(env).some((k) => k.startsWith('DSH_'))) return 'nexus'
  if (Object.keys(env).some((k) => k.startsWith('HERMES_'))) return 'hermes'
  return 'cli'
}

/** Errors carry a stable code; the CLI maps codes to exit statuses. */
export class SuError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(code, message, extra) {
    super(message)
    this.code = code
    this.extra = extra
  }
}
export class UsageError extends SuError {
  constructor(/** @type {string} */ message) { super('USAGE', message) }
}

export const EXIT = {
  USAGE: 2, UNKNOWN_SERVER: 2, CONFIRM: 3, HOSTKEY_CHANGED: 4, UNREACHABLE: 5, AUTH: 6, PASSPHRASE_REQUIRED: 6,
  READONLY: 7, SUDO: 8, TIMEOUT: 124, ABORTED: 130, INTERNAL: 1, REMOTE: 1,
}

/** Keep the first `head` and last `tail` lines, capped at maxBytes. */
export function clip(/** @type {string} */ text, head = 50, tail = 150, maxBytes = 16_384) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let out = text
  let cut = 0
  if (lines.length > head + tail) {
    cut = lines.length - head - tail
    out = [...lines.slice(0, head), `… ${cut} lines cut …`, ...lines.slice(-tail)].join('\n') + '\n'
  }
  if (Buffer.byteLength(out) > maxBytes) {
    const b = Buffer.from(out)
    const half = Math.floor(maxBytes / 2)
    out = b.subarray(0, half).toString() + `\n… ${b.length - maxBytes} bytes cut …\n` + b.subarray(-half).toString()
    cut = cut || 1
  }
  return { text: out, cut, lines: lines.length }
}
