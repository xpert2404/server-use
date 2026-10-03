// The daemon: mutual token check, one process across CLI calls, pooled connection reuse, reconnects, version switch.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startFixture, SH } from './fixture.mjs'
import { sandbox, until } from './e2e/helpers.mjs'
import { socketPath, VERSION } from '../src/paths.mjs'
import { mac, PROTOCOL } from '../src/client.mjs'
import { takeLock } from '../src/daemon.mjs'

process.env.SERVER_USE_DAEMON_IDLE_MS = '60000'
const PW = 'fx-Secret-d41e'
const skip = SH ? false : 'no POSIX sh for the fixture (install Git for Windows or set SU_TEST_SH)'

/**
 * Send lines on a raw daemon connection; collect what comes back until it closes (or `wait` ms pass).
 * With `key`, answer the daemon's challenge with a proof made from it, then send `after`.
 */
function raw(/** @type {string[]} */ lines, { key = '', after = /** @type {string[]} */ ([]), wait = 1500 } = {}) {
  return /** @type {Promise<{data: string, closed: boolean}>} */ (new Promise((resolve, reject) => {
    let data = ''
    const sock = net.connect(socketPath())
    const timer = setTimeout(() => { sock.destroy(); resolve({ data, closed: false }) }, wait)
    sock.on('data', (d) => {
      const before = data
      data += d
      const ch = /"t":"challenge".*"nonce":"(\w+)"/.exec(data)
      if (key && ch && !before.includes('"challenge"')) sock.write([JSON.stringify({ t: 'auth', mac: mac(key, 'client', ch[1]) }), ...after].map((l) => l + '\n').join(''))
    })
    sock.on('error', reject)
    sock.on('close', () => { clearTimeout(timer); resolve({ data, closed: true }) })
    sock.write(lines.map((l) => l + '\n').join(''))
  }))
}
const hello = (version = VERSION) => JSON.stringify({ t: 'hello', nonce: 'n0', version, protocol: PROTOCOL, agent: 'test' })
const alive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('daemon lock: an empty lock is still being written and is not stolen; an old empty one is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'su-lock-'))
  const prev = process.env.SERVER_USE_HOME
  process.env.SERVER_USE_HOME = dir
  try {
    const lock = join(dir, 'daemon.lock')
    writeFileSync(lock, '')
    assert.equal(takeLock(), false)
    assert.equal(readFileSync(lock, 'utf8'), '')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    assert.equal(takeLock(), true)
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid))
  } finally {
    if (prev === undefined) delete process.env.SERVER_USE_HOME
    else process.env.SERVER_USE_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('daemon', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  /** @type {Awaited<ReturnType<typeof startFixture>>} */ let fx
  const pid = async () => {
    const r = await s.su(['daemon', 'status'])
    return Number(/running: pid (\d+)/.exec(r.out)?.[1] ?? assert.fail(r.all))
  }
  const token = () => readFileSync(join(s.home, 'daemon.token'), 'utf8').trim()

  before(async () => {
    s = sandbox()
    process.env.SERVER_USE_HOME = s.home // for socketPath()
    fx = await startFixture({ password: PW })
    const r = await s.su(['add', 'd1', `tester@127.0.0.1:${fx.port}`, '--password-stdin'], { input: PW })
    assert.equal(r.code, 0, r.all)
    fx.password = null
  })
  after(async () => {
    await s?.cleanup()
    await fx?.close()
  })

  test('a connection without the right token is dropped before any request is served', async () => {
    const ping = JSON.stringify({ t: 'req', id: 1, op: 'ping' })
    assert.deepEqual(await raw([ping]), { data: '', closed: true })
    // the daemon proves the token first (over our nonce), but serves nothing before our own proof
    const early = await raw([hello(), ping])
    assert.equal(JSON.parse(early.data).proof, mac(token(), 'daemon', 'n0'))
    assert.equal(early.closed, true)
    for (const key of ['0'.repeat(48), token() + 'x']) {
      const r = await raw([hello()], { key, after: [ping] })
      assert.equal(r.closed, true)
      assert.doesNotMatch(r.data, /"t":"(hello|res)"/)
    }
    const ok = await raw([hello()], { key: token(), after: [ping] })
    assert.match(ok.data, /"t":"hello","ok":true/)
    assert.match(ok.data, /"t":"res","id":1,"ok":true/)
  })

  test('a fake daemon squatting the pipe/socket gets neither the token nor a password', async () => {
    const sq = sandbox()
    mkdirSync(sq.home, { recursive: true })
    writeFileSync(join(sq.home, 'daemon.token'), 'f'.repeat(48))
    process.env.SERVER_USE_HOME = sq.home
    const path = socketPath()
    process.env.SERVER_USE_HOME = s.home
    let got = ''
    const fake = net.createServer((c) => {
      c.on('error', () => {})
      c.once('data', (d) => { got += d; c.end(JSON.stringify({ t: 'challenge', proof: '0'.repeat(64), nonce: 'n' }) + '\n') })
    })
    await new Promise((r) => fake.listen(path, () => r(undefined)))
    try {
      const r = await sq.su(['add', 'x', 'tester@127.0.0.1:1', '--password-stdin'], { input: 'Sq-Secret-77' })
      assert.notEqual(r.code, 0)
      assert.match(r.all, /identity check failed/)
      assert.match(got, /"t":"hello"/)
      assert.doesNotMatch(got, /f{48}|Sq-Secret-77|"t":"(auth|req)"/)
    } finally {
      await new Promise((r) => fake.close(() => r(undefined)))
      await sq.cleanup()
    }
  })

  test('one daemon across CLI calls; the second exec reuses the pooled connection', async () => {
    const p = await pid()
    assert.equal((await s.su(['disconnect', 'd1'])).code, 0)
    const before = fx.handshakes
    for (const word of ['one', 'two']) {
      const r = await s.su(['exec', 'd1', `echo ${word}`])
      assert.equal(r.code, 0, r.all)
      assert.match(r.out, new RegExp(`\\n${word}\\n`))
    }
    assert.equal(fx.handshakes - before, 1)
    assert.equal(await pid(), p)
  })

  test('reconnects on its own after the server restarts (same host key)', async () => {
    await fx.restart()
    const r = await s.su(['exec', 'd1', 'echo again'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /\nagain\n/)
  })

  test('reconnect: a command cut off by the restart is reported as aborted and not run again', async () => {
    const mark = join(s.home, 'runs-once.txt').replaceAll('\\', '/')
    const running = s.su(['exec', 'd1', `echo x >> '${mark}'; sleep 5; echo done`])
    await until(async () => { try { return readFileSync(mark, 'utf8').length > 0 || 'not started' } catch { return 'not started' } }, 10_000, 100)
    await fx.restart()
    const r = await running
    assert.notEqual(r.code, 0, r.all)
    assert.doesNotMatch(r.out, /\ndone\n/)
    assert.match(r.all, /DISCONNECTED: connection lost while the command was running; not retried/)
    assert.equal(readFileSync(mark, 'utf8'), 'x\n')
  })

  test('a newer client or a restart while a command runs: neither fails nor cuts the command off', async () => {
    const old = await pid()
    const mark = join(s.home, 'busy.txt').replaceAll('\\', '/')
    const running = s.su(['exec', 'd1', `echo x > '${mark}'; sleep 3; echo finished`])
    await until(async () => existsSync(mark) || 'not started', 10_000, 100)
    // the busy daemon serves the newer client instead of making way
    const newer = await raw([hello('99.0.0')], { key: token() })
    assert.match(newer.data, /"t":"hello","ok":true.*"restart":false/)
    // the new daemon waits for the draining one instead of quitting on its lock
    const r = await s.su(['daemon', 'restart'])
    assert.equal(r.code, 0, r.all)
    const x = await running
    assert.equal(x.code, 0, x.all)
    assert.match(x.out, /\nfinished\n/)
    assert.notEqual(await pid(), old)
  })

  test('a newer client makes the daemon exit; the next call starts a fresh one', async () => {
    const old = await pid()
    const r = await raw([hello('99.0.0')], { key: token() })
    assert.match(r.data, /"ok":false.*"restart":true/)
    await until(async () => !alive(old) || `pid ${old} still alive`, 15_000, 100)
    const x = await s.su(['exec', 'd1', 'echo fresh'])
    assert.equal(x.code, 0, x.all)
    assert.notEqual(await pid(), old)
  })
})
