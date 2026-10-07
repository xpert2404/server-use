// Real CLI + daemon + sshd tests. The integrator runs this suite serially with the other e2e files.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { skip, sandbox, RUN, PW } from './helpers.mjs'

describe('e2e: approved runbooks', { skip }, () => {
  let s
  const base = `$HOME/.server-use-rb-${RUN}`
  const approve = async (name, script, flags = [], target = 'rb-root') => {
    const result = await s.su(['runbook', 'add', target, name, '--script', '-', '--yes', ...flags], { input: script })
    assert.equal(result.code, 0, result.all)
    return result
  }
  const run = (name, flags = [], target = 'rb-root') => s.su(['run', target, name, ...flags])
  const mutate = (name, fn) => {
    const path = join(s.home, 'runbooks.yaml')
    const books = YAML.parse(readFileSync(path, 'utf8'))
    fn(books[name])
    writeFileSync(path, YAML.stringify(books))
  }

  before(async () => {
    s = sandbox()
    await s.add('rb-root', 'root')
    await s.add('rb-alice', 'alice')
    assert.equal((await s.sh('rb-root', `mkdir -p "${base}"`)).code, 0)
  })
  after(async () => {
    await s?.sh('rb-root', `rm -rf "${base}"`, '--yes').catch(() => {})
    s?.assertNoLeak([PW.root, PW.alice])
    await s?.cleanup()
  })

  test('approval is explicit; an approved destructive fix runs on confirm without --yes and verifies', async () => {
    const name = 'approved'
    const script = `mkdir -p "${base}/scratch"; rm -rf "${base}/scratch"; echo fixed-once`
    const refused = await s.su(['runbook', 'add', 'rb-root', name, '--script', '-'], { input: script })
    assert.equal(refused.code, 3, refused.all)
    assert.match(refused.all, /approval/)
    await approve(name, script, ['--verify', `test ! -d "${base}/scratch"`])
    const result = await run(name, ['--json'])
    assert.equal(result.code, 0, result.all)
    const host = JSON.parse(result.out).results[0]
    assert.equal(host.runbook, name)
    assert.equal(host.verify, 'ok')
    assert.equal(host.exit, 0)
    assert.match(host.stdout.text, /fixed-once/)
    assert.match(host.sha, /^[a-f0-9]{64}$/)
    const list = await s.su(['runbook', 'ls', '--json'])
    assert.equal(list.code, 0, list.all)
    assert.ok(JSON.parse(list.out).runbooks.some((book) => book.name === name && book.state === 'ok'))
    const shown = await s.su(['runbook', 'show', name, '--json'])
    assert.equal(JSON.parse(shown.out).script, script)
  })

  test('parameters are validated and shell metacharacters stay literal; dry run has no side effects', async () => {
    const name = 'parameters'
    const value = "caddy'; touch INJECTED-RUNBOOK; echo '$(touch OTHER-RUNBOOK)"
    await approve(name, `printf '%s\\n' "$SU_P_unit" > "${base}/parameter"`, ['--param', `unit=${value}`, '--limit', '1/1h'])
    const dry = await run(name, [`unit=${value}`, '--dry-run'])
    assert.equal(dry.code, 0, dry.all)
    assert.match(dry.out, /DRY RUN/)
    assert.equal((await s.sh('rb-root', `test ! -e "${base}/parameter"`)).code, 0)
    for (const parameters of [[], ['unit=sshd'], [`unit=${value}`, 'extra=x']]) {
      const bad = await run(name, [...parameters, '--yes'])
      assert.equal(bad.code, 2, bad.all)
    }
    const good = await run(name, [`unit=${value}`])
    assert.equal(good.code, 0, good.all)
    assert.equal((await s.sh('rb-root', `cat "${base}/parameter"`)).out.trim(), value)
    assert.equal((await s.sh('rb-root', 'test ! -e "$HOME/INJECTED-RUNBOOK" && test ! -e "$HOME/OTHER-RUNBOOK"')).code, 0)
  })

  test('hash tampering, out-of-scope targets and changed aliases never execute, even with --yes', async () => {
    await approve('tampered', `touch "${base}/tampered"`)
    mutate('tampered', (book) => book.script += '; echo edited')
    const tampered = await run('tampered', ['--yes'])
    assert.equal(tampered.code, 2, tampered.all)
    assert.match(tampered.all, /changed after the user approved/)
    assert.equal((await s.sh('rb-root', `test ! -e "${base}/tampered"`)).code, 0)
    await approve('scope', 'echo allowed')
    const outside = await run('scope', ['--yes'], 'rb-alice')
    assert.equal(outside.code, 2, outside.all)
    assert.match(outside.all, /outside the targets approved/)
    assert.equal((await s.su(['set', 'rb-root', 'user=alice'])).code, 0)
    try {
      const moved = await run('scope', ['--yes'])
      assert.equal(moved.code, 2, moved.all)
      assert.match(moved.all, /changed since approval/)
    } finally {
      assert.equal((await s.su(['set', 'rb-root', 'user=root'])).code, 0)
    }
  })

  test('readonly stays readonly after approval and --yes; removing a runbook revokes it', async () => {
    await approve('readonly', 'echo blocked')
    assert.equal((await s.su(['set', 'rb-root', 'policy=readonly'])).code, 0)
    try {
      const result = await run('readonly', ['--yes'])
      assert.equal(result.code, 7, result.all)
      assert.match(result.all, /readonly/)
    } finally {
      assert.equal((await s.su(['set', 'rb-root', 'policy=confirm'])).code, 0)
    }
    const removed = await s.su(['runbook', 'rm', 'readonly'])
    assert.equal(removed.code, 0, removed.all)
    assert.equal((await run('readonly')).code, 2)
  })

  test('rate limit survives concurrent callers and daemon restart; --yes cannot lift it', async () => {
    const script = `echo attempt >> "${base}/attempts"; sleep 1; echo done`
    await approve('limited', script, ['--limit', '1/1h'])
    const results = await Promise.all([run('limited'), run('limited')])
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 1], results.map((r) => r.all).join('\n'))
    assert.equal((await s.sh('rb-root', `wc -l < "${base}/attempts"`)).out.trim(), '1')
    assert.equal((await s.su(['daemon', 'restart'])).code, 0)
    const refused = await run('limited', ['--yes'])
    assert.equal(refused.code, 1, refused.all)
    assert.match(refused.all, /RATE_LIMIT|limit 1\/1h reached/)
    await approve('limited', script, ['--limit', '2/1h'])
    assert.equal((await run('limited')).code, 0)
    assert.equal((await s.sh('rb-root', `wc -l < "${base}/attempts"`)).out.trim(), '2')
  })

  test('failed verification reports failure and retries only verification, never the approved fix', { timeout: 120_000 }, async () => {
    await approve('verify-fails', `echo fix >> "${base}/fix-count"`, ['--verify', `echo probe >> "${base}/probe-count"; echo unavailable >&2; return 9`])
    const result = await run('verify-fails', ['--json'])
    assert.equal(result.code, 1, result.all)
    const host = JSON.parse(result.out).results[0]
    assert.equal(host.verify, 'failed')
    assert.match(host.stdout.text, /verify FAILED after 5 attempts/)
    assert.match(host.stdout.text, /unavailable/)
    assert.equal((await s.sh('rb-root', `wc -l < "${base}/fix-count"; wc -l < "${base}/probe-count"`)).out.trim(), '1\n5')
  })

  test('permissions prints ready Claude JSON and Codex rules without granting approval or arbitrary exec', async () => {
    await approve('permissions', 'echo allowed')
    const claude = await s.su(['permissions', '--format', 'claude', '--json'])
    assert.equal(claude.code, 0, claude.all)
    const configured = JSON.parse(claude.out)
    const fragment = JSON.parse(configured.text)
    assert.ok(fragment.permissions.allow.includes('Bash(server-use run rb-root permissions *)'))
    assert.ok(!fragment.permissions.allow.some((rule) => rule.includes('runbook add') || rule.includes('server-use exec')))
    const codex = await s.su(['permissions', '--format', 'codex'])
    assert.equal(codex.code, 0, codex.all)
    assert.match(codex.out, /prefix_rule\(pattern=\["server-use","run","rb-root","permissions"\], decision="allow"\)/)
    assert.match(codex.out, /appended flags cannot bypass/)
  })
})
