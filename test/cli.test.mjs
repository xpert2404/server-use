// The real CLI and daemon against in-process fixture servers: onboarding, fleet exec, policies, errors, put/get.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixture, newHostKey, SH } from './fixture.mjs'
import { ROOT } from '../src/paths.mjs'
import { sandbox } from './e2e/helpers.mjs'

process.env.SERVER_USE_DAEMON_IDLE_MS = '60000'
const PW = 'fx-Secret-7f3a9c' // must never show up outside secrets.json
const skip = SH ? false : 'no POSIX sh for the fixture (install Git for Windows or set SU_TEST_SH)'

describe('cli against fixture servers', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  /** @type {Awaited<ReturnType<typeof startFixture>>[]} */ let fx = []
  const work = mkdtempSync(join(tmpdir(), 'su work-'))
  const at = (/** @type {typeof fx[0]} */ f) => `${f.user}@127.0.0.1:${f.port}`
  const json = async (/** @type {string[]} */ args) => {
    const r = await s.su([...args, '--json'])
    try { return { ...r, res: JSON.parse(r.out).results } } catch { return assert.fail(`no JSON (exit ${r.code}): ${r.all}`) }
  }

  before(async () => {
    s = sandbox()
    fx = await Promise.all([startFixture({ password: PW }), startFixture({ password: PW }), startFixture({ user: 'root', password: PW })])
  })
  after(async () => {
    await s?.cleanup()
    await Promise.all(fx.map((f) => f.close()))
    rmSync(work, { recursive: true, force: true })
  })

  test('add with --password-stdin installs the key; exec then works with password login gone', async () => {
    const r = await s.su(['add', 'web1', at(fx[0]), '--password-stdin', '--tag', 'fleet'], { input: PW })
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /key installed and key login verified/)
    const pub = readFileSync(join(s.home, 'id_ed25519.pub'), 'utf8').split(' ')[1]
    assert.ok(readFileSync(join(fx[0].home, '.ssh', 'authorized_keys'), 'utf8').includes(pub))
    const show = await s.su(['show', 'web1'])
    assert.match(show.out, /auth key/)
    assert.match(show.out, /secrets \(file\): none/)

    fx[0].password = null
    assert.equal((await s.su(['disconnect', 'web1'])).code, 0)
    const x = await s.su(['exec', 'web1', 'echo "hello from $(whoami)"'])
    assert.equal(x.code, 0, x.all)
    assert.match(x.out, /^── web1 · exit 0 · [\d.]+s\nhello from /)
  })

  test('add two more servers (one keeps its password)', async () => {
    let r = await s.su(['add', 'web2', at(fx[1]), '--password-stdin', '--tag', 'fleet', '--keep-password'], { input: PW })
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /stored password in file/)
    r = await s.su(['add', 'web3', at(fx[2]), '--password-stdin', '--tag', 'fleet'], { input: PW })
    assert.equal(r.code, 0, r.all)
    fx[2].password = null
  })

  test('fan-out keeps each host\'s stdout and stderr apart', async () => {
    fx.forEach((f, i) => writeFileSync(join(f.home, 'who'), `host${i + 1}`))
    const cmd = 'echo "$(cat who) out"; echo "$(cat who) err" >&2'
    const j = await json(['exec', 'tag:fleet', cmd])
    assert.equal(j.code, 0, j.all)
    assert.deepEqual(j.res.map((/** @type {any} */ x) => [x.host, x.stdout.text, x.stderr.text]), [
      ['web1', 'host1 out\n', 'host1 err\n'], ['web2', 'host2 out\n', 'host2 err\n'], ['web3', 'host3 out\n', 'host3 err\n'],
    ])
    const r = await s.su(['exec', 'tag:fleet', cmd])
    const blocks = r.out.split(/^(?=── )/m)
    assert.equal(blocks.length, 3)
    blocks.forEach((b, i) => {
      assert.match(b, new RegExp(`^── web${i + 1} · exit 0 .*\\nhost${i + 1} out\\n\\[stderr\\]\\nhost${i + 1} err\\n`))
      assert.equal(b.match(/host\d/g)?.length, 2, b)
    })
    assert.match(r.out, /3 ok\n$/)
  })

  test('fan-out runs in parallel', async () => {
    const t = Date.now()
    const j = await json(['exec', 'web1,web2,web3', 'sleep 1'])
    const wall = Date.now() - t
    assert.equal(j.code, 0, j.all)
    const sum = j.res.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + x.ms, 0)
    assert.ok(sum >= 2900, `each host slept (sum ${sum} ms)`)
    assert.ok(wall < sum * 0.75, `wall ${wall} ms vs. ${sum} ms summed`)
  })

  test('long output is clipped, the full output is in the log', async () => {
    const r = await s.su(['exec', 'web1', 'seq 1 5000'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /^50\n… 4800 lines cut …\n4851$/m)
    const log = /full stdout: (.+)$/m.exec(r.out)?.[1]
    assert.ok(log, r.out.slice(0, 300))
    assert.equal(readFileSync(log, 'utf8'), Array.from({ length: 5000 }, (_, i) => `${i + 1}\n`).join(''))
  })

  test('timeout → exit 124', async () => {
    const t = Date.now()
    const r = await s.su(['exec', 'web1', 'sleep 8; echo not-reached', '--timeout', '1s'])
    assert.equal(r.code, 124, r.all)
    assert.match(r.out, /TIMEOUT: timed out after 1s/)
    assert.doesNotMatch(r.out, /not-reached/)
    assert.ok(Date.now() - t < 6000)
  })

  test('policy confirm stops a destructive command (exit 3) until --yes', async () => {
    mkdirSync(join(fx[0].home, 'victim'))
    let r = await s.su(['exec', 'web1', 'rm -rf victim'])
    assert.equal(r.code, 3, r.all)
    assert.match(r.out, /CONFIRM: .*rm -r\/-f.*--yes/)
    assert.ok(existsSync(join(fx[0].home, 'victim')))
    r = await s.su(['exec', 'web1', 'rm -rf victim', '--yes'])
    assert.equal(r.code, 0, r.all)
    assert.ok(!existsSync(join(fx[0].home, 'victim')))
  })

  test('readonly → exit 7', async () => {
    assert.equal((await s.su(['set', 'web1', 'policy=readonly'])).code, 0)
    const r = await s.su(['exec', 'web1', 'echo hi'])
    assert.equal(r.code, 7, r.all)
    assert.match(r.out, /READONLY/)
    assert.equal((await s.su(['set', 'web1', 'policy=confirm'])).code, 0)
  })

  test('another name for the address of a readonly server stays readonly', async () => {
    assert.equal((await s.su(['set', 'web1', 'policy=readonly'])).code, 0)
    try {
      let r = await s.su(['add', 'web1-alias', at(fx[0]), '--policy', 'open'])
      assert.equal(r.code, 0, r.all)
      assert.match(r.out, /policy readonly/)
      assert.equal((await s.su(['exec', 'web1-alias', 'echo hi'])).code, 7)
      // Another spelling of the address is recognized by the pinned host key.
      r = await s.su(['add', 'web1-alias3', `${fx[0].user}@localhost:${fx[0].port}`, '--policy', 'open'])
      assert.equal(r.code, 0, r.all)
      assert.match(r.out, /policy readonly taken over from web1/)
      await s.su(['rm', 'web1-alias3'])
      // No policy field means confirm, and that is what gets taken over and shown.
      await s.su(['rm', 'web1-alias'])
      assert.equal((await s.su(['set', 'web1', 'policy='])).code, 0)
      r = await s.su(['add', 'web1-alias2', at(fx[0]), '--policy', 'open'])
      assert.equal(r.code, 0, r.all)
      assert.match(r.out, /· policy confirm[\s\S]*hint: policy confirm taken over from web1/)
    } finally {
      await s.su(['rm', 'web1-alias'])
      await s.su(['rm', 'web1-alias2'])
      await s.su(['rm', 'web1-alias3'])
      await s.su(['set', 'web1', 'policy=confirm'])
    }
  })

  test('bad flags and a bad --policy exit 2, the policy before connecting', async () => {
    for (const args of [['ls', '--bogus'], ['logs', 'web1', 'syslog', '-n'], ['add', 'x', 'root@127.0.0.1:1', '--policy', 'bogus']]) {
      const r = await s.su(args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.all}`)
    }
  })

  test('unknown server → exit 2', async () => {
    const r = await s.su(['exec', 'nope', 'true'])
    assert.equal(r.code, 2, r.all)
    assert.match(r.err, /unknown server "nope"/)
  })

  test('--cwd and --env values survive quoting', async () => {
    mkdirSync(join(fx[0].home, "it's here"))
    const value = `it's "q" $HOME \`id\` \\ ;`
    const j = await json(['exec', 'web1', 'basename "$PWD"; printf %s "$MSG"', '--cwd', "it's here", '--env', `MSG=${value}`])
    assert.equal(j.code, 0, j.all)
    assert.equal(j.res[0].stdout.text, `it's here\n${value}`)
  })

  test('--sudo as root runs the command directly', async () => {
    const r = await s.su(['exec', 'web3', 'echo "$((6 * 7))"', '--sudo'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /\n42\n/)
  })

  test('put/get round trip of a binary file with a space in the name', async () => {
    const data = randomBytes(300_000)
    writeFileSync(join(work, 'bin file.dat'), data)
    let r = await s.su(['put', 'web1', join(work, 'bin file.dat'), '~/up dir/'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /uploaded 300000 bytes → ~\/up dir\/bin file.dat/)
    assert.ok(readFileSync(join(fx[0].home, 'up dir', 'bin file.dat')).equals(data))
    r = await s.su(['get', 'web1', '~/up dir/bin file.dat', join(work, 'back file.dat')])
    assert.equal(r.code, 0, r.all)
    assert.ok(readFileSync(join(work, 'back file.dat')).equals(data))
  })

  test('get into a directory that does not exist yet (trailing /) keeps the file name', async () => {
    const r = await s.su(['get', 'web1', '~/up dir/bin file.dat', join(work, 'new dir') + '/'])
    assert.equal(r.code, 0, r.all)
    assert.ok(existsSync(join(work, 'new dir', 'bin file.dat')), r.out)
  })

  test('mcp: help lists the real tools; transfer cannot touch server-use\'s own state', async () => {
    const pins = readFileSync(join(s.home, 'known_hosts'), 'utf8')
    const sshKnown = join(dirname(s.home), 'ssh', 'known_hosts') // the sandbox's SERVER_USE_SSH_DIR
    // realpath keeps a loopback admin-share alias as it is; only file identity shows it is the same directory.
    const unc = '\\\\localhost\\' + s.home[0] + '$' + s.home.slice(2)
    const get = (/** @type {string} */ local) => ({ method: 'tools/call', params: { name: 'transfer', arguments: { direction: 'get', targets: 'web1', remote: '~/up dir/bin file.dat', local } } })
    const put = (/** @type {string} */ local) => ({ method: 'tools/call', params: { name: 'transfer', arguments: { direction: 'put', targets: 'web1', local, remote: '~/stolen' } } })
    const planted = join(ROOT, 'mcp-planted.dat')
    // "\Users\..." is absolute on win32 but drive-relative: the daemon must get the path the guard checked, drive included.
    // Only strippable on the cwd's drive (the one mcp resolves against; CI has the checkout on D: and TEMP on C:).
    const noDrive = (/** @type {string} */ p) => process.platform === 'win32' && p.slice(0, 2).toLowerCase() === process.cwd().slice(0, 2).toLowerCase() ? p.slice(2) : p
    // A login key outside ~/.ssh (add --key), and another server-use install (the daemon may run from that copy).
    const loginKey = join(work, 'login key')
    writeFileSync(loginKey, readFileSync(join(s.home, 'id_ed25519')))
    const k = await s.su(['add', 'web1-key', at(fx[0]), '--key', loginKey])
    assert.equal(k.code, 0, k.all)
    const other = join(work, 'other install')
    mkdirSync(join(other, 'bin'), { recursive: true })
    writeFileSync(join(other, 'bin', 'server-use.mjs'), '')
    const calls = [
      { method: 'tools/list' },
      get(join(s.home, 'known_hosts')),
      put(join(s.home, 'id_ed25519')),
      get(sshKnown),
      { method: 'tools/call', params: { name: 'servers', arguments: { action: 'add', name: 'web1-mcp', address: at(fx[0]), policy: null } } },
      put(join(dirname(sshKnown), 'id_ed25519')), // a login key
      get(planted), // server-use's own code
      get(noDrive(join(work, 'mcp dl')) + '/'),
      put(loginKey),
      get(join(other, 'src', 'guard.mjs')),
      ...(process.platform === 'win32' && existsSync(unc) ? [get(join(unc, 'known_hosts'))] : []),
    ]
    const r = await s.su(['mcp'], { input: calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c }) + '\n').join('') })
    const leaked = existsSync(planted)
    rmSync(planted, { force: true }) // before any assert: never leave a planted file in the repo
    const res = Object.fromEntries(r.out.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m.result]))
    const names = res[1].tools.map((/** @type {any} */ t) => t.name)
    assert.ok((await s.su(['help', 'mcp'])).out.includes(`(tools: ${names.join(', ')})`), names.join(', '))
    for (const id of [2, 3, 11]) {
      if (!res[id]) continue // id 11 needs the C$ admin share
      assert.equal(res[id].isError, true, res[id].content[0].text)
      assert.match(res[id].content[0].text, /^USAGE: local path is inside server-use's state directory/)
    }
    for (const id of [4, 6]) assert.match(res[id].content[0].text, /^USAGE: local path is inside .*known_hosts and keys server-use trusts/)
    for (const id of [7, 10]) assert.match(res[id].content[0].text, /^USAGE: local path is inside server-use's install directory/)
    assert.ok(!leaked)
    assert.ok(!existsSync(join(other, 'src')))
    assert.match(res[9].content[0].text, /^USAGE: local path is the login key of a server in the inventory/)
    await s.su(['rm', 'web1-key'])
    assert.equal(res[8].isError, false, res[8].content[0].text)
    assert.ok(res[8].content[0].text.includes(`bytes → ${join(work, 'mcp dl', 'bin file.dat')}`), res[8].content[0].text)
    assert.equal(res[5].isError, false, res[5].content[0].text) // policy null = the default
    assert.equal(JSON.parse(res[5].content[0].text).policy, 'confirm')
    await s.su(['rm', 'web1-mcp'])
    assert.equal(readFileSync(join(s.home, 'known_hosts'), 'utf8'), pins)
    assert.ok(!existsSync(join(fx[0].home, 'stolen')))
    assert.ok(!existsSync(sshKnown))
  })

  test('host key change → exit 4, trust --reset recovers', async () => {
    await fx[1].restart({ hostKey: newHostKey() })
    let r = await s.su(['exec', 'web2', 'touch ran'])
    assert.equal(r.code, 4, r.all)
    assert.match(r.out, /HOST KEY CHANGED/)
    assert.ok(!existsSync(join(fx[1].home, 'ran')))
    assert.equal((await s.su(['trust', 'web2', '--reset'])).code, 0)
    r = await s.su(['exec', 'web2', 'echo back'])
    assert.equal(r.code, 0, r.all)
    assert.match(r.out, /\nback\n/)
  })

  test('wrong password → exit 6, unreachable → exit 5', async () => {
    const f = await startFixture({ password: PW })
    const r = await s.su(['add', 'bad', at(f), '--password-stdin'], { input: 'not-the-password' })
    await f.close()
    assert.equal(r.code, 6, r.all)
    assert.match(r.err, /authentication failed/)
    const port = await new Promise((resolve) => { const srv = createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) }) })
    const u = await s.su(['add', 'dead', `root@127.0.0.1:${port}`])
    assert.equal(u.code, 5, u.all)
    assert.doesNotMatch((await s.su(['ls'])).out, /\b(bad|dead)\b/)
  })

  test('the password never leaks into state files or output', async () => {
    await s.su(['ls'])
    await s.su(['show', 'web1'])
    await s.su(['show', 'web2'])
    await s.su(['audit', '-n', '100'])
    assert.ok(readFileSync(join(s.home, 'secrets.json'), 'utf8').includes(PW), 'web2 kept its password (sanity)')
    for (const f of ['audit.jsonl', 'servers.yaml', 'daemon.log', 'runs']) assert.ok(existsSync(join(s.home, f)), f)
    s.assertNoLeak([PW])
  })
})
