// @ts-check
// Where server-use keeps its state. One directory per user (override with SERVER_USE_HOME).
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

export const DEFAULT_HOME = join(homedir(), '.server-use')
export const home = () => process.env.SERVER_USE_HOME || DEFAULT_HOME
export const file = (/** @type {string[]} */ ...p) => join(home(), ...p)
/** The user's OpenSSH directory (override for tests). */
export const sshDir = () => process.env.SERVER_USE_SSH_DIR || join(homedir(), '.ssh')
export const homeHash = () => createHash('sha256').update(home()).digest('hex').slice(0, 12)

export function ensureHome() {
  mkdirSync(home(), { recursive: true, mode: 0o700 })
  return home()
}

export function socketPath() {
  if (process.platform === 'win32') return String.raw`\\.\pipe\server-use-` + homeHash()
  const p = file('daemon.sock')
  // Unix socket paths are capped at ~104 bytes (macOS).
  return Buffer.byteLength(p) < 100 ? p : join(tmpdir(), `server-use-${homeHash()}.sock`)
}
