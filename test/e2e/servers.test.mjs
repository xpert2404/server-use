// e2e: onboarding with passwords, key login, fan-out, sudo, status, logs, policies, harden, host key pinning.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { skip, sandbox, passwordLogin, until, repoFile, PW, RUN } from './helpers.mjs'

const USERS = [['e2e-root', 'root'], ['e2e-alice', 'alice'], ['e2e-bob', 'bob']]

describe('e2e: servers', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  before(() => { s = sandbox() })
  after(() => s?.cleanup())

  test('add-server root with a password installs the key and keeps no secret', async () => {
    const r = await s.add('e2e-root', 'root')
    assert.match(r.out, /auth key/)
    assert.match(r.out, /key installed and key login verified/)
    assert.match((await s.su(['show', 'e2e-root'])).out, /secrets \(file\): none/)
  })

  test('add-server alice keeps her password only as sudo password', async () => {
    const r = await s.add('e2e-alice', 'alice')
    assert.match(r.out, /key installed and key login verified/)
    assert.match(r.out, /stored sudo in file/)
    assert.match((await s.su(['show', 'e2e-alice'])).out, /secrets \(file\): sudo$/m)
  })

  test('add-server bob (passwordless sudo) stores nothing', async () => {
    const r = await s.add('e2e-bob', 'bob')
    assert.match(r.out, /key installed and key login verified/)
    assert.match((await s.su(['show', 'e2e-bob'])).out, /secrets \(file\): none/)
  })

  test('after disconnect, exec logs in with the key alone', async () => {
    for (const [name, user] of USERS) {
      assert.equal((await s.su(['disconnect', name])).code, 0)
      const r = await s.sh(name, 'id -un')
      assert.equal(r.code, 0, r.err)
      assert.equal(r.out, `${user}\n`)
    }
  })

  test('a second alias of the same server needs no password and knows the host key', async () => {
    const r = await s.add('e2e-root2', 'root', { password: false })
    assert.match(r.out, /\(known\)/)
  })

  test('exec fans out over aliases, one block per host', async () => {
    let r = await s.su(['exec', 'e2e-root,e2e-root2', 'echo "hi from $(id -un)"'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^── e2e-root · exit 0 · [\d.]+s\nhi from root$/m)
    assert.match(r.out, /^── e2e-root2 · exit 0 · [\d.]+s\nhi from root$/m)
    assert.match(r.out, /^2 ok$/m)

    r = await s.su(['exec', 'tag:e2e', 'id -un'])
    assert.equal(r.code, 0, r.all)
    for (const [name, user] of [...USERS, ['e2e-root2', 'root']]) assert.match(r.out, new RegExp(`^── ${name} · exit 0 .*\\n${user}$`, 'm'))
    assert.match(r.out, /^4 ok$/m)
  })

  test('--sudo: alice with the stored password (command and script), bob without one', async () => {
    const r = await s.su(['exec', 'e2e-alice', 'id -u', '--sudo'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^── e2e-alice · exit 0 .*\n0$/m)
    for (const name of ['e2e-alice', 'e2e-bob']) {
      const x = await s.sh(name, 'id -u\nid -un\n', '--sudo')
      assert.equal(x.code, 0, x.err)
      assert.equal(x.out, '0\nroot\n', name)
    }
  })

  test('--sudo without a stored sudo password exits 8', async () => {
    assert.equal((await s.su(['set', 'e2e-alice', 'sudo-password', '--stdin'])).code, 0)
    const r = await s.su(['exec', 'e2e-alice', 'id -u', '--sudo'])
    assert.equal(r.code, 8, r.all)
    assert.match(r.out, /SUDO/)
    assert.equal((await s.su(['set', 'e2e-alice', 'sudo-password', '--stdin'], { input: PW.alice })).code, 0)
    assert.equal((await s.sh('e2e-alice', 'id -u', '--sudo')).out, '0\n')
  })

  test('status', async () => {
    const r = await s.su(['status', 'e2e-root'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^[✓!] e2e-root +up \S+ · load /m)
    const j = JSON.parse((await s.su(['status', 'e2e-root', '--json'])).out).results[0]
    assert.equal(j.exit, 0, j.stderr?.text)
    for (const k of ['uptime_s', 'mem_used_pct', 'disk_root_used_pct']) assert.match(j.data[k] ?? '', /^\d+$/, k)
    assert.match(j.data.load1 ?? '', /^\d+(\.\d+)?$/)
    assert.match(j.data.failed_units, /^(-|\d+)$/, '- without systemd, else a count')
    assert.match(j.data.containers_total, /^(-|\d+)$/, '- without docker, else a count')
  })

  test('logs: a file with spaces in its path, a root-only file via sudo, a missing source', async () => {
    const setup = await s.sh('e2e-root', `mkdir -p '/tmp/su e2e' /root/su-e2e
printf 'one\\ntwo\\nthree\\n' > '/tmp/su e2e/app log.txt'
echo root-only > /root/su-e2e/secret.log && chmod 600 /root/su-e2e/secret.log`)
    assert.equal(setup.code, 0, setup.err)

    let r = await s.su(['logs', 'e2e-root', '/tmp/su e2e/app log.txt', '-n', '2'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^two\nthree$/m)
    assert.doesNotMatch(r.out, /^one$/m)

    r = await s.su(['logs', 'e2e-root', '/tmp/su e2e/app log.txt', '--since', '1h'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /\[stderr\][^]*since/i)

    r = await s.su(['logs', 'e2e-alice', '/root/su-e2e/secret.log'])
    assert.equal(r.code, 1, r.all)
    r = await s.su(['logs', 'e2e-alice', '/root/su-e2e/secret.log', '--sudo'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^root-only$/m)

    r = await s.su(['logs', 'e2e-root', `no-such-source-${RUN}`])
    assert.equal(r.code, 1, r.all)
    assert.match(r.out, /\[stderr\]/)
  })

  test('policy confirm: a destructive exec exits 3 and runs only with --yes', async () => {
    assert.equal((await s.sh('e2e-root', 'mkdir -p /tmp/su-e2e-policy/x')).code, 0)
    let r = await s.su(['exec', 'e2e-root', 'rm -rf /tmp/su-e2e-policy'])
    assert.equal(r.code, 3, r.all)
    assert.match(r.out, /CONFIRM/)
    assert.equal((await s.sh('e2e-root', 'test -d /tmp/su-e2e-policy/x')).code, 0, 'nothing may run without --yes')
    r = await s.su(['exec', 'e2e-root', 'rm -rf /tmp/su-e2e-policy', '--yes'])
    assert.equal(r.code, 0, r.all)
    assert.equal((await s.sh('e2e-root', 'test ! -e /tmp/su-e2e-policy')).code, 0)
  })

  test('policy readonly: exec and job start refused (exit 7), status allowed', async () => {
    assert.equal((await s.su(['set', 'e2e-root2', 'policy=readonly'])).code, 0)
    let r = await s.su(['exec', 'e2e-root2', 'true'])
    assert.equal(r.code, 7, r.all)
    assert.match(r.out, /READONLY/)
    r = await s.su(['job', 'start', 'e2e-root2', `ro-${RUN}`, 'true'])
    assert.equal(r.code, 7, r.all)
    r = await s.su(['status', 'e2e-root2'])
    assert.equal(r.code, 0, r.all)
    assert.equal((await s.su(['set', 'e2e-root2', 'policy=confirm'])).code, 0)
  })

  test('harden --check as root and through sudo', async () => {
    for (const name of ['e2e-root', 'e2e-alice']) {
      const r = await s.su(['harden', name, '--check'])
      assert.equal(r.code, 0, r.all)
      assert.match(r.out, /ssh password auth: yes/)
    }
  })

  test('harden --agent-user creates a key-only user without sudo, idempotently', async () => {
    let r = await s.su(['harden', 'e2e-root', '--agent-user'])
    assert.equal(r.code, 3, r.all)
    r = await s.su(['harden', 'e2e-root', '--agent-user', '--yes'])
    assert.equal(r.code, 0, r.all)
    assert.match((await s.su(['ls'])).out, /^e2e-root-agent +agent@/m)
    assert.equal((await s.sh('e2e-root-agent', 'id -un')).out, 'agent\n')
    assert.notEqual((await s.sh('e2e-root-agent', 'sudo -n true')).code, 0, 'the agent user must not have sudo')
    r = await s.su(['harden', 'e2e-root', '--agent-user', '--yes'])
    assert.equal(r.code, 0, r.all)
  })

  test('harden --agent-user re-run never writes or chowns as root through the agent user\'s ~/.ssh', async () => {
    // what the agent user can plant where fs.protected_hardlinks=0: authorized_keys hardlinked to a root-only file
    const victim = `/root/su-e2e-victim-${RUN}`
    let r = await s.sh('e2e-root', `echo untouched > ${victim} && chmod 600 ${victim} && ln -f ${victim} ~agent/.ssh/authorized_keys`)
    assert.equal(r.code, 0, r.err)
    r = await s.su(['harden', 'e2e-root', '--agent-user', '--yes'])
    assert.notEqual(r.code, 0, 'the agent user cannot open a root-only file, so the key install must fail')
    r = await s.sh('e2e-root', `stat -c '%U %a' ${victim} && cat ${victim}; rm -f ${victim} ~agent/.ssh/authorized_keys`, '--yes')
    assert.equal(r.out, 'root 600\nuntouched\n')
    r = await s.su(['harden', 'e2e-root', '--agent-user', '--yes'])
    assert.equal(r.code, 0, r.all)
    assert.equal((await s.su(['disconnect', 'e2e-root-agent'])).code, 0)
    assert.equal((await s.sh('e2e-root-agent', 'id -un')).out, 'agent\n', 'a clean re-run installs the key again')
  })

  test('hostkey change: exit 4, nothing runs, trust --reset recovers', async () => {
    const kh = join(s.home, 'known_hosts')
    const pinned = readFileSync(kh, 'utf8')
    // same key type, one bit off: what a reinstalled server or a man in the middle looks like
    writeFileSync(kh, pinned.split('\n').map((line) => {
      const f = line.split(' ')
      if (f.length < 3) return line
      const blob = Buffer.from(f[2], 'base64')
      blob[blob.length - 1] ^= 1
      return [f[0], f[1], blob.toString('base64'), ...f.slice(3)].join(' ')
    }).join('\n'))
    assert.equal((await s.su(['disconnect', 'e2e-root'])).code, 0)
    const marker = `/tmp/su-e2e-hostkey-${RUN}`
    let r = await s.su(['exec', 'e2e-root', `touch ${marker}`])
    assert.equal(r.code, 4, r.all)
    assert.match(r.out, /HOST KEY CHANGED/)
    r = await s.su(['trust', 'e2e-root', '--reset'])
    assert.equal(r.code, 0, r.all)
    r = await s.sh('e2e-root', `test ! -e ${marker}`)
    assert.equal(r.code, 0, 'the command must not have run on the unverified connection')
  })

  test('harden --lock-password keeps key login and refuses passwords; unlock-password restores them', { timeout: 600_000 }, async () => {
    const dropIn = '/etc/ssh/sshd_config.d/00-server-use.conf'
    try {
      let r = await s.su(['harden', 'e2e-root', '--lock-password'])
      assert.equal(r.code, 3, r.all)
      r = await s.su(['harden', 'e2e-root', '--lock-password', '--yes'], { timeout: 180_000 })
      assert.equal(r.code, 0, r.all)
      assert.match(r.out, /^passwordauthentication no$/m)
      assert.equal((await s.su(['disconnect', 'e2e-root'])).code, 0)
      assert.equal((await s.sh('e2e-root', 'true')).code, 0, 'a fresh key login must work after locking')
      await until(async () => { const c = await passwordLogin('alice'); return c === 6 || `password login exit ${c}` }, 20_000)

      r = await s.su(['exec', 'e2e-root', '--script', repoFile('remote/harden.sh'), '--env', 'SU_ACTION=unlock-password', '--yes'])
      assert.equal(r.code, 0, r.all)
      await until(async () => { const c = await passwordLogin('alice'); return c === 0 || `password login exit ${c}` }, 30_000)
    } finally {
      // later test files log in with passwords: never leave the container locked
      await s.sh('e2e-root', `if [ -e ${dropIn} ]; then rm -f ${dropIn} && kill -HUP "$(cat /run/sshd.pid)" && sleep 1; fi`, '--yes').catch(() => {})
    }
  })

  test('secret leak: no password in any output or state file', () => {
    s.assertNoLeak(Object.values(PW))
  })
})
