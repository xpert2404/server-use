// @ts-check
// servers.yaml: the inventory. No secrets in here — those live in secrets.mjs.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import YAML from 'yaml'
import { file, ensureHome } from './paths.mjs'
import { SuError, UsageError } from './util.mjs'

export const POLICIES = ['open', 'confirm', 'readonly']
export const AUTHS = ['key', 'agent', 'password']
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const FIELDS = ['host', 'port', 'user', 'auth', 'key', 'tags', 'policy', 'facts', 'jump', 'added', 'note']

/**
 * @typedef {{host: string, port?: number, user: string, auth?: string, key?: string, tags?: string[],
 *   policy?: string, facts?: Record<string, string>, added?: string, note?: string}} Server
 */

const path = () => file('servers.yaml')

function readDoc() {
  const p = path()
  const text = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const doc = YAML.parseDocument(text || '{}')
  if (doc.errors.length) throw new SuError('INVENTORY', `servers.yaml is invalid: ${doc.errors[0].message}`)
  return doc
}

function writeDoc(/** @type {YAML.Document} */ doc) {
  ensureHome()
  const tmp = path() + '.tmp'
  writeFileSync(tmp, String(doc), { mode: 0o600 })
  renameSync(tmp, path())
}

/** @returns {Record<string, Server>} */
export function load() {
  return /** @type {Record<string, Server>} */ (readDoc().toJS() || {})
}

export function validName(/** @type {string} */ name) {
  if (!NAME.test(name) || name === 'all') throw new UsageError(`invalid server name "${name}" (letters, digits, . _ - ; not "all")`)
  return name
}

/** @returns {Server & {name: string}} */
export function get(/** @type {string} */ name) {
  const s = load()[name]
  if (!s) throw unknown(name)
  return { name, port: 22, auth: 'key', tags: [], policy: 'confirm', ...s }
}

export const list = () => Object.keys(load()).map(get)

/** Create or merge fields; `undefined` deletes a field. */
export function upsert(/** @type {string} */ name, /** @type {Partial<Server>} */ fields) {
  validName(name)
  const doc = readDoc()
  for (const [k, v] of Object.entries(fields)) {
    if (!FIELDS.includes(k)) throw new UsageError(`unknown field "${k}" (${FIELDS.join(', ')})`)
    if (k === 'policy' && v !== undefined && !POLICIES.includes(/** @type {string} */ (v))) throw new UsageError(`policy must be one of ${POLICIES.join('|')}`)
    if (k === 'auth' && v !== undefined && !AUTHS.includes(/** @type {string} */ (v))) throw new UsageError(`auth must be one of ${AUTHS.join('|')}`)
    if (v === undefined) doc.deleteIn([name, k])
    else doc.setIn([name, k], v)
  }
  writeDoc(doc)
  return get(name)
}

export function remove(/** @type {string} */ name) {
  const doc = readDoc()
  if (!doc.hasIn([name])) throw unknown(name)
  doc.deleteIn([name])
  writeDoc(doc)
}

/** "web1", "web1,web2", "tag:prod", "all" → server names (deduplicated, inventory order). */
export function resolveTargets(/** @type {string} */ spec) {
  if (!spec) throw new UsageError('missing target (server name, a,b, tag:<tag> or all)')
  const inv = load()
  const names = Object.keys(inv)
  const out = new Set()
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part === 'all') names.forEach((n) => out.add(n))
    else if (part.startsWith('tag:')) {
      const tag = part.slice(4)
      const hit = names.filter((n) => (inv[n].tags || []).includes(tag))
      if (!hit.length) throw new SuError('UNKNOWN_SERVER', `no server has tag "${tag}"`)
      hit.forEach((n) => out.add(n))
    } else if (inv[part]) out.add(part)
    else throw unknown(part)
  }
  if (!out.size) throw new SuError('UNKNOWN_SERVER', 'inventory is empty — add one with: server-use add <name> <user@host>')
  return [...out]
}

function unknown(/** @type {string} */ name) {
  const known = Object.keys(load())
  return new SuError('UNKNOWN_SERVER', `unknown server "${name}"` + (known.length ? ` (known: ${known.join(', ')})` : ' (inventory is empty)'))
}

/** "user@host:port" → parts. IPv6 as [::1]:22. */
export function parseAddress(/** @type {string} */ addr, defaultUser = 'root') {
  const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(addr || '')
  if (!m) throw new UsageError(`bad address "${addr}" (use user@host or user@host:port)`)
  return { user: m[1] || defaultUser, host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : 22 }
}
