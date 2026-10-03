// put/get edge cases against a fixture server, concurrent cron edits, and where secrets land on headless Linux.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Duplex } from 'node:stream'
import { delimiter, dirname, join } from 'node:path'
import { startFixture, SH } from './fixture.mjs'
import { sandbox, repoFile } from './e2e/helpers.mjs'

process.env.SERVER_USE_DAEMON_IDLE_MS = '60000'
const WIN = process.platform === 'win32'
const skip = SH ? false : 'no POSIX sh for the fixture (install Git for Windows or set SU_TEST_SH)'
const work = mkdtempSync(join(tmpdir(), 'su io-'))
after(() => rmSync(work, { recursive: true, force: true }))

describe('put/get', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  /** @type {Awaited<ReturnType<typeof startFixture>>} */ let fx
  before(async () => {
    s = sandbox()
    fx = await startFixture({ password: 'fx-io-pw' })
    const r = await s.su(['add', 'io1', `tester@127.0.0.1:${fx.port}`, '--password-stdin'], { input: 'fx-io-pw' })
    assert.equal(r.code, 0, r.all)
  })
  after(async () => {
    await s?.cleanup()
    await fx?.close()
  })

  test('get creates the local file private (0600)', { skip: WIN && 'no POSIX modes on Windows' }, async () => {
    writeFileSync(join(fx.home, 'key.pem'), 'secret')
    writeFileSync(join(work, 'key.pem.su-part'), 'stale') // an existing temp file must not lend its mode
    chmodSync(join(work, 'key.pem.su-part'), 0o644)
    const r = await s.su(['get', 'io1', '~/key.pem', join(work, 'key.pem')])
    assert.equal(r.code, 0, r.all)
    assert.equal(statSync(join(work, 'key.pem')).mode & 0o777, 0o600)
  })

  test('put to an existing remote directory without a trailing slash fails and leaves nothing behind', async () => {
    mkdirSync(join(fx.home, 'adir'))
    writeFileSync(join(work, 'up.txt'), 'data')
    const r = await s.su(['put', 'io1', join(work, 'up.txt'), '~/adir'])
    assert.notEqual(r.code, 0, r.all)
    assert.match(r.all, /is a directory/)
    assert.deepEqual(readdirSync(join(fx.home, 'adir')), [])
  })

  test('put whose upload ends early installs nothing', async () => {
    // The remote side as sshd leaves it when an abort's KILL misses `cat`: stdin just closes, here after 500 bytes.
    const client = { exec(/** @type {string} */ cmd, /** @type {Function} */ cb) {
      const child = spawn(/** @type {string} */ (SH), ['-c', cmd], { cwd: fx.home, env: fx.env, windowsHide: true })
      child.stdin.end('x'.repeat(500))
      const ch = Object.assign(new Duplex({ read() {}, write(_c, _e, done) { done() } }), { stderr: child.stderr, signal() {}, close() {} })
      child.stdout.on('data', (d) => ch.push(d))
      child.on('close', (code) => ch.emit('close', code))
      cb(undefined, ch)
    } }
    writeFileSync(join(fx.home, 'cut.txt'), 'old')
    writeFileSync(join(work, 'cut.txt'), 'x'.repeat(1000))
    process.env.SERVER_USE_HOME = s.home // the inventory with io1
    const { put } = await import('../src/ops/transfer.mjs')
    const ctx = /** @type {any} */ ({ pool: { with: (/** @type {string} */ _n, /** @type {Function} */ fn) => fn({ name: 'io1', state: 'open', client }) }, agent: 'test', runId: 't' })
    const { results: [r] } = await put(ctx, { targets: 'io1', local: join(work, 'cut.txt'), remote: '~/cut.txt', yes: true })
    assert.notEqual(r.exit, 0, JSON.stringify(r))
    assert.equal(readFileSync(join(fx.home, 'cut.txt'), 'utf8'), 'old')
    assert.deepEqual(readdirSync(fx.home).filter((f) => f.startsWith('cut.txt.su-tmp.')), [])
  })

  /** A client that runs `prefix`, then the command, in sh in the fixture home. */
  const shClient = (/** @type {string} */ prefix) => ({ exec(/** @type {string} */ cmd, /** @type {Function} */ cb) {
    const child = spawn(/** @type {string} */ (SH), ['-c', `${prefix}\n${cmd}`], { cwd: fx.home, env: fx.env, windowsHide: true })
    const ch = Object.assign(new Duplex({ read() {}, write(c, _e, done) { child.stdin.write(c, done) }, final(done) { child.stdin.end(done) } }),
      { stderr: child.stderr, signal() {}, close() {} })
    child.stdout.on('data', (d) => ch.push(d))
    child.on('close', (code) => ch.emit('close', code))
    cb(undefined, ch)
  } })

  test('put does not reuse a file planted at a guessable temp name', async () => {
    // Planted where the old `<dst>.su-tmp.$$` landed (same shell, same $$); as root, a symlink there was a write anywhere.
    const client = shClient('echo planted > pl.txt.su-tmp.$$')
    writeFileSync(join(work, 'pl.txt'), 'new')
    process.env.SERVER_USE_HOME = s.home
    const { put } = await import('../src/ops/transfer.mjs')
    const ctx = /** @type {any} */ ({ pool: { with: (/** @type {string} */ _n, /** @type {Function} */ fn) => fn({ name: 'io1', state: 'open', client }) }, agent: 'test', runId: 't' })
    const { results: [r] } = await put(ctx, { targets: 'io1', local: join(work, 'pl.txt'), remote: '~/pl.txt', yes: true })
    assert.equal(r.exit, 0, JSON.stringify(r))
    assert.equal(readFileSync(join(fx.home, 'pl.txt'), 'utf8'), 'new')
    const planted = readdirSync(fx.home).filter((f) => f.startsWith('pl.txt.su-tmp.'))
    assert.equal(planted.length, 1, String(planted))
    assert.equal(readFileSync(join(fx.home, planted[0]), 'utf8'), 'planted\n')
    // A new file gets the umask default, as `cat >` gave it (not 0600, and not one worked out in octal arithmetic,
    // which zsh/ksh login shells read as decimal).
    if (!WIN) assert.equal(statSync(join(fx.home, 'pl.txt')).mode & 0o777, 0o666 & ~process.umask())
  })

  test('put will not write in a temp dir that is not private', async () => {
    // As if another account swapped the fresh temp dir for a symlink to a dir of its own before the cd: root would
    // write `f` in there, through whatever `f` is. A dir with entries stands in (Windows has no modes or owners to fake).
    mkdirSync(join(fx.home, 'lure'))
    writeFileSync(join(fx.home, 'lure', 'f'), 'victim')
    writeFileSync(join(work, 'sw.txt'), 'new')
    process.env.SERVER_USE_HOME = s.home
    const { put } = await import('../src/ops/transfer.mjs')
    const client = shClient('mktemp() { echo lure; }')
    const ctx = /** @type {any} */ ({ pool: { with: (/** @type {string} */ _n, /** @type {Function} */ fn) => fn({ name: 'io1', state: 'open', client }) }, agent: 'test', runId: 't' })
    const { results: [r] } = await put(ctx, { targets: 'io1', local: join(work, 'sw.txt'), remote: '~/sw.txt', yes: true })
    assert.notEqual(r.exit, 0, JSON.stringify(r))
    assert.match(r.stderr.text, /not private/)
    assert.equal(readFileSync(join(fx.home, 'lure', 'f'), 'utf8'), 'victim')
    assert.deepEqual(readdirSync(fx.home).filter((f) => f.startsWith('sw.txt')), [])
  })

  test('put --mode works on a path starting with "-", and a copied mode drops setuid', async () => {
    writeFileSync(join(work, 'k.txt'), 'secret')
    let r = await s.su(['put', 'io1', join(work, 'k.txt'), '~/-k.txt', '--mode', '600'])
    assert.equal(r.code, 0, r.all)
    assert.equal(readFileSync(join(fx.home, '-k.txt'), 'utf8'), 'secret')
    if (WIN) return // no POSIX modes
    assert.equal(statSync(join(fx.home, '-k.txt')).mode & 0o7777, 0o600) // chmod read "-k..." as options, kept 644
    // A dst planted setuid by whoever can write its dir must not make a --sudo upload setuid root.
    writeFileSync(join(fx.home, 'tool'), 'old')
    chmodSync(join(fx.home, 'tool'), 0o4755)
    r = await s.su(['put', 'io1', join(work, 'k.txt'), '~/tool'])
    assert.equal(r.code, 0, r.all)
    assert.equal(statSync(join(fx.home, 'tool')).mode & 0o7777, 0o755)
  })

  test('get that fails before the transfer leaves no .su-part behind', async () => {
    process.env.SERVER_USE_HOME = s.home
    const { get } = await import('../src/ops/transfer.mjs')
    const ctx = /** @type {any} */ ({ pool: { with: async () => { throw Object.assign(new Error('no sudo password'), { code: 'SUDO' }) } }, agent: 'test', runId: 't' })
    const { results: [r] } = await get(ctx, { targets: 'io1', remote: '/etc/shadow', local: join(work, 'shadow'), sudo: true })
    assert.equal(r.error?.code, 'SUDO', JSON.stringify(r))
    assert.deepEqual(readdirSync(work).filter((f) => f.startsWith('shadow')), [])
  })

  test('put of an unreadable local file fails fast with a usage error', { timeout: 60_000 }, async (t) => {
    const f = join(work, 'locked.txt')
    writeFileSync(f, 'data')
    if (WIN) spawnSync('icacls', [f, '/deny', '*S-1-1-0:(RD)'], { stdio: 'ignore' }) // stat still works, open fails
    else if (process.getuid?.() === 0) return t.skip('root reads anything')
    else chmodSync(f, 0)
    const r = await s.su(['put', 'io1', f, '~/locked.txt'], { timeout: 30_000 })
    assert.equal(r.code, 2, r.all)
    assert.match(r.all, /cannot read/)
  })
})

test('concurrent cron add on one server keeps every entry', { skip, timeout: 120_000 }, async () => {
  const home = join(work, 'cronhome')
  const bin = join(work, 'cronbin')
  mkdirSync(home)
  mkdirSync(bin)
  // A crontab that stores in $HOME and is slow to read, so unserialised read-modify-writes overlap for sure.
  writeFileSync(join(bin, 'crontab'), [
    '#!/bin/sh',
    'f="$HOME/crontab.txt"',
    'if [ "$1" = -l ]; then sleep 1; [ -f "$f" ] || { echo "no crontab for tester" >&2; exit 1; }; cat "$f"',
    'else cat >"$f"; fi',
    '',
  ].join('\n'), { mode: 0o755 })
  const PATH = WIN ? [bin, dirname(/** @type {string} */ (SH))].join(delimiter) : [bin, process.env.PATH].join(delimiter)
  const add = (/** @type {string} */ name) => new Promise((resolve) => execFile(/** @type {string} */ (SH), [repoFile('remote/cron.sh')], {
    env: { PATH, HOME: home, SYSTEMROOT: process.env.SYSTEMROOT, SU_ACTION: 'add', SU_NAME: name, SU_SCHEDULE: '* * * * *', SU_PAYLOAD_B64: Buffer.from('true').toString('base64') },
    windowsHide: true,
  }, (e, out, err) => resolve({ name, code: e ? e.code : 0, out: out + err })))
  const names = ['j1', 'j2', 'j3']
  for (const r of /** @type {any[]} */ (await Promise.all(names.map(add)))) assert.equal(r.code, 0, `${r.name}: ${r.out}`)
  const tab = readFileSync(join(home, 'crontab.txt'), 'utf8')
  for (const n of names) assert.match(tab, new RegExp(`# server-use:${n}$`, 'm'), tab)
})

// No Secret Service (no D-Bus session): the keyring binding would silently use the in-memory kernel keyring,
// which forgets everything on reboot.
test('headless Linux stores secrets in the file', { skip: (process.platform !== 'linux' || process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DISPLAY) && 'needs Linux without a desktop session' }, async () => {
  delete process.env.SERVER_USE_SECRETS
  const { backend } = await import('../src/secrets.mjs')
  assert.equal(backend(), 'file')
})
