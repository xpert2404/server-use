// Pure functions and the file-backed state (inventory, host keys, secrets), each test in a fresh SERVER_USE_HOME.
import { describe, test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { createHmac, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import * as inventory from '../src/inventory.mjs'
import * as hostkeys from '../src/hostkeys.mjs'
import { Pool, connect } from '../src/pool.mjs'
import * as secrets from '../src/secrets.mjs'
import { destructive, check } from '../src/guard.mjs'
import { clip, parseDuration, shq, shVars, fingerprint } from '../src/util.mjs'
import { formatResults, worst } from '../src/format.mjs'
import { parseSshConfig, add, set, rm } from '../src/ops/servers.mjs'
import { repoUrl } from '../src/ops/scripts.mjs'
import { SH, startFixture } from './fixture.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'su-unit-'))
process.env.SERVER_USE_SECRETS = 'file'
let n = 0
beforeEach(() => {
  const dir = join(tmp, String(++n))
  process.env.SERVER_USE_HOME = join(dir, 'home')
  process.env.SERVER_USE_SSH_DIR = join(dir, 'ssh')
  mkdirSync(process.env.SERVER_USE_SSH_DIR, { recursive: true })
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const home = (/** @type {string} */ ...p) => join(/** @type {string} */ (process.env.SERVER_USE_HOME), ...p)
const pubBlob = (type = 'ed25519') =>
  /** @type {any} */ (ssh2.utils.parseKey(ssh2.utils.generateKeyPairSync(/** @type {any} */ (type), type === 'ecdsa' ? { bits: 256 } : undefined).public)).getPublicSSH()

describe('inventory', () => {
  test('upsert keeps comments and other entries, undefined deletes a field', () => {
    mkdirSync(home(), { recursive: true })
    writeFileSync(home('servers.yaml'), '# my fleet\nweb1:\n  # the main box\n  host: 10.0.0.1\n  user: root\n  note: old\n# staging below\nweb2:\n  host: 10.0.0.2\n  user: deploy\n')
    inventory.upsert('web1', { policy: 'open', note: undefined })
    inventory.upsert('web3', { host: 'h3', user: 'u' })
    const text = readFileSync(home('servers.yaml'), 'utf8')
    for (const c of ['# my fleet', '# the main box', '# staging below']) assert.ok(text.includes(c), `lost "${c}":\n${text}`)
    assert.deepEqual(inventory.load().web1, { host: '10.0.0.1', user: 'root', policy: 'open' })
    assert.equal(inventory.get('web2').user, 'deploy')
    assert.equal(inventory.get('web3').policy, 'confirm') // defaults filled in by get()
  })

  test('upsert validates names, fields, policy and auth', () => {
    assert.throws(() => inventory.upsert('all', { host: 'x' }), { code: 'USAGE' })
    assert.throws(() => inventory.upsert('bad name', { host: 'x' }), { code: 'USAGE' })
    assert.throws(() => inventory.upsert('ok', /** @type {any} */ ({ password: 'x' })), { code: 'USAGE' })
    assert.throws(() => inventory.upsert('ok', { policy: 'yolo' }), { code: 'USAGE' })
    assert.throws(() => inventory.upsert('ok', { auth: 'magic' }), { code: 'USAGE' })
  })

  test('resolveTargets: all, tag:, lists, dedupe, unknown', () => {
    assert.throws(() => inventory.resolveTargets('all'), { code: 'UNKNOWN_SERVER' }) // empty inventory
    inventory.upsert('a', { host: 'a', user: 'r', tags: ['x'] })
    inventory.upsert('b', { host: 'b', user: 'r', tags: ['x', 'y'] })
    inventory.upsert('c', { host: 'c', user: 'r', tags: ['y'] })
    assert.deepEqual(inventory.resolveTargets('all'), ['a', 'b', 'c'])
    assert.deepEqual(inventory.resolveTargets('tag:y'), ['b', 'c'])
    assert.deepEqual(inventory.resolveTargets('a, b ,a'), ['a', 'b'])
    assert.deepEqual(inventory.resolveTargets('tag:x,b'), ['a', 'b'])
    assert.throws(() => inventory.resolveTargets('a,nope'), { code: 'UNKNOWN_SERVER', message: /unknown server "nope" \(known: a, b, c\)/ })
    assert.throws(() => inventory.resolveTargets('tag:zzz'), { code: 'UNKNOWN_SERVER' })
    assert.throws(() => inventory.resolveTargets(''), { code: 'USAGE' })
  })

  test('parseAddress', () => {
    assert.deepEqual(inventory.parseAddress('root@1.2.3.4'), { user: 'root', host: '1.2.3.4', port: 22 })
    assert.deepEqual(inventory.parseAddress('deploy@web.example.com:2222'), { user: 'deploy', host: 'web.example.com', port: 2222 })
    assert.deepEqual(inventory.parseAddress('web1'), { user: 'root', host: 'web1', port: 22 })
    assert.deepEqual(inventory.parseAddress('web1', 'ubuntu'), { user: 'ubuntu', host: 'web1', port: 22 })
    assert.deepEqual(inventory.parseAddress('u@[fe80::1]:2200'), { user: 'u', host: 'fe80::1', port: 2200 })
    assert.deepEqual(inventory.parseAddress('[::1]'), { user: 'root', host: '::1', port: 22 })
    for (const bad of ['', 'u@h:abc', '::1', 'u@h:22:33']) assert.throws(() => inventory.parseAddress(bad), { code: 'USAGE' }, bad)
  })
})

describe('guard', () => {
  test('destructive: matches', () => {
    for (const cmd of [
      'rm -rf /var/www', 'rm -r build', 'rm --force x', 'cd /tmp && rm -fr cache', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda bs=1M',
      'sudo reboot', 'shutdown -h now', 'systemctl stop nginx', 'systemctl --now disable nginx', 'docker compose down', 'docker rm -f web',
      'docker system prune -af', 'psql -c "DROP TABLE users"', 'DELETE FROM orders', 'ufw allow 22', 'crontab -r', 'passwd root',
      'chmod 777 /srv', 'chown -R www /', 'echo x > /etc/hosts', 'killall node', 'kill -9 123', 'git reset --hard HEAD~1',
      'git push --force origin main', 'apt-get -y purge nginx', 'dnf remove httpd', 'apk del curl', 'mv /etc /old',
    ]) assert.ok(destructive(cmd), cmd)
  })

  test('destructive: leaves ordinary commands alone', () => {
    for (const cmd of [
      'ls -la', 'rm file.txt', 'rm -i notes', 'systemctl status nginx', 'systemctl restart nginx', 'docker ps', 'docker logs web',
      'cat /etc/hosts', 'grep -r TODO .', 'git status', 'git push origin main', 'apt-get install -y curl', 'kill 123', 'echo done > /tmp/x',
      'df -h', 'tail -n 50 /var/log/syslog', undefined, '',
    ]) assert.equal(destructive(cmd), null, String(cmd))
  })

  test('check: open, confirm, readonly', () => {
    const srv = (/** @type {string|undefined} */ policy) => ({ name: 'web1', policy })
    assert.doesNotThrow(() => check(srv('open'), 'exec', { text: 'rm -rf /srv' }))
    assert.throws(() => check(srv('confirm'), 'exec', { text: 'rm -rf /srv' }), { code: 'CONFIRM', message: /--yes/ })
    assert.throws(() => check(srv(undefined), 'exec', { text: 'rm -rf /srv' }), { code: 'CONFIRM' }) // confirm is the default
    assert.doesNotThrow(() => check(srv('confirm'), 'exec', { text: 'rm -rf /srv', yes: true }))
    assert.doesNotThrow(() => check(srv('confirm'), 'exec', { text: 'uptime' }))
    assert.throws(() => check(srv('confirm'), 'harden', { always: 'create a user' }), { code: 'CONFIRM' })
    assert.throws(() => check(srv('readonly'), 'exec', { text: 'uptime', yes: true }), { code: 'READONLY' })
    assert.throws(() => check(srv('readonly'), 'put', {}), { code: 'READONLY' })
    for (const op of ['status', 'logs', 'get', 'job.ls', 'cron.ls', 'deploy.ls']) assert.doesNotThrow(() => check(srv('readonly'), op, {}), op)
  })
})

describe('util', () => {
  test('clip keeps head and tail lines', () => {
    assert.deepEqual(clip('a\nb\n'), { text: 'a\nb\n', cut: 0, lines: 2 })
    const text = Array.from({ length: 300 }, (_, i) => `L${i + 1}`).join('\n') + '\n'
    const c = clip(text)
    assert.equal(c.cut, 100)
    assert.equal(c.lines, 300)
    const lines = c.text.trimEnd().split('\n')
    assert.deepEqual([lines[0], lines[49], lines[50], lines[51], lines.at(-1)], ['L1', 'L50', '… 100 lines cut …', 'L151', 'L300'])
    assert.equal(lines.length, 201)
    assert.deepEqual(clip('1\n2\n3\n4\n5\n6\n', 1, 2).text, '1\n… 3 lines cut …\n5\n6\n')
  })

  test('clip caps bytes', () => {
    const c = clip('x'.repeat(40_000))
    assert.ok(c.cut > 0)
    assert.match(c.text, /… 23616 bytes cut …/)
    assert.ok(Buffer.byteLength(c.text) < 16_384 + 50)
  })

  test('parseDuration', () => {
    const cases = { '90s': 90_000, '5m': 300_000, '2h': 7_200_000, '1d': 86_400_000, '1.5h': 5_400_000, '250ms': 250, '10': 10_000, ' 3 m ': 180_000 }
    for (const [v, ms] of Object.entries(cases)) assert.equal(parseDuration(v), ms, v)
    assert.equal(parseDuration(3), 3000)
    for (const bad of ['abc', '5x', '-1s', '']) assert.throws(() => parseDuration(bad), { code: 'USAGE' }, bad)
  })

  test('shq quotes anything for a POSIX shell', () => {
    assert.equal(shq("it's"), String.raw`'it'\''s'`)
    assert.equal(shVars({ SU_A: "x'y", SU_B: undefined, SU_C: 3 }), String.raw`SU_A='x'\''y'` + "\nSU_C='3'\n")
    assert.throws(() => shVars({ 'bad-name': 1 }))
    if (!SH) return
    const values = ["it's", "x'; echo INJECTED; '", '$HOME `id` "q" \\ $(true)', 'multi\nline', '', "''"]
    for (const v of values) {
      const r = spawnSync(SH, ['-c', `printf %s ${shq(v)}`], { encoding: 'utf8' })
      assert.equal(r.stdout, v, `${JSON.stringify(v)} → ${r.stderr}`)
    }
  })
})

describe('hostkeys', () => {
  test('trust on first use, then known, then a changed key is refused', () => {
    const [k1, k2] = [pubBlob(), pubBlob()]
    assert.deepEqual(hostkeys.verify('h1', 22, k1), { ok: true, status: 'new', fingerprint: fingerprint(k1) })
    assert.match(readFileSync(home('known_hosts'), 'utf8'), /^h1 ssh-ed25519 /)
    assert.equal(hostkeys.verify('h1', 22, k1).status, 'known')
    assert.deepEqual(hostkeys.verify('h1', 22, k2), { ok: false, status: 'changed', fingerprint: fingerprint(k2), expected: fingerprint(k1) })
    assert.equal(hostkeys.verify('h1', 2222, k2).status, 'new') // [h1]:2222 is another host id
    assert.match(readFileSync(home('known_hosts'), 'utf8'), /^\[h1\]:2222 ssh-ed25519 /m)
    const other = hostkeys.verify('h1', 22, pubBlob('ecdsa')) // another key type is a change too, not a second pin
    assert.deepEqual([other.ok, other.status], [false, 'changed'])
    assert.deepEqual(hostkeys.knownTypes('h1', 22), ['ssh-ed25519'])
    assert.equal(hostkeys.forget('h1', 22), 1)
    assert.equal(hostkeys.verify('h1', 22, k2).status, 'new')
    assert.equal(hostkeys.verify('h1', 2222, k2).status, 'known') // forget() left the other port alone
  })

  test('~/.ssh/known_hosts entries (plain and hashed) are imported, and a mismatch there counts as changed', () => {
    const [k1, k2, k3] = [pubBlob(), pubBlob(), pubBlob()]
    const hashed = (/** @type {string} */ id) => {
      const salt = randomBytes(20)
      return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(id).digest('base64')}`
    }
    writeFileSync(join(/** @type {string} */ (process.env.SERVER_USE_SSH_DIR), 'known_hosts'), [
      '# comment',
      `${hashed('hashed.example')} ssh-ed25519 ${k1.toString('base64')}`,
      `${hashed('[hashed.example]:2200')} ssh-ed25519 ${k2.toString('base64')}`,
      `plain.example,10.0.0.9 ssh-ed25519 ${k3.toString('base64')}`,
      `pinned.example ssh-ed25519 ${k2.toString('base64')}`,
      '',
    ].join('\n'))
    assert.equal(hostkeys.verify('hashed.example', 22, k1).status, 'imported')
    assert.equal(hostkeys.verify('hashed.example', 22, k1).status, 'known') // copied into our own file
    assert.equal(hostkeys.verify('hashed.example', 2200, k2).status, 'imported')
    assert.equal(hostkeys.verify('10.0.0.9', 22, k3).status, 'imported')
    const changed = hostkeys.verify('plain.example', 22, k1)
    assert.equal(changed.ok, false)
    assert.equal(changed.status, 'changed')
    hostkeys.add('pinned.example', 22, k1)
    assert.equal(hostkeys.verify('pinned.example', 22, k2).status, 'changed') // our pin wins over a later ~/.ssh entry
  })

  test('forget (trust --reset) also overrides a stale key in ~/.ssh/known_hosts', () => {
    const [old, fresh] = [pubBlob(), pubBlob()]
    writeFileSync(join(/** @type {string} */ (process.env.SERVER_USE_SSH_DIR), 'known_hosts'), `h2 ssh-ed25519 ${old.toString('base64')}\n`)
    assert.deepEqual(hostkeys.knownTypes('h2', 22), ['ssh-ed25519'])
    assert.equal(hostkeys.verify('h2', 22, fresh).status, 'changed') // reinstalled server
    assert.equal(hostkeys.forget('h2', 22), 0) // nothing pinned in our own file yet
    assert.deepEqual(hostkeys.knownTypes('h2', 22), [])
    assert.equal(hostkeys.verify('h2', 22, fresh).status, 'new')
    assert.equal(hostkeys.verify('h2', 22, fresh).status, 'known')
    assert.equal(hostkeys.verify('h2', 22, old).status, 'changed') // the stale entry no longer counts
    assert.equal(hostkeys.forget('h2', 22), 1)
    assert.equal(readFileSync(home('known_hosts'), 'utf8'), '@reset h2\n') // one marker, however often reset
  })
})

describe('pool', () => {
  test('a refused channel (sshd MaxSessions) waits for a slot instead of dropping the shared connection', async () => {
    inventory.upsert('web', { host: 'h', user: 'u' })
    const pool = new Pool()
    let ended = 0
    const conn = { client: { end: () => ended++ }, name: 'web', key: Pool.key(inventory.get('web')), state: 'ready', since: 0, lastUsed: 0, active: 0, queue: [] }
    pool.conns.set('web', /** @type {any} */ (conn))
    let finishSlow = (/** @type {string} */ _v) => {}
    const slow = pool.with('web', () => new Promise((res) => { finishSlow = res })) // holds the one session the server allows
    let tries = 0
    const second = pool.with('web', async () => {
      if (++tries === 1) throw Object.assign(new Error('(SSH) Channel open failure: open failed'), { channelOpenFailed: true, reason: 1 })
      return 'ran'
    })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual([tries, /** @type {any} */ (conn).cap, ended], [1, 1, 0]) // queued on the same connection
    finishSlow('slow')
    assert.deepEqual(await Promise.all([slow, second]), ['slow', 'ran'])
    assert.equal(ended, 0)
    assert.equal(pool.conns.get('web'), conn)
    pool.closeAll()
  })

  test('a server without the pinned key type fails as HOSTKEY_CHANGED, not as a handshake error', async () => {
    const fx = await startFixture() // ed25519 host key only
    try {
      writeFileSync(join(/** @type {string} */ (process.env.SERVER_USE_SSH_DIR), 'known_hosts'), `[127.0.0.1]:${fx.port} ecdsa-sha2-nistp256 ${pubBlob('ecdsa').toString('base64')}
`)
      await assert.rejects(connect(/** @type {any} */ ({ name: 'fx', host: '127.0.0.1', port: fx.port, user: fx.user })), { code: 'HOSTKEY_CHANGED' })
    } finally { await fx.close() }
  })
})

describe('servers', () => {
  test('a new secret keeps the shared connection (commands in flight survive), a new address drops it', () => {
    inventory.upsert('web', { host: 'h', user: 'u' })
    const pool = new Pool()
    let ended = 0
    pool.conns.set('web', /** @type {any} */ ({ client: { end: () => ended++ }, state: 'ready', active: 1 }))
    const ctx = { pool, agent: 't', runId: 't' }
    set(ctx, { name: 'web', secret: { kind: 'sudo-password', value: 's3' } })
    set(ctx, { name: 'web', secret: { kind: 'password', value: '' } })
    assert.equal(ended, 0)
    set(ctx, { name: 'web', fields: { host: 'h2' } })
    assert.equal(ended, 1)
    pool.closeAll()
  })

  test('rm names a way to forget the pin that works once the entry is gone, and only where a pin is', () => {
    inventory.upsert('web', { host: 'h', port: 2222, user: 'u' })
    inventory.upsert('fresh', { host: 'nowhere', user: 'u' })
    hostkeys.add('h', 2222, pubBlob())
    const pool = new Pool()
    const ctx = { pool, agent: 't', runId: 't' }
    assert.match(rm(ctx, { name: 'web' }).kept[0], /delete the lines starting with "\[h\]:2222 " in .*known_hosts/)
    assert.deepEqual(rm(ctx, { name: 'fresh' }).kept.map((k) => k.split(' ')[0]), ['notes']) // nothing pinned, nothing to forget
    writeFileSync(join(/** @type {string} */ (process.env.SERVER_USE_SSH_DIR), 'known_hosts'), `other ssh-ed25519 ${pubBlob().toString('base64')}\n`)
    assert.match(hostkeys.forgetHint('other', 22), /ssh-keygen -R "other"/) // the user's own known_hosts decides
    hostkeys.forget('other', 22)
    assert.equal(hostkeys.forgetHint('other', 22), '') // @reset hides that entry: deleting it would gain nothing
    pool.closeAll()
  })

  test('an alias inherits readonly although its handshake picked another key type than the pin, even via a forwarder', async () => {
    const [ed, ec, other] = [ssh2.utils.generateKeyPairSync('ed25519'), ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }), ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 })]
    const listen = (/** @type {string[]} */ hostKeys) => {
      const srv = new ssh2.Server({ hostKeys }, (/** @type {any} */ c) => {
        c.on('error', () => {})
        c.on('authentication', (/** @type {any} */ x) => x.accept())
      })
      return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)))
    }
    const [ro, decoy] = /** @type {any[]} */ (await Promise.all([listen([ed.private, ec.private]), listen([other.private])]))
    // The first connection reaches the readonly server, any later one (say, a host key probe) a decoy with another ecdsa key.
    let conns = 0
    const fwd = net.createServer((sock) => {
      const to = net.connect(conns++ ? decoy.address().port : ro.address().port, '127.0.0.1')
      sock.pipe(to).pipe(sock)
      sock.on('error', () => {})
      to.on('error', () => {})
    })
    await new Promise((r) => fwd.listen(0, '127.0.0.1', () => r(undefined)))
    const pool = new Pool()
    try {
      inventory.upsert('ro', { host: '127.0.0.1', port: ro.address().port, user: 'u', policy: 'readonly' })
      hostkeys.add('127.0.0.1', ro.address().port, /** @type {any} */ (ssh2.utils.parseKey(ec.public)).getPublicSSH()) // an old ecdsa-only pin
      // The forwarder's address has no pins, so ssh2 negotiates ed25519 there.
      const r = await add({ pool, agent: 't', runId: 't' }, { name: 'alias', address: `u@127.0.0.1:${/** @type {any} */ (fwd.address()).port}`, password: 'pw', installKey: false, policy: 'open' })
      assert.equal(r.hostkey.status, 'new')
      assert.equal(r.policy, 'readonly')
      assert.match(r.hints.join('\n'), /policy readonly taken over from ro/)
    } finally {
      pool.closeAll()
      ro.close(); decoy.close(); fwd.close()
    }
  })
})

describe('secrets (file backend)', () => {
  test('set, get, delete one kind, delete all; file is private', () => {
    assert.equal(secrets.backend(), 'file')
    secrets.setSecret('web1', 'password', 'pw-1')
    secrets.setSecret('web1', 'sudo', 'sudo-1')
    secrets.setSecret('web2', 'passphrase', 'pp-2')
    assert.equal(secrets.getSecret('web1', 'password'), 'pw-1')
    assert.equal(secrets.hasSecret('web1', 'sudo'), true)
    if (process.platform !== 'win32') assert.equal(statSync(home('secrets.json')).mode & 0o777, 0o600)
    secrets.deleteSecret('web1', 'password')
    assert.equal(secrets.getSecret('web1', 'password'), undefined)
    assert.equal(secrets.getSecret('web1', 'sudo'), 'sudo-1')
    secrets.deleteSecret('web1')
    assert.equal(secrets.hasSecret('web1', 'sudo'), false)
    assert.equal(secrets.getSecret('web2', 'passphrase'), 'pp-2')
    assert.throws(() => secrets.setSecret('web1', 'token', 'x'))
    assert.ok(!readFileSync(home('secrets.json'), 'utf8').includes('pw-1'))
  })
})

describe('parseSshConfig', () => {
  test('Host blocks, first value wins, wildcards skipped, Match ignored', () => {
    const cfg = [
      '# personal',
      'Host web1 web1-alias',
      '  HostName 10.0.0.1',
      '  User deploy',
      '  Port 2222',
      '  IdentityFile "~/.ssh/web 1"   # quoted',
      '  User second-user-ignored',
      'Host *.internal bastion',
      '  User jump',
      'Host db',
      '  HostName=db.example.com',
      'Host *',
      '  User everyone',
      'Match host db',
      '  User matched',
      'Host web1',
      '  Port 9999',
      'Host my@box',
      '  HostName 10.0.0.5',
    ].join('\r\n')
    assert.deepEqual(parseSshConfig(cfg), [
      { name: 'web1', host: '10.0.0.1', port: 2222, user: 'deploy', key: '~/.ssh/web 1' },
      { name: 'web1-alias', host: '10.0.0.1', port: 2222, user: 'deploy', key: '~/.ssh/web 1' },
      { name: 'bastion', host: 'bastion', port: 22, user: 'jump', key: undefined },
      { name: 'db', host: 'db.example.com', port: 22, user: undefined, key: undefined },
      { name: 'my-box', host: '10.0.0.5', port: 22, user: undefined, key: undefined },
    ])
  })
})

describe('repoUrl', () => {
  test('short forms become clone URLs, URLs and server paths pass through', () => {
    const cases = {
      'owner/repo': 'https://github.com/owner/repo.git',
      'owner/repo.git': 'https://github.com/owner/repo.git',
      'github.com/owner/repo': 'https://github.com/owner/repo.git',
      'gitlab.example.com/grp/proj.git': 'https://gitlab.example.com/grp/proj.git',
      'https://github.com/o/r': 'https://github.com/o/r',
      'ssh://git@host:2222/o/r.git': 'ssh://git@host:2222/o/r.git',
      'git@github.com:o/r.git': 'git@github.com:o/r.git',
      '/srv/git/app.git': '/srv/git/app.git',
      '~/repos/app': '~/repos/app',
    }
    for (const [repo, url] of Object.entries(cases)) assert.equal(repoUrl(repo), url, repo)
    for (const bad of ['', 'not a repo', 'just-a-name']) assert.throws(() => repoUrl(bad), { code: 'USAGE' }, bad)
  })
})

describe('format', () => {
  const ok = (/** @type {string} */ host, extra = {}) => ({ host, exit: 0, ms: 180, stdout: { text: `${host} out\n` }, stderr: { text: '' }, ...extra })

  test('formatResults: per-host blocks, stderr, log paths, errors and a summary', () => {
    assert.deepEqual(formatResults([ok('web1')]), { text: '── web1 · exit 0 · 0.18s\nweb1 out\n', code: 0 })
    const { text, code } = formatResults([
      ok('web1', { stderr: { text: 'warn\n' }, stdout: { text: 'big\n', log: '/l/web1.log' } }),
      { host: 'web2', exit: null, error: { code: 'UNREACHABLE', message: 'web2: ECONNREFUSED' } },
      { host: 'web3', exit: 124, ms: 1000, stdout: { text: '' }, stderr: { text: '' }, error: { code: 'TIMEOUT', message: 'timed out after 1s' } },
    ])
    assert.equal(text, [
      '── web1 · exit 0 · 0.18s · full stdout: /l/web1.log', 'big', '[stderr]', 'warn',
      '── web2 · UNREACHABLE: web2: ECONNREFUSED',
      '── web3 · exit 124 · 1.00s', 'TIMEOUT: timed out after 1s',
      '1 ok · 2 failed (web2, web3)', '',
    ].join('\n'))
    assert.equal(code, 5)
    assert.deepEqual(formatResults([ok('web1')], { raw: true }), { text: 'web1 out\n', code: 0 })
  })

  test('worst: the first failing host decides', () => {
    const err = (/** @type {string} */ c) => ({ host: 'h', exit: null, error: { code: c, message: '' } })
    assert.equal(worst([]), 0)
    assert.equal(worst([ok('a'), ok('b')]), 0)
    assert.equal(worst([ok('a'), { host: 'b', exit: 2 }, { host: 'c', exit: 1 }]), 2)
    assert.equal(worst([{ host: 'a', exit: 300 }]), 255)
    assert.equal(worst([{ host: 'a', exit: 124, error: { code: 'TIMEOUT' } }]), 124)
    const codes = { CONFIRM: 3, HOSTKEY_CHANGED: 4, UNREACHABLE: 5, AUTH: 6, READONLY: 7, SUDO: 8, UNKNOWN_SERVER: 2, SOMETHING_NEW: 1 }
    for (const [c, exit] of Object.entries(codes)) assert.equal(worst([ok('a'), err(c)]), exit, c)
  })
})
