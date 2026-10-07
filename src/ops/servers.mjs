// @ts-check
// Inventory operations: add (with key bootstrap), import from ~/.ssh/config, list, show, set, rm, trust, facts, notes.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { generateEd25519 } from '../keygen.mjs'
import * as inventory from '../inventory.mjs'
import * as hostkeys from '../hostkeys.mjs'
import { setSecret, deleteSecret, getSecret, backend } from '../secrets.mjs'
import { connect } from '../pool.mjs'
import { file, ensureHome, sshDir } from '../paths.mjs'
import { audit } from '../audit.mjs'
import { rawExec, fanOut } from './exec.mjs'
import { scriptSource, kv } from '../remote.mjs'
import { shVars, SuError, UsageError } from '../util.mjs'

/** @typedef {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} Ctx */

/** This workstation's own key pair, created on first use. */
export function ensureKey() {
  ensureHome()
  const priv = file('id_ed25519')
  if (!existsSync(priv)) {
    const kp = generateEd25519({ comment: `server-use@${hostname()}` })
    writeFileSync(priv, kp.private, { mode: 0o600 })
    writeFileSync(priv + '.pub', kp.public + '\n', { mode: 0o644 })
  }
  return readFileSync(priv + '.pub', 'utf8').trim()
}

// ---- notes: the per-server memory every agent reads first ----

const notesPath = (/** @type {string} */ name) => file('notes', `${name}.md`)
export function appendNote(/** @type {string} */ name, /** @type {string} */ line) {
  mkdirSync(file('notes'), { recursive: true })
  const p = notesPath(name)
  if (!existsSync(p)) writeFileSync(p, `# ${name}\n\nWhat runs here, where, and why. server-use appends deploys, cron jobs and jobs; agents add the rest.\n\n## Log\n`)
  appendFileSync(p, `- ${new Date().toLocaleString('sv-SE').slice(0, 16)} ${line}\n`)
}
export function readNote(/** @type {string} */ name) {
  return existsSync(notesPath(name)) ? readFileSync(notesPath(name), 'utf8') : ''
}

/** Adapt a bare ssh2 client to what rawExec expects. */
const adhoc = (/** @type {import('ssh2').Client} */ client, /** @type {string} */ name) =>
  /** @type {import('../pool.mjs').Conn} */ ({ client, name, key: '', state: 'ready', since: Date.now(), lastUsed: Date.now(), active: 0, queue: [] })

async function runAdhoc(/** @type {import('ssh2').Client} */ client, /** @type {string} */ name, /** @type {string} */ script, /** @type {Record<string, unknown>} */ vars = {}) {
  const r = await rawExec(adhoc(client, name), { command: 'sh -s', stdin: shVars(vars) + scriptSource(script), timeoutMs: 120_000 })
  if (r.exit !== 0) throw new SuError('REMOTE', `${script}.sh failed on ${name} (exit ${r.exit}): ${(r.stderr.text || r.stdout.text).trim().slice(-1500)}`)
  return r.stdout.text
}

const FACT_KEYS = ['os', 'arch', 'kernel', 'init', 'docker', 'compose', 'git', 'python3', 'node', 'uv', 'tz', 'cpus', 'mem_mb', 'disk_root_free_gb', 'pkg', 'sudo', 'crontab', 'flock', 'setsid', 'home']
const pickFacts = (/** @type {Record<string, string>} */ f) => Object.fromEntries(FACT_KEYS.filter((k) => f[k] !== undefined && f[k] !== '').map((k) => [k, f[k]]))

/**
 * op "servers.add": {name, address, password?, key?, tags?, policy?, keepPassword?, installKey?, note?, force?}
 * @param {Ctx} ctx @param {any} a
 */
export async function add(ctx, a) {
  const name = inventory.validName(a.name)
  const inv = inventory.load()
  if (inv[name] && !a.force) throw new UsageError(`"${name}" already exists (see: server-use show ${name}; change with set, or add --force to replace)`)
  const { user, host, port } = inventory.parseAddress(a.address)
  // Validate before connecting: a late failure would come after the key is installed and the password deleted.
  if (a.policy && !inventory.POLICIES.includes(a.policy)) throw new UsageError(`policy must be one of ${inventory.POLICIES.join('|')}`)
  const hints = []
  /** @type {inventory.Server & {name: string}} */
  const server = { name, host, port, user, auth: a.password !== undefined ? 'password' : 'key', key: a.key, tags: a.tags || [], policy: a.policy || 'confirm' }

  const client = await connect(server, { password: a.password })
  const hostkey = client.hostkey
  let facts = {}
  let keyInstalled = false
  let stored = 'none'
  try {
    try {
      facts = pickFacts(kv(await runAdhoc(client, name, 'facts')))
    } catch (e) {
      hints.push(`facts could not be collected: ${/** @type {Error} */ (e).message}`)
    }

    // Another entry for the same machine (same address, or any spelling of it with the same host key) keeps the
    // strictest policy, so an MCP agent cannot re-add a readonly server as open. Only keys proven on this
    // authenticated connection count (a second connection could be routed elsewhere): the one it presented and, from
    // an OpenSSH server, all its others (their proof arrives before the facts' output).
    const rank = (/** @type {string|undefined} */ p) => inventory.POLICIES.indexOf(p || 'confirm')
    const keys = [hostkey?.fingerprint, ...client.proven]
    for (const [n, s] of Object.entries(inv)) {
      if (n === name || rank(s.policy) <= rank(server.policy)) continue
      const sameText = String(s.host).toLowerCase() === host.toLowerCase() && (s.port || 22) === port
      const same = sameText || hostkeys.pinned(s.host, s.port || 22).some((f) => keys.includes(f))
      // A server that proves no other keys can't rule out holding n's pinned key of another type: fail safe.
      const types = hostkeys.knownTypes(s.host, s.port || 22)
      const unsure = !same && !client.proven.length && types.length > 0 && !types.includes(hostkey?.type)
      if (!same && !unsure) continue
      server.policy = s.policy || 'confirm'
      hints.push(`policy ${server.policy} taken over from ${n} (${same ? 'same server' : 'could not rule out the same server'}); only the user may loosen it: server-use set ${name} policy=...`)
    }

    if (a.password !== undefined && a.installKey !== false) {
      const pub = ensureKey()
      await runAdhoc(client, name, 'harden', { SU_ACTION: 'install-key', SU_PUBKEY: pub })
      try {
        const probe = await connect(server, { keyOnly: true })
        probe.end()
        keyInstalled = true
        server.auth = 'key'
      } catch (e) {
        hints.push(`key login did not work after installing the key (${/** @type {Error} */ (e).message}); keeping password login`)
      }
    }
    if (a.password !== undefined) {
      deleteSecret(name)
      if (!keyInstalled || a.keepPassword) { setSecret(name, 'password', a.password); stored = 'password' }
      else if (user !== 'root' && /** @type {any} */ (facts).sudo === 'password') { setSecret(name, 'sudo', a.password); stored = 'sudo' }
      if (keyInstalled) hints.push('The password went through the chat. Change it on the server (passwd) or lock password login: server-use harden ' + name + ' --lock-password --yes')
    }

    inventory.upsert(name, {
      host, port, user, auth: server.auth, key: a.key, tags: server.tags, policy: server.policy,
      facts, added: new Date().toISOString().slice(0, 10), note: a.note,
    })
    if (!readNote(name)) appendNote(name, `added ${user}@${host}:${port} (${facts.os || 'unknown OS'})`)
  } catch (e) {
    client.end() // not adopted by the pool yet: nobody else would close it
    throw e
  }
  ctx.pool.adopt(name, client)
  audit({ agent: ctx.agent, op: 'add', host: name, target: `${user}@${host}:${port}`, hostkey: hostkey?.fingerprint, keyInstalled })
  return {
    name, host, port, user, auth: server.auth, policy: server.policy, tags: server.tags,
    hostkey: { fingerprint: hostkey?.fingerprint, status: hostkey?.status },
    keyInstalled, secretStored: stored, secretBackend: backend(), facts, hints,
  }
}

/** op "servers.list" */
export function list(/** @type {Ctx} */ ctx) {
  const states = ctx.pool.states()
  return { servers: inventory.list().map((s) => ({ ...s, facts: undefined, connection: states[s.name]?.state || 'idle', os: s.facts?.os })) }
}

/** op "servers.show": {name} */
export function show(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const s = inventory.get(a.name)
  const secrets = ['password', 'sudo', 'passphrase'].filter((k) => getSecret(s.name, k) !== undefined)
  return { server: s, connection: ctx.pool.states()[s.name] || { state: 'idle' }, secrets, secretBackend: backend(), notes: readNote(s.name), notesPath: notesPath(s.name) }
}

/** op "servers.set": {name, fields: {k: v}, secret?: {kind, value}} */
export function set(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  inventory.get(a.name)
  if (a.secret) {
    const kind = { password: 'password', 'sudo-password': 'sudo', sudo: 'sudo', passphrase: 'passphrase' }[/** @type {string} */ (a.secret.kind)]
    if (!kind) throw new UsageError('secret must be password, sudo-password or passphrase')
    if (a.secret.value === '' || a.secret.value === undefined) deleteSecret(a.name, kind)
    else setSecret(a.name, kind, a.secret.value)
    // No drop: secrets are read on use (sudo) or at the next login, and dropping would kill commands in flight.
  }
  /** @type {Record<string, unknown>} */
  const f = {}
  for (const [k, v] of Object.entries(a.fields || {})) {
    if (k === 'port') f.port = Number(v)
    else if (k === 'tags') f.tags = String(v).split(',').map((t) => t.trim()).filter(Boolean)
    else f[k] = v === '' ? undefined : v
  }
  const s = Object.keys(f).length ? inventory.upsert(a.name, f) : inventory.get(a.name)
  if (['host', 'port', 'user', 'key', 'auth'].some((k) => k in f)) ctx.pool.drop(a.name)
  audit({ agent: ctx.agent, op: 'set', host: a.name, fields: Object.keys(f), secret: a.secret ? a.secret.kind : undefined })
  return { server: s }
}

/** op "servers.rm": {name} — keeps pinned host keys and notes. */
export function rm(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const s = inventory.get(a.name)
  ctx.pool.drop(a.name)
  inventory.remove(a.name)
  deleteSecret(a.name)
  audit({ agent: ctx.agent, op: 'rm', host: a.name })
  const forget = hostkeys.forgetHint(s.host, s.port || 22)
  const pin = forget ? [`pinned host key (trust --reset needs the entry; to forget it now, ${forget})`] : []
  return { removed: a.name, kept: [...pin, `notes (${notesPath(a.name)})`] }
}

/** op "trust.reset": {name} */
export function trustReset(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const s = inventory.get(a.name)
  ctx.pool.drop(a.name)
  const n = hostkeys.forget(s.host, s.port || 22)
  audit({ agent: ctx.agent, op: 'trust-reset', host: a.name })
  return { name: a.name, forgotten: n, next: 'the next connection pins whatever key the server presents — verify it out of band' }
}

/** op "facts": {targets} — re-collect OS/tooling facts and store them. */
export async function refreshFacts(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const names = inventory.resolveTargets(a.targets)
  const results = await fanOut(names, async (name) => {
    const r = await ctx.pool.with(name, (conn) => rawExec(conn, { command: 'sh -s', stdin: scriptSource('facts'), timeoutMs: 60_000 }))
    if (r.exit !== 0) throw new SuError('REMOTE', r.stderr.text.trim() || `facts.sh exit ${r.exit}`)
    const facts = pickFacts(kv(r.stdout.text))
    inventory.upsert(name, { facts })
    return { host: name, exit: 0, facts }
  })
  return { results }
}

/** op "notes": {name, append?} */
export function notes(/** @type {Ctx} */ _ctx, /** @type {any} */ a) {
  inventory.get(a.name)
  if (a.append) appendNote(a.name, a.append)
  return { name: a.name, path: notesPath(a.name), notes: readNote(a.name) }
}

/**
 * Parse ~/.ssh/config Host blocks (first value wins, like OpenSSH). Wildcard hosts and Include are skipped.
 * @returns {{name: string, host: string, port: number, user?: string, key?: string}[]}
 */
export function parseSshConfig(/** @type {string} */ text) {
  /** @type {Map<string, Record<string, string>>} */
  const blocks = new Map()
  /** @type {string[]} */ let current = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^([^\s=]+)\s*=?\s*(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      current = value.split(/\s+/).filter((h) => !/[*?!]/.test(h))
      for (const h of current) if (!blocks.has(h)) blocks.set(h, {})
      continue
    }
    if (key === 'match') { current = []; continue }
    for (const h of current) {
      const b = /** @type {Record<string, string>} */ (blocks.get(h))
      if (!(key in b)) b[key] = value
    }
  }
  return [...blocks].map(([name, b]) => ({
    name: name.replace(/[^a-zA-Z0-9_.-]/g, '-'), host: b.hostname || name, port: b.port ? Number(b.port) : 22, user: b.user,
    key: b.identityfile,
  }))
}

/** op "servers.import": {path?, dryRun?, force?, defaultUser?} */
export function importSshConfig(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const path = a.path || join(sshDir(), 'config')
  if (!existsSync(path)) throw new UsageError(`no ssh config at ${path}`)
  const found = parseSshConfig(readFileSync(path, 'utf8'))
  const inv = inventory.load()
  const out = []
  for (const h of found) {
    const exists = !!inv[h.name]
    const entry = { ...h, user: h.user || a.defaultUser || 'root' }
    if (exists && !a.force) { out.push({ ...entry, action: 'skipped (exists)' }); continue }
    if (!a.dryRun) inventory.upsert(h.name, { host: entry.host, port: entry.port, user: entry.user, key: entry.key, auth: 'key', policy: 'confirm', tags: ['imported'], added: new Date().toISOString().slice(0, 10) })
    out.push({ ...entry, action: a.dryRun ? 'would import' : 'imported' })
  }
  if (!a.dryRun) audit({ agent: ctx.agent, op: 'import', path, count: out.filter((o) => o.action === 'imported').length })
  return { path, servers: out, hint: 'Test with: server-use status all — host keys are pinned on first contact (or taken from ~/.ssh/known_hosts).' }
}
