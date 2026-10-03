// @ts-check
// Remote logic lives in POSIX sh scripts under remote/. They are streamed over stdin (`sh -s`), so
// nothing is installed on the server and arguments never show up in the remote process list.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, file } from './paths.mjs'
import * as inventory from './inventory.mjs'
import { rawExec, withSudo } from './ops/exec.mjs'
import { shVars, SuError } from './util.mjs'

/** @type {Map<string, string>} */
const cache = new Map()
export function scriptSource(/** @type {string} */ name) {
  if (!cache.has(name)) cache.set(name, readFileSync(join(ROOT, 'remote', `${name}.sh`), 'utf8'))
  return /** @type {string} */ (cache.get(name))
}

/** Base64 so arbitrary payloads (commands, scripts, secrets) survive shell quoting untouched. */
export const b64 = (/** @type {string|Buffer} */ v) => Buffer.from(v).toString('base64')

/**
 * Run remote/<name>.sh with SU_* variables on one server.
 * @param {{pool: import('./pool.mjs').Pool, signal?: AbortSignal, runId: string}} ctx
 * @param {string} server
 * @param {string} name
 * @param {Record<string, unknown>} vars
 * @param {{sudo?: boolean, timeoutMs?: number, full?: boolean}} [o]
 */
export async function runScript(ctx, server, name, vars, o = {}) {
  const s = inventory.get(server)
  const script = shVars(vars) + scriptSource(name)
  return ctx.pool.with(server, async (conn) => {
    const w = o.sudo ? await withSudo(conn, s, 'sh -s') : { command: 'sh -s', prefix: '' }
    return rawExec(conn, {
      command: w.command, stdin: w.prefix + script, timeoutMs: o.timeoutMs || 10 * 60_000, signal: ctx.signal, wrap: /** @type {any} */ (w).wrap,
      logBase: file('runs', ctx.runId, `${server}.${name}`), full: o.full,
    })
  })
}

/** Like runScript but throws REMOTE on non-zero exit and returns stdout text. */
export async function runScriptOk(/** @type {Parameters<typeof runScript>} */ ...args) {
  const r = await runScript(...args)
  if (r.exit !== 0) {
    throw new SuError(r.error?.code || 'REMOTE', `${args[1]}: ${args[2]}.sh failed (exit ${r.exit}): ${(r.stderr.text || r.stdout.text).trim().slice(-2000)}`)
  }
  return r
}

/** Parse key=value lines (facts.sh / status.sh output). */
export function kv(/** @type {string} */ text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
