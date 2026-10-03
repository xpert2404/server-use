// deploy: the op's argument checks and result parsing, and remote/deploy.sh run locally (job mode, no SSH) against a
// git repo in a temp dir. `sleep` is stubbed out so a failing health check gives up at once, `date` counts up so
// releases sort in deploy order, and `crontab -l` prints $HOME/crontab.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { deploy, parseResult } from '../src/ops/scripts.mjs'
import { scriptSource, b64 } from '../src/remote.mjs'
import { SH } from './fixture.mjs'
import { until } from './e2e/helpers.mjs'

const WIN = process.platform === 'win32'
const tmp = mkdtempSync(join(tmpdir(), 'su-scripts-'))
process.env.SERVER_USE_HOME = join(tmp, 'su-home')
process.env.SERVER_USE_SECRETS = 'file'
after(() => rmSync(tmp, { recursive: true, force: true }))

describe('deploy op', () => {
  test('a bad --watch fails before anything is deployed', async () => {
    // "nope" is no server: reaching the deploy itself would fail with UNKNOWN_SERVER instead
    await assert.rejects(deploy(/** @type {any} */ ({}), { target: 'nope', repo: 'o/r', watch: '5x' }), /bad duration/)
    await assert.rejects(deploy(/** @type {any} */ ({}), { target: 'nope', repo: 'o/r', name: 'a'.repeat(60), watch: '5m' }), /cron job name/)
  })

  test('SU_RESULT: the last line wins and paths may contain spaces', () => {
    const out = 'SU_RESULT base=/evil release=x sha=y service=z\n==> build\nSU_RESULT base=/srv/my app release=/srv/my app/releases/20260101000000-abc1234 sha=abc1234 service=job\n'
    assert.deepEqual(parseResult(out), { base: '/srv/my app', release: '/srv/my app/releases/20260101000000-abc1234', sha: 'abc1234', service: 'job' })
    assert.deepEqual(parseResult('no result'), {})
  })
})

// Git Bash makes copies for `ln -s` unless native symlinks work (developer mode or admin)
const symlinks = (() => {
  try { symlinkSync(tmp, join(tmp, 'link-probe'), 'dir'); return true } catch { return false }
})()
const git = spawnSync('git', ['--version']).status === 0
const skip = !SH ? 'no POSIX sh' : !git ? 'no git' : !symlinks ? 'no symlinks (Windows: enable developer mode)' : false

describe('remote/deploy.sh', { skip }, () => {
  const posix = (/** @type {string} */ p) => (WIN ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/') : p)
  const dir = join(tmp, 'deploy')
  const repo = join(dir, 'repo')
  const base = join(dir, 'base')
  const state = join(base, '.server-use')
  const stub = join(dir, 'stub')
  const PATH = [stub, ...(WIN ? [dirname(/** @type {string} */ (SH)), join(dirname(/** @type {string} */ (SH)), '..', '..', 'mingw64', 'bin')] : [process.env.PATH])].join(delimiter)

  const commit = (/** @type {string} */ v) => {
    writeFileSync(join(repo, 'index.html'), v)
    for (const args of [['add', '.'], ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', v]]) {
      assert.equal(spawnSync('git', args, { cwd: repo }).status, 0)
    }
  }
  const run = (/** @type {Record<string, string>} */ vars) => {
    const r = spawnSync(/** @type {string} */ (SH), [], {
      input: scriptSource('deploy'), encoding: 'utf8', timeout: 60_000,
      env: { PATH, HOME: dir, MSYS: 'winsymlinks:nativestrict', SYSTEMROOT: process.env.SYSTEMROOT, SU_NAME: 'app', SU_REPO: posix(repo), SU_BASE: posix(base), ...vars },
    })
    return { code: r.status, all: `${r.stdout}${r.stderr}` }
  }
  const ran = () => join(base, 'current', 'ran')
  const crontab = join(dir, 'crontab')

  before(() => {
    mkdirSync(repo, { recursive: true })
    mkdirSync(stub)
    // a non-root `id` keeps a root Linux host in job mode instead of installing a systemd unit
    const stubs = [['sleep', ':'], ['id', 'echo 1000'], ['crontab', 'cat "$HOME/crontab"'], ['docker', 'echo "$*" >>"$HOME/docker.log"'],
      ['date', `n=$(($(cat "$HOME/n" 2>/dev/null || echo 0) + 1)); echo $n >"$HOME/n"; printf '2026010100%04d\\n' $n`]]
    for (const [cmd, body] of stubs) {
      writeFileSync(join(stub, cmd), `#!/bin/sh\n${body}\n`)
      chmodSync(join(stub, cmd), 0o755)
    }
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0)
  })

  test('once a watch exists, a deploy without --watch updates its settings', async () => {
    commit('v1')
    let r = run({ SU_RUN: 'echo one >ran', SU_WATCH: '1', SU_SELF_B64: b64(scriptSource('deploy')) })
    assert.equal(r.code, 0, r.all)
    // the deploy op adds the pull check's cron entry after the first deploy; a CRLF line still runs and counts
    writeFileSync(crontab, '*/5 * * * * /bin/sh /x/deploy-app.sh # server-use:deploy-app\r\n')
    commit('v2')
    r = run({ SU_RUN: 'echo two >ran' })
    assert.equal(r.code, 0, r.all)
    assert.match(readFileSync(join(state, 'deploy.env'), 'utf8'), /^export SU_RUN='echo two >ran'$/m)
    await until(async () => existsSync(ran()) || 'v2 run has not started', 10_000, 100)
  })

  test('a failed deploy with a changed --run restarts the previous release with its own command', async () => {
    rmSync(ran())
    commit('v3')
    const r = run({ SU_RUN: 'exit 1', SU_HEALTH: 'test -f ran' })
    assert.equal(r.code, 1, r.all)
    assert.match(r.all, /ROLLED BACK/)
    assert.match(readFileSync(join(state, 'run.sh'), 'utf8'), /^echo two >ran$/m)
    assert.equal(readFileSync(join(state, 'service'), 'utf8'), 'job\n')
    await until(async () => existsSync(ran()) || 'the previous release was not restarted with its command', 10_000, 100)
  })

  test('a manual rollback restarts the previous release with its own command', async () => {
    const v1 = readdirSync(join(base, 'releases')).sort()[0]
    rmSync(join(base, 'releases', v1, 'ran'))
    const r = run({ SU_ACTION: 'rollback' })
    assert.equal(r.code, 0, r.all)
    assert.match(r.all, /watch: the pull check skips/)
    assert.match(readFileSync(join(state, 'run.sh'), 'utf8'), /^echo one >ran$/m)
    await until(async () => (existsSync(ran()) && readFileSync(ran(), 'utf8') === 'one\n') || 'v1 was not restarted with its command', 10_000, 100)
  })

  test('after `cron rm deploy-<name>` deploys and rollbacks leave the watch alone, and each release keeps its command', () => {
    rmSync(crontab)
    commit('v4')
    let r = run({ SU_RUN: 'echo four >ran' })
    assert.equal(r.code, 0, r.all)
    assert.doesNotMatch(r.all, /watch:/)
    assert.match(readFileSync(join(state, 'deploy.env'), 'utf8'), /^export SU_RUN='echo two >ran'$/m)
    // v4 -> v2: the single launch.prev slot holds v1's command by now
    r = run({ SU_ACTION: 'rollback' })
    assert.equal(r.code, 0, r.all)
    assert.doesNotMatch(r.all, /watch:/)
    assert.match(readFileSync(join(state, 'run.sh'), 'utf8'), /^echo two >ran$/m)
  })

  test('leaving a compose release (failed health check or rollback) takes its compose project down', () => {
    const log = join(dir, 'docker.log')
    writeFileSync(join(repo, 'compose.yml'), 'services: {}\n')
    commit('v5')
    let r = run({ SU_HEALTH: 'false' })
    assert.equal(r.code, 1, r.all)
    assert.match(r.all, /ROLLED BACK/)
    assert.match(readFileSync(log, 'utf8'), /^compose -p app down$/m)
    rmSync(log)
    commit('v6')
    r = run({})
    assert.equal(r.code, 0, r.all)
    // v6 (compose) -> v4 (job)
    r = run({ SU_ACTION: 'rollback' })
    assert.equal(r.code, 0, r.all)
    assert.match(readFileSync(log, 'utf8'), /^compose -p app down$/m)
    assert.equal(readFileSync(join(state, 'service'), 'utf8'), 'job\n')
  })
})
