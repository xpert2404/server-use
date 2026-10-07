// e2e: job wait, job start --wait / --max-time against a real sshd (the container of test/e2e/Dockerfile).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { skip, sandbox, sleep, until, RUN } from './helpers.mjs'

describe('e2e: job wait', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  /** @type {Set<string>} */ const names = new Set()
  const jn = (/** @type {string} */ stem) => { const n = `jw-${stem}-${RUN}`; names.add(n); return n }
  const su = (/** @type {string[]} */ args, o = {}) => s.su(args, { timeout: 120_000, ...o })
  const start = async (/** @type {string} */ n, /** @type {string} */ cmd, /** @type {string[]} */ ...flags) => {
    const r = await su(['job', 'start', 'e2e-root', n, cmd, ...flags])
    assert.equal(r.code, 0, r.all)
    return Number(/pid (\d+)/.exec(r.out)?.[1])
  }
  // pgrep with a bracketed first letter never matches its own command line
  const running = async (/** @type {string} */ pattern) => (await s.sh('e2e-root', `pgrep -f '${pattern}' >/dev/null`)).code === 0

  before(async () => {
    s = sandbox()
    await s.add('e2e-root', 'root')
  })
  after(async () => {
    for (const n of names) {
      await s?.su(['job', 'stop', 'e2e-root', n], { timeout: 60_000 }).catch(() => {})
      await s?.sh('e2e-root', `rm -rf "$HOME/.server-use/jobs/${n}"`).catch(() => {})
    }
    await s?.cleanup()
  })

  test('wait returns the exit code, name, duration and the log tail', { timeout: 180_000 }, async () => {
    const n = jn('exit4')
    await start(n, 'sleep 3; echo done; exit 4')
    const r = await su(['job', 'wait', 'e2e-root', n, '--timeout', '60s'])
    assert.equal(r.code, 4, r.all)
    assert.match(r.out, new RegExp(`^${n} exited 4 after \\d+s \\(started \\d{4}-`, 'm'))
    assert.match(r.out, /^done$/m)
    // asking again is cheap and gives the same answer
    const again = await su(['job', 'wait', 'e2e-root', n])
    assert.equal(again.code, 4, again.all)
    assert.match(again.out, /exited 4 after/)
    assert.match((await su(['job', 'ls', 'e2e-root'])).out, new RegExp(`^${n} +exited +\\S+ +4 +\\d+s$`, 'm'))
  })

  test('still running at the timeout: exit 124 in time; after job stop the wait ends with 137 or 143', { timeout: 180_000 }, async () => {
    const n = jn('long')
    await start(n, 'echo begun; sleep 60')
    const t = Date.now()
    const r = await su(['job', 'wait', 'e2e-root', n, '--timeout', '3s'])
    assert.equal(r.code, 124, r.all)
    assert.ok(Date.now() - t < 15_000, `took ${Date.now() - t} ms`)
    assert.match(r.out, /still running after \d+s \(pid \d+, log \d+ B\); call job wait again/)
    assert.match(r.out, /^begun$/m)
    assert.equal((await su(['job', 'stop', 'e2e-root', n], { timeout: 60_000 })).code, 0)
    const w = await su(['job', 'wait', 'e2e-root', n, '--timeout', '30s'])
    assert.ok([137, 143].includes(w.code), w.all)
    assert.match(w.out, /exited 1[34]\d after/)
  })

  test('start --wait=60s returns the job\'s exit code', { timeout: 180_000 }, async () => {
    const n = jn('sw')
    const r = await su(['job', 'start', 'e2e-root', n, 'echo working; sleep 2; exit 5', '--wait=60s'])
    assert.equal(r.code, 5, r.all)
    assert.match(r.out, /exited 5 after/)
    assert.match(r.out, /^working$/m)
    assert.doesNotMatch(r.out, /started \S+ pid/)
  })

  test('--max-time 2s stops a runaway job and its children: exit 124, recorded, nothing left behind', { timeout: 180_000 }, async () => {
    const n = jn('mt')
    await start(n, 'sleep 58 & sleep 59; echo not-reached', '--max-time', '2s')
    const t = Date.now()
    const r = await su(['job', 'wait', 'e2e-root', n, '--timeout', '40s'])
    assert.equal(r.code, 124, r.all)
    assert.ok(Date.now() - t < 40_000)
    assert.match(r.out, /exited 124 after/)
    assert.doesNotMatch(r.out, /still running|not-reached/)
    assert.match((await su(['job', 'status', 'e2e-root', n])).out, /exited 124/)
    assert.equal(await running('[s]leep 5[89]'), false, 'the children of a job that ran out of time must be gone')
    assert.equal((await su(['job', 'start', 'e2e-root', jn('mtbad'), 'true', '--max-time', 'soon'])).code, 2)
  })

  test('job stop reaches a --max-time job (timeout leads a process group of its own)', { timeout: 180_000 }, async () => {
    const n = jn('mtstop')
    await start(n, 'sleep 56 & sleep 57', '--max-time', '1h')
    assert.equal(await running('[s]leep 5[67]'), true)
    assert.equal((await su(['job', 'stop', 'e2e-root', n], { timeout: 60_000 })).code, 0)
    await until(async () => !(await running('[s]leep 5[67]')) || 'the sleeps are still there', 20_000, 500)
  })

  test('a running job carries oom_score_adj 500 (the OOM killer takes it before sshd)', { timeout: 120_000 }, async () => {
    const n = jn('oom')
    const pid = await start(n, 'sleep 55')
    const r = await s.sh('e2e-root', `cat /proc/${pid}/oom_score_adj; for c in $(pgrep -P ${pid}); do cat /proc/$c/oom_score_adj; done`)
    assert.deepEqual(r.out.trim().split('\n'), ['500', '500'], r.err)
  })

  test('dropping the connection during a wait does not matter: the wait ends with the right code', { timeout: 180_000 }, async () => {
    const n = jn('drop')
    await start(n, 'sleep 6; echo after-drop; exit 3')
    const w = su(['job', 'wait', 'e2e-root', n, '--timeout', '90s'])
    await sleep(2000)
    assert.equal((await su(['disconnect', 'e2e-root'])).code, 0)
    const r = await w
    assert.equal(r.code, 3, r.all)
    assert.match(r.out, /after-drop/)
    // and a second CLI that waits for the same job afterwards gets the same answer
    assert.equal((await su(['job', 'wait', 'e2e-root', n])).code, 3)
  })

  test('a daemon restart during a wait: the CLI asks again and gets the job\'s exit code', { timeout: 180_000 }, async () => {
    const n = jn('dr')
    await start(n, 'sleep 9; exit 6')
    const w = su(['job', 'wait', 'e2e-root', n, '--timeout', '90s'])
    await sleep(2000)
    assert.equal((await su(['daemon', 'restart'])).code, 0)
    const r = await w
    assert.equal(r.code, 6, r.all)
    assert.match(r.out, /exited 6 after/)
  })

  test('nine waits at once leave the host\'s SSH sessions free for other commands', { timeout: 180_000 }, async () => {
    const n = jn('many')
    await start(n, 'sleep 14')
    const waits = Array.from({ length: 9 }, () => su(['job', 'wait', 'e2e-root', n, '--timeout', '90s']))
    await sleep(3000)
    const t = Date.now()
    const x = await su(['exec', 'e2e-root', 'echo still-served'])
    assert.equal(x.code, 0, x.all)
    assert.ok(Date.now() - t < 8000, `exec took ${Date.now() - t} ms behind nine waits`)
    for (const r of await Promise.all(waits)) assert.equal(r.code, 0, r.all)
  })

  test('unknown job: exit 1 with a clear message', async () => {
    const r = await su(['job', 'wait', 'e2e-root', `jw-nope-${RUN}`])
    assert.equal(r.code, 1, r.all)
    assert.match(r.out, /no job named/)
  })

  test('the runner gone without an exit file (killed, server rebooted): exit 1, "unknown"', { timeout: 120_000 }, async () => {
    const n = jn('gone')
    const pid = await start(n, 'sleep 54')
    // the runner leads its process group (setsid): this takes the runner and the job with it, no exit file written
    assert.equal((await s.sh('e2e-root', `kill -KILL -${pid}`, '--yes')).code, 0)
    const r = await su(['job', 'wait', 'e2e-root', n, '--timeout', '20s'])
    assert.equal(r.code, 1, r.all)
    assert.match(r.out, /unknown: runner gone without exit code/)
  })

  test('a job restarted under the same name during a wait: the wait says so and follows the new run', { timeout: 180_000 }, async () => {
    const n = jn('restart')
    await start(n, 'sleep 10; echo second-run; exit 0')
    const w = su(['job', 'wait', 'e2e-root', n, '--timeout', '90s'])
    await sleep(2500)
    // what `job start` under the same name leaves behind for a waiter: another started stamp
    const r0 = await s.sh('e2e-root', `echo 2000-01-01T00:00:00+0000 > "$HOME/.server-use/jobs/${n}/started"`)
    assert.equal(r0.code, 0, r0.err)
    const r = await w
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /job was restarted at 2000-01-01T00:00:00\+0000; waited for the new run/)
    assert.match(r.out, /second-run/)
  })
})
