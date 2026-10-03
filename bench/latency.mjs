#!/usr/bin/env node
// Latency of the pooled connection vs a fresh handshake, and fan-out over several servers.
//
//   node bench/latency.mjs --target <server> [--runs 30] [--fanout <targets>]
//
// cold   = disconnect, then exec (new SSH handshake each time)
// warm   = exec on the kept connection, measured at the daemon client (no process start)
// cli    = `server-use exec` as a new process each time (what an agent's shell tool pays)
// fanout = one exec on all --fanout targets at once vs the slowest single one
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { DaemonClient } from '../src/client.mjs'
import { ROOT } from '../src/paths.mjs'

const args = process.argv.slice(2)
const opt = (/** @type {string} */ f, /** @type {string} */ d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const target = opt('--target', '')
const runs = Number(opt('--runs', '30'))
const fanout = opt('--fanout', '')
if (!target) { console.error('usage: node bench/latency.mjs --target <server> [--runs 30] [--fanout <targets>]'); process.exit(2) }

const c = await DaemonClient.connect({ agent: 'bench' })
const exec = async (/** @type {string} */ targets, cmd = 'true') => {
  const r = await c.request('exec', { targets, command: cmd })
  const bad = r.results.find((/** @type {any} */ x) => x.exit !== 0)
  if (bad) throw new Error(`${bad.host}: ${bad.error?.message || `exit ${bad.exit}`}`)
}
const time = async (/** @type {() => any} */ fn) => { const t = performance.now(); await fn(); return performance.now() - t }
const stats = (/** @type {number[]} */ xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (/** @type {number} */ p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), min: +s[0].toFixed(1) }
}

await exec(target) // warm-up
const cold = []
for (let i = 0; i < Math.min(runs, 10); i++) {
  await c.request('disconnect', { name: target })
  cold.push(await time(() => exec(target)))
}
const warm = []
for (let i = 0; i < runs; i++) warm.push(await time(() => exec(target)))
const cli = []
const bin = join(ROOT, 'bin', 'server-use.mjs')
for (let i = 0; i < Math.min(runs, 15); i++) {
  cli.push(await time(() => { const r = spawnSync(process.execPath, [bin, 'exec', target, 'true'], { stdio: 'ignore' }); if (r.status) throw new Error(`cli exit ${r.status}`) }))
}
const node = []
for (let i = 0; i < 5; i++) node.push(await time(() => spawnSync(process.execPath, ['-e', '0'])))

/** @type {Record<string, unknown>} */
const report = { target, cold: stats(cold), warm: stats(warm), cli: stats(cli), nodeStartup: stats(node) }
report.clientOverheadMs = +(stats(cli).p50 - stats(node).p50 - stats(warm).p50).toFixed(1)
report.warmVsCold = `${(stats(cold).p50 / stats(warm).p50).toFixed(1)}x faster`

if (fanout) {
  const names = (await c.request('servers.list')).servers.map((/** @type {any} */ s) => s.name)
  const hosts = fanout === 'all' ? names : fanout.split(',')
  const single = []
  for (const h of hosts) single.push(await time(() => exec(h, 'sleep 1')))
  const together = await time(() => exec(fanout, 'sleep 1'))
  report.fanout = { hosts: hosts.length, slowestSingleMs: +Math.max(...single).toFixed(0), allAtOnceMs: +together.toFixed(0), ratio: +(together / Math.max(...single)).toFixed(2) }
}
c.close()
console.log(JSON.stringify(report, null, 2))
