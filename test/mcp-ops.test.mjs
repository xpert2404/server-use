import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callTool, TOOLS } from '../src/mcp.mjs'
import { SuError } from '../src/util.mjs'

test('new remote MCP operations refuse absent targets before daemon access', async () => {
  const c = { request() { assert.fail('unexpected daemon access') } }
  for (const name of ['check', 'doctor', 'watch']) await assert.rejects(callTool(c, name, {}), /requires target/)
  for (const name of ['check', 'doctor', 'watch', 'run']) assert.ok(TOOLS.find(t => t.name === name).inputSchema.required.includes('target'))
})
test('watch rejects credential injection before transport and never advertises a credential argument', async () => {
  const c = { request() { assert.fail('credential reached daemon') } }
  for (const key of ['secret', 'token', 'password']) await assert.rejects(callTool(c, 'watch', { target: 'lab', action: 'on', [key]: 'sensitive' }), /never model arguments/)
  const properties = TOOLS.find(t => t.name === 'watch').inputSchema.properties
  assert.ok(!('secret' in properties))
})
test('run forwards only approved execution fields and cannot acquire a rate override', async () => {
  const c = { async request(op, a) { assert.equal(op, 'run'); assert.ok(!('yes' in a)); assert.deepEqual(a.params, { unit: 'app' }); return { results: [{ host: 'lab', exit: 0 }] } } }
  assert.equal((await callTool(c, 'run', { target: 'lab', runbook: 'fix', params: { unit: 'app' }, yes: true })).isError, false)
})
test('runbook approval exceptions propagate intact for native approval adapters', async () => {
  const error = new SuError('CONFIRM', 'approval required')
  await assert.rejects(callTool({ async request() { throw error } }, 'runbook', { action: 'add', target: 'lab', name: 'fix', script: 'true' }), e => e === error)
})
test('mixed successful completion and pending waits are a normal MCP answer, job exit 124 stays an error', async () => {
  const r = results => ({ async request() { return { results } } })
  assert.equal((await callTool(r([{ host: 'a', exit: 0, waitState: 'exited' }, { host: 'b', exit: 124, waitState: 'running' }]), 'job', { action: 'wait', target: 'a,b' })).isError, false)
  assert.equal((await callTool(r([{ host: 'a', exit: 124, waitState: 'exited' }]), 'job', { action: 'wait', target: 'a' })).isError, true)
  assert.equal((await callTool(r([{ host: 'a', exit: null, error: { code: 'AUTH', message: 'refused' } }]), 'job', { action: 'wait', target: 'a' })).isError, true)
})
