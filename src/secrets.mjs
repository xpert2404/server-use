// @ts-check
// Passwords, sudo passwords and key passphrases. OS keychain first; plain file (mode 600) where
// no keychain exists (headless Linux, containers) or SERVER_USE_SECRETS=file.
// ponytail: file fallback has the same trust level as ~/.ssh/id_*; age/sops once inventories are shared.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { file, ensureHome, home, DEFAULT_HOME, homeHash } from './paths.mjs'

export const KINDS = ['password', 'sudo', 'passphrase']
const SERVICE = 'server-use'
// Secret Service or nothing: without it the binding silently uses the kernel keyring, which is in-memory and
// forgets everything on reboot. Headless Linux gets the file instead.
const OPTS = { linux: { store: 'secret-service' } }

/** @type {null | false | (new (service: string, user: string, opts?: object) => {getPassword(): string|null, setPassword(v: string): void, deletePassword(): boolean})} */
let Entry = null

function keyring() {
  if (Entry !== null) return Entry
  Entry = false
  if (process.env.SERVER_USE_SECRETS === 'file') return Entry
  try {
    const mod = createRequire(import.meta.url)('@napi-rs/keyring')
    new mod.Entry(SERVICE, '__probe__', OPTS).getPassword() // throws without a usable backend (e.g. no Secret Service)
    Entry = mod.Entry
  } catch { /* fall back to file */ }
  return Entry
}

export const backend = () => (keyring() ? 'keychain' : 'file')

const account = (/** @type {string} */ server, /** @type {string} */ kind) =>
  (home() === DEFAULT_HOME ? '' : `${homeHash()}/`) + `${server}:${kind}`

const filePath = () => file('secrets.json')
function readFile() {
  return existsSync(filePath()) ? JSON.parse(readFileSync(filePath(), 'utf8')) : {}
}
function writeFile(/** @type {Record<string, string>} */ data) {
  ensureHome()
  const tmp = filePath() + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, filePath())
}

/** @returns {string | undefined} */
export function getSecret(/** @type {string} */ server, /** @type {string} */ kind) {
  const E = keyring()
  if (E) return new E(SERVICE, account(server, kind), OPTS).getPassword() ?? undefined
  return readFile()[account(server, kind)]
}

export function setSecret(/** @type {string} */ server, /** @type {string} */ kind, /** @type {string} */ value) {
  if (!KINDS.includes(kind)) throw new Error(`unknown secret kind ${kind}`)
  const E = keyring()
  if (E) return new E(SERVICE, account(server, kind), OPTS).setPassword(value)
  const data = readFile()
  data[account(server, kind)] = value
  writeFile(data)
}

export function deleteSecret(/** @type {string} */ server, /** @type {string} [kind] */ kind) {
  const kinds = kind ? [kind] : KINDS
  const E = keyring()
  if (E) {
    for (const k of kinds) try { new E(SERVICE, account(server, k), OPTS).deletePassword() } catch { /* absent */ }
    return
  }
  const data = readFile()
  for (const k of kinds) delete data[account(server, k)]
  writeFile(data)
}

export const hasSecret = (/** @type {string} */ server, /** @type {string} */ kind) => getSecret(server, kind) !== undefined
