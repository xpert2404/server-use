// e2e: git deploys of a repo that lives on the server, run as a systemd unit when the server has systemd and root,
// otherwise as a detached job (the CI container has no systemd),
// health checks with automatic rollback, deploy ls and manual rollback.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { skip, sandbox, until, PW } from './helpers.mjs'

const REPO = '/tmp/su-e2e-repo'
const BASE = '/opt/e2eapp'
const APP = 'python3 -m http.server 18080 --bind 127.0.0.1'
const health = (/** @type {string} */ v) => `curl -fsS http://127.0.0.1:18080/index.html | grep -qx ${v}`

describe('e2e: deploy', { skip }, () => {
  /** @type {ReturnType<typeof sandbox>} */ let s
  /** @type {Record<string, {base: string, release: string, sha: string, service: string}>} */ const deployed = {}
  before(async () => {
    s = sandbox()
    await s.add('e2e-root', 'root')
    // leftovers of an earlier run against the same container
    const r = await s.sh('e2e-root', `[ -f ${BASE}/.server-use/run.pid ] && kill -TERM -"$(cat ${BASE}/.server-use/run.pid)"
rm -rf ${BASE} ${REPO} && mkdir -p ${REPO} && cd ${REPO} && git init -q -b main &&
git config user.email e2e@example.invalid && git config user.name e2e`, '--yes')
    assert.equal(r.code, 0, r.err)
  })
  after(() => s?.cleanup())

  const commit = async (/** @type {string} */ v) => {
    const r = await s.sh('e2e-root', `cd ${REPO} && echo ${v} > index.html && git add index.html && git commit -qm ${v} && git rev-parse HEAD`)
    assert.equal(r.code, 0, r.err)
    return r.out.trim()
  }
  const deploy = async (/** @type {string} */ healthCmd, run = APP) => {
    const r = await s.su(['deploy', 'e2e-root', REPO, '--name', 'e2eapp', '--build', 'true', '--run', run, '--health', healthCmd, '--json'], { timeout: 600_000 })
    let res
    try { res = JSON.parse(r.out).results[0] } catch { assert.fail(`deploy gave no JSON (exit ${r.code}): ${r.all}`) }
    return { code: r.code, res, all: `${res.stdout?.text ?? ''}${res.stderr?.text ?? ''}${res.error?.message ?? ''}` }
  }
  const current = async () => (await s.sh('e2e-root', `readlink ${BASE}/current`)).out.trim().split('/').pop()
  const serves = (/** @type {string} */ v) => until(async () => {
    const r = await s.sh('e2e-root', 'curl -fsS http://127.0.0.1:18080/index.html')
    return r.out === `${v}\n` || `app answers: ${r.out}${r.err}`
  }, 30_000)

  for (const v of ['v1', 'v2']) {
    test(`deploy ${v}: new release, current switched, run as unit or job, health ok`, { timeout: 600_000 }, async () => {
      const sha = await commit(v)
      const { code, res, all } = await deploy(health(v))
      assert.equal(code, 0, all)
      assert.match(res.stdout.text.trimEnd().split('\n').at(-1), /^SU_RESULT base=\S+ release=\S+ sha=\S+ service=\S+$/)
      const d = res.deployed
      assert.equal(d.base, BASE)
      assert.match(d.service, /^(job|server-use-e2eapp\.service)$/)
      assert.ok(d.sha && sha.startsWith(d.sha), `sha ${d.sha} vs ${sha}`)
      assert.equal(await current(), d.release.split('/').pop())
      await serves(v)
      deployed[v] = d
    })
  }

  test('shared/.env is linked into the release and private', async () => {
    const r = await s.sh('e2e-root', `test -f ${BASE}/current/.env && stat -c %a ${BASE}/shared/.env`)
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, '600\n')
  })

  test('deploy with a failing --health rolls back to the previous release', { timeout: 600_000 }, async () => {
    await commit('v3')
    const { code, all } = await deploy('false')
    assert.equal(code, 1, all)
    assert.match(all, /ROLLED BACK/)
    assert.equal(await current(), deployed.v2.release.split('/').pop())
    await serves('v2')
  })

  test('a failed deploy with a changed --run restarts the previous release with its own command', { timeout: 600_000 }, async () => {
    await commit('v3b')
    const { code, all } = await deploy(health('v3b'), 'exit 1')
    assert.equal(code, 1, all)
    assert.match(all, /ROLLED BACK/)
    assert.equal(await current(), deployed.v2.release.split('/').pop())
    await serves('v2')
  })

  test('deploy ls lists the releases with their sha', async () => {
    const r = await s.su(['deploy', 'ls', 'e2e-root', 'e2eapp'])
    assert.equal(r.code, 0, r.all)
    for (const v of ['v1', 'v2']) assert.ok(r.out.includes(deployed[v].sha), `${v} (${deployed[v].sha}) missing:\n${r.out}`)
  })

  test('deploy rollback switches back to v1 and restarts it', { timeout: 300_000 }, async () => {
    const r = await s.su(['deploy', 'rollback', 'e2e-root', 'e2eapp'], { timeout: 300_000 })
    assert.equal(r.code, 0, r.all)
    assert.equal(await current(), deployed.v1.release.split('/').pop())
    await serves('v1')
  })

  test('deploy --watch: the pull check deploys only a new commit, exactly once', { timeout: 900_000 }, async () => {
    const releases = async () => (await s.sh('e2e-root', `ls -1 ${BASE}/releases`)).out.trim().split('\n').filter(Boolean)
    const cycle = async () => {
      const r = await s.su(['cron', 'run', 'e2e-root', 'deploy-e2eapp'], { timeout: 600_000 })
      assert.equal(r.code, 0, r.all)
    }
    const v4 = await commit('v4')
    const r = await s.su(['deploy', 'e2e-root', REPO, '--name', 'e2eapp', '--build', 'true', '--run', APP,
      '--health', 'curl -fsS http://127.0.0.1:18080/index.html', '--watch', '5m'], { timeout: 600_000 })
    assert.equal(r.code, 0, r.all)
    assert.match(r.all, /pull check \*\/5 \* \* \* \* \(cron deploy-e2eapp\)/)
    await serves('v4')
    const after4 = await releases()
    const cur4 = await current()
    assert.ok(v4.startsWith(cur4.split('-')[1]), `${cur4} vs ${v4}`)

    await cycle()
    await cycle()
    assert.deepEqual(await releases(), after4, 'no push: no deploy')
    assert.equal(await current(), cur4)

    const v5 = await commit('v5')
    await cycle()
    await serves('v5')
    const after5 = await releases()
    assert.equal(after5.filter((x) => !after4.includes(x)).length, 1, `one new release: ${after5}`)
    assert.ok(v5.startsWith((await current()).split('-')[1]))
    await cycle()
    assert.deepEqual(await releases(), after5, 'same commit again: no deploy')
    const log = await s.sh('e2e-root', `cat ${BASE}/.server-use/deploy.log`)
    assert.equal(log.out.match(/^=== .* watch: /gm)?.length, 1, log.out)
    assert.match(log.out, new RegExp(`watch: \\S+ -> ${v5}`))
    assert.equal((await s.su(['cron', 'rm', 'e2e-root', 'deploy-e2eapp', '--yes'])).code, 0)
  })

  test('secret leak: the password shows up nowhere', () => {
    s.assertNoLeak([PW.root])
  })
})
