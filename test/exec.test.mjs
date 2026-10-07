// rawExec's output collection and the sudo wrapper, against a mock channel / the local sh (no SSH server).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import * as secrets from '../src/secrets.mjs'
import { rawExec, withSudo } from '../src/ops/exec.mjs'
import { SH } from './fixture.mjs'

const dir = mkdtempSync(join(tmpdir(), 'su-exec-'))
process.env.SERVER_USE_HOME = join(dir, 'home')
process.env.SERVER_USE_SECRETS = 'file'
after(() => rmSync(dir, { recursive: true, force: true }))

/** An ssh2-like channel the test drives by emitting 'data' / 'close' itself. */
const channel = () => Object.assign(new Readable({ read() {} }), { stderr: new EventEmitter(), write() { return true }, end() {}, signal() {}, close() {} })
const conn = (/** @type {any} */ ch) => /** @type {any} */ ({ name: 'web1', state: 'open', client: { exec: (/** @type {string} */ _c, /** @type {Function} */ cb) => cb(undefined, ch) } })

test('output cut by line count gets its full log even under the 16 KB spill size', async () => {
  const ch = channel()
  const p = rawExec(conn(ch), { command: 'x', logBase: join(dir, 'lines') })
  const full = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n'
  ch.emit('data', Buffer.from(full))
  ch.emit('close', 0)
  const r = await p
  assert.equal(r.stdout.truncated, true)
  assert.match(r.stdout.text, /… 100 lines cut …/)
  assert.equal(readFileSync(r.stdout.log, 'utf8'), full)
  assert.equal(r.stderr.log, undefined)
})

test('late data after a timeout reaches neither a reused fd nor an ended sink', async () => {
  const ch = channel()
  const p = rawExec(conn(ch), { command: 'x', timeoutMs: 30, logBase: join(dir, 'late') })
  ch.emit('data', Buffer.alloc(20_000, 'a')) // past SPILL_AT: the log fd is open
  const r = await p
  assert.equal(r.exit, 124)
  const other = join(dir, 'other')
  const fd = openSync(other, 'w') // most likely the number the log fd just freed
  try {
    ch.emit('data', Buffer.from('LATE'))
    ch.stderr.emit('data', Buffer.from('LATE'))
  } finally { closeSync(fd) }
  assert.equal(readFileSync(other, 'utf8'), '')
  assert.equal(readFileSync(r.stdout.log, 'utf8').length, 20_000)

  // get: the caller ends its sink right after the timeout result
  const ch2 = channel()
  /** @type {string[]} */ const got = []
  /** @type {Error[]} */ const errs = []
  const sink = new Writable({ write(c, _e, cb) { got.push(String(c)); cb() } }).on('error', (e) => errs.push(e))
  const r2 = await rawExec(conn(ch2), { command: 'x', sink, timeoutMs: 30 })
  assert.equal(r2.exit, 124)
  sink.end()
  ch2.emit('data', Buffer.from('LATE'))
  await new Promise((res) => setImmediate(res))
  assert.deepEqual(errs, [])
  assert.deepEqual(got, [])
})

test('an abort before or during the channel open never leaves the command running unattended', async () => {
  // Aborted while queued/connecting (signal already aborted): the command is never sent.
  /** @type {string[]} */ const sent = []
  const run = (/** @type {string} */ c, /** @type {Function} */ cb) => { sent.push(c); const ch = channel(); cb(undefined, ch); setImmediate(() => ch.emit('close', 0)) }
  const r = await rawExec(/** @type {any} */ ({ name: 'web1', state: 'open', client: { exec: run } }), { command: 'rm -rf /x', signal: AbortSignal.abort() })
  assert.equal(r.exit, 130)
  assert.equal(r.error?.code, 'ABORTED')
  assert.deepEqual(sent, [])

  // Aborted during the open round trip: the command just started. No stdin, channel closed, killed once its pid arrives.
  /** @type {any[]} */ const writes = []
  let closed = false
  const ch = Object.assign(channel(), { write: (/** @type {any} */ d) => writes.push(d), end: (/** @type {any} */ d) => d && writes.push(d), close: () => { closed = true } })
  /** @type {Function[]} */ const cbs = []
  const conn2 = /** @type {any} */ ({ name: 'web1', state: 'open', client: { exec: (/** @type {string} */ c, /** @type {Function} */ cb) => { sent.push(c); cbs.push(cb) } } })
  const ac = new AbortController()
  const p = rawExec(conn2, { command: 'sh -s', stdin: 'rm -rf /x\n', signal: ac.signal })
  ac.abort()
  cbs[0](undefined, ch)
  setImmediate(() => ch.emit('close', 0))
  const r2 = await p
  assert.equal(r2.exit, 130)
  assert.equal(r2.error?.code, 'ABORTED')
  assert.deepEqual(writes, [])
  assert.ok(closed)
  ch.stderr.emit('data', Buffer.from('\x1eSUPID4242\x1e\n'))
  assert.match(sent[1] ?? '', /kill -TERM 4242/)
})

test('sudo password never reaches the command, whether sudo prompts for it or not', { skip: !SH && 'no sh' }, async () => {
  const pw = 'hunter2-secret'
  secrets.setSecret('web1', 'sudo', pw)
  const w = await withSudo(/** @type {any} */ ({ sudo: 'password' }), /** @type {any} */ ({ name: 'web1', user: 'tester' }), 'sh -s')
  // Stand-in sudo: drops its options and runs the command; the prompting one eats a line first, like `sudo -S`.
  for (const prompts of [true, false]) {
    const fake = `sudo() { ${prompts ? 'IFS= read -r _pw; ' : ''}while [ "$1" != sh ]; do shift; done; "$@"; }\n`
    const r = spawnSync(/** @type {string} */ (SH), ['-c', fake + w.command], { input: w.prefix + 'echo ok\n', encoding: 'utf8', env: { ...process.env, PATH: [dirname(SH), process.env.PATH].join(delimiter) } })
    assert.equal(r.stdout, 'ok\n', `prompts=${prompts}: ${r.stderr}`)
    assert.ok(!r.stderr.includes(pw), `prompts=${prompts}: ${r.stderr}`)
  }
})
