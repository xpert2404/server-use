import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import ssh2 from 'ssh2'
import { sandbox } from './e2e/helpers.mjs'
import { startFixture, SH } from './fixture.mjs'
import { generateEd25519 } from '../src/keygen.mjs'

test('daemon keys and import expose metadata, preserve imports and support existing private keys', { skip: !SH }, async () => {
  const s = sandbox()
  const fx = await startFixture()
  const ssh = join(dirname(s.home), 'ssh')
  const pair = generateEd25519()
  const key = join(ssh, 'custom login')
  writeFileSync(key, pair.private)
  mkdirSync(join(fx.home, '.ssh'))
  writeFileSync(join(fx.home, '.ssh', 'authorized_keys'), pair.public)
  writeFileSync(key + '.pub', pair.public)
  writeFileSync(join(ssh, 'unrelated'), 'not a key')
  const missing = join(ssh, 'absent')
  const config = join(ssh, 'config')
  writeFileSync(config, `Host imported\n HostName 127.0.0.1\n Port ${fx.port}\n User tester\n IdentityFile "${key}"\nHost missing\n IdentityFile "${missing}"\nHost *.ignored\n HostName ignored\n`)
  try {
    let r = await s.su(['import', 'ssh-config', '--dry-run', '--json'])
    assert.equal(r.code, 0, r.all)
    const preview = JSON.parse(r.out).servers
    assert.equal(preview.length, 2)
    assert.equal(preview[0].keyStatus.type, 'ssh-ed25519')
    assert.equal(preview[1].keyStatus.exists, false)
    assert.equal(preview[1].userDefaulted, true)
    assert.deepEqual(JSON.parse((await s.su(['ls', '--json'])).out).servers, [])
    r = await s.su(['import', 'ssh-config', '--json'])
    assert.equal(r.code, 0, r.all)
    assert.equal(JSON.parse(r.out).servers[0].action, 'imported')
    r = await s.su(['import', 'ssh-config', '--json'])
    assert.equal(JSON.parse(r.out).servers[0].action, 'skipped (exists)')
    r = await s.su(['keys', '--json'])
    assert.equal(r.code, 0, r.all)
    const data = JSON.parse(r.out)
    const found = data.keys.find((k) => k.path === key)
    assert.equal(found.type, 'ssh-ed25519')
    assert.equal(found.usable, true)
    assert.match(found.fingerprint, /^SHA256:/)
    assert.deepEqual(found.usedBy, ['imported'])
    assert.equal(data.keys.filter((k) => k.path === key).length, 1)
    assert.ok(!data.keys.some((k) => k.path.endsWith('.pub') || k.path.endsWith('unrelated')))
    assert.equal(data.agent.configured, false)
    r = await s.su(['exec', 'imported', '--', 'printf', 'import-login-ok'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /import-login-ok/)
    await s.su(['set', 'imported', 'policy=readonly'])
    r = await s.su(['import', 'ssh-config', '--force', '--json'])
    assert.equal(r.code, 0, r.all)
    assert.equal(JSON.parse((await s.su(['show', 'imported', '--json'])).out).server.policy, 'readonly')
    s.assertNoLeak([pair.private])
  } finally { await s.cleanup(); await fx.close() }
})

test('encrypted existing key: local onboarding stores passphrase only after success and reconnects', { skip: !SH }, async () => {
  const s = sandbox()
  const fx = await startFixture()
  const passphrase = 'fixture-only-passphrase-49'
  const pair = ssh2.utils.generateKeyPairSync('rsa', { bits: 2048, cipher: 'aes256-cbc', passphrase })
  const key = join(dirname(s.home), 'ssh', 'encrypted')
  writeFileSync(key, pair.private)
  mkdirSync(join(fx.home, '.ssh'))
  writeFileSync(join(fx.home, '.ssh', 'authorized_keys'), pair.public)
  const args = ['add', 'encrypted', `tester@127.0.0.1:${fx.port}`, '--key', key, '--json']
  try {
    let r = await s.su(['keys', '--json'])
    assert.equal(JSON.parse(r.out).keys.find((k) => k.path === key).encrypted, true)
    r = await s.su(args)
    assert.notEqual(r.code, 0)
    assert.match(r.all, /PASSPHRASE_REQUIRED|passphrase-protected/)
    r = await s.su([...args, '--passphrase-stdin'], { input: 'wrong-fixture-passphrase' })
    assert.notEqual(r.code, 0)
    assert.deepEqual(JSON.parse((await s.su(['ls', '--json'])).out).servers, [])
    r = await s.su([...args, '--passphrase-stdin'], { input: passphrase })
    assert.equal(r.code, 0, r.all)
    assert.equal(JSON.parse(r.out).auth, 'key')
    assert.ok(readFileSync(join(s.home, 'secrets.json'), 'utf8').includes(passphrase))
    await s.su(['daemon', 'stop'])
    r = await s.su(['exec', 'encrypted', '--', 'printf', 'key-login-ok'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /key-login-ok/)
    s.assertNoLeak([passphrase, 'wrong-fixture-passphrase', pair.private])
  } finally { await s.cleanup(); await fx.close() }
})
