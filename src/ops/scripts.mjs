// @ts-check
// Operations backed by the POSIX scripts in remote/: status, logs, job, cron, env, deploy, harden.
import * as inventory from '../inventory.mjs'
import { check } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { deleteSecret, getSecret, setSecret } from '../secrets.mjs'
import { connect } from '../pool.mjs'
import { runScript, runScriptOk, scriptSource, kv, b64 } from '../remote.mjs'
import { fanOut } from './exec.mjs'
import { ensureKey, appendNote } from './servers.mjs'
import { SuError, UsageError, parseDuration, shq } from '../util.mjs'

/** @typedef {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} Ctx */

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
function needName(/** @type {string} */ what, /** @type {string|undefined} */ v) {
  if (!v || !NAME.test(v)) throw new UsageError(`${what} name must match ${NAME} (got "${v ?? ''}")`)
  return v
}

/** One single-target op that just returns the script's text output. */
async function single(/** @type {Ctx} */ ctx, /** @type {string} */ target, /** @type {string} */ op, /** @type {string} */ script, /** @type {Record<string, unknown>} */ vars, /** @type {{text?: string, yes?: boolean, always?: string, sudo?: boolean, timeoutMs?: number}} */ o = {}) {
  const names = inventory.resolveTargets(target)
  return {
    results: await fanOut(names, async (name) => {
      check(inventory.get(name), op, o)
      const r = await runScript(ctx, name, script, vars, { sudo: o.sudo, timeoutMs: o.timeoutMs })
      const logged = Object.entries(vars).filter(([k, v]) => v !== undefined && !k.includes('PAYLOAD') && !k.includes('SELF') && !k.includes('PUBKEY'))
        .map(([k, v]) => [k.replace(/^SU_/, '').toLowerCase(), String(v).replace(/:\/\/[^/@\s]+@/g, '://***@')])
      audit({ agent: ctx.agent, op, host: name, ...Object.fromEntries(logged), exit: r.exit })
      return { host: name, ...r }
    }),
  }
}

// ---- status ----

function statusLine(/** @type {Record<string, string>} */ s) {
  const up = Number(s.uptime_s)
  const upText = !up ? '?' : up > 86400 ? `${Math.floor(up / 86400)}d` : up > 3600 ? `${Math.floor(up / 3600)}h` : `${Math.floor(up / 60)}m`
  const parts = [`up ${upText}`, `load ${s.load1 ?? '?'}`, `mem ${s.mem_used_pct ?? '?'}%`, `disk / ${s.disk_root_used_pct ?? '?'}%`]
  if (s.failed_units && s.failed_units !== '-') parts.push(`failed units ${s.failed_units}${s.failed_list ? ` (${s.failed_list})` : ''}`)
  if (s.containers_total && s.containers_total !== '-') parts.push(`docker ${s.containers_running}/${s.containers_total}`)
  if (s.reboot_required === 'yes') parts.push('REBOOT REQUIRED')
  const warn = Number(s.disk_root_used_pct) >= 90 || Number(s.mem_used_pct) >= 95 || (s.failed_units && s.failed_units !== '-' && s.failed_units !== '0')
  return { ok: !warn, line: parts.join(' · ') }
}

/** op "status": {targets} */
export async function status(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const names = inventory.resolveTargets(a.targets || 'all')
  const results = await fanOut(names, async (name) => {
    const r = await runScript(ctx, name, 'status', {}, { timeoutMs: 60_000 })
    const data = kv(r.stdout.text)
    return { host: name, exit: r.exit, ms: r.ms, data, ...statusLine(data), stderr: r.stderr }
  })
  return { results }
}

// ---- logs ----

/** op "logs": {target, source, lines?, since?, sudo?} */
export function logs(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  if (!a.source) throw new UsageError('logs needs a source: systemd unit, docker container or file path')
  return single(ctx, a.target, 'logs', 'logs', { SU_SOURCE: a.source, SU_LINES: Number(a.lines || 200), SU_SINCE: a.since || '' }, { sudo: a.sudo })
}

// ---- jobs: long runs that survive disconnects ----

/** op "job": {action: start|ls|logs|stop|status, target, name?, command?, script?, lines?, yes?} */
export async function job(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const action = a.action
  if (!['start', 'ls', 'logs', 'stop', 'status'].includes(action)) throw new UsageError('job action: start | ls | logs | stop | status')
  const name = action === 'ls' ? '' : needName('job', a.name)
  const payload = action === 'start' ? (a.script ?? a.command) : undefined
  if (action === 'start' && !payload) throw new UsageError('job start needs a command or --script')
  const out = await single(ctx, a.target, `job.${action}`, 'job', { SU_ACTION: action, SU_NAME: name, SU_LINES: Number(a.lines || 100), SU_PAYLOAD_B64: payload ? b64(payload) : undefined }, { text: payload, yes: a.yes, sudo: a.sudo })
  if (action === 'start') for (const r of out.results) if (r.exit === 0) appendNote(r.host, `job ${name} started: ${oneLine(payload)}`)
  return out
}

// ---- cron: real system cron, in a marked block; foreign lines are never touched ----

const CRON = /^(@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|(\S+\s+){4}\S+)$/

/** op "cron": {action: ls|add|rm|run|logs, target, name?, schedule?, command?, script?, lock?, lines?, yes?} */
export async function cron(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const action = a.action
  if (!['ls', 'add', 'rm', 'run', 'logs'].includes(action)) throw new UsageError('cron action: ls | add | rm | run | logs')
  const name = action === 'ls' ? '' : needName('cron job', a.name)
  const payload = action === 'add' ? (a.script ?? a.command) : undefined
  if (action === 'add') {
    if (!a.schedule || !CRON.test(String(a.schedule).trim())) throw new UsageError(`bad schedule "${a.schedule ?? ''}" (5 fields like "0 6 * * 1-5" or @daily)`)
    if (!payload) throw new UsageError('cron add needs a command or --script')
  }
  const out = await single(ctx, a.target, `cron.${action}`, 'cron', {
    SU_ACTION: action, SU_NAME: name, SU_SCHEDULE: action === 'add' ? String(a.schedule).trim() : undefined,
    SU_PAYLOAD_B64: payload ? b64(payload) : undefined, SU_LOCK: a.lock === false ? 0 : 1, SU_LINES: Number(a.lines || 100),
  }, { text: payload, yes: a.yes, sudo: a.sudo, timeoutMs: action === 'run' ? a.timeoutMs || 10 * 60_000 : 60_000 })
  for (const r of out.results) {
    if (r.exit !== 0) continue
    if (action === 'add') appendNote(r.host, `cron ${name}: ${a.schedule} → ${oneLine(payload)}`)
    if (action === 'rm') appendNote(r.host, `cron ${name} removed`)
  }
  return out
}

// ---- env: .env of an app (values arrive base64 on stdin, never in argv) ----

/** op "env": {action: ls|set|rm, target, app, key?, value?, base?} */
export function env(/** @type {Ctx} */ ctx, /** @type {any} */ a) {
  const action = a.action
  if (!['ls', 'set', 'rm'].includes(action)) throw new UsageError('env action: ls | set | rm')
  const app = needName('app', a.app)
  if (action !== 'ls' && !ENV_KEY.test(a.key || '')) throw new UsageError(`bad key "${a.key ?? ''}"`)
  if (action === 'set' && a.value === undefined) throw new UsageError('env set needs a value (pass it on stdin)')
  return single(ctx, a.target, `env.${action}`, 'env', {
    SU_ACTION: action, SU_APP: app, SU_KEY: a.key, SU_BASE: a.base, SU_PAYLOAD_B64: action === 'set' ? b64(a.value) : undefined,
  }, { sudo: a.sudo })
}

// ---- deploy ----

/** "owner/repo", "github.com/owner/repo", full URLs → clone URL. */
export function repoUrl(/** @type {string} */ repo) {
  if (!repo) throw new UsageError('deploy needs a repo (owner/repo, github.com/owner/repo or a git URL)')
  if (/^(https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(repo)) return repo
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo.replace(/\.git$/, '')}.git`
  if (/^[\w.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+/.test(repo)) return `https://${repo.replace(/\.git$/, '')}.git`
  if (repo.startsWith('/') || repo.startsWith('~')) return repo // a repo already on the server
  throw new UsageError(`can't read repo "${repo}"`)
}

/**
 * deploy.sh's last line "SU_RESULT base=… release=… sha=… service=…" → fields. The last such line wins (a build
 * may print one too), and base/release may contain spaces.
 * @returns {Record<string, string>}
 */
export function parseResult(/** @type {string} */ stdout) {
  const line = [...stdout.matchAll(/^SU_RESULT (.*)$/gm)].at(-1)?.[1] ?? ''
  return { ...line.match(/^base=(?<base>.*) release=(?<release>.*) sha=(?<sha>\S*) service=(?<service>.*)$/)?.groups }
}

/** Interval → cron schedule for the pull check. */
function everyToCron(/** @type {string} */ every) {
  const min = Math.max(1, Math.round(parseDuration(every) / 60_000))
  if (min < 60) return `*/${min} * * * *`
  const h = Math.round(min / 60)
  return h >= 24 ? '17 3 * * *' : `7 */${h} * * *`
}

/**
 * op "deploy": {action: deploy|ls|rollback|key, target, repo?, name?, ref?, base?, run?, build?, health?, keep?, watch?, sudo?, yes?}
 * @param {Ctx} ctx @param {any} a
 */
export async function deploy(ctx, a) {
  const action = a.action || 'deploy'
  if (!['deploy', 'ls', 'rollback', 'key'].includes(action)) throw new UsageError('deploy action: deploy | ls | rollback | key')
  const url = action === 'deploy' ? repoUrl(a.repo) : undefined
  const name = needName('app', a.name || (url ? url.replace(/\.git$/, '').split(/[/:]/).pop() : undefined))
  // a bad --watch must fail before anything is deployed, not after
  const schedule = a.watch && action === 'deploy' ? everyToCron(a.watch) : undefined
  if (schedule) needName('cron job', `deploy-${name}`)
  const vars = {
    SU_ACTION: action, SU_NAME: name, SU_REPO: url, SU_REF: a.ref, SU_BASE: a.base, SU_RUN: a.run, SU_BUILD: a.build,
    SU_HEALTH: a.health, SU_KEEP: a.keep || 3, SU_WATCH: a.watch ? 1 : undefined, SU_SELF_B64: a.watch ? b64(scriptSource('deploy')) : undefined,
  }
  const text = [a.run, a.build, a.health].filter(Boolean).join('\n')
  const out = await single(ctx, a.target, `deploy.${action}`, 'deploy', vars, { text, yes: a.yes, sudo: a.sudo, timeoutMs: 30 * 60_000 })
  for (const r of out.results) {
    if (r.exit !== 0 || action !== 'deploy') continue
    const res = parseResult(r.stdout.text)
    Object.assign(r, { deployed: res })
    appendNote(r.host, `deploy ${name} ${res.sha || ''} → ${res.release || res.base || ''}${a.run ? ` (run: ${oneLine(a.run)})` : ''}${res.service ? ` service ${res.service}` : ''}`)
    if (schedule && res.base) {
      const c = await cron(ctx, {
        action: 'add', target: r.host, name: `deploy-${name}`, schedule, yes: true, sudo: a.sudo,
        command: `SU_ACTION=watch-check sh ${shq(`${res.base}/.server-use/deploy.sh`)}`,
      })
      Object.assign(r, { watch: c.results[0]?.exit === 0 ? `pull check ${schedule} (cron deploy-${name})` : `watch setup failed: ${c.results[0]?.stderr?.text || c.results[0]?.error?.message}` })
    }
  }
  return out
}

// ---- harden ----

/**
 * op "harden": {target, action: install-key|lock-password|agent-user|check, user?, yes?}
 * lock-password proves a fresh key-only login works before and after the change, and reverts otherwise.
 * @param {Ctx} ctx @param {any} a
 */
export async function harden(ctx, a) {
  const action = a.action || 'check'
  if (!['install-key', 'lock-password', 'agent-user', 'check'].includes(action)) throw new UsageError('harden action: install-key | lock-password | agent-user | check')
  const names = inventory.resolveTargets(a.target)
  const pub = ensureKey()
  const results = await fanOut(names, async (name) => {
    const server = inventory.get(name)
    const sudo = server.user !== 'root'
    if (action === 'check') {
      const r = await runScript(ctx, name, 'harden', { SU_ACTION: 'check' }, { sudo })
      return { host: name, ...r }
    }
    if (action === 'install-key') {
      check(server, 'harden', {})
      const r = await runScriptOk(ctx, name, 'harden', { SU_ACTION: 'install-key', SU_PUBKEY: pub })
      audit({ agent: ctx.agent, op: 'harden.install-key', host: name, exit: r.exit })
      return { host: name, ...r }
    }
    if (action === 'agent-user') {
      check(server, 'harden', { always: 'create a user', yes: a.yes })
      const user = a.user || 'agent'
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new UsageError(`bad user name "${user}"`)
      const r = await runScriptOk(ctx, name, 'harden', { SU_ACTION: 'agent-user', SU_AGENT_USER: user, SU_PUBKEY: pub }, { sudo })
      const alias = `${name}-${user}`
      if (!inventory.load()[alias]) {
        inventory.upsert(alias, { host: server.host, port: server.port, user, auth: 'key', tags: [...(server.tags || []), 'least-privilege'], policy: server.policy, added: new Date().toISOString().slice(0, 10) })
      }
      appendNote(name, `agent user "${user}" created (no sudo); inventory alias ${alias}`)
      audit({ agent: ctx.agent, op: 'harden.agent-user', host: name, user, exit: r.exit })
      return { host: name, ...r, alias }
    }
    // lock-password
    check(server, 'harden', { always: 'lock password login', yes: a.yes })
    await runScriptOk(ctx, name, 'harden', { SU_ACTION: 'install-key', SU_PUBKEY: pub })
    await provesKeyLogin(server, 'before the change; nothing was locked')
    const r = await runScriptOk(ctx, name, 'harden', { SU_ACTION: 'lock-password' }, { sudo })
    try {
      await provesKeyLogin(server, 'after the change')
    } catch (e) {
      // Safety revert: it must run even if the caller disconnected meanwhile (an aborted signal would skip it).
      const u = await runScript({ ...ctx, signal: undefined }, name, 'harden', { SU_ACTION: 'unlock-password' }, { sudo })
      throw new SuError('REMOTE', `${/** @type {Error} */ (e).message} — ${u.exit === 0 ? 'password login was re-enabled' : `the revert FAILED (exit ${u.exit}): re-enable password login by hand (PasswordAuthentication yes)`}`)
    }
    inventory.upsert(name, { auth: 'key' })
    // the login password stays the sudo password of a non-root user; keep it for --sudo (as add() does)
    const pw = getSecret(name, 'password')
    if (sudo && pw !== undefined && getSecret(name, 'sudo') === undefined && server.facts?.sudo !== 'nopasswd') setSecret(name, 'sudo', pw)
    deleteSecret(name, 'password')
    appendNote(name, 'password login disabled (key only)')
    audit({ agent: ctx.agent, op: 'harden.lock-password', host: name, exit: r.exit })
    return { host: name, ...r }
  })
  return { results }
}

async function provesKeyLogin(/** @type {inventory.Server & {name: string}} */ server, /** @type {string} */ when) {
  try {
    const c = await connect(server, { keyOnly: true })
    c.end()
  } catch (e) {
    throw new SuError('AUTH', `a fresh key-only login failed ${when} (${/** @type {Error} */ (e).message})`)
  }
}

const oneLine = (/** @type {string|undefined} */ s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > 100 ? t.slice(0, 100) + '…' : t
}
