// Deterministic daemon socket failures; no daemon process or SSH server is needed.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient, mac } from '../src/client.mjs'
import { waitCall } from '../src/jobcli.mjs'
import { VERSION } from '../src/paths.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'su-client-'))
const previous = process.env.SERVER_USE_HOME
process.env.SERVER_USE_HOME = tmp
const token = 'client-regression-token'
writeFileSync(join(tmp, 'daemon.token'), token, { mode: 0o600 })
after(() => {
  if (previous === undefined) delete process.env.SERVER_USE_HOME
  else process.env.SERVER_USE_HOME = previous
  rmSync(tmp, { recursive: true, force: true })
})
const closed = { code: 'INTERNAL', message: 'daemon connection closed' }
const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

class Socket extends EventEmitter {
  destroyed = false
  writable = true
  messages = []
  constructor(write = () => {}) { super(); this.onWrite = write }
  setEncoding() {}
  write(text, callback = () => {}) {
    const msg = JSON.parse(text)
    this.messages.push(msg)
    this.onWrite(msg, callback)
    return true
  }
  destroy() {
    if (this.destroyed) return this
    this.destroyed = true
    this.writable = false
    queueMicrotask(() => this.emit('close'))
    return this
  }
  receive(msg) { this.emit('data', JSON.stringify(msg) + '\n') }
}
const connecting = (t, make) => {
  t.mock.method(net, 'connect', () => {
    const socket = make()
    queueMicrotask(() => socket.emit('connect'))
    return socket
  })
}
const authenticated = (onRequest = () => {}) => {
  const sock = new Socket((msg, callback) => {
    if (msg.t === 'hello') queueMicrotask(() => sock.receive({ t: 'challenge', nonce: 'daemon-nonce', proof: mac(token, 'daemon', msg.nonce) }))
    else if (msg.t === 'auth') {
      assert.equal(msg.mac, mac(token, 'client', 'daemon-nonce'))
      queueMicrotask(() => sock.receive({ t: 'hello', ok: true, version: VERSION }))
    } else onRequest(sock, msg, callback)
  })
  return sock
}

test('EPIPE while sending the initial hello rejects safely and sends no auth or request', async (t) => {
  let sock
  connecting(t, () => sock = new Socket(() => { queueMicrotask(() => sock.emit('error', epipe())) }))
  await assert.rejects(DaemonClient.connect({ autostart: false }), closed)
  assert.equal(sock.destroyed, true)
  assert.deepEqual(sock.messages.map((m) => m.t), ['hello'])
})
test('a failed hello write callback and a synchronous write error both reject safely', async (t) => {
  for (const mode of ['callback', 'throw']) {
    connecting(t, () => new Socket((_msg, callback) => {
      if (mode === 'throw') throw epipe()
      callback(epipe())
    }))
    await assert.rejects(DaemonClient.connect({ autostart: false }), closed)
    t.mock.restoreAll()
  }
})
test('a close between connect and hello is classified as a closed daemon connection', async (t) => {
  let sock
  connecting(t, () => sock = new Socket(() => sock.destroy()))
  await assert.rejects(DaemonClient.connect({ autostart: false }), closed)
  assert.equal(sock.messages.length, 1)
})
test('an error immediately after connect stays handled before handshake listeners are installed', async (t) => {
  t.mock.method(net, 'connect', () => {
    const sock = new Socket()
    queueMicrotask(() => { sock.emit('connect'); sock.emit('error', epipe()) })
    return sock
  })
  await assert.rejects(DaemonClient.connect({ autostart: false }), closed)
})
test('an identity failure refuses auth and secret request arguments; it is not a retryable transport failure', async (t) => {
  let sock
  connecting(t, () => sock = new Socket((msg) => queueMicrotask(() => sock.receive({ t: 'challenge', nonce: 'bad', proof: '0'.repeat(64) }))))
  const request = DaemonClient.connect({ autostart: false }).then((client) => client.request('servers.add', { password: 'never-send-this-secret' }))
  await assert.rejects(request, { code: 'INTERNAL', message: /identity check failed/ })
  assert.deepEqual(sock.messages.map((m) => m.t), ['hello'])
  assert.ok(!JSON.stringify(sock.messages).includes('never-send-this-secret'))
  assert.equal(sock.destroyed, true)
})
test('post-auth socket errors reject every pending request and future requests without uncaught errors', async () => {
  const sock = new Socket()
  const client = new DaemonClient(sock)
  const requests = [client.request('ping'), client.request('job', { action: 'wait' })]
  const rejected = requests.map((request) => assert.rejects(request, closed))
  sock.emit('error', epipe())
  await Promise.all(rejected)
  assert.equal(client.pending.size, 0)
  assert.equal(sock.destroyed, true)
  await assert.rejects(client.request('ping'), closed)
  sock.emit('error', epipe()) // A subsequent error after close must also stay handled.
})
test('request write errors through callbacks or throws clear all pending state', async () => {
  for (const mode of ['callback', 'throw']) {
    const sock = new Socket((_msg, callback) => {
      if (mode === 'throw') throw epipe()
      callback(epipe())
    })
    const client = new DaemonClient(sock)
    await assert.rejects(client.request('ping'), closed)
    assert.equal(client.pending.size, 0)
    assert.equal(sock.destroyed, true)
  }
})
test('ordinary replies and daemon operation errors preserve their existing semantics', async () => {
  const sock = new Socket()
  const client = new DaemonClient(sock)
  const success = client.request('ping')
  sock.receive({ t: 'res', id: 1, ok: true, result: { pid: 7 } })
  assert.deepEqual(await success, { pid: 7 })
  const failure = client.request('exec')
  sock.receive({ t: 'res', id: 2, ok: false, error: { code: 'AUTH', message: 'authentication failed' } })
  await assert.rejects(failure, { code: 'AUTH', message: 'authentication failed' })
  const circular = {}; circular.self = circular
  await assert.rejects(client.request('bad', circular), TypeError)
  assert.equal(client.pending.size, 0)
  client.close()
})
test('job wait retries a failed hello and returns the new daemon response', async (t) => {
  let connects = 0
  const sockets = []
  connecting(t, () => {
    let sock
    if (++connects === 1) sock = new Socket(() => queueMicrotask(() => sock.emit('error', epipe())))
    else sock = authenticated((socket, msg) => {
      assert.equal(msg.op, 'job')
      assert.equal(msg.args.action, 'wait')
      socket.receive({ t: 'res', id: msg.id, ok: true, result: { results: [{ host: 'web', exit: 6, waitState: 'exited' }] } })
    })
    sockets.push(sock)
    return sock
  })
  const result = await waitCall({ target: 'web', name: 'job', timeoutMs: 30_000 })
  assert.equal(result.results[0].exit, 6)
  assert.equal(connects, 2)
  assert.deepEqual(sockets[0].messages.map((m) => m.t), ['hello'])
  assert.deepEqual(sockets[1].messages.map((m) => m.t), ['hello', 'auth', 'req'])
})
