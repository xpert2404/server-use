// job wait, job start --wait / --max-time: flag parsing, the wait loop (job.sh replies faked), the MCP mapping, and the
// real thing: CLI + daemon + remote/job.sh against an in-process fixture server.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { scriptSource } from '../src/remote.mjs'
import { startFixture, SH } from './fixture.mjs'
import { sandbox, sleep, until } from './e2e/helpers.mjs'
import { bareWait, jobTimes } from '../src/jobcli.mjs'
import { jobWait, maxTimeSeconds } from '../src/ops/jobwait.mjs'
import { job } from '../src/ops/scripts.mjs'
import { callTool } from '../src/mcp.mjs'
import { check, READ_OPS } from '../src/guard.mjs'
import * as inventory from '../src/inventory.mjs'
import { SuError } from '../src/util.mjs'

process.env.SERVER_USE_DAEMON_IDLE_MS = '60000'
const tmp = mkdtempSync(join(tmpdir(), 'su-jw-'))
process.env.SERVER_USE_HOME = join(tmp, 'home') // for the in-process inventory and audit of the loop tests
process.env.SERVER_USE_SECRETS = 'file'
after(() => rmSync(tmp, { recursive: true, force: true }))

test('remote job refuses a requested timebox before starting when timeout is unavailable', { skip: !SH && 'no POSIX shell' }, () => {
  const script = "SU_ACTION=start\nSU_NAME=no-timeout\nSU_MAX_TIME=1\nSU_PAYLOAD_B64=dHJ1ZQ==\ntimeout() { return 127; }\n" + scriptSource('job')
  const result = spawnSync(SH, [], { input: script, encoding: 'utf8', env: { ...process.env, HOME: tmp } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /job was not started/)
  assert.ok(!existsSync(join(tmp, '.server-use/jobs/no-timeout')))
})

test('remote job refuses a TERM-only timeout that cannot enforce the timebox', { skip: !SH && 'no POSIX shell' }, () => {
  const script = "SU_ACTION=start\nSU_NAME=term-only\nSU_MAX_TIME=1\nSU_PAYLOAD_B64=dHJ1ZQ==\ntimeout() { [ \"$1\" != -k ]; }\n" + scriptSource('job')
  const result = spawnSync(SH, [], { input: script, encoding: 'utf8', env: { ...process.env, HOME: tmp } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires a working timeout command with -k; job was not started/)
  assert.ok(!existsSync(join(tmp, '.server-use/jobs/term-only')))
})

describe('flags', () => {
  test('--wait, --wait=10m, --max-time 4h and --timeout become milliseconds', () => {
    const v = (/** @type {string[]} */ ...a) => {
      const out = /** @type {Record<string, string>} */ ({})
      const args = bareWait(a)
      for (const x of args) if (x.startsWith('--') && x.includes('=')) out[x.slice(2, x.indexOf('='))] = x.slice(x.indexOf('=') + 1)
      return out
    }
    assert.deepEqual(bareWait(['start', 't', 'n', '--wait', 'echo hi']), ['start', 't', 'n', '--wait=', 'echo hi'], 'a bare --wait must not take the command as its value')
    assert.deepEqual(bareWait(['start', 't', 'n', '--', '--wait']), ['start', 't', 'n', '--', '--wait'], 'after -- it belongs to the command')
    assert.equal(jobTimes('start', v('--wait')).waitMs, 30 * 60_000)
    assert.equal(jobTimes('start', v('--wait=10m')).waitMs, 600_000)
    assert.equal(jobTimes('start', { 'max-time': '4h' }).maxTimeMs / 1000, 14_400)
    assert.equal(jobTimes('wait', { timeout: '2h' }).timeoutMs, 7_200_000)
    assert.equal(jobTimes('wait', {}).timeoutMs, 30 * 60_000)
    assert.equal(jobTimes('start', {}).waitMs, undefined)
    assert.throws(() => jobTimes('start', { wait: 'soon' }), { code: 'USAGE', message: /bad duration/ })
    assert.throws(() => jobTimes('wait', { wait: '' }), { code: 'USAGE', message: /job wait/ })
    assert.throws(() => jobTimes('logs', { 'max-time': '1h' }), { code: 'USAGE' })
    assert.throws(() => jobTimes('start', { timeout: '1h' }), { code: 'USAGE' })
    assert.equal(maxTimeSeconds(14_400_000), 14_400)
    assert.equal(maxTimeSeconds(1500), 2)
    assert.throws(() => maxTimeSeconds(0), { code: 'USAGE' })
    assert.throws(() => maxTimeSeconds(undefined), { code: 'USAGE' })
    assert.throws(() => maxTimeSeconds(Infinity), { code: 'USAGE' })
  })

  test('job wait never needs a writable server: readonly allows it', () => {
    assert.ok(READ_OPS.has('job.wait'))
    assert.doesNotThrow(() => check({ name: 'web1', policy: 'readonly' }, 'job.wait', {}))
    assert.throws(() => check({ name: 'web1', policy: 'readonly' }, 'job.start', { text: 'true' }), { code: 'READONLY' })
  })
})

/** job.sh's reply to action wait, as runScript would deliver it. */
const reply = (/** @type {string} */ state, /** @type {number|string} */ code = '', started = 'T1', body = '') => ({
  exit: 0, ms: 3, stdout: { text: `SU_JOB state=${state} code=${code} started=${started}\n${body}`, bytes: 0 }, stderr: { text: '' },
})
/** A runScript stand-in that answers with the given replies in order (the last one repeats) and remembers its calls. */
function fake(/** @type {any[]} */ replies) {
  /** @type {{vars: any, opts: any}[]} */ const calls = []
  const run = async (/** @type {any} */ _ctx, /** @type {string} */ _host, /** @type {string} */ _script, /** @type {any} */ vars, /** @type {any} */ opts) => {
    calls.push({ vars, opts })
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (r instanceof Error) throw r
    return r
  }
  return { run: /** @type {any} */ (run), calls }
}
const ctx = (/** @type {Partial<{signal: AbortSignal, isStopping: () => boolean}>} */ extra = {}) => /** @type {any} */ ({ pool: {}, agent: 'test', runId: 'r', ...extra })
const fast = { gap: () => 5 }

describe('the wait loop', () => {
  before(() => {
    inventory.upsert('web1', { host: '127.0.0.1', user: 'tester' })
    inventory.upsert('ro', { host: '127.0.0.2', user: 'tester', policy: 'readonly' })
  })
  test('a hung connection/probe is bounded by the caller deadline and cancelled', async () => {
    let signal
    const t = Date.now()
    const out = await jobWait(ctx(), { target: 'web1', timeoutMs: 25 }, 'w1', { run: async (c) => { signal = c.signal; return new Promise(() => {}) } })
    assert.equal(out.results[0].exit, 124)
    assert.equal(out.results[0].error.code, 'TIMEOUT')
    assert.ok(signal.aborted)
    assert.ok(Date.now() - t < 500)
  })

  test('a job that already ended answers at once: its exit code, the text without the machine line', async () => {
    const f = fake([reply('exited', 4, 'T1', 'w1 exited 4 after 3s (started T1)\nline one\n')])
    const { results: [r] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60_000 }, 'w1', { ...f, ...fast })
    assert.equal(r.exit, 4)
    assert.equal(r.waitState, 'exited')
    assert.equal(r.stdout.text, 'w1 exited 4 after 3s (started T1)\nline one\n')
    assert.equal(r.ms, undefined, 'no run time in the host line: it would be the last poll, not the job')
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0].vars, { SU_ACTION: 'wait', SU_NAME: 'w1', SU_LINES: 40, SU_TAIL: undefined })
  })

  test('polls until the job ends; each poll is short, so no SSH session is held in between', async () => {
    const f = fake([reply('running'), reply('running'), reply('exited', 0, 'T1', 'w1 exited 0 after 9s\n')])
    const { results: [r] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60_000, lines: '12', sudo: true }, 'w1', { ...f, ...fast })
    assert.equal(r.exit, 0)
    assert.equal(f.calls.length, 3)
    for (const c of f.calls) {
      assert.ok(c.opts.timeoutMs <= 60_000, 'a poll is cut off after at most a minute')
      assert.equal(c.opts.sudo, true)
      assert.equal(c.vars.SU_LINES, 12)
    }
  })

  test('at the timeout: exit 124, "running", the tail of the last poll; ends on time', async () => {
    const f = fake([reply('running'), reply('running', '', 'T1', 'w1 still running after 5m (pid 7, log 1 KB); call job wait again\ntail\n')])
    const t = Date.now()
    const { results: [r] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60 }, 'w1', { ...f, gap: () => 10 })
    const took = Date.now() - t
    assert.equal(r.exit, 124)
    assert.equal(r.waitState, 'running')
    assert.match(r.stdout.text, /^w1 still running after 5m/)
    assert.ok(took >= 50 && took < 2000, `${took} ms for a 60 ms timeout`)
    assert.equal(f.calls.at(-1).vars.SU_TAIL, 1, 'the last poll asks for the tail')
    assert.ok(f.calls.slice(0, -1).every((c) => c.vars.SU_TAIL === undefined), 'the earlier ones do not')
    // a timeout of 0 is one look
    const g = fake([reply('running', '', 'T1', 'x\n')])
    assert.equal((await jobWait(ctx(), { target: 'web1', timeoutMs: 0 }, 'w1', { ...g, ...fast })).results[0].exit, 124)
    assert.equal(g.calls.length, 1)
  })

  test('a restart under the same name is noted and the wait goes on with the new run', async () => {
    const f = fake([reply('running', '', 'T1'), reply('running', '', 'T2'), reply('exited', 0, 'T2', 'w1 exited 0 after 1s (started T2)\n')])
    const { results: [r] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60_000 }, 'w1', { ...f, ...fast })
    assert.equal(r.exit, 0)
    assert.equal(r.stdout.text, 'job was restarted at T2; waited for the new run\nw1 exited 0 after 1s (started T2)\n')
  })

  test('the runner is gone without an exit file: exit 1, "unknown"', async () => {
    const f = fake([reply('unknown', '', 'T1', 'w1 unknown: runner gone without exit code (server rebooted?)\n')])
    const { results: [r] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60_000 }, 'w1', { ...f, ...fast })
    assert.equal(r.exit, 1)
    assert.equal(r.waitState, 'unknown')
    assert.match(r.stdout.text, /runner gone without exit code/)
  })

  test('an unknown job is job.sh\'s own error, untouched', async () => {
    const f = fake([{ exit: 1, ms: 2, stdout: { text: '' }, stderr: { text: "job: no job named 'nope'\n" } }])
    const { results: [r] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60_000 }, 'nope', { ...f, ...fast })
    assert.equal(r.exit, 1)
    assert.match(r.stderr.text, /no job named 'nope'/)
    assert.equal(f.calls.length, 1)
  })

  test('a dropped connection or an unreachable host between polls is retried; auth and host key errors are not', async () => {
    const f = fake([new SuError('UNREACHABLE', 'down'), { exit: 255, ms: 1, error: { code: 'DISCONNECTED', message: 'lost' }, stdout: { text: '' }, stderr: { text: '' } }, reply('exited', 2, 'T1', 'w1 exited 2\n')])
    const { results: [r] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60_000 }, 'w1', { ...f, ...fast })
    assert.equal(r.exit, 2)
    assert.equal(f.calls.length, 3)
    for (const code of ['AUTH', 'HOSTKEY_CHANGED']) {
      const g = fake([new SuError(code, 'nope')])
      const { results: [x] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 60_000 }, 'w1', { ...g, ...fast })
      assert.equal(x.error.code, code)
      assert.equal(g.calls.length, 1)
    }
    // still unreachable at the deadline: that is the answer
    const h = fake([new SuError('UNREACHABLE', 'down')])
    const { results: [y] } = await jobWait(ctx(), { target: 'web1', timeoutMs: 30 }, 'w1', { ...h, gap: () => 5 })
    assert.equal(y.error.code, 'UNREACHABLE')
  })

  test('the caller going away ends the wait (never the job); a daemon that is stopping asks for a retry', async () => {
    const ac = new AbortController()
    const f = fake([reply('running')])
    const p = jobWait(ctx({ signal: ac.signal }), { target: 'web1', timeoutMs: 60_000 }, 'w1', { ...f, gap: () => 60_000 })
    await sleep(30)
    ac.abort()
    const { results: [r] } = await p
    assert.equal(r.error.code, 'ABORTED')
    assert.equal(f.calls.length, 1, 'no poll after the abort')
    await assert.rejects(jobWait(ctx({ isStopping: () => true }), { target: 'web1', timeoutMs: 60_000 }, 'w1', { ...fake([reply('running')]), ...fast }), { code: 'RESTARTING' })
  })

  test('waiting is allowed on a readonly server; bad input is refused before any poll', async () => {
    const f = fake([reply('exited', 0, 'T1', 'x\n')])
    assert.equal((await jobWait(ctx(), { target: 'ro', timeoutMs: 1000 }, 'w1', { ...f, ...fast })).results[0].exit, 0)
    await assert.rejects(jobWait(ctx(), { target: 'web1', timeoutMs: -5 }, 'w1', { ...f, ...fast }), { code: 'USAGE' })
    await assert.rejects(job(ctx(), { action: 'wait', target: 'web1', name: 'bad name!' }), { code: 'USAGE', message: /job name/ })
    await assert.rejects(job(ctx(), { action: 'start', target: 'web1', name: 'ok', command: 'true', maxTimeMs: 0 }), { code: 'USAGE', message: /at least 1s/ })
    await assert.rejects(job(ctx(), { action: 'bogus', target: 'web1', name: 'ok' }), { message: /wait/ })
  })

  test('several hosts are waited for side by side, one result each', async () => {
    inventory.upsert('web2', { host: '127.0.0.3', user: 'tester' })
    const f = fake([reply('exited', 0, 'T1', 'ok\n')])
    const { results } = await jobWait(ctx(), { target: 'web1,web2', timeoutMs: 1000 }, 'w1', { ...f, ...fast })
    assert.deepEqual(results.map((/** @type {any} */ x) => [x.host, x.exit]), [['web1', 0], ['web2', 0]])
  })
})

describe('MCP job tool', () => {
  const client = (/** @type {any} */ result) => {
    /** @type {any[]} */ const sent = []
    return { sent, c: /** @type {any} */ ({ request: async (/** @type {string} */ op, /** @type {any} */ a) => { sent.push({ op, a }); return { results: [{ host: 'web1', ...result }] } } }) }
  }
  const running = { exit: 124, waitState: 'running', stdout: { text: 'w1 still running after 1m (pid 7, log 1 KB); call job wait again\n' } }

  test('wait: default 45 s, "still running" is an answer and not an error', async () => {
    const { c, sent } = client(running)
    const out = await callTool(c, 'job', { action: 'wait', target: 'web1', name: 'w1' })
    assert.equal(sent[0].a.timeoutMs, 45_000)
    assert.equal(out.isError, false)
    assert.match(out.text, /still running/)
    await callTool(c, 'job', { action: 'wait', target: 'web1', name: 'w1', timeout: '2m' })
    assert.equal(sent[1].a.timeoutMs, 120_000)
  })

  test('a job that ended with a failure is an error, one that succeeded is not; a job\'s own exit 124 is not "still running"', async () => {
    assert.equal((await callTool(client({ exit: 4, waitState: 'exited', stdout: { text: 'w1 exited 4 after 3s\n' } }).c, 'job', { action: 'wait', target: 'web1', name: 'w1' })).isError, true)
    assert.equal((await callTool(client({ exit: 0, waitState: 'exited', stdout: { text: 'w1 exited 0 after 3s\n' } }).c, 'job', { action: 'wait', target: 'web1', name: 'w1' })).isError, false)
    assert.equal((await callTool(client({ exit: 124, waitState: 'exited', stdout: { text: 'w1 exited 124 after 2h\n' } }).c, 'job', { action: 'wait', target: 'web1', name: 'w1' })).isError, true)
    assert.equal((await callTool(client({ exit: 1, stdout: { text: '' }, stderr: { text: "job: no job named 'x'\n" } }).c, 'job', { action: 'wait', target: 'web1', name: 'x' })).isError, true)
  })

  test('start: maxTime is passed on as milliseconds, other actions are untouched', async () => {
    const { c, sent } = client({ exit: 0, stdout: { text: 'started w1 pid 5\n' } })
    await callTool(c, 'job', { action: 'start', target: 'web1', name: 'w1', command: 'true', maxTime: '4h' })
    assert.equal(sent[0].a.maxTimeMs, 14_400_000)
    assert.equal(sent[0].a.timeoutMs, undefined)
    await callTool(c, 'job', { action: 'ls', target: 'web1' })
    assert.equal(sent[1].a.maxTimeMs, undefined)
  })
})

// ---- the real thing ----

const PW = 'fx-Secret-jw41'
const skip = SH ? false : 'no POSIX sh for the fixture (install Git for Windows or set SU_TEST_SH)'

describe('job wait against a fixture server (CLI, daemon and remote/job.sh)', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  /** @type {Awaited<ReturnType<typeof startFixture>>} */ let fx
  const RUN = Date.now().toString(36)
  const names = new Set()
  const jn = (/** @type {string} */ stem) => { const n = `${stem}-${RUN}`; names.add(n); return n }
  const su = (/** @type {string[]} */ args, o = {}) => s.su(args, { timeout: 90_000, ...o })
  const start = async (/** @type {string} */ n, /** @type {string} */ cmd, /** @type {string[]} */ ...flags) => {
    const r = await su(['job', 'start', 'web1', n, cmd, ...flags])
    assert.equal(r.code, 0, r.all)
    return Number(/pid (\d+)/.exec(r.out)?.[1])
  }
  const hasTimeout = async () => (await s.sh('web1', 'command -v timeout >/dev/null 2>&1')).code === 0

  before(async () => {
    s = sandbox()
    fx = await startFixture({ password: PW })
    const r = await s.su(['add', 'web1', `${fx.user}@127.0.0.1:${fx.port}`, '--password-stdin'], { input: PW })
    assert.equal(r.code, 0, r.all)
  })
  after(async () => {
    for (const n of names) await s?.su(['job', 'stop', 'web1', n], { timeout: 30_000 }).catch(() => {})
    await s?.cleanup()
    await fx?.close()
  })

  test('wait returns the job\'s exit code, name, duration and the log tail; asking again gives the same answer', async () => {
    const n = jn('done')
    await start(n, 'echo first; echo done; sleep 2; exit 4')
    const r = await su(['job', 'wait', 'web1', n, '--timeout', '60s'])
    assert.equal(r.code, 4, r.all)
    assert.match(r.out, /^── web1 · exit 4\n/)
    assert.match(r.out, new RegExp(`^${n} exited 4 after \\d+s \\(started \\d{4}-\\d\\d-\\d\\dT[\\d:]+[+-]\\d{4}\\)$`, 'm'))
    assert.match(r.out, /^done$/m)
    const again = await su(['job', 'wait', 'web1', n])
    assert.equal(again.code, 4, again.all)
    assert.match(again.out, /exited 4 after/)
    const j = await su(['job', 'wait', 'web1', n, '--json'])
    assert.equal(j.code, 4)
    assert.equal(JSON.parse(j.out).results[0].waitState, 'exited')
    const st = await su(['job', 'status', 'web1', n])
    assert.match(st.out, /^elapsed +\d+s$/m)
    assert.match((await su(['job', 'ls', 'web1'])).out, new RegExp(`ELAPSED\\n(.*\\n)*${n} +exited +\\S+ +4 +\\d+s`))
  })

  test('-n limits the tail', async () => {
    const n = jn('tail')
    await start(n, 'seq 1 30')
    const r = await su(['job', 'wait', 'web1', n, '--timeout', '30s', '-n', '3'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /\n28\n29\n30\n$/)
    assert.doesNotMatch(r.out, /^27$/m)
  })

  test('still running at the timeout: exit 124 and "still running", then stop, then the wait is over', { timeout: 120_000 }, async () => {
    const n = jn('long')
    const pid = await start(n, 'echo begun; sleep 25')
    const t = Date.now()
    const r = await su(['job', 'wait', 'web1', n, '--timeout', '2s'])
    assert.equal(r.code, 124, r.all)
    assert.ok(Date.now() - t < 15_000)
    assert.match(r.out, new RegExp(`^${n} still running after \\d+s \\(pid \\d+, log \\d+ B\\); call job wait again$`, 'm'))
    assert.match(r.out, /^begun$/m)
    assert.equal(JSON.parse((await su(['job', 'wait', 'web1', n, '--timeout', '1s', '--json'])).out).results[0].waitState, 'running')
    assert.ok(pid > 0)
    const stop = await su(['job', 'stop', 'web1', n], { timeout: 60_000 })
    assert.equal(stop.code, 0, stop.all)
    const w = await su(['job', 'wait', 'web1', n, '--timeout', '30s'])
    assert.ok([137, 143].includes(w.code), w.all) // killed by TERM (143), or KILL (137)
    assert.match(w.out, /exited 1[34]\d after/)
  })

  test('start --wait is start and wait: the job\'s exit code, no "started" line', async () => {
    const n = jn('sw')
    const t = Date.now()
    const r = await su(['job', 'start', 'web1', n, 'echo working; sleep 1; exit 5', '--wait=60s'])
    assert.equal(r.code, 5, r.all)
    assert.match(r.out, /exited 5 after/)
    assert.match(r.out, /^working$/m)
    assert.doesNotMatch(r.out, /started \S+ pid/)
    assert.ok(Date.now() - t < 30_000)
    // a bare --wait does not eat the command, and a start that fails shows why
    const n2 = jn('sw2')
    const bare = await su(['job', 'start', 'web1', n2, 'exit 0', '--wait'])
    assert.equal(bare.code, 0, bare.all)
    const bad = await su(['job', 'start', 'web1', 'bad name!', 'true', '--wait'])
    assert.equal(bad.code, 2, bad.all)
    assert.match(bad.all, /job name must match/)
  })

  test('--max-time stops a runaway job or refuses to start without timeout', { timeout: 120_000 }, async () => {
    const n = jn('mt')
    const r = await su(['job', 'start', 'web1', n, 'sleep 40 & sleep 41', '--max-time', '2s', '--wait=40s'])
    if (await hasTimeout()) {
      assert.equal(r.code, 124, r.all)
      assert.match(r.out, /exited 124 after/)
      assert.doesNotMatch(r.out, /still running/)
      assert.match((await su(['job', 'status', 'web1', n])).out, /exited 124/)
      assert.equal(JSON.parse((await su(['job', 'wait', 'web1', n, '--json'])).out).results[0].waitState, 'exited', 'a job that exited 124 is not "still running"')
    } else {
      assert.equal(r.code, 1, r.all)
      assert.match(r.all, /requires a working timeout command with -k; job was not started/)
    }
    assert.equal((await su(['job', 'start', 'web1', jn('mtbad'), 'true', '--max-time', 'soon'])).code, 2)
  })

  test('an unknown job: exit 1 with job.sh\'s message; no name: usage', async () => {
    const r = await su(['job', 'wait', 'web1', `nope-${RUN}`])
    assert.equal(r.code, 1, r.all)
    assert.match(r.out, /job: no job named 'nope-/)
    assert.equal((await su(['job', 'wait', 'web1'])).code, 2)
    assert.equal((await su(['job', 'wait', 'nosuchserver', 'x'])).code, 2)
  })

  test('the job state survives the connection being dropped during a wait: the wait still ends with the right code', { timeout: 120_000 }, async () => {
    const n = jn('drop')
    await start(n, 'sleep 5; echo after-drop; exit 3')
    const w = su(['job', 'wait', 'web1', n, '--timeout', '60s'])
    await sleep(1500)
    assert.equal((await su(['disconnect', 'web1'])).code, 0)
    const r = await w
    assert.equal(r.code, 3, r.all)
    assert.match(r.out, /after-drop/)
  })

  test('the daemon restarting during a wait: the CLI asks again and gets the job\'s exit code', { timeout: 120_000 }, async () => {
    const n = jn('dr')
    await start(n, 'sleep 8; exit 6')
    const w = su(['job', 'wait', 'web1', n, '--timeout', '90s'])
    await sleep(1500)
    const rs = await su(['daemon', 'restart'])
    assert.equal(rs.code, 0, rs.all)
    const r = await w
    assert.equal(r.code, 6, r.all)
    assert.match(r.out, /exited 6 after/)
  })

  test('waits do not use up the host\'s SSH sessions: other commands run while nine waits are pending', { timeout: 120_000 }, async () => {
    const n = jn('many')
    await start(n, 'sleep 12')
    const waits = Array.from({ length: 9 }, () => su(['job', 'wait', 'web1', n, '--timeout', '60s']))
    await sleep(2500)
    const t = Date.now()
    const x = await su(['exec', 'web1', 'echo still-served'])
    assert.equal(x.code, 0, x.all)
    assert.match(x.out, /still-served/)
    assert.ok(Date.now() - t < 5000, `exec took ${Date.now() - t} ms behind nine waits`)
    const rs = await Promise.all(waits)
    for (const r of rs) assert.equal(r.code, 0, r.all)
  })

  test('MCP: wait answers "still running" without an error, then the exit code', { timeout: 120_000 }, async () => {
    const n = jn('mcp')
    await start(n, 'sleep 4; echo mcp-done; exit 2')
    const call = (/** @type {number} */ id, /** @type {any} */ args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'job', arguments: { action: 'wait', target: 'web1', name: n, ...args } } }) + '\n'
    const run = async (/** @type {any} */ args) => {
      const r = await su(['mcp'], { input: call(1, args) })
      return JSON.parse(r.out.trim().split('\n')[0]).result
    }
    const first = await run({ timeout: '1s' })
    assert.equal(first.isError, false, first.content[0].text)
    assert.match(first.content[0].text, /still running/)
    const second = await run({ timeout: '30s' })
    assert.equal(second.isError, true)
    assert.match(second.content[0].text, /exited 2 after/)
    assert.match(second.content[0].text, /mcp-done/)
  })

  test('the OOM killer takes jobs first: the job runs with oom_score_adj 500', { skip: process.platform !== 'linux' || !existsSync('/proc/self/oom_score_adj') ? 'Linux /proc only' : false }, async () => {
    const n = jn('oom')
    const pid = await start(n, 'sleep 30')
    await until(async () => existsSync(`/proc/${pid}/oom_score_adj`) || 'no /proc entry', 5000, 100)
    assert.equal(readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim(), '500')
  })
})
