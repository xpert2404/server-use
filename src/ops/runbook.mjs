// @ts-check
// Runbooks: fixes the user approved once (`runbook add ... --yes`), which the agent can then run with `run`, no --yes.
//
// Why this is safe to run unattended:
// - The approved text is pinned by a sha256 over everything that changes what runs or where (script, verify,
//   parameters, sudo, targets, limit). `run` recomputes it and refuses a runbook that was edited afterwards.
// - Parameters are enumerated at approval. A value must be on its list, and it reaches the server only as an exported
//   variable (SU_P_<key>, quoted by shq), never inside the script text.
// - Targets are the approved scope, the rate limit is counted from the audit log, readonly servers stay readonly.
// runbooks.yaml is no boundary against an agent that can edit files in ~/.server-use (neither is servers.yaml);
// the boundary is the host's approval prompt for `runbook add` / `--yes` (see `server-use permissions`).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import YAML from 'yaml'
import * as inventory from '../inventory.mjs'
import { check } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { file, ensureHome } from '../paths.mjs'
import { SuError, UsageError, parseDuration, shq } from '../util.mjs'
import { rawExec, withSudo, shellText, fanOut, DEFAULT_TIMEOUT_MS } from './exec.mjs'
import { appendNote } from './servers.mjs'

/** @typedef {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} Ctx */
/**
 * @typedef {{script: string, sha256: string, targets: string, servers: Record<string, {host: string, port: number, user: string}>, params: Record<string, string[]>, verify?: string,
 *   sudo?: boolean, limit: string, approvedAt: string, approvedBy: string}} Runbook
 */

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/ // the cron / job name rule
const KEY = /^[a-z][a-z0-9_]{0,31}$/
const MAX_TEXT = 64 * 1024
const MAX_VALUE = 200
const VERIFY_TRIES = 5
const VERIFY_DELAY_S = 3

// ---- storage: ~/.server-use/runbooks.yaml, mode 600 ----

const path = () => file('runbooks.yaml')

/** @returns {Record<string, Runbook>} */
export function load() {
  const p = path()
  if (!existsSync(p)) return {}
  /** @type {any} */ let doc
  try { doc = YAML.parse(readFileSync(p, 'utf8')) } catch (e) { throw new SuError('RUNBOOKS', `runbooks.yaml is invalid: ${/** @type {Error} */ (e).message}`) }
  if (doc == null) return {}
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new SuError('RUNBOOKS', 'runbooks.yaml is invalid: expected one entry per runbook name')
  return doc
}

function save(/** @type {Record<string, Runbook>} */ all) {
  ensureHome()
  const text = '# Approved runbooks. Do not edit: `server-use run` refuses an entry whose text no longer matches its sha256.\n' + YAML.stringify(all, { lineWidth: 0 })
  const back = YAML.parse(text) ?? {}
  for (const [name, rb] of Object.entries(all)) {
    if (digest(back[name]) !== digest(rb)) throw new SuError('RUNBOOKS', `could not store runbook ${name} byte for byte; simplify its script`)
  }
  const tmp = path() + '.tmp'
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path())
}

/** sha256 of everything that decides what runs, where and how often (not of the approval metadata). */
export function digest(/** @type {Runbook} */ rb) {
  const params = Object.fromEntries(Object.entries(rb.params || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const servers = Object.entries(rb.servers || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, s]) => [name, s?.host, s?.port, s?.user])
  return createHash('sha256').update(JSON.stringify([rb.script, rb.verify || '', params, !!rb.sudo, rb.targets, servers, rb.limit])).digest('hex')
}

const intact = (/** @type {Runbook} */ rb) => digest(rb) === rb.sha256

// ---- validation ----

function args(/** @type {unknown} */ a, /** @type {string[]} */ allowed) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new UsageError('runbook arguments must be an object')
  const extra = Object.keys(a).filter((key) => !allowed.includes(key))
  if (extra.length) throw new UsageError(`unsupported runbook fields: ${extra.join(', ')}`)
}

function needName(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !NAME.test(v)) throw new UsageError(`runbook name must match ${NAME} (got "${v ?? ''}")`)
  return v
}

function text(/** @type {string} */ what, /** @type {unknown} */ v) {
  if (typeof v !== 'string') throw new UsageError(`${what} must be text`)
  const t = v.replace(/\r\n/g, '\n')
  if (!t.trim()) throw new UsageError(`${what} is empty`)
  if (t.includes('\0')) throw new UsageError(`${what} contains a NUL byte`)
  if (Buffer.byteLength(t) > MAX_TEXT) throw new UsageError(`${what} is larger than ${MAX_TEXT / 1024} KB`)
  return t
}

/**
 * ["unit=caddy,searxng", "sig=TERM"] → {unit: ["caddy", "searxng"], sig: ["TERM"]}
 * @param {unknown} specs
 */
export function parseParams(specs) {
  /** @type {Record<string, string[]>} */ const out = {}
  for (const spec of Array.isArray(specs) ? specs : specs == null ? [] : [specs]) {
    const s = String(spec)
    const i = s.indexOf('=')
    const key = s.slice(0, i)
    if (i < 1 || !KEY.test(key)) throw new UsageError(`bad --param "${s}" (use key=value1,value2 ; key matches ${KEY})`)
    if (Object.hasOwn(out, key)) throw new UsageError(`--param ${key} given twice`)
    const values = [...new Set(s.slice(i + 1).split(',').map((x) => x.trim()))]
    for (const v of values) {
      if (!v || v.length > MAX_VALUE || /[\n\r\0]/.test(v)) throw new UsageError(`bad value for --param ${key}: 1 to ${MAX_VALUE} characters, no newline (commas separate values)`)
    }
    out[key] = values
  }
  return out
}

/** "3/1h" → {max: 3, ms: 3600000} */
export function parseLimit(/** @type {unknown} */ spec) {
  const m = /^(\d{1,4})\/(\S+)$/.exec(String(spec ?? '').trim())
  const ms = m ? parseDuration(m[2]) : 0
  if (!m || Number(m[1]) < 1 || ms < 1000 || ms > 7 * 86_400_000) throw new UsageError(`bad --limit "${spec}" (use N/<duration> between 1s and 7d, e.g. 3/1h)`)
  return { max: Number(m[1]), ms }
}

/** Checks a run request against the declared parameters; returns [key, value] pairs in declaration order. */
export function checkParams(/** @type {Runbook} */ rb, /** @type {unknown} */ given) {
  if (given != null && (typeof given !== 'object' || Array.isArray(given))) throw new UsageError('parameters must be an object of key=value pairs')
  const g = /** @type {Record<string, unknown>} */ (given || {})
  for (const k of Object.keys(g)) {
    if (!Object.hasOwn(rb.params, k)) throw new UsageError(`unknown parameter "${k}" (this runbook declares: ${Object.keys(rb.params).join(', ') || 'none'})`)
  }
  return Object.entries(rb.params).map(([k, allowed]) => {
    if (!Object.hasOwn(g, k)) throw new UsageError(`missing parameter ${k}= (allowed: ${allowed.join(' | ')})`)
    if (typeof g[k] !== 'string' || !allowed.includes(g[k])) throw new UsageError(`${k}=${JSON.stringify(g[k])} is not an approved value (allowed: ${allowed.join(' | ')})`)
    return /** @type {[string, string]} */ ([k, g[k]])
  })
}

const identity = (/** @type {inventory.Server} */ s) => ({ host: s.host, port: s.port ?? 22, user: s.user })

/** An approval pins aliases AND their login destination, even when it was made for all or a tag. */
function approvedServer(/** @type {Runbook} */ rb, /** @type {string} */ host) {
  const server = inventory.get(host)
  if (!Object.hasOwn(rb.servers, host)) throw new UsageError(`${host} is outside the approved targets (${Object.keys(rb.servers).join(', ')})`)
  const pinned = rb.servers[host]
  if (server.host !== pinned.host || (server.port ?? 22) !== pinned.port || server.user !== pinned.user) {
    throw new UsageError(`${host}'s host, port or user changed since approval; ask the user to re-approve the runbook`)
  }
  return server
}

const paramText = (/** @type {[string, string][] | Record<string, string>} */ p) =>
  (Array.isArray(p) ? p : Object.entries(p)).map(([k, v]) => `${k}=${v}`).join(' ')

function get(/** @type {string} */ name) {
  needName(name)
  const all = load()
  if (typeof name !== 'string' || !Object.hasOwn(all, name)) {
    const known = Object.keys(all)
    throw new UsageError(`unknown runbook "${name ?? ''}" (${known.length ? `approved: ${known.join(', ')}` : 'none approved yet'})`)
  }
  const rb = all[name]
  if (typeof rb?.script !== 'string' || typeof rb.targets !== 'string' || typeof rb.limit !== 'string' || typeof rb.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(rb.sha256) ||
      typeof rb.params !== 'object' || !rb.params || Array.isArray(rb.params) || typeof rb.servers !== 'object' || !rb.servers || Array.isArray(rb.servers) || !Object.keys(rb.servers).length) {
    throw new UsageError(`runbook ${name} in runbooks.yaml is damaged; ask the user to re-add it`)
  }
  for (const [k, values] of Object.entries(rb.params)) {
    if (!KEY.test(k) || !Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string' || !v || v.length > MAX_VALUE || /[\n\r\0]/.test(v))) {
      throw new UsageError(`runbook ${name} has invalid parameters; ask the user to re-add it`)
    }
  }
  if ((rb.verify != null && typeof rb.verify !== 'string') || (rb.sudo != null && typeof rb.sudo !== 'boolean') ||
      Object.entries(rb.servers).some(([host, s]) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host) || !s || typeof s.host !== 'string' || typeof s.user !== 'string' ||
        !Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) {
    throw new UsageError(`runbook ${name} has invalid approval fields; ask the user to re-add it`)
  }
  return { name, rb }
}

// ---- add / ls / show / rm ----

/**
 * op "runbook.add": {targets, name, script, verify?, params?: ["k=v1,v2"], limit?, sudo?, yes}
 * `yes` is the human approval: without it this always answers CONFIRM, whatever the server policies are.
 * @param {Ctx} ctx @param {any} a
 */
export function add(ctx, a) {
  args(a, ['sub', 'targets', 'name', 'script', 'verify', 'params', 'limit', 'sudo', 'yes'])
  const name = needName(a.name)
  const targets = String(a.targets ?? '').split(',').map((s) => s.trim()).filter(Boolean).join(',')
  const hosts = inventory.resolveTargets(targets)
  const script = text('script', a.script)
  if (a.sudo != null && typeof a.sudo !== 'boolean') throw new UsageError('sudo must be a boolean')
  const verify = a.verify != null ? text('verify', a.verify) : undefined
  const params = parseParams(a.params)
  const limit = String(a.limit ?? '3/1h').trim()
  parseLimit(limit)
  for (const m of `${script}\n${verify ?? ''}`.matchAll(/\bSU_P_([A-Za-z0-9_]+)/g)) {
    if (!Object.hasOwn(params, m[1])) throw new UsageError(`the script uses $SU_P_${m[1]} but no --param ${m[1]}=<values> is declared`)
  }
  /** @type {Runbook} */
  const servers = Object.fromEntries(hosts.map((host) => [host, identity(inventory.get(host))]))
  const rb = { script, sha256: '', targets, servers, params, ...(verify ? { verify } : {}), sudo: !!a.sudo, limit, approvedAt: new Date().toISOString(), approvedBy: ctx.agent }
  rb.sha256 = digest(rb)
  const sha = rb.sha256.slice(0, 8)
  if (a.yes !== true) {
    throw new SuError('CONFIRM', `runbook add always needs the user's approval. Show the user the script, the targets (${targets} → ${hosts.join(', ')}), ` +
      `the parameters (${Object.entries(params).map(([k, v]) => `${k} = ${v.join('|')}`).join('; ') || 'none'}), the verify command, sudo (${rb.sudo ? 'yes' : 'no'}) and the limit (${limit}); ` +
      `this is sha ${sha}. Repeat with --yes only after they agree.`, { sha })
  }
  const all = load()
  const replaced = Object.hasOwn(all, name) ? String(all[name]?.sha256 ?? '').slice(0, 8) : undefined
  save({ ...all, [name]: rb })
  audit({ agent: ctx.agent, op: 'runbook.add', cmd: name, targets, sha: rb.sha256, sudo: rb.sudo, limit, ...(replaced ? { replaced } : {}) })
  return { name, sha: rb.sha256, targets, hosts, params, verify: !!verify, sudo: rb.sudo, limit, ...(replaced ? { replaced } : {}) }
}

function summary(/** @type {string} */ name, /** @type {Runbook} */ rb) {
  if (!rb || typeof rb !== 'object' || Array.isArray(rb)) return { name, state: 'DAMAGED' }
  return {
    name, targets: rb.targets, hosts: Object.keys(rb.servers || {}), servers: rb.servers, params: rb.params, verify: rb.verify, sudo: !!rb.sudo, limit: rb.limit,
    sha: rb.sha256, approvedAt: rb.approvedAt, approvedBy: rb.approvedBy, state: intact(rb) ? 'ok' : 'MODIFIED',
  }
}

/** Print configuration only. Prefix rules grant CLI access; the daemon enforces every runbook constraint. */
export function permissions(/** @type {Ctx} */ _ctx, /** @type {any} */ a = {}) {
  args(a, ['format'])
  const format = a.format || 'claude'
  if (!['claude', 'codex'].includes(format)) throw new UsageError('permissions --format must be claude or codex')
  const reads = [['ls'], ['show'], ['status'], ['logs'], ['check'], ['doctor'], ['job', 'ls'], ['job', 'status'], ['job', 'logs'], ['job', 'wait'], ['cron', 'ls'], ['cron', 'logs'], ['runbook', 'ls'], ['runbook', 'show']]
  const prefixes = reads.map((words) => ['server-use', ...words])
  for (const [name] of Object.entries(load())) {
    const { rb } = get(name)
    if (!intact(rb)) continue
    for (const host of Object.keys(rb.servers)) {
      try {
        const server = approvedServer(rb, host)
        if (server.policy !== 'readonly') prefixes.push(['server-use', 'run', host, name])
      } catch { /* removed or reassigned aliases cannot receive unattended grants */ }
    }
  }
  const note = 'Review and merge these CLI rules into your agent configuration. Run grants cover only named approved scripts and servers; appended flags cannot bypass the hash, parameter, destination, readonly or rate checks. Shell rules do not grant MCP tools. Your agent sandbox and existing stricter rules still apply.'
  if (format === 'claude') {
    const config = { permissions: { allow: prefixes.map((p) => `Bash(${p.join(' ')} *)`) } }
    return { format, path: '.claude/settings.local.json', config, text: JSON.stringify(config, null, 2) + '\n', note, source: 'https://code.claude.com/docs/en/permissions' }
  }
  const rules = prefixes.map((p) => `prefix_rule(pattern=${JSON.stringify(p)}, decision="allow")`).join('\n') + '\n'
  return { format, path: '~/.codex/rules/server-use.rules', text: rules, note, source: 'https://developers.openai.com/codex/rules' }
}

/** op "runbook.ls" */
export function ls() {
  return { runbooks: Object.entries(load()).map(([n, rb]) => summary(n, rb)) }
}

/** op "runbook.show": {name} */
export function show(/** @type {Ctx} */ _ctx, /** @type {any} */ a) {
  const { name, rb } = get(a.name)
  return { ...summary(name, rb), script: rb.script }
}

/** op "runbook.rm": {name}. Removing only takes capability away, so it needs no approval. */
export function rm(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const name = needName(a.name)
  const all = load()
  if (!Object.hasOwn(all, name)) throw new UsageError(`unknown runbook "${name}"`)
  delete all[name]
  save(all)
  audit({ agent: ctx.agent, op: 'runbook.rm', cmd: name })
  return { removed: name }
}

// ---- run ----

/** Reservations count even when SSH fails or the daemon is stopped before the result can be logged. */
export function runsSince(/** @type {string} */ runbook, /** @type {string} */ host, /** @type {number} */ since) {
  const p = file('audit.jsonl')
  if (!existsSync(p)) return 0
  let n = 0
  // ponytail: scans the whole log on every run; fine for a log of a few MB, add rotation or an index beyond that.
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(l)
      if ((e.op === 'run.started' || (e.op === 'run' && !e.reserved)) && e.runbook === runbook && e.host === host && Date.parse(e.ts) >= since) n++
    } catch { /* a torn line */ }
  }
  return n
}

// The function wrapper makes the shell parse the whole script before it runs (a syntax error runs nothing) and
// keeps anything the script starts away from its stdin, which would eat the rest of it (see remote/README.md).
const wrap = (/** @type {string} */ script) => `__su_runbook() {\n${script}\n}\n__su_runbook </dev/null\n`

const verifyLoop = (/** @type {string} */ verify) => `__su_verify() {
${verify}
}
n=0
while [ "$n" -lt ${VERIFY_TRIES} ]; do
  n=$((n + 1))
  out=$(__su_verify 2>&1 </dev/null)
  rc=$?
  if [ "$rc" -eq 0 ]; then echo "verify ok (attempt $n)"; exit 0; fi
  [ "$n" -lt ${VERIFY_TRIES} ] && sleep ${VERIFY_DELAY_S}
done
echo "verify FAILED after ${VERIFY_TRIES} attempts (last exit $rc); not retried"
printf '%s\\n' "$out" | tail -n 20
exit 1
`

/**
 * op "run": {target, runbook, params?: {k: v}, dryRun?}
 * A run cannot override the approved limit. The user can re-approve a different limit with runbook add --yes.
 * @param {Ctx} ctx @param {any} a
 */
export async function run(ctx, a) {
  try {
    return await runChecked(ctx, a)
  } catch (e) {
    const err = /** @type {any} */ (e)
    audit({ agent: ctx.agent, op: 'run.refused', runbook: String(a?.runbook ?? ''), target: String(a?.target ?? ''), reason: `${err.code}: ${err.message}`.slice(0, 300) })
    throw e
  }
}

async function runChecked(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  args(a, ['target', 'runbook', 'params', 'dryRun', 'yes'])
  if (a.dryRun != null && typeof a.dryRun !== 'boolean') throw new UsageError('dryRun must be a boolean')
  const { name: rbName, rb } = get(a.runbook)
  const sha = rb.sha256
  if (!intact(rb)) {
    throw new UsageError(`runbook ${rbName} was changed after the user approved it (approved sha ${String(sha).slice(0, 8)}, now ${digest(rb).slice(0, 8)}); it will not run. ` +
      `Ask the user to review it (server-use runbook show ${rbName}) and re-approve it with runbook add ... --yes`)
  }
  const names = inventory.resolveTargets(a.target)
  const scope = new Set(Object.keys(rb.servers))
  const outside = names.filter((n) => !scope.has(n))
  if (outside.length) throw new UsageError(`${outside.join(', ')} ${outside.length > 1 ? 'are' : 'is'} outside the targets approved for runbook ${rbName} (${rb.targets}: ${[...scope].join(', ') || 'no server left'})`)
  const params = checkParams(rb, a.params)
  const lim = parseLimit(rb.limit)
  const ps = paramText(params)
  const head = `runbook ${rbName} (sha ${sha.slice(0, 8)})${ps ? ` ${ps}` : ''}`
  /** @type {Record<string, string>} */
  const env = Object.fromEntries(params.map(([k, v]) => [`SU_P_${k}`, v]))
  const used = (/** @type {string} */ host) => runsSince(rbName, host, Date.now() - lim.ms)

  if (a.dryRun) {
    return {
      dryRun: true,
      results: await fanOut(names, async (host, i = names.indexOf(host)) => {
        check(approvedServer(rb, host), 'run', {})
        const count = `limit ${rb.limit}: ${used(host)} of ${lim.max} used on ${host} (a dry run does not count)`
        const body = i === 0
          ? [`${head} · DRY RUN, nothing was executed`, `runs as: ${rb.sudo ? 'sudo ' : ''}bash (else sh), timeout ${DEFAULT_TIMEOUT_MS / 60_000}m`,
            `env:\n${Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join('\n') || '(none)'}`, `script:\n${rb.script.replace(/\n$/, '')}`,
            rb.verify ? `verify (up to ${VERIFY_TRIES} attempts, ${VERIFY_DELAY_S} s apart):\n${rb.verify.replace(/\n$/, '')}` : 'verify: none', count]
          : [`${head} · DRY RUN, same script and parameters`, count]
        return { host, exit: 0, ms: 0, stdout: { text: body.join('\n') + '\n' } }
      }),
    }
  }

  return {
    results: await fanOut(names, async (host) => {
      try {
        return await runOn(ctx, host, rbName, rb, { env, head, ps, lim })
      } catch (e) {
        const err = /** @type {any} */ (e)
        audit({ agent: ctx.agent, op: 'run.refused', host, runbook: rbName, reason: `${err.code}: ${err.message}`.slice(0, 300) })
        throw e
      }
    }),
  }
}

/**
 * @param {Ctx} ctx @param {string} host @param {string} rbName @param {Runbook} rb
 * @param {{env: Record<string, string>, head: string, ps: string, lim: {max: number, ms: number}}} o
 */
async function runOn(ctx, host, rbName, rb, { env, head, ps, lim }) {
  const server = approvedServer(rb, host)
  check(server, 'run', {}) // readonly still blocks; CONFIRM is skipped by design: the user approved this text
  const used = runsSince(rbName, host, Date.now() - lim.ms)
  if (used >= lim.max) {
    throw new SuError('RATE_LIMIT', `limit ${rb.limit} reached for ${rbName} on ${host} (${used} attempts in that window). Wait for the window to expire or ask the user to re-approve a higher limit (runbook add ... --limit ... --yes). --yes cannot bypass a runbook limit.`)
  }
  // Synchronous check + durable reservation, before the first await: concurrent callers cannot exceed the limit.
  audit({ agent: ctx.agent, op: 'run.started', host, runbook: rbName, sha: rb.sha256, runId: ctx.runId })
  const logBase = file('runs', ctx.runId, `${host}.run-${rbName}`)
  /** @param {string} script @param {number} timeoutMs @param {string} tag */
  const exec = (script, timeoutMs, tag) => ctx.pool.with(host, async (conn) => {
    const { text: command, stdin } = shellText({ script, env })
    const w = /** @type {any} */ (rb.sudo ? await withSudo(conn, server, command) : { command, prefix: '' })
    return rawExec(conn, { command: w.command, stdin: w.prefix + stdin, timeoutMs, signal: ctx.signal, logBase: `${logBase}${tag}`, wrap: w.wrap })
  })
  const r = await exec(wrap(rb.script), DEFAULT_TIMEOUT_MS, '')
  let exit = r.exit
  /** @type {'none'|'skipped'|'ok'|'failed'} */ let verify = 'none'
  let tail = '', vline = ''
  let ms = r.ms
  if (r.exit !== 0 || r.error) verify = rb.verify ? 'skipped' : 'none'
  else if (rb.verify) {
    // Its own channel: retrying a channel that failed to open must never re-run the script.
    const v = await exec(verifyLoop(rb.verify), (VERIFY_TRIES * (VERIFY_DELAY_S + 20)) * 1000, '.verify')
    ms += v.ms
    const lines = (v.stdout.text || v.error?.message || 'verify did not run').trim().split('\n')
    verify = v.exit === 0 ? 'ok' : 'failed'
    if (verify === 'failed') exit = 1
    tail = lines.slice(1).join('\n')
    vline = lines[0]
  }
  const why = verify === 'skipped' ? `script exited ${r.exit}${r.error ? ` (${r.error.code})` : ''}, verify skipped` : verify === 'none' ? 'no verify' : vline
  const out = r.stdout.text
  const stdout = { ...r.stdout, text: `${out}${out && !out.endsWith('\n') ? '\n' : ''}${head} · ${why}\n${tail ? tail + '\n' : ''}` }
  audit({ agent: ctx.agent, op: 'run', host, runbook: rbName, sha: rb.sha256, params: Object.fromEntries(Object.entries(env).map(([k, v]) => [k.slice(5), v])), cmd: [rbName, ps].filter(Boolean).join(' '), sudo: !!rb.sudo, exit, verify, ms, reserved: true, runId: ctx.runId })
  const outcome = `exit ${exit}, ${verify === 'ok' ? 'verify ok' : verify === 'failed' ? 'verify FAILED' : verify === 'skipped' ? 'verify skipped' : 'no verify'}`
  appendNote(host, `run ${[rbName, ps].filter(Boolean).join(' ')} (${ctx.agent}) ${outcome}`)
  return { host, ...r, exit, ms, stdout, runbook: rbName, sha: rb.sha256, verify }
}
