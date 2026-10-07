import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { watchSettings, watchUrl, watch } from '../src/ops/watch.mjs'
import { b64, scriptSource } from '../src/remote.mjs'
import { shVars } from '../src/util.mjs'
import { SH } from './fixture.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'su-watch-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
test('settings accept precise cron intervals, random ntfy topics and HTTP status probes', () => {
  const a = watchSettings({ urls: ['https://example.invalid/ping=204', 'http://127.0.0.1:8000/a?x=1'] })
  assert.equal(a.schedule, '*/5 * * * *')
  assert.match(a.endpoint, /^https:\/\/ntfy.sh\/server-use-[a-f0-9]{36}$/)
  assert.equal(a.urls, '204|https://example.invalid/ping\nok|http://127.0.0.1:8000/a?x=1')
  assert.notEqual(a.endpoint, watchSettings({}).endpoint)
  assert.equal(watchSettings({ every: '1h' }).schedule, '0 * * * *')
  assert.equal(watchSettings({ notify: 'telegram:-123', secret: '123:abc_X' }).endpoint, 'https://api.telegram.org')
})
test('invalid interval, URL, provider, secret and probes fail before any inventory or SSH operation', async () => {
  for (const every of ['0', '30s', '7m', '90m', 'NaN', '-1']) assert.throws(() => watchSettings({ every }), /watch|duration/)
  for (const url of ['file:///secret', 'https://user:secret@host/a', 'https://host/a\nheader', 'https://host/"x', 'https://host/\\x']) {
    assert.throws(() => watchUrl(url), (e) => !e.message.includes('secret') || !url.includes('secret'))
  }
  assert.throws(() => watchSettings({ notify: 'telegram:abcd', secret: '123:a' }), /Telegram/)
  assert.throws(() => watchSettings({ notify: 'smtp:secret' }), (e) => !e.message.includes('secret'))
  assert.throws(() => watchSettings({ secret: 'key\nInjected' }), /single line/)
  assert.throws(() => watchSettings({ urls: 'https://host' }), /array/)
  await assert.rejects(watch({}, { sub: 'on', targets: 'absent', every: '7m' }), /divide/)
  await assert.rejects(watch({}, { sub: 'mute', targets: 'absent', key: 'disk:/\nfoo' }), /kind:id/)
})

describe('remote watch lifecycle and state machine', { skip: !SH && 'no POSIX sh' }, () => {
  let home, stub, path
  let count = 0
  const wfile = (name) => join(home, '.server-use', 'watch', name)
  const read = (file) => existsSync(file) ? readFileSync(file, 'utf8') : ''
  const run = (vars = {}) => {
    const r = spawnSync(SH, [], { input: shVars(vars) + scriptSource('watch'), encoding: 'utf8', timeout: 15_000,
      env: { PATH: path, HOME: home, SYSTEMROOT: process.env.SYSTEMROOT } })
    return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
  }
  const on = (overrides = {}) => {
    const r = run({ SU_ACTION: 'on', SU_MODE: 'ntfy', SU_LABEL: 'test-host', SU_ENDPOINT: 'http://notify.invalid/topic', SU_SECRET: '', SU_CHAT: '', SU_EVERY: '300', SU_CHECK: '', SU_HEARTBEAT: '', SU_URLS_B64: '', SU_SCHEDULE: '*/5 * * * *',
      SU_WATCH_B64: b64(scriptSource('watch')), SU_CHECK_B64: b64(scriptSource('check')), SU_CRON_B64: b64(scriptSource('cron')), ...overrides })
    assert.equal(r.code, 0, r.all)
    writeFileSync(wfile('check.sh'), 'cat "$HOME/findings"\nprintf "now=%s\\n" "$(date +%s)"\n')
    writeFileSync(join(home, 'findings'), '')
    return r
  }
  const fault = (text = 'item=warn|disk|/|disk / 94% used\n') => writeFileSync(join(home, 'findings'), text)
  const notifications = () => read(join(home, 'deliveries.body'))
  const notified = () => read(join(home, 'deliveries.args')).trim().split('\n').filter(Boolean).length

  beforeEach(() => {
    home = join(tmp, String(++count)); stub = join(home, 'stub')
    mkdirSync(stub, { recursive: true })
    const stubs = [
      ['id', 'echo 1000'], ['flock', ':'],
      ['crontab', `case "$1" in -l) if [ -f "$HOME/crontab" ]; then cat "$HOME/crontab"; else echo 'no crontab' >&2; exit 1; fi ;; -) [ ! -f "$HOME/reject-cron" ] || exit 1; cat >"$HOME/crontab" ;; esac`],
      ['curl', `conf=$(cat)
printf '%s\\n' "$*" >>"$HOME/all-curl.args"
printf '%s\\n' "$conf" >>"$HOME/all-curl.config"
case "$*" in *--write-out*) cat "$HOME/http-code" 2>/dev/null || printf 200 ;;
*) [ ! -f "$HOME/reject-send" ] || exit 22
printf '%s\\n' "$*" >>"$HOME/deliveries.args"
printf '%s\\n' "$conf" >>"$HOME/deliveries.config"
cat "$HOME/.server-use/watch/body" >>"$HOME/deliveries.body"
;; esac`],
      // The signer stub records argv; the real Python HMAC implementation is exercised by the sshd e2e case.
      ['python3', `printf '%s\\n' "$*" >"$HOME/signer.args"; printf 'aabbcc\\n'`],
    ]
    for (const [cmd, body] of stubs) { const f = join(stub, cmd); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755) }
    path = [stub, ...(process.platform === 'win32' ? [dirname(SH)] : [process.env.PATH])].join(delimiter)
  })
  test('on installs only its cron entry, ls shows safe metadata, off removes it and preserves foreign entries', () => {
    writeFileSync(join(home, 'crontab'), '# foreign\n0 0 * * * echo existing\n')
    on()
    assert.match(read(join(home, 'crontab')), /server-use:watch/)
    assert.match(read(join(home, 'crontab')), /0 0 \* \* \* echo existing/)
    assert.match(run({ SU_ACTION: 'ls' }).out, /watch on: every 300s, notify ntfy/)
    const off = run({ SU_ACTION: 'off', SU_CRON_B64: b64(scriptSource('cron')) })
    assert.equal(off.code, 0, off.all)
    assert.equal(read(join(home, 'crontab')), '# foreign\n0 0 * * * echo existing\n')
    assert.equal(existsSync(wfile('secret')), false)
    assert.equal(run({ SU_ACTION: 'ls' }).out, 'watch off\n')
    assert.equal(run({ SU_ACTION: 'off' }).code, 0)
  })
  test('a fault needs two runs, repeated runs stay quiet, recovery needs two clean runs', () => {
    on(); fault()
    assert.equal(run().code, 0)
    assert.equal(notified(), 0)
    assert.equal(run().code, 0)
    assert.equal(notified(), 1)
    assert.match(notifications(), /WARN disk:\/.*94%/)
    run(); assert.equal(notified(), 1)
    fault(''); run(); assert.equal(notified(), 1)
    run(); assert.equal(notified(), 2)
    assert.match(notifications(), /RESOLVED disk:\//)
    assert.equal(read(wfile('state')), '')
  })
  test('one clean run resets debounce, severity escalation needs two runs and six-hour reminders recur', () => {
    on(); fault(); run(); fault(''); run(); fault(); run()
    assert.equal(notified(), 0)
    run(); assert.equal(notified(), 1)
    fault('item=crit|disk|/|disk full\n'); run(); assert.equal(notified(), 1)
    run(); assert.equal(notified(), 2)
    const state = read(wfile('state')).split('|'); state[7] = '1'; writeFileSync(wfile('state'), state.join('|'))
    run(); assert.equal(notified(), 3)
  })
  test('partial probes preserve active faults without sending false recovery', () => {
    on(); fault(); run(); run()
    fault('partial=disk:permission denied\n'); run(); run()
    assert.equal(notified(), 1)
    assert.match(read(wfile('state')), /^disk\|\//)
  })
  test('unavailable probes interrupt consecutive failures and clean-run recovery counters', () => {
    on(); fault(); run(); fault('partial=disk:unknown\n'); run(); fault(); run()
    assert.equal(notified(), 0)
    run(); assert.equal(notified(), 1)
    fault(''); run(); fault('partial=disk:unknown\n'); run(); fault(''); run()
    assert.equal(notified(), 1)
    run(); assert.equal(notified(), 2)
  })
  test('mute suppresses findings while heartbeat still runs; clearing mute sends the active fault', () => {
    on({ SU_HEARTBEAT: 'http://heartbeat.invalid/private' })
    assert.equal(run({ SU_ACTION: 'mute', SU_MUTE_KEY: 'disk:/', SU_MUTE_FOR: '3600' }).code, 0)
    fault(); run(); run()
    assert.equal(notified(), 0)
    assert.match(read(join(home, 'all-curl.config')), /heartbeat.invalid\/private/)
    assert.equal(run({ SU_ACTION: 'mute', SU_MUTE_KEY: 'disk:/', SU_MUTE_FOR: '0' }).code, 0)
    run(); assert.equal(notified(), 1)
    assert.match(run({ SU_ACTION: 'ls' }).out, /last run:/)
  })
  test('failed delivery retries on the following run and recovery retries until sent', () => {
    on(); fault(); run(); writeFileSync(join(home, 'reject-send'), '1')
    assert.match(run().out, /notification failed/)
    assert.match(run({ SU_ACTION: 'ls' }).out, /delivery failed/)
    assert.equal(notified(), 0)
    rmSync(join(home, 'reject-send')); run(); assert.equal(notified(), 1)
    assert.equal(existsSync(wfile('notify_error')), false)
    fault(''); run(); writeFileSync(join(home, 'reject-send'), '1'); run()
    assert.equal(notified(), 1)
    assert.match(read(wfile('state')), /^disk/)
    rmSync(join(home, 'reject-send')); run(); assert.equal(notified(), 2)
  })
  test('HTTP probes debounce and exact codes work; probe URLs are absent from finding text', () => {
    on({ SU_URLS_B64: b64('204|http://probe.invalid/token=private') })
    writeFileSync(join(home, 'http-code'), '500')
    run(); run()
    assert.match(notifications(), /HTTP probe 1 returned 500/)
    assert.doesNotMatch(notifications(), /private|probe.invalid/)
    writeFileSync(join(home, 'http-code'), '204'); run(); run()
    assert.match(notifications(), /RESOLVED http:1/)
  })
  test('ntfy access token uses curl stdin, never argv/crontab/state/output; test notification is explicit', () => {
    const secret = 'private-key-12345'
    const created = on({ SU_SECRET: secret })
    const tested = run({ SU_ACTION: 'test' })
    assert.equal(tested.code, 0, tested.all)
    assert.match(read(join(home, 'deliveries.config')), /Authorization: Bearer private-key-12345/)
    for (const text of [created.all, tested.all, run({ SU_ACTION: 'ls' }).all, read(join(home, 'crontab')), read(wfile('watch.env')), read(wfile('state')), read(join(home, 'all-curl.args'))]) assert.ok(!text.includes(secret), text)
    assert.equal(read(wfile('secret')), secret)
  })
  test('Telegram token is carried only in curl stdin; webhook signs JSON and keeps key out of signer argv', () => {
    const token = '12345:abc_private'
    on({ SU_MODE: 'telegram', SU_ENDPOINT: 'https://api.telegram.org', SU_CHAT: '-99', SU_SECRET: token })
    assert.equal(run({ SU_ACTION: 'test' }).code, 0)
    assert.match(read(join(home, 'deliveries.config')), /bot12345:abc_private\/sendMessage/)
    assert.match(read(join(home, 'deliveries.config')), /chat_id=-99/)
    assert.ok(!read(join(home, 'all-curl.args')).includes(token))
    on({ SU_MODE: 'webhook', SU_ENDPOINT: 'http://webhook.invalid/private', SU_SECRET: 'hmac-private-key' })
    assert.equal(run({ SU_ACTION: 'test' }).code, 0)
    assert.match(read(join(home, 'deliveries.config')), /X-Server-Use-Signature: sha256=aabbcc/)
    assert.ok(!read(join(home, 'signer.args')).includes('hmac-private-key'))
    const lastBody = read(join(home, 'deliveries.body')).trim().split('\n').at(-1)
    assert.equal(JSON.parse(lastBody).host, 'test-host')
  })
  test('webhook JSON correctly escapes quotes and backslashes in evidence text', () => {
    on({ SU_MODE: 'webhook', SU_ENDPOINT: 'http://webhook.invalid/', SU_SECRET: '' })
    fault('item=warn|disk|/|disk "quoted" C:\\data\n'); run(); run()
    assert.match(JSON.parse(notifications()).message, /disk "quoted" C:\\data/)
  })
  test('rejected cron setup preserves active settings and credentials', () => {
    on({ SU_SECRET: 'old-key' }); writeFileSync(join(home, 'reject-cron'), '1')
    const before = read(wfile('watch.env'))
    const r = run({ SU_ACTION: 'on', SU_MODE: 'ntfy', SU_ENDPOINT: 'http://new.invalid/', SU_SECRET: 'new-key', SU_EVERY: '60', SU_LABEL: 'test-host', SU_URLS_B64: '', SU_WATCH_B64: b64(scriptSource('watch')), SU_CHECK_B64: b64(scriptSource('check')), SU_CRON_B64: b64(scriptSource('cron')), SU_SCHEDULE: '* * * * *' })
    assert.equal(r.code, 1)
    assert.match(r.all, /previous settings kept/)
    assert.equal(read(wfile('watch.env')), before)
    assert.equal(read(wfile('secret')), 'old-key')
    assert.equal(existsSync(wfile('secret.new')), false)
  })
  test('watch settings preserve apostrophes as data when written and sourced', () => {
    on({ SU_ENDPOINT: "http://notify.invalid/a'b" })
    const r = run({ SU_ACTION: 'test' })
    assert.equal(r.code, 0, r.all)
    assert.match(read(join(home, 'deliveries.config')), /notify.invalid\/a'b/)
  })
  test('root refuses a home in lower-privileged ancestry before writing anything', () => {
    writeFileSync(join(stub, 'id'), '#!/bin/sh\necho 0\n')
    writeFileSync(join(stub, 'stat'), '#!/bin/sh\necho 1000\n')
    chmodSync(join(stub, 'stat'), 0o755)
    const r = run({ SU_ACTION: 'on' })
    assert.equal(r.code, 1)
    assert.match(r.err, /ancestry must be owned by root/)
    assert.equal(existsSync(join(home, '.server-use')), false)
  })
  test('symlinks in managed files are rejected before touching their targets', (t) => {
    on()
    const victim = join(home, 'victim')
    writeFileSync(victim, 'preserve')
    rmSync(wfile('secret'))
    try { symlinkSync(victim, wfile('secret')) } catch { t.skip('native symlinks unavailable'); return }
    const r = run({ SU_ACTION: 'test' })
    assert.equal(r.code, 1, r.all)
    assert.match(r.err, /symlink/)
    assert.equal(read(victim), 'preserve')
  })
  test('a symlink in the cron watch log is rejected before installing a privileged writer', (t) => {
    const logs = join(home, '.server-use', 'logs')
    mkdirSync(logs, { recursive: true })
    const victim = join(home, 'victim')
    writeFileSync(victim, 'preserve')
    try { symlinkSync(victim, join(logs, 'cron-watch.log')) } catch { t.skip('native symlinks unavailable'); return }
    const r = run({ SU_ACTION: 'on' })
    assert.equal(r.code, 1, r.all)
    assert.match(r.err, /symlink/)
    assert.equal(read(victim), 'preserve')
    assert.equal(existsSync(join(home, 'crontab')), false)
  })
})
