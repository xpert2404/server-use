import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { parseCheck, diffHost, checkCode } from '../src/ops/check.mjs'
import { formatCheck, hint } from '../src/checkfmt.mjs'
import { scriptSource } from '../src/remote.mjs'
import { SH } from './fixture.mjs'
import { checkSpec } from '../src/inventory.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'su-check-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const finding = (sev = 'warn', kind = 'disk', id = '/') => ({ sev, kind, id, text: `${kind} ${id}` })

test('check settings reject unsupported HTTP skip while accepting supported probe skips', () => {
  assert.doesNotThrow(() => checkSpec('skip=disk,backup,watch'))
  assert.throws(() => checkSpec('skip=http'), /bad check setting/)
  assert.throws(() => checkSpec('skip=disk,http'), /bad check setting/)
})

test('parse check completion, findings, separators and partial probes; clipped output is incomplete', () => {
  assert.deepEqual(parseCheck('item=warn|disk|/|full|still\r\npartial=cert:permission denied\nnow=1234\n'), {
    items: [{ sev: 'warn', kind: 'disk', id: '/', text: 'full|still' }], partial: [{ probe: 'cert', reason: 'permission denied' }], now: 1234,
  })
  for (const text of ['now=1234\nclipped\n', 'now=-1\n', 'now=1234x\n', 'now=Infinity\n']) assert.equal(parseCheck(text).now, undefined)
  assert.deepEqual(parseCheck('item=toString|disk|/|bad\nitem=warn|disk\nnow=3\n').items, [])
})
test('diff marks new and severity escalation, preserves first-seen time and reports recovery', () => {
  const first = diffHost({}, [finding(), finding('info', 'reboot', 'required')], { now: 100 })
  assert.equal(first.items[0].state, 'new')
  assert.equal(first.items[1].state, undefined)
  const ongoing = diffHost(first.next, [finding()], { now: 200 })
  assert.equal(ongoing.items[0].state, 'ongoing')
  const worse = diffHost(ongoing.next, [finding('crit')], { now: 300 })
  assert.equal(worse.items[0].state, 'new')
  assert.equal(worse.next['disk|/'].since, 100)
  assert.deepEqual(diffHost(worse.next, [], { now: 400 }).resolved, [{ sev: 'crit', since: 100, kind: 'disk', id: '/' }])
})
test('partial probes and unreachable hosts never produce false recoveries', () => {
  const state = diffHost({}, [finding(), finding('warn', 'inodes'), finding('warn', 'cert', 'example'), finding('crit', 'connect', 'login')]).next
  const partial = diffHost(state, [], { partial: [{ probe: 'disk' }, { probe: 'cert' }] })
  assert.deepEqual(Object.keys(partial.next).sort(), ['cert|example', 'disk|/', 'inodes|/'])
  assert.equal(partial.resolved[0].kind, 'connect')
  const dead = diffHost(state, [finding('crit', 'connect', 'login')], { reachable: false })
  assert.equal(dead.resolved.length, 0)
  assert.equal(Object.keys(dead.next).length, 4)
})
test('exit 10 distinguishes attention from changes; info never requires attention', () => {
  assert.equal(checkCode([{ items: [finding('info')], resolved: [] }]), 0)
  assert.equal(checkCode([{ items: [finding()], resolved: [] }]), 10)
  assert.equal(checkCode([{ items: [{ ...finding(), state: 'ongoing' }], resolved: [] }], true), 0)
  assert.equal(checkCode([{ items: [], resolved: [{}] }], true), 10)
  assert.equal(checkCode([{ items: [{ ...finding(), state: 'new' }], resolved: [] }], true), 10)
})
test('actual SSH, authentication, host key and script errors retain their exit status, including unchanged failures', () => {
  for (const [code, expected] of [['HOSTKEY_CHANGED', 4], ['AUTH', 6], ['UNREACHABLE', 5], ['TIMEOUT', 124]]) {
    const rows = [{ error: { code, message: 'failure' }, items: [{ ...finding('crit', 'connect', 'login'), state: 'ongoing' }], resolved: [] }]
    assert.equal(checkCode(rows), expected)
    assert.equal(checkCode(rows, true), expected)
  }
  assert.equal(checkCode([{ exit: 1, error: { code: 'REMOTE' }, items: [], resolved: [] }]), 1)
  assert.equal(checkCode([{ exit: 9, items: [], resolved: [] }]), 9)
})
test('format healthy, ranked attention, ongoing changes, recovered and partial results', () => {
  const row = (host, items = [], partial = [], resolved = []) => ({ host, items, partial, resolved })
  assert.equal(formatCheck({ code: 0, results: [row('a'), row('b')] }), 'all 2 servers ok\n')
  const s = formatCheck({ code: 10, results: [row('a', [finding()]), row('b', [{ ...finding('crit'), state: 'new' }]), row('c', [], [{ probe: 'oom' }])] })
  assert.match(s, /^✗ b/m)
  assert.ok(s.indexOf('✗ b') < s.indexOf('! a'))
  assert.match(s, /doctor b/)
  assert.match(s, /not checked: c oom/)
  assert.match(formatCheck({ code: 0, changed: true, results: [row('a', [finding()])] }), /no change.*still open/)
  assert.match(formatCheck({ code: 10, changed: true, results: [row('a', [], [], [{ kind: 'job', id: 'a', since: 1000 }])] }), /resolved: a job a/)
  assert.equal(hint('web', { kind: 'job', id: 'build' }), 'server-use job logs web build')
})

describe('remote check probes', { skip: !SH && 'no POSIX sh' }, () => {
  const stub = join(tmp, 'stub')
  mkdirSync(stub)
  for (const [cmd, body] of [['df', `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 100 96 4 96%% /\n/dev/a 100 96 4 96%% /bind\ntmpfs 100 100 0 100%% /run\n/dev/b 100 92 8 92%% /data\n'`], ['systemctl', 'exit 1'], ['id', 'echo 1000']]) {
    writeFileSync(join(stub, cmd), `#!/bin/sh\n${body}\n`); chmodSync(join(stub, cmd), 0o755)
  }
  const path = [stub, ...(process.platform === 'win32' ? [dirname(SH)] : [process.env.PATH])].join(delimiter)
  const run = (body, vars = {}) => {
    const r = spawnSync(SH, [], { encoding: 'utf8', input: scriptSource('check') + '\n' + body, env: { PATH: path, HOME: tmp, SYSTEMROOT: process.env.SYSTEMROOT, SU_CHECK_LIB: '1', ...vars }, timeout: 10_000 })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  test('disk findings use thresholds, deduplicate bind mounts and exclude virtual filesystems', () => {
    const out = run('settings; usage disk -P "$w_disk"')
    assert.match(out, /item=crit\|disk\|\/\|disk \/ 96%/)
    assert.match(out, /item=warn\|disk\|\/data/)
    assert.doesNotMatch(out, /bind|run/)
    assert.equal(run('settings; usage disk -P "$w_disk"', { SU_CHECK: 'disk=99' }), '')
    assert.equal(run('settings; usage inodes -Pi "$w_inodes"', { SU_CHECK: 'skip=disk' }), '')
  })
  test('failed systemd probe is explicit; absent certificate findings cannot imply health', () => {
    assert.match(run('settings; p_units'), /^partial=unit:systemctl failed/)
  })
  test('configured stale and missing backup paths are findings, fresh backup is quiet', () => {
    const fresh = join(tmp, 'backup.dat')
    writeFileSync(fresh, 'backup')
    const posix = (p) => process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/') : p
    assert.equal(run('settings; p_backups', { SU_CHECK: `backup=${posix(fresh)}:24` }), '')
    assert.match(run('settings; p_backups', { SU_CHECK: `backup=${posix(fresh)}-missing:24` }), /backup.*missing/)
  })
  test('watch heartbeat config is read as data, never sourced as code', () => {
    mkdirSync(join(tmp, '.server-use', 'watch'), { recursive: true })
    writeFileSync(join(tmp, '.server-use', 'watch', 'watch.env'), `WATCH_EVERY_S='300'\necho injected-from-watch-env\n`)
    assert.doesNotMatch(run('settings; p_watch'), /injected-from-watch-env/)
  })
})
