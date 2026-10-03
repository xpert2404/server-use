// @ts-check
// Host key pinning (trust on first use, hard stop on change). Stored in OpenSSH known_hosts format,
// and ~/.ssh/known_hosts (plain or hashed entries) is consulted before trusting a new key.
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { file, ensureHome, sshDir } from './paths.mjs'
import { fingerprint, keyType } from './util.mjs'

const hostId = (/** @type {string} */ host, /** @type {number} */ port) => (port === 22 ? host : `[${host}]:${port}`)
const ours = () => file('known_hosts')

/** @returns {{type: string, blob: Buffer}[]} */
function entries(/** @type {string} */ path, /** @type {string} */ id) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('@')) continue
    if (!matches(parts[0], id)) continue
    try { out.push({ type: parts[1], blob: Buffer.from(parts[2], 'base64') }) } catch { /* skip */ }
  }
  return out
}

function matches(/** @type {string} */ field, /** @type {string} */ id) {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|')
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(id).digest('base64') === hash
  }
  return field.split(',').includes(id)
}

/**
 * The keys on file for the host. Once our file pins any key (or after `trust --reset`, see forget) it alone decides,
 * so a key another tool later writes to ~/.ssh/known_hosts can't override the pin.
 */
function known(/** @type {string} */ id) {
  const mine = entries(ours(), id).map((e) => ({ ...e, src: 'ours' }))
  if (mine.length || existsSync(ours()) && readFileSync(ours(), 'utf8').split(/\r?\n/).includes(`@reset ${id}`)) return mine
  return entries(join(sshDir(), 'known_hosts'), id).map((e) => ({ ...e, src: 'ssh' }))
}

/** Key types on file for the host, so the handshake prefers those (like OpenSSH orders HostKeyAlgorithms). */
export const knownTypes = (/** @type {string} */ host, /** @type {number} */ port) =>
  [...new Set(known(hostId(host, port)).map((e) => e.type))]

/** Fingerprints on file for the host. Unlike verify, never pins anything. */
export const pinned = (/** @type {string} */ host, /** @type {number} */ port) =>
  known(hostId(host, port)).map((e) => fingerprint(e.blob))

/**
 * @returns {{ok: true, status: 'known'|'new'|'imported', fingerprint: string}
 *   | {ok: false, status: 'changed', fingerprint: string, expected: string}}
 */
export function verify(/** @type {string} */ host, /** @type {number} */ port, /** @type {Buffer} */ blob) {
  const id = hostId(host, port)
  const fp = fingerprint(blob)
  const all = known(id)
  const hit = all.find((e) => e.blob.equals(blob))
  if (hit?.src === 'ssh') add(host, port, blob)
  if (hit) return { ok: true, status: hit.src === 'ours' ? 'known' : 'imported', fingerprint: fp }
  // Any key on file binds, whatever its type: a MITM must not get in by presenting a key of another type.
  const pinned = all.find((e) => e.type === keyType(blob)) ?? all[0]
  if (pinned) return { ok: false, status: 'changed', fingerprint: fp, expected: fingerprint(pinned.blob) }
  add(host, port, blob)
  return { ok: true, status: 'new', fingerprint: fp }
}

/**
 * How to forget a pin when `trust --reset` can't: it only resets the address of a server in the inventory.
 * '' when nothing is pinned (no key anywhere, or an @reset marker hides the ~/.ssh/known_hosts entry).
 */
export function forgetHint(/** @type {string} */ host, /** @type {number} */ port) {
  const id = hostId(host, port)
  const src = known(id)[0]?.src
  // Only a key that came from the user's own ~/.ssh/known_hosts is worth removing there.
  return !src ? '' : src === 'ours' ? `delete the lines starting with "${id} " in ${ours()}` : `run: ssh-keygen -R "${id}"`
}

export function add(/** @type {string} */ host, /** @type {number} */ port, /** @type {Buffer} */ blob) {
  ensureHome()
  appendFileSync(ours(), `${hostId(host, port)} ${keyType(blob)} ${blob.toString('base64')}\n`, { mode: 0o600 })
}

/**
 * Forget pinned keys for a host. ~/.ssh/known_hosts is never edited; instead an "@reset <id>" marker makes our
 * file alone decide for this host from now on, so a stale key there can't block the new pin.
 */
export function forget(/** @type {string} */ host, /** @type {number} */ port) {
  const id = hostId(host, port)
  const mark = `@reset ${id}`
  const lines = existsSync(ours()) ? readFileSync(ours(), 'utf8').split(/\r?\n/) : []
  const gone = lines.filter((l) => matches(l.trim().split(/\s+/)[0], id))
  const keep = lines.filter((l) => l.trim() && l !== mark && !gone.includes(l))
  ensureHome()
  writeFileSync(ours(), [...keep, mark].join('\n') + '\n', { mode: 0o600 })
  return gone.length
}
