// @ts-check
// job wait: block until a job ends and return its exit code, duration and log tail in one reply.
//
// The daemon polls `remote/job.sh` (action wait, one cheap look) instead of holding one SSH channel for the whole
// run: a held channel would use up one of the host's few sessions (PER_HOST), and with a few waits at once every
// other command of that host would queue behind them. Between two polls nothing is held, so exec, put and the
// other waits go through, a dropped connection costs one retried poll, and a daemon restart costs nothing but the
// wait itself: the exit code is read from the exit file on the server again by the next `job wait`.
import * as inventory from '../inventory.mjs'
import { check } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { runScript } from '../remote.mjs'
import { SuError, UsageError } from '../util.mjs'

export const DEFAULT_WAIT_MS = 30 * 60_000
const POLL_TIMEOUT_MS = 60_000
/** Errors that mean "could not look right now": the next poll may work. Auth and host key errors are not among them. */
const TRANSIENT = new Set(['UNREACHABLE', 'DISCONNECTED', 'TIMEOUT'])
/** First line of job.sh's reply to action wait. */
const HEADER = /^SU_JOB state=(\w+) code=(\d*) started=(\S*)\n/
/** Pause before poll i+1: 0.5 s, 1 s, 2 s, 4 s, then every 5 s. */
const gap = (/** @type {number} */ i) => Math.min(5000, 500 * 2 ** i)

/** --max-time in ms → whole seconds for job.sh (at least 1). */
export function maxTimeSeconds(/** @type {unknown} */ ms) {
  if (!Number.isSafeInteger(Number(ms)) || Number(ms) <= 0) throw new UsageError('--max-time must be at least 1s (a finite positive duration)')
  const s = Math.ceil(Number(ms) / 1000)
  if (!(s >= 1)) throw new UsageError('--max-time must be at least 1s')
  return s
}

/**
 * op "job", action wait: {target, name, timeoutMs?, lines?, sudo?}. One result per host; `exit` is the job's exit
 * code, 124 while it still runs (waitState "running", call again) and 1 when its runner vanished (waitState "unknown").
 * `deps` lets tests replace the script runner and the poll gap.
 * @param {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} ctx
 * @param {any} a @param {string} name
 * @param {{run?: typeof runScript, gap?: (i: number) => number}} [deps]
 */
export async function jobWait(ctx, a, name, deps = {}) {
  const timeoutMs = a.timeoutMs === undefined ? DEFAULT_WAIT_MS : Number(a.timeoutMs)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new UsageError(`bad wait timeout "${a.timeoutMs}"`)
  const names = inventory.resolveTargets(a.target)
  // Not fanOut: that holds one of its 32 daemon-wide slots for as long as the callback runs, and a wait runs for hours.
  const results = await Promise.all(names.map(async (host) => {
    try {
      check(inventory.get(host), 'job.wait', {})
      const r = await waitOne(ctx, host, name, a, timeoutMs, deps)
      audit({ agent: ctx.agent, op: 'job.wait', host, name, state: r.waitState, exit: r.exit })
      return { host, ...r }
    } catch (e) {
      const err = /** @type {any} */ (e)
      if (err.code === 'RESTARTING') throw e
      return { host, exit: null, error: { code: err.code || 'INTERNAL', message: err.message, ...(err.extra || {}) } }
    }
  }))
  return { results }
}

/** @returns {Promise<any>} a runScript-shaped result */
async function waitOne(/** @type {any} */ ctx, /** @type {string} */ host, /** @type {string} */ name, /** @type {any} */ a, /** @type {number} */ timeoutMs, /** @type {any} */ deps) {
  const run = deps.run ?? runScript
  const pause = deps.gap ?? gap
  const t0 = Date.now()
  const end = t0 + timeoutMs
  /** @type {string | undefined} */ let started
  let note = ''
  for (let i = 0; ; i++) {
    if (ctx.signal?.aborted) return aborted()
    // The daemon is going away (restart, upgrade): end the wait quickly; the client asks again and the new daemon looks at the job anew.
    if (ctx.isStopping?.()) throw new SuError('RESTARTING', 'daemon is restarting, retry')
    const left = end - Date.now()
    // The poll at the deadline asks for the tail too, so a "still running" reply has something to show.
    const final = left <= 0
    /** @type {any} */ let r
    try {
      // Includes connection and channel acquisition. At the deadline one final snapshot gets at most 1s.
      const budget = final ? 1000 : Math.max(1, Math.min(POLL_TIMEOUT_MS, left))
      r = await poll(run, ctx, host, { SU_ACTION: 'wait', SU_NAME: name, SU_LINES: Number(a.lines || 40), SU_TAIL: final ? 1 : undefined }, { sudo: a.sudo, timeoutMs: budget }, budget)
    } catch (e) {
      if (final || !TRANSIENT.has(/** @type {any} */ (e).code)) throw e
    }
    if (r?.error?.code === 'ABORTED') return r
    if (r?.error) {
      if (!TRANSIENT.has(r.error.code) || final || Date.now() >= end) return r
    } else if (r) {
      if (r.exit !== 0) return r // e.g. no such job: job.sh's own message, exit 1
      const m = HEADER.exec(r.stdout.text)
      if (!m) return r
      const [head, state, code, st] = m
      if (started !== undefined && st !== started) note = `job was restarted at ${st}; waited for the new run\n`
      started = st
      const base = { ...r, ms: undefined, waitedMs: Date.now() - t0, stdout: { ...r.stdout, text: note + r.stdout.text.slice(head.length) } }
      if (state === 'exited') return { ...base, exit: Number(code) || 0, waitState: 'exited' }
      if (state !== 'running') return { ...base, exit: 1, waitState: 'unknown' }
      if (final) return { ...base, exit: 124, waitState: 'running' }
    }
    await nap(Math.min(pause(i), left), ctx.signal)
  }
}

const aborted = () => ({ exit: 130, error: { code: 'ABORTED', message: 'caller disconnected; stopped waiting (the job itself is untouched)' } })

async function poll(run, ctx, host, vars, options, budget) {
  const controller = new AbortController()
  let timer
  let onAbort
  const limit = new Promise(resolve => {
    onAbort = () => { resolve(aborted()); controller.abort() }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      resolve({ exit: 124, error: { code: 'TIMEOUT', message: 'wait deadline reached during state probe; job state is unknown, wait again' } })
      controller.abort()
    }, budget)
    if (ctx.signal?.aborted) onAbort()
  })
  try { return await Promise.race([run({ ...ctx, signal: controller.signal }, host, 'job', vars, options), limit]) }
  finally { clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort) }
}

/** Sleep that ends early when the caller disconnects. */
function nap(/** @type {number} */ ms, /** @type {AbortSignal | undefined} */ signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(undefined) }
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
