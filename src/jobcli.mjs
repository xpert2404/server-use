// @ts-check
// CLI side of `job wait` and `job start --wait/--max-time`: flag handling, and a wait call that survives the daemon
// going away (restart, crash). Waiting twice is harmless: every wait reads the job's state on the server again.
import { call } from './client.mjs'
import { UsageError, parseDuration } from './util.mjs'

export const DEFAULT_WAIT = '30m'

/** `--wait` may stand alone or carry a value (`--wait=10m`); it must never swallow the next word, so bare becomes `--wait=`. */
export function bareWait(/** @type {string[]} */ args) {
  const end = args.includes('--') ? args.indexOf('--') : args.length
  return args.map((a, i) => (a === '--wait' && i < end ? '--wait=' : a))
}

/**
 * The time flags of a job call, in milliseconds: waitMs (start --wait), maxTimeMs (start --max-time), timeoutMs (wait --timeout).
 * @param {string} action @param {Record<string, any>} v
 */
export function jobTimes(action, v) {
  if (v.wait !== undefined && action !== 'start') throw new UsageError('--wait belongs to "job start"; for a job that is already running use "job wait"')
  if (v['max-time'] !== undefined && action !== 'start') throw new UsageError('--max-time belongs to "job start"')
  if (v.timeout !== undefined && action !== 'wait') throw new UsageError('--timeout belongs to "job wait" (job start takes --wait=<time>)')
  return {
    waitMs: v.wait === undefined ? undefined : parseDuration(v.wait || DEFAULT_WAIT),
    maxTimeMs: v['max-time'] === undefined ? undefined : parseDuration(v['max-time']),
    timeoutMs: action === 'wait' ? parseDuration(v.timeout || DEFAULT_WAIT) : undefined,
  }
}

/**
 * Block until the job ends or `timeoutMs` has passed (the reply says which). When the daemon goes away meanwhile the
 * wait is asked again with the time that is left; the new daemon starts by itself.
 * @param {{target: string, name: string, timeoutMs: number, lines?: string, sudo?: boolean}} args
 * @returns {Promise<any>}
 */
export async function waitCall(args) {
  const end = Date.now() + args.timeoutMs
  for (let tries = 0; ; tries++) {
    try {
      return await call('job', { ...args, action: 'wait', timeoutMs: Math.max(0, end - Date.now()) })
    } catch (e) {
      const err = /** @type {any} */ (e)
      if (tries >= 5 || !(err.code === 'RESTARTING' || err.message === 'daemon connection closed')) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
