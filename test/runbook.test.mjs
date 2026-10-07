// Pure state and local shell channels; no SSH connections or e2e fixture required.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import YAML from 'yaml'
import * as inventory from '../src/inventory.mjs'
import * as rb from '../src/ops/runbook.mjs'
import { file } from '../src/paths.mjs'
import { SH } from './fixture.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'su-runbook-'))
let sequence = 0
beforeEach(() => {
  process.env.SERVER_USE_HOME = join(tmp, String(++sequence), 'local')
  inventory.upsert('web1', { host: 'web1.example', user: 'root', tags: ['prod'], policy: 'confirm' })
  inventory.upsert('web2', { host: 'web2.example', user: 'root', tags: ['staging'], policy: 'confirm' })
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const blockedPool = { with() { assert.fail('a refused or dry run must not open an SSH channel') } }
const ctx = (pool = blockedPool) => ({ pool, agent: 'unit', runId: `unit-${sequence}` })
const add = (overrides = {}) => rb.add(ctx(), { targets: 'web1', name: 'fix', script: 'echo fixed', yes: true, ...overrides })
const mutate = (fn) => {
  const all = rb.load()
  fn(all.fix)
  writeFileSync(file('runbooks.yaml'), YAML.stringify(all))
}
const audit = () => readFileSync(file('audit.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s))
const first = async (args, pool = blockedPool) => (await rb.run(ctx(pool), { target: 'web1', runbook: 'fix', ...args })).results[0]

/** An ssh2-shaped channel that executes on the local POSIX shell instead of connecting to a server. */
function localPool({ gate, fail } = {}) {
  const home = join(tmp, String(sequence), 'remote')
  mkdirSync(home, { recursive: true })
  const commands = []
  return {
    home, commands,
    async with(name, fn) {
      if (fail) throw Object.assign(new Error('channel unavailable'), { code: 'UNREACHABLE' })
      if (gate) await gate
      return fn({ name, state: 'open', sudo: 'root', client: { exec(command, callback) {
        commands.push(command)
        const channel = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(), write() { return true }, signal() {}, close() {},
          end(input = '') {
            queueMicrotask(() => {
              const env = { ...process.env, HOME: home }
              if (process.platform === 'win32') env.PATH = [dirname(SH), join(dirname(SH), '..', '..', 'mingw64', 'bin')].join(';')
              const result = spawnSync(SH, ['-c', command], { input, env, cwd: home, encoding: 'utf8', timeout: 30_000, windowsHide: true })
              if (result.stdout) channel.emit('data', Buffer.from(result.stdout))
              if (result.stderr) channel.stderr.emit('data', Buffer.from(result.stderr))
              channel.emit('close', result.status ?? 255)
            })
          },
        })
        callback(undefined, channel)
      } } })
    },
  }
}

test('approval is mandatory even for open servers, and a refusal stores nothing', () => {
  inventory.upsert('web1', { policy: 'open' })
  assert.throws(() => add({ yes: false }), { code: 'CONFIRM' })
  assert.throws(() => add({ yes: 'true' }), { code: 'CONFIRM' })
  assert.equal(existsSync(file('runbooks.yaml')), false)
})

test('approval normalizes CRLF, pins destination and round-trips script text byte for byte', () => {
  const approved = add({ script: "printf '%s\\n' '  quoted  '\r\n\r\n", targets: 'tag:prod' })
  const shown = rb.show(ctx(), { name: 'fix' })
  assert.equal(shown.script, "printf '%s\\n' '  quoted  '\n\n")
  assert.equal(shown.state, 'ok')
  assert.equal(shown.sha, approved.sha)
  assert.deepEqual(shown.servers, { web1: { host: 'web1.example', port: 22, user: 'root' } })
})

test('parameters must be declared, unique, finite nonempty values without newlines', () => {
  assert.deepEqual(rb.parseParams(['unit=caddy, nginx,caddy', 'sig=TERM']), { unit: ['caddy', 'nginx'], sig: ['TERM'] })
  for (const invalid of [['foo='], ['foo=a,'], ['Bad=a'], ['foo=a', 'foo=b'], ['foo=one\ntwo'], ['foo=' + 'a'.repeat(201)]]) {
    assert.throws(() => rb.parseParams(invalid), { code: 'USAGE' })
  }
  assert.throws(() => add({ script: 'echo "$SU_P_unit"' }), /no --param unit/)
  assert.throws(() => add({ verify: 'test "$SU_P_unit" = caddy' }), /no --param unit/)
})

test('invalid scripts, names, verify text and sudo values are rejected before approval', () => {
  for (const script of ['', ' \n', 'echo\0bad', 'a'.repeat(65537), 123]) assert.throws(() => add({ script }), { code: 'USAGE' })
  for (const name of ['../bad', '*', 'a'.repeat(65)]) assert.throws(() => add({ name }), { code: 'USAGE' })
  assert.throws(() => add({ verify: '' }), { code: 'USAGE' })
  assert.throws(() => add({ sudo: 'false' }), { code: 'USAGE' })
})

test('rate limits are bounded counts and windows from 1 second through 7 days', () => {
  assert.deepEqual(rb.parseLimit('3/1h'), { max: 3, ms: 3600000 })
  assert.deepEqual(rb.parseLimit('9999/7d'), { max: 9999, ms: 604800000 })
  for (const bad of ['0/1h', '10000/1h', '1/999ms', '1/8d', '1/0', '1/soon', 'unlimited']) {
    assert.throws(() => rb.parseLimit(bad), { code: 'USAGE' })
  }
})

test('digest binds script, verification, parameters, sudo, scope, destination and limit', () => {
  add({ params: ['unit=caddy,nginx'], verify: 'true' })
  const original = rb.load().fix
  for (const change of [
    (x) => x.script += '\necho changed', (x) => x.verify = 'false', (x) => x.params.unit.push('sshd'),
    (x) => x.sudo = true, (x) => x.targets = 'all', (x) => x.servers.web1.host = 'other.example', (x) => x.limit = '4/1h',
  ]) {
    const changed = structuredClone(original)
    change(changed)
    assert.notEqual(rb.digest(changed), original.sha256)
  }
  const changed = structuredClone(original)
  changed.approvedAt = '2000-01-01'; changed.approvedBy = 'another label'
  assert.equal(rb.digest(changed), original.sha256)
})

test('modified scripts are inspectable but never run, even with --yes or --dry-run', async () => {
  add()
  mutate((x) => x.script = 'echo tampered')
  assert.equal(rb.show(ctx(), { name: 'fix' }).state, 'MODIFIED')
  for (const flags of [{}, { yes: true }, { dryRun: true }]) await assert.rejects(first(flags), /changed after the user approved/)
  assert.equal(audit().filter((x) => x.op === 'run.started').length, 0)
})

test('run rejects missing, extra, wrong-type and unapproved parameters, even with --yes', async () => {
  add({ params: ['unit=caddy,nginx'] })
  for (const params of [{}, { unit: 'sshd' }, { unit: 1 }, { unit: 'caddy', extra: 'x' }, [], 'unit=caddy']) {
    await assert.rejects(first({ params, yes: true }), { code: 'USAGE' })
  }
  assert.equal(rb.runsSince('fix', 'web1', 0), 0)
})

test('approval of a tag or all pins its current servers; later additions are outside scope', async () => {
  add({ targets: 'tag:prod' })
  inventory.upsert('web2', { tags: ['prod'] })
  await assert.rejects(first({ target: 'tag:prod', dryRun: true }), /outside the targets approved/)
  add({ targets: 'all' })
  inventory.upsert('web3', { host: 'web3.example', user: 'root' })
  await assert.rejects(first({ target: 'all', yes: true }), /outside the targets approved/)
})

test('reassigning an approved alias to another host, port or user refuses without SSH', async () => {
  for (const update of [{ host: 'other.example' }, { port: 2222 }, { user: 'alice' }]) {
    inventory.upsert('web1', { host: 'web1.example', port: 22, user: 'root' })
    add()
    inventory.upsert('web1', update)
    const result = await first({ yes: true })
    assert.equal(result.error.code, 'USAGE')
    assert.match(result.error.message, /changed since approval/)
  }
})

test('readonly policy blocks approved runbooks and dry runs, even with --yes', async () => {
  add()
  inventory.upsert('web1', { policy: 'readonly' })
  for (const flags of [{}, { yes: true }, { dryRun: true }]) {
    assert.equal((await first(flags)).error.code, 'READONLY')
  }
  assert.equal(rb.runsSince('fix', 'web1', 0), 0)
})

test('dry run shows exact approved environment, script and verify without executing or consuming a slot', async () => {
  add({ params: ['unit=caddy'], script: 'echo "$SU_P_unit"', verify: 'true' })
  const result = await first({ params: { unit: 'caddy' }, dryRun: true })
  assert.equal(result.exit, 0)
  assert.match(result.stdout.text, /DRY RUN/)
  assert.match(result.stdout.text, /SU_P_unit='caddy'/)
  assert.match(result.stdout.text, /verify \(up to 5 attempts, 3 s apart\)/)
  assert.equal(rb.runsSince('fix', 'web1', 0), 0)
})

test('rate reservations persist through failed SSH and --yes never overrides them', async () => {
  add({ limit: '1/1h' })
  const failed = await first({}, localPool({ fail: true }))
  assert.equal(failed.error.code, 'UNREACHABLE')
  assert.equal(rb.runsSince('fix', 'web1', 0), 1)
  for (const flags of [{}, { yes: true }]) assert.equal((await first(flags)).error.code, 'RATE_LIMIT')
  assert.equal(rb.runsSince('fix', 'web1', 0), 1)
})

test('concurrent callers reserve before waiting for a channel; only one passes a one-run limit', async () => {
  add({ limit: '1/1h' })
  let release
  const gate = new Promise((resolve) => release = resolve)
  const pool = { async with() { await gate; throw new Error('test channel not opened') } }
  const pending = first({}, pool)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await first()).error.code, 'RATE_LIMIT')
  assert.equal(rb.runsSince('fix', 'web1', 0), 1)
  release()
  await pending
})

test('audit counting ignores refused, old, other-host and completion records; accepts legacy runs and torn lines', () => {
  const entry = (fields) => JSON.stringify({ ts: new Date().toISOString(), runbook: 'fix', host: 'web1', ...fields })
  writeFileSync(file('audit.jsonl'), [entry({ op: 'run.started' }), entry({ op: 'run', reserved: true }), entry({ op: 'run' }), entry({ op: 'run.refused' }),
    entry({ op: 'run.started', host: 'web2' }), entry({ op: 'run.started', ts: '2000-01-01' }), '{broken'].join('\n'))
  assert.equal(rb.runsSince('fix', 'web1', Date.now() - 10000), 2)
})

test('reapproval can raise the bound and removal revokes the capability', async () => {
  add({ limit: '1/1h' })
  await first({}, localPool({ fail: true }))
  add({ limit: '2/1h' })
  assert.equal((await first({}, localPool({ fail: true }))).error.code, 'UNREACHABLE')
  assert.equal(rb.runsSince('fix', 'web1', 0), 2)
  assert.deepEqual(rb.rm(ctx(), { name: 'fix' }), { removed: 'fix' })
  await assert.rejects(first(), /unknown runbook/)
})

test('malformed YAML and damaged parameter declarations fail closed', async () => {
  add()
  mutate((x) => x.params = { unit: null })
  await assert.rejects(first(), /invalid parameters/)
  writeFileSync(file('runbooks.yaml'), '[unclosed')
  assert.throws(() => rb.load(), { code: 'RUNBOOKS' })
  writeFileSync(file('runbooks.yaml'), '[]')
  assert.throws(() => rb.load(), { code: 'RUNBOOKS' })
})

test('raw daemon arguments cannot substitute command, sudo, timeout or extra approval fields', async () => {
  add()
  for (const unsupported of [{ script: 'echo other' }, { sudo: true }, { timeoutMs: 1 }, { command: 'echo other' }]) {
    await assert.rejects(first(unsupported), /unsupported runbook fields/)
  }
  await assert.rejects(first({ dryRun: 'false' }), /dryRun must be a boolean/)
  assert.throws(() => add({ unapproved: true }), /unsupported runbook fields/)
})

test('damaged approval can be listed and revoked without execution or reapproval', () => {
  add()
  const all = rb.load()
  all.fix = null
  writeFileSync(file('runbooks.yaml'), YAML.stringify(all))
  assert.deepEqual(rb.ls().runbooks, [{ name: 'fix', state: 'DAMAGED' }])
  assert.deepEqual(rb.rm(ctx(), { name: 'fix' }), { removed: 'fix' })
  assert.deepEqual(rb.load(), {})
})

test('reordering pinned destination fields does not change the script approval or destination', async () => {
  add()
  mutate((x) => x.servers.web1 = { user: 'root', port: 22, host: 'web1.example' })
  const result = await first({ dryRun: true })
  assert.equal(result.exit, 0)
  assert.equal(rb.show(ctx(), { name: 'fix' }).state, 'ok')
})

test('permissions prints valid Claude JSON and Codex prefix rules for readings and each approved named run', () => {
  add()
  const claude = rb.permissions(ctx(), { format: 'claude' })
  assert.deepEqual(JSON.parse(claude.text), claude.config)
  assert.ok(claude.config.permissions.allow.includes('Bash(server-use run web1 fix *)'))
  assert.ok(claude.config.permissions.allow.includes('Bash(server-use job wait *)'))
  assert.ok(!claude.config.permissions.allow.some((x) => /exec|runbook add|put|get|set|policy/.test(x)))
  const codex = rb.permissions(ctx(), { format: 'codex' })
  assert.match(codex.text, /prefix_rule\(pattern=\["server-use","run","web1","fix"\], decision="allow"\)/)
  assert.match(codex.note, /Shell rules do not grant MCP/)
  assert.throws(() => rb.permissions(ctx(), { format: 'unknown' }), { code: 'USAGE' })
})

test('permissions excludes modified approvals, readonly hosts and destinations changed since approval', () => {
  add({ targets: 'all' })
  inventory.upsert('web1', { policy: 'readonly' })
  inventory.upsert('web2', { host: 'another.example' })
  assert.doesNotMatch(rb.permissions(ctx(), { format: 'codex' }).text, /"run"/)
  inventory.upsert('web1', { policy: 'confirm' })
  mutate((x) => x.script = 'echo changed')
  assert.doesNotMatch(rb.permissions(ctx(), { format: 'codex' }).text, /"run"/)
})

test('approved destructive text executes once on confirm without --yes and successful verification is reported', { skip: !SH && 'no POSIX shell' }, async () => {
  add({ script: 'mkdir -p scratch; rm -rf scratch; printf done', verify: 'test ! -d scratch', sudo: true, limit: '1/1h' })
  const pool = localPool()
  const result = await first({}, pool)
  assert.equal(result.exit, 0, result.stderr.text)
  assert.equal(result.verify, 'ok')
  assert.match(result.stdout.text, /^done\nrunbook fix .*verify ok/m)
  assert.equal(pool.commands.filter((x) => x.includes('exec bash -s')).length, 2, 'script and verification have separate channels')
  assert.equal(rb.runsSince('fix', 'web1', 0), 1, 'completion does not double count its reservation')
  assert.equal(audit().find((x) => x.op === 'run').verify, 'ok')
})

test('an approved parameter with shell metacharacters remains one literal variable value', { skip: !SH && 'no POSIX shell' }, async () => {
  const value = "caddy'; touch INJECTED; echo '$(touch OTHER)"
  add({ params: [`unit=${value}`], script: "printf '%s\\n' \"$SU_P_unit\"" })
  const pool = localPool()
  const result = await first({ params: { unit: value } }, pool)
  assert.equal(result.exit, 0, result.stderr.text)
  assert.equal(result.stdout.text.split('\n')[0], value)
  assert.equal(existsSync(join(pool.home, 'INJECTED')), false)
  assert.equal(existsSync(join(pool.home, 'OTHER')), false)
})

test('script failure preserves its exit and skips verification; a shell syntax error executes no body', { skip: !SH && 'no POSIX shell' }, async () => {
  add({ script: 'echo failed; return 9', verify: 'touch VERIFIED' })
  const pool = localPool()
  const result = await first({}, pool)
  assert.equal(result.exit, 9)
  assert.equal(result.verify, 'skipped')
  assert.equal(existsSync(join(pool.home, 'VERIFIED')), false)
  add({ script: 'touch EARLY\nif then' })
  const syntax = await first({}, pool)
  assert.equal(syntax.exit, 2)
  assert.equal(existsSync(join(pool.home, 'EARLY')), false)
})
