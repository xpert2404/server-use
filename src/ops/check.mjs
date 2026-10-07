// @ts-check
// op "check": remote/check.sh on every target, diffed against the previous check of the same host
// (state/check.json), so the caller sees what is new and what has resolved. One dead host never hides the others.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as inventory from '../inventory.mjs'
import { check as policy } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { file, ensureHome } from '../paths.mjs'
import { runScript } from '../remote.mjs'
import { fanOut } from './exec.mjs'
import { worst } from '../format.mjs'

/** @typedef {{sev: string, kind: string, id: string, text: string, state?: 'new'|'ongoing'}} Item */
/** @typedef {Record<string, {sev: string, since: number}>} HostState  key "<kind>|<id>" */

const SEV = /** @type {Record<string, number>} */ ({ info: 0, warn: 1, crit: 2 })

/** check.sh output → items, partial probes and the server's clock. A `|` in the text is kept (only the first three split). */
export function parseCheck(/** @type {string} */ text) {
  /** @type {Item[]} */ const items = []
  /** @type {{probe: string, reason: string}[]} */ const partial = []
  /** @type {number | undefined} */ let now
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('item=')) {
      const [sev, kind, id, ...rest] = line.slice(5).split('|')
      if (Object.hasOwn(SEV, sev) && /^[a-z][a-z0-9_-]*$/.test(kind) && rest.length) items.push({ sev, kind, id: id ?? '', text: rest.join('|') })
    } else if (line.startsWith('partial=')) {
      const body = line.slice(8)
      const i = body.indexOf(':')
      if (i > 0) partial.push({ probe: body.slice(0, i), reason: body.slice(i + 1) })
    } else if (/^now=[1-9]\d*$/.test(line)) now = Number(line.slice(4))
  }
  // A completion marker must be the last nonempty line, not an earlier marker in clipped output.
  if (!/^now=[1-9]\d*$/.test(text.trim().split('\n').at(-1) || '') || !Number.isSafeInteger(now)) now = undefined
  return { items, partial, now }
}

/**
 * Mark the crit/warn items new (not in prev, or worse than before) or ongoing, list what has resolved, and build the
 * state to keep. Old findings of a probe that could not look this time (partial), or of a host that could not be
 * reached, are carried over: no information is not good news.
 * @param {HostState} prev @param {Item[]} items
 * @param {{partial?: {probe: string}[], reachable?: boolean, now?: number}} [o]
 */
export function diffHost(prev, items, { partial = [], reachable = true, now = Date.now() } = {}) {
  /** @type {HostState} */ const next = {}
  const out = items.map((i) => {
    if (i.sev === 'info') return { ...i }
    const k = `${i.kind}|${i.id}`
    const p = prev[k]
    next[k] = { sev: i.sev, since: p ? p.since : now }
    return /** @type {Item} */ ({ ...i, state: !p || SEV[i.sev] > SEV[p.sev] ? 'new' : 'ongoing' })
  })
  /** @type {{kind: string, id: string, sev: string, since: number}[]} */ const resolved = []
  for (const [k, p] of Object.entries(prev)) {
    if (k in next) continue
    const kind = k.slice(0, k.indexOf('|'))
    const blind = reachable ? partial.some((q) => q.probe === kind || (q.probe === 'disk' && kind === 'inodes')) : kind !== 'connect'
    if (blind) next[k] = p
    else resolved.push({ kind, id: k.slice(kind.length + 1), sev: p.sev, since: p.since })
  }
  return { items: out, resolved, next }
}

const statePath = () => file('state', 'check.json')
/** @returns {Record<string, HostState>} */
function loadState() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([, host]) => host && typeof host === 'object' && !Array.isArray(host))
      .map(([name, host]) => [name, Object.fromEntries(Object.entries(host).filter(([key, value]) => key.includes('|') && value && ['warn', 'crit'].includes(value.sev) && Number.isSafeInteger(value.since) && value.since >= 0 && value.since <= 8_640_000_000_000_000))]))
  } catch { return {} }
}
function saveState(/** @type {Record<string, HostState>} */ state) {
  ensureHome()
  mkdirSync(file('state'), { recursive: true, mode: 0o700 })
  const tmp = statePath() + '.tmp'
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, statePath())
}

/** A host that could not be checked becomes an item of its own. */
function failure(/** @type {any} */ x) {
  const e = x.error
  if (e?.code === 'SUDO') return { sev: 'warn', kind: 'connect', id: 'sudo', text: e.message }
  if (e?.code === 'TIMEOUT') return { sev: 'crit', kind: 'connect', id: 'login', text: 'the check timed out after 60 s' }
  if (e) return { sev: 'crit', kind: 'connect', id: 'login', text: `${e.code === 'UNREACHABLE' ? 'unreachable' : e.code}: ${e.message}` }
  return { sev: 'crit', kind: 'check', id: 'script', text: `check script failed (exit ${x.exit}): ${String(x.stderr?.text || '').trim().slice(-200)}` }
}

/** Exit status of `server-use check`: 10 = something needs a look. With changed: only if that set differs from last time. */
export function checkCode(/** @type {{items: Item[], resolved: unknown[]}[]} */ results, changed = false) {
  const failed = worst(results)
  if (failed) return failed
  const hit = changed
    ? results.some((r) => r.resolved.length || r.items.some((i) => i.state === 'new'))
    : results.some((r) => r.items.some((i) => i.sev !== 'info'))
  return hit ? 10 : 0
}

/**
 * op "check": {targets?, changed?, sudo?}
 * @param {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} ctx @param {any} a
 */
export async function check(ctx, a) {
  const names = inventory.resolveTargets(a.targets || 'all')
  const raw = await fanOut(names, async (name) => {
    const server = inventory.get(name)
    policy(server, 'check', {})
    const r = await runScript(ctx, name, 'check', { SU_CHECK: server.check }, { sudo: a.sudo, timeoutMs: 60_000, full: true })
    audit({ agent: ctx.agent, op: 'check', host: name, sudo: !!a.sudo, exit: r.exit })
    return { host: name, ...r }
  })
  const known = inventory.load()
  const previous = loadState()
  /** @type {Record<string, HostState>} */ const state = Object.create(null)
  for (const h of Object.keys(previous)) if (h in known) state[h] = previous[h]
  const now = Date.now()
  const results = raw.map((/** @type {any} */ x) => {
    const parsed = x.error || x.exit !== 0 ? null : parseCheck(x.stdout.text)
    // exit 0 without the closing now= line means the output was cut or is not ours: never read that as healthy
    const ok = !!parsed && parsed.now !== undefined && !x.stdout?.truncated
    const items = parsed && ok ? parsed.items : [failure(parsed ? { exit: 1, stderr: { text: 'missing completion marker or truncated output' } } : x)]
    const partial = parsed && ok ? parsed.partial : []
    const d = diffHost(previous[x.host] || {}, items, { partial, reachable: ok, now })
    state[x.host] = d.next
    const incomplete = !ok && !x.error && x.exit === 0
    return {
      host: x.host, ms: x.ms, exit: incomplete ? 1 : x.exit,
      ...(x.error ? { error: x.error } : incomplete ? { error: { code: 'REMOTE', message: 'check output was incomplete or truncated' } } : {}),
      items: d.items, resolved: d.resolved, partial,
    }
  })
  saveState(state)
  return { results, changed: !!a.changed, code: checkCode(results, !!a.changed) }
}
