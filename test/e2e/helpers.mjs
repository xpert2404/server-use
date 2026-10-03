// Harness for the end-to-end tests: drives the real CLI against the sshd container from test/e2e/Dockerfile.
// Every sandbox has its own SERVER_USE_HOME (so its own daemon and key), file secrets, an empty ~/.ssh and no agent.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOST = process.env.SU_E2E_HOST
export const PORT = process.env.SU_E2E_PORT || '22'
export const skip = HOST ? false : 'SU_E2E_HOST is not set (run the container from test/e2e/Dockerfile)'
export const PW = {
  root: process.env.SU_E2E_ROOT_PASSWORD || 'root-pw',
  alice: process.env.SU_E2E_ALICE_PASSWORD || 'alice-pw',
  bob: process.env.SU_E2E_BOB_PASSWORD || 'bob-pw',
}
/** Unique per test run, for names that must not collide with leftovers of an earlier run on the same container. */
export const RUN = Date.now().toString(36)
export const addr = (/** @type {string} */ user) => `${user}@${HOST}:${PORT}`
export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))
export const repoFile = (/** @type {string} */ p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const BIN = repoFile('bin/server-use.mjs')

/** Poll until check() returns true; anything else it returns describes the last state for the failure message. */
export async function until(/** @type {() => Promise<true | string>} */ check, ms = 30_000, every = 1000) {
  const end = Date.now() + ms
  for (;;) {
    const state = await check()
    if (state === true) return
    if (Date.now() > end) assert.fail(`gave up after ${ms / 1000}s: ${state}`)
    await sleep(every)
  }
}

export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'su-e2e-'))
  const home = join(dir, 'home')
  const sshDir = join(dir, 'ssh')
  mkdirSync(sshDir)
  const env = { ...process.env, SERVER_USE_HOME: home, SERVER_USE_SECRETS: 'file', SERVER_USE_SSH_DIR: sshDir, SSH_AUTH_SOCK: '', SERVER_USE_AGENT: 'e2e' }
  /** @type {string[]} */ const outputs = []

  /** Run `server-use ...args`. Resolves with the exit code; rejects only if the CLI had to be killed. */
  const su = (/** @type {string[]} */ args, { input = '', timeout = 120_000 } = {}) =>
    /** @type {Promise<{code: number, out: string, err: string, all: string}>} */ (new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [BIN, ...args], { env, timeout, maxBuffer: 64 << 20 }, (e, out, err) => {
        outputs.push(out, err)
        if (e && typeof e.code !== 'number') return reject(new Error(`server-use ${args.join(' ')}: ${e.message}\n${out}${err}`))
        resolve({ code: e ? Number(e.code) : 0, out, err, all: out + err })
      })
      child.stdin?.end(input)
    }))

  return {
    home,
    su,

    /** Add a server with the e2e tag; with a password by default (read from stdin like an agent would). */
    async add(/** @type {string} */ name, /** @type {keyof typeof PW} */ user, { password = true } = {}) {
      const args = ['add', name, addr(user), '--tag', 'e2e']
      const r = password ? await su([...args, '--password-stdin'], { input: PW[user] }) : await su(args)
      assert.equal(r.code, 0, r.all)
      return r
    },

    /** Run a script on one target via `exec --script -` and return that host's stdout/stderr exactly. */
    async sh(/** @type {string} */ target, /** @type {string} */ script, /** @type {string[]} */ ...flags) {
      const r = await su(['exec', target, '--script', '-', '--json', ...flags], { input: script })
      let res
      try { res = JSON.parse(r.out).results[0] } catch { assert.fail(`exec on ${target} gave no JSON (exit ${r.code}): ${r.all}`) }
      return { code: r.code, out: res.stdout?.text ?? '', err: res.stderr?.text ?? res.error?.message ?? '' }
    },

    /** Fail if a secret appears in any CLI output of this sandbox or in any state file except secrets.json. */
    assertNoLeak(/** @type {string[]} */ secrets) {
      /** @type {string[]} */ const files = []
      const walk = (/** @type {string} */ d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name))
          else if (e.isFile() && e.name !== 'secrets.json') files.push(join(d, e.name))
        }
      }
      walk(home)
      for (const secret of secrets) {
        for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(secret), `a secret leaked into ${f}`)
        assert.ok(!outputs.some((o) => o.includes(secret)), 'a secret leaked into CLI output')
      }
    },

    async cleanup() {
      await su(['daemon', 'stop'], { timeout: 30_000 }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Exit code of a password-only login from a fresh sandbox (no key anywhere): 0 = accepted, 6 = refused. */
export async function passwordLogin(/** @type {keyof typeof PW} */ user) {
  const p = sandbox()
  try {
    return (await p.su(['add', 'probe', addr(user), '--password-stdin', '--no-install-key'], { input: PW[user] })).code
  } finally {
    await p.cleanup()
  }
}
