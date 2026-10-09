import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { callTool } from '../src/mcp.mjs'
import { sandbox } from './e2e/helpers.mjs'

test('public stdio MCP exposes no secret inputs and rejects credential payloads before starting a daemon', async () => {
  const s = sandbox()
  const secret = 'Mcp-Privacy-Control-29f7'
  const calls = [
    { method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'privacy-test' } } },
    { method: 'tools/list' },
    ...['servers', 'watch'].flatMap(name => ['password', 'sudoPassword', 'sudo-password', 'passphrase', 'privateKey', 'secret', 'token'].map(key => ({
      method: 'tools/call', params: { name, arguments: { action: name === 'servers' ? 'add' : 'on', name: 'lab', address: 'root@127.0.0.1:1', target: 'lab', [key]: secret } },
    }))),
    { method: 'tools/call', params: { name: 'deploy', arguments: { action: 'env_set', target: 'lab', name: 'app', key: 'API_KEY', value: secret } } },
    { method: 'tools/call', params: { name: 'deploy', arguments: { action: 'env_ls', target: 'lab', name: 'app', value: secret } } },
  ]
  try {
    const r = await s.su(['mcp'], { input: calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c })).join('\n') + '\n' })
    assert.equal(r.code, 0, r.all)
    assert.ok(!r.all.includes(secret), 'rejected values must not be echoed')
    const replies = new Map(r.out.trim().split('\n').map(line => JSON.parse(line)).map(m => [m.id, m.result]))
    assert.equal(replies.size, calls.length)
    assert.match(replies.get(1).instructions, /Never request passwords/)
    const tools = replies.get(2).tools
    assert.ok(!('password' in tools.find(t => t.name === 'servers').inputSchema.properties))
    const deploy = tools.find(t => t.name === 'deploy').inputSchema.properties
    assert.ok(!('value' in deploy))
    assert.ok(!deploy.action.enum.includes('env_set'))
    for (let id = 3; id <= calls.length; id++) {
      const reply = replies.get(id)
      assert.equal(reply.isError, true)
      assert.match(reply.content[0].text, /^USAGE: .*never MCP arguments/)
    }
    assert.ok(!existsSync(s.home), 'validation must precede daemon connection and local state creation')
  } finally {
    await s.cleanup()
  }
})

test('trusted local adapters retain out-of-band onboarding and env writes without returning secret values', async () => {
  const secret = 'Local-Adapter-Control-6a91'
  const operations = []
  const c = { async request(op, args) {
    operations.push(op)
    if (op === 'servers.add') {
      assert.equal(args.password, secret)
      return { name: 'lab', keyInstalled: true }
    }
    assert.equal(op, 'env')
    assert.equal(args.value, secret)
    return { results: [{ host: 'lab', exit: 0, stdout: { text: 'stored API_KEY' } }] }
  } }
  const added = await callTool(c, 'servers', { action: 'add', name: 'lab', address: 'root@127.0.0.1:1', password: secret })
  const stored = await callTool(c, 'deploy', { action: 'env_set', target: 'lab', name: 'app', key: 'API_KEY', value: secret })
  assert.equal(added.isError, false)
  assert.equal(stored.isError, false)
  assert.ok(!JSON.stringify([added, stored]).includes(secret))
  assert.deepEqual(operations, ['servers.add', 'env'])
})
