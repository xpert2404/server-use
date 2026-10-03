// e2e: detached jobs, real cron entries next to foreign crontab lines, app .env files.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { skip, sandbox, until, sleep, PW, RUN } from './helpers.mjs'

// Everything here must come back byte for byte: trailing blanks, a tab, backslashes, an escaped %, a blank line,
// and a foreign line that merely ends like one of ours.
const FOREIGN = [
  '# foreign crontab: every byte must survive',
  'MAILTO=""',
  '*/7 * * * * echo "100\\% foreign" >/dev/null 2>&1   ',
  '@reboot\t/bin/true',
  '# C:\\temp\\new',
  '',
  '# copied by hand: * * * * * true # server-use:tick',
  '',
  '',
].join('\n')
const BLOCK = /^# >>> server-use .*\n(?:.*\n)*?# <<< server-use <<<\n/m
const TICK = 'echo "tick $(date +%s)" >> /tmp/su-e2e-ticks.txt'
const starts = (/** @type {string} */ log) => (log.match(/^=== .* start$/gm) || []).length

// Spaces, both quote kinds, shell metacharacters, a backslash and a leading blank.
const VALUE = ' it\'s "quoted" & 100% $HOME `id` \\ end'
const ENV_FILE = '/opt/e2eenv/shared/.env'
const SPACED_BASE = '/tmp/su e2e/env base'

describe('e2e: jobs, cron and env', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  let foreignTab = ''
  before(async () => {
    s = sandbox()
    await s.add('e2e-root', 'root')
  })
  after(() => s?.cleanup())

  const crontab = async () => {
    const r = await s.sh('e2e-root', 'crontab -l')
    assert.equal(r.code, 0, r.err)
    return r.out
  }
  // The value as sh sees it after sourcing the file, base64 so it never shows up in an output.
  const envValue = async (/** @type {string} */ file, /** @type {string} */ key) => {
    const r = await s.sh('e2e-root', `set -a; . '${file}' || exit 1; printf '%s' "$${key}" | base64 -w0`)
    assert.equal(r.code, 0, r.err)
    return Buffer.from(r.out, 'base64').toString()
  }
  const envKeys = async (/** @type {string} */ file) => (await s.sh('e2e-root', `sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' '${file}'`)).out

  test('job survives disconnect and reports its exit code and output', { timeout: 180_000 }, async () => {
    const name = `short-${RUN}`
    const r = await s.su(['job', 'start', 'e2e-root', name, 'echo begin; sleep 3; echo end; exit 3'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, new RegExp(`started ${name} pid \\d+`))
    assert.equal((await s.su(['disconnect', 'e2e-root'])).code, 0)
    await until(async () => {
      const st = await s.su(['job', 'status', 'e2e-root', name])
      return /exited\W+3\b/.test(st.out) || st.all
    }, 60_000)
    const logs = await s.su(['job', 'logs', 'e2e-root', name])
    assert.equal(logs.code, 0, logs.all)
    assert.match(logs.out, /^begin$/m)
    assert.match(logs.out, /^end$/m)
  })

  test('job stop ends a job that outlived a disconnect', { timeout: 180_000 }, async () => {
    const name = `long-${RUN}`
    let r = await s.su(['job', 'start', 'e2e-root', name, 'sleep 1000'])
    assert.equal(r.code, 0, r.all)
    const pid = r.out.match(/pid (\d+)/)?.[1]
    assert.ok(pid, r.out)
    assert.equal((await s.su(['disconnect', 'e2e-root'])).code, 0)
    assert.equal((await s.sh('e2e-root', `kill -0 ${pid}`)).code, 0, 'the job must survive the disconnect')
    assert.match((await s.su(['job', 'status', 'e2e-root', name])).out, /\brunning\b/)
    assert.match((await s.su(['job', 'ls', 'e2e-root'])).out, new RegExp(`^${name} +running`, 'm'))
    r = await s.su(['job', 'stop', 'e2e-root', name], { timeout: 60_000 })
    assert.equal(r.code, 0, r.all)
    await until(async () => (await s.sh('e2e-root', `kill -0 ${pid} 2>/dev/null`)).code !== 0 || `pid ${pid} still alive`, 20_000)
  })

  test('cron add keeps foreign crontab lines byte-identical and replaces an entry of the same name', async () => {
    const put = await s.sh('e2e-root', `printf '%s' '${Buffer.from(FOREIGN).toString('base64')}' | base64 -d | crontab -`)
    assert.equal(put.code, 0, put.err)
    foreignTab = await crontab()
    for (let i = 0; i < 2; i++) {
      const r = await s.su(['cron', 'add', 'e2e-root', 'tick', '* * * * *', TICK])
      assert.equal(r.code, 0, r.all)
    }
    const tab = await crontab()
    assert.equal(tab.replace(BLOCK, ''), foreignTab, 'lines outside the managed block changed')
    const block = tab.match(BLOCK)?.[0] ?? ''
    assert.equal(block.match(/ # server-use:tick$/gm)?.length, 1, `one entry expected:\n${block}`)
    assert.match(block, /^\* \* \* \* \* \/bin\/sh \/root\/\.server-use\/cron\/tick\.sh # server-use:tick$/m)
    assert.doesNotMatch(block, /(?<!\\)%/, 'an unescaped % in a crontab line becomes a newline')
  })

  test('cron ls, run and logs', async () => {
    let r = await s.su(['cron', 'ls', 'e2e-root'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^tz=\S+/m)
    assert.match(r.out, /^tick +\* \* \* \* \* +echo "tick/m)
    assert.match(r.out, /foreign/)
    r = await s.su(['cron', 'run', 'e2e-root', 'tick'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^=== .* exit 0$/m)
    assert.equal((await s.sh('e2e-root', 'test -s /tmp/su-e2e-ticks.txt')).code, 0)
    r = await s.su(['cron', 'logs', 'e2e-root', 'tick'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^=== .* start$/m)
  })

  test('cron itself runs the entry', { timeout: 240_000 }, async () => {
    await until(async () => {
      const r = await s.su(['cron', 'logs', 'e2e-root', 'tick'])
      return starts(r.out) >= 2 || `no cron run yet (only cron run so far):\n${r.all}`
    }, 150_000, 5000)
  })

  test('cron flock skips a run while the previous one is active', { timeout: 120_000 }, async () => {
    let r = await s.su(['cron', 'add', 'e2e-root', 'slow', '0 0 1 1 *', 'sleep 8'])
    assert.equal(r.code, 0, r.all)
    const first = s.su(['cron', 'run', 'e2e-root', 'slow'])
    await sleep(3000)
    r = await s.su(['cron', 'run', 'e2e-root', 'slow'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /skipped: previous run still active/)
    assert.equal((await first).code, 0)
  })

  test('cron rm restores the crontab byte for byte and keeps the log', async () => {
    for (const name of ['tick', 'slow']) {
      const r = await s.su(['cron', 'rm', 'e2e-root', name])
      assert.equal(r.code, 0, r.all)
    }
    assert.equal(await crontab(), foreignTab)
    const files = await s.sh('e2e-root', 'test -f ~/.server-use/logs/cron-tick.log && test ! -e ~/.server-use/cron/tick.sh && test ! -e ~/.server-use/cron/tick.cmd')
    assert.equal(files.code, 0, 'rm keeps the log and removes the wrapper and the command')
    assert.equal((await s.su(['cron', 'rm', 'e2e-root', 'tick'])).code, 1)
  })

  test('env set/ls/rm: tricky values round-trip, ls never prints values', async () => {
    const clean = await s.sh('e2e-root', `rm -rf /opt/e2eenv '${SPACED_BASE}'`, '--yes')
    assert.equal(clean.code, 0, clean.err)
    let r = await s.su(['env', 'set', 'e2e-root', 'e2eenv', 'GREETING'], { input: VALUE })
    assert.equal(r.code, 0, r.all)
    r = await s.su(['env', 'set', 'e2e-root', 'e2eenv', 'PORT=8080'])
    assert.equal(r.code, 0, r.all)
    assert.equal(await envValue(ENV_FILE, 'GREETING'), VALUE)
    assert.equal(await envValue(ENV_FILE, 'PORT'), '8080')
    assert.equal((await s.sh('e2e-root', `stat -c %a ${ENV_FILE}`)).out, '600\n')

    r = await s.su(['env', 'ls', 'e2e-root', 'e2eenv'])
    assert.equal(r.code, 0, r.all)
    assert.ok(r.out.includes(ENV_FILE), r.out)
    assert.match(r.out, /^GREETING$/m)
    assert.match(r.out, /^PORT$/m)
    assert.ok(!r.out.includes('quoted') && !r.out.includes('8080'), `ls printed a value:\n${r.out}`)

    r = await s.su(['env', 'set', 'e2e-root', 'e2eenv', 'GREETING'], { input: 'second value' })
    assert.equal(r.code, 0, r.all)
    assert.equal(await envKeys(ENV_FILE), 'GREETING\nPORT\n', 'set replaces the line in place')
    assert.equal(await envValue(ENV_FILE, 'GREETING'), 'second value')

    r = await s.su(['env', 'rm', 'e2e-root', 'e2eenv', 'PORT'])
    assert.equal(r.code, 0, r.all)
    assert.equal(await envKeys(ENV_FILE), 'GREETING\n')
    assert.equal((await s.su(['env', 'rm', 'e2e-root', 'e2eenv', 'PORT'])).code, 1)
  })

  test('env with a --base path containing spaces', async () => {
    const r = await s.su(['env', 'set', 'e2e-root', 'e2eenv', 'SPACED', '--base', SPACED_BASE], { input: 'a b' })
    assert.equal(r.code, 0, r.all)
    assert.equal(await envValue(`${SPACED_BASE}/shared/.env`, 'SPACED'), 'a b')
    assert.match((await s.su(['env', 'ls', 'e2e-root', 'e2eenv', '--base', SPACED_BASE])).out, /^SPACED$/m)
  })

  test('secret leak: neither the password nor the env value shows up anywhere', () => {
    s.assertNoLeak([PW.root, VALUE])
  })
})
