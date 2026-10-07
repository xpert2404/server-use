import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { generateEd25519, KEYGEN_ATTEMPTS } from '../src/keygen.mjs'
import { ensureKey } from '../src/ops/servers.mjs'
import { newHostKey } from './fixture.mjs'

const valid = generateEd25519({ comment: 'regression-control' })
const privateBlob = Buffer.from(valid.private.split('\n').slice(1, -2).join(''), 'base64')
// A deterministic malformed OpenSSH Ed25519 field: the public field must be exactly 32 bytes.
let position = 15 // "openssh-key-v1\0"
const skipString = () => { const size = privateBlob.readUInt32BE(position); position += 4 + size }
skipString(); skipString(); skipString() // cipher, KDF, KDF options
position += 4 // number of keys
skipString() // public blob
position += 4 + 8 // private blob length, duplicated check integers
skipString() // key type
privateBlob.writeUInt32BE(31, position)
const malformed = { ...valid, private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${privateBlob.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n` }
assert.ok(ssh2.utils.parseKey(malformed.private) instanceof Error, 'negative control must be malformed')
assert.ok(!(ssh2.utils.parseKey(valid.private) instanceof Error), 'positive control must be valid')

test('malformed first draw is discarded; valid next draw preserves the pair and options', () => {
  let calls = 0
  const options = { comment: 'caller-comment' }
  const pair = generateEd25519(options, (type, passedOptions) => {
    assert.equal(type, 'ed25519')
    assert.equal(passedOptions, options)
    return ++calls === 1 ? malformed : valid
  })
  assert.equal(calls, 2)
  assert.ok(pair === valid, 'the valid generated pair must be returned unchanged')
})
test('generation exhausts its bound with a safe error rather than emitting malformed keys', () => {
  let calls = 0
  assert.throws(() => generateEd25519({}, () => { calls++; return malformed }), (error) => {
    assert.equal(error.code, 'INTERNAL')
    assert.match(error.message, /after 8 attempts/)
    assert.ok(!error.message.includes(malformed.private))
    assert.ok(!error.message.includes(malformed.public))
    return true
  })
  assert.equal(calls, KEYGEN_ATTEMPTS)
})
test('mismatched pairs, public-only private input and private material in the public output are rejected', () => {
  const other = generateEd25519()
  assert.throws(() => generateEd25519({}, () => ({ ...valid, public: other.public })), /valid Ed25519/)
  assert.throws(() => generateEd25519({}, () => ({ private: valid.public, public: valid.public })), /valid Ed25519/)
  assert.throws(() => generateEd25519({}, () => ({ private: valid.private, public: valid.private })), /valid Ed25519/)
})
test('fixture keys parse, and persisted workstation keys retain modes and remain stable', () => {
  const parsedHost = ssh2.utils.parseKey(newHostKey())
  assert.ok(!(parsedHost instanceof Error))
  assert.equal(parsedHost.type, 'ssh-ed25519')
  const tmp = mkdtempSync(join(tmpdir(), 'su-keygen-'))
  const previous = process.env.SERVER_USE_HOME
  process.env.SERVER_USE_HOME = tmp
  try {
    const first = ensureKey()
    const privatePath = join(tmp, 'id_ed25519')
    const originalPrivate = readFileSync(privatePath, 'utf8')
    const parsedPrivate = ssh2.utils.parseKey(originalPrivate)
    const parsedPublic = ssh2.utils.parseKey(first)
    assert.ok(!(parsedPrivate instanceof Error) && !(parsedPublic instanceof Error))
    assert.ok(parsedPrivate.getPublicSSH().equals(parsedPublic.getPublicSSH()))
    assert.equal(ensureKey(), first)
    assert.ok(readFileSync(privatePath, 'utf8') === originalPrivate, 'an existing private key must stay unchanged')
    if (process.platform !== 'win32') {
      assert.equal(statSync(privatePath).mode & 0o777, 0o600)
      assert.equal(statSync(privatePath + '.pub').mode & 0o777, 0o644)
    }
  } finally {
    if (previous === undefined) delete process.env.SERVER_USE_HOME
    else process.env.SERVER_USE_HOME = previous
    rmSync(tmp, { recursive: true, force: true })
  }
})
