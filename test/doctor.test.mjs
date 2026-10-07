import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { SH } from './fixture.mjs'
import { parseDoctor, formatDoctor, redact, doctor } from '../src/ops/doctor.mjs'
import * as inventory from '../src/inventory.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'su-doctor-'))
process.env.SERVER_USE_HOME = tmp
after(() => rmSync(tmp, { recursive: true, force: true }))
const meta = '== meta\nnow=1791388800\nsince_min=120\nuser=alice\nhostname=lab\n'

test('doctor ranks evidence and retains unavailable probes and recent changes', () => {
  const data = parseDoctor(meta + '== errors\nerr\t4\tapi\tfirst\tlast\tconnection refused\n== disk\ndisk\t/\t1000\t10\t99\t93\n== changes\nfile\t1791388790\tconf\t/etc/app.conf\nfile\t1\tconf\t/old\n== partial\njournal\tneeds root\n')
  assert.equal(data.findings[0].severity, 'crit')
  assert.match(data.findings[0].title, /99%/)
  assert.equal(data.findings.length, 3)
  assert.equal(data.changes.length, 1)
  assert.deepEqual(data.partial, ['journal: needs root'])
  assert.match(formatDoctor(data), /Next: df/)
})
test('doctor redacts known credential forms before parsing or formatting', () => {
  const tokens = ['private-test-secret', 'abcdefghijk123456', 'ghp_' + 'a'.repeat(30)]
  const text = `password=${tokens[0]} Bearer ${tokens[1]} https://bob:${tokens[0]}@example.invalid ${tokens[2]}`
  const data = parseDoctor(meta + `== errors\nerr\t1\tapi\tfirst\tlast\t${text}\n`)
  for (const token of tokens) assert.ok(!JSON.stringify(data).includes(token))
  assert.match(redact(text), /password=\*\*\*/)
})
test('doctor reports host pressure, OOM, units, containers, job/cron, certificates and clock', () => {
  const data = parseDoctor(meta + '== host\nmem_total_kb=1000\nmem_avail_kb=10\nload=8 4 2\ncpus=2\n== oom\noom\t1791388700\tworker\n== units\nfailed\tapp.service\nunitlog\tapp.service\terror happened\n== containers\nctr\tapi\trestarting\t1\ttrue\t3\tstart\tend\tunhealthy\n== cron\njobexit\tbuild\t4\tnow\ncronrun\tbackup\t=== now exit 2\n== certs\ncert\tapi\texpired\t-1\n== ntp\nntp_sync=no\n')
  assert.equal(data.findings.length, 9)
  assert.ok(data.findings.some(f => f.evidence === 'error happened'))
})
test('doctor redacts entire quoted values including delimiters and escaped quotes', () => {
  for (const text of ['password="alpha beta"', "token:'alpha;beta,gamma'", 'secret="alpha\\"beta"', 'password="alpha beta', "token:'alpha;beta,gamma"]) {
    assert.ok(!redact(text).includes('alpha'), redact(text))
    assert.ok(!redact(text).includes('beta'), redact(text))
  }
})
test('remote doctor redactor removes complete quoted secrets before transport', { skip: !SH && 'no POSIX shell' }, () => {
  const source = readFileSync(new URL('../remote/doctor.sh', import.meta.url), 'utf8')
  const library = /AWKLIB='([\s\S]*?)'\r?\n/.exec(source)[1]
  const body = 'error password="alpha beta" token:\x27alpha;beta,gamma\x27 secret="alpha\\"beta"\nerror password="alpha beta\nerror token:\x27alpha;beta,gamma'
  const script = `AWKLIB='${library}'\nawk "$AWKLIB"'{print red($0)}' <<'SU_REDACT_INPUT'\n${body}\nSU_REDACT_INPUT\n`
  const result = spawnSync(SH, [], { input: script, encoding: 'utf8', env: { ...process.env, PATH: [dirname(SH), process.env.PATH].join(delimiter) } })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!result.stdout.includes('alpha'), result.stdout)
  assert.ok(!result.stdout.includes('beta'), result.stdout)
  assert.ok(!result.stdout.includes('gamma'), result.stdout)
})
test('doctor refuses malformed snapshots and invalid windows', async () => {
  assert.throws(() => parseDoctor('== host\nload=1\n'), /incomplete/)
  for (const since of ['0s', '8d', 'bad']) await assert.rejects(doctor({}, { targets: 'missing', since }), /duration|since/)
})
test('doctor recent packages accept epoch timestamps and the server timezone', () => {
  const data = parseDoctor(meta + 'tz=+0200\n== changes\npkg\t1791388790\trpm upgrade\npkg\t2026-10-07T18:00:00\tapt upgrade\n')
  assert.equal(data.changes.length, 2)
})
test('doctor on readonly server makes one remote snapshot and remains read-only', async () => {
  inventory.upsert('lab', { host: 'example.invalid', user: 'alice', policy: 'readonly' })
  let calls = 0
  const out = await doctor({ agent: 'test' }, { targets: 'lab', since: '10m' }, { run: async (ctx, host, script, vars, options) => {
    calls++; assert.equal(script, 'doctor'); assert.equal(vars.SU_SINCE_MIN, 10)
    assert.equal(options.full, true)
    assert.ok(!('SU_RECLAIM' in vars))
    return { exit: 0, stdout: { text: meta + '== partial\ndocker\tnot installed\n' } }
  } })
  assert.equal(calls, 1)
  assert.match(out.results[0].stdout.text, /Unavailable probes/)
})
