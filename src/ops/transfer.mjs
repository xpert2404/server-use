// @ts-check
// put/get over a plain exec channel (`cat`), so it works wherever a shell works — no SFTP subsystem needed.
// ponytail: single files only; directories go through tar (see skill) or deploy.
import { createReadStream, createWriteStream, statSync, renameSync, rmSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { basename, dirname, join, isAbsolute } from 'node:path'
import * as inventory from '../inventory.mjs'
import { check } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { rawExec, withSudo, fanOut } from './exec.mjs'
import { UsageError, shq } from '../util.mjs'

/** Remote path as shell text; "~/x" is relative to the login directory (the exec cwd). */
const rpath = (/** @type {string} */ p) => shq(p.replace(/^~\/?/, '') || '.')

/**
 * op "put": {targets, local (absolute), remote, mode?, sudo?, yes?}
 * @param {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} ctx @param {any} a
 */
export async function put(ctx, a) {
  if (!isAbsolute(a.local)) throw new UsageError('local path must be absolute')
  let st
  try { st = statSync(a.local) } catch { throw new UsageError(`no such local file: ${a.local}`) }
  if (!st.isFile()) throw new UsageError(`${a.local} is not a file (directories: tar them first, or use deploy)`)
  // Fail here, not after the remote `cat` started waiting for a stdin that never comes.
  try { closeSync(openSync(a.local, 'r')) } catch (e) { throw new UsageError(`cannot read ${a.local}: ${/** @type {any} */ (e).code}`) }
  if (a.mode !== undefined && !/^[0-7]{3,4}$/.test(String(a.mode))) throw new UsageError('mode must be octal like 644')
  const remote = a.remote.endsWith('/') ? a.remote + basename(a.local) : a.remote
  const dst = rpath(remote)
  const inner = [
    // mv would drop the temp file inside the directory.
    `[ -d ${dst} ] && { printf 'put: %s is a directory; end the path with / to upload into it\\n' ${shq(remote)} >&2; exit 1; }`,
    `d=$(dirname -- ${dst}) && mkdir -p -- "$d"`,
    `case ${dst} in /*) D=${dst} ;; *) D=$PWD/${dst} ;; esac`, // absolute: the steps below run in the temp dir
    // In a dir another account can write (an app dir owned by www-data), any by-name step on a temp file there
    // (cat, wc, chmod) can hit a symlink swapped in for it, and root writes or chmods the target. So the file lives
    // in a fresh dir of our own, and the check catches that dir swapped for a symlink before the cd: it must be
    // empty, ours and writable by no one else.
    `t=$(mktemp -d -- ${dst}.su-tmp.XXXXXX) && cd -- "$t" || exit 1`,
    `[ -z "$(ls -A)" ] && [ "$(ls -ldn . | awk '{print substr($1, 6, 1) substr($1, 9, 1) $3}')" = "--$(id -u)" ] || { echo "put: temp dir $t is not private, nothing installed" >&2; exit 1; }`,
    `fail() { rm -f f; cd .. && rmdir -- "\${t##*/}"; exit 1; }`,
    `cat > f || fail`,
    // stdin also ends early when a read error, abort or timeout kills the run but the KILL misses `cat`
    // (sudo, servers without signal support): never install a short file. $((...)) strips BSD wc's blanks.
    `[ $(($(wc -c < f))) -eq ${st.size} ] || { echo 'put: upload incomplete, nothing installed' >&2; fail; }`,
    // An existing dst lends its mode, but not setuid/setgid: a dst planted with them would make the upload setuid root.
    a.mode ? `chmod ${a.mode} f || fail` : `[ -e "$D" ] && chmod "$(stat -c %a "$D" 2>/dev/null || stat -f %Lp "$D")" f 2>/dev/null && chmod ug-s f; true`,
    // ponytail: a dst swapped for a symlink to a dir during the upload gets `f` moved into that dir; GNU-only `mv -T`
    // would close it.
    `mv -f -- f "$D" || fail`,
    `cd .. && rmdir -- "\${t##*/}"`,
    `wc -c < "$D"`,
  ].join('\n')
  const names = inventory.resolveTargets(a.targets)
  const results = await fanOut(names, async (name) => {
    const server = inventory.get(name)
    check(server, 'put', { text: `> ${remote}`, yes: a.yes })
    /** @type {Error | undefined} */ let readErr
    const r = await ctx.pool.with(name, async (conn) => {
      const w = a.sudo ? await withSudo(conn, server, inner) : { command: inner, prefix: '' }
      // A read error stops the remote run instead of leaving `cat` waiting for the rest. Opened sync, so no error
      // can fire before rawExec listens for the abort.
      const ac = new AbortController()
      const rs = createReadStream(a.local, { fd: openSync(a.local, 'r') }).on('error', (e) => { readErr = e; ac.abort() })
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal
      try {
        return await rawExec(conn, { command: w.command, stdinPrefix: w.prefix, stdin: rs, timeoutMs: 60 * 60_000, signal, wrap: /** @type {any} */ (w).wrap })
      } finally { rs.destroy() } // the channel may close before the file is read to the end
    })
    if (readErr) Object.assign(r, { exit: 1, error: { code: 'LOCAL', message: `reading ${a.local} failed: ${readErr.message}` } })
    const bytes = Number(r.stdout.text.trim())
    if (r.exit === 0 && bytes !== st.size) Object.assign(r, { exit: 1, error: { code: 'REMOTE', message: `size mismatch: sent ${st.size}, remote has ${bytes}` } })
    audit({ agent: ctx.agent, op: 'put', host: name, local: a.local, remote, bytes: st.size, exit: r.exit })
    return { host: name, ...r, remote, bytes: st.size }
  })
  return { results }
}

/**
 * op "get": {targets, remote, local (absolute)} — several targets: local is a directory, files become <host>_<name>.
 * @param {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} ctx @param {any} a
 */
export async function get(ctx, a) {
  if (!isAbsolute(a.local)) throw new UsageError('local path must be absolute')
  const names = inventory.resolveTargets(a.targets)
  const many = names.length > 1
  const results = await fanOut(names, async (name) => {
    const server = inventory.get(name)
    check(server, 'get', {})
    let dest = a.local
    if (many) dest = join(a.local, `${name}_${basename(a.remote)}`)
    else if (a.local.endsWith('/') || a.local.endsWith('\\') || isDir(a.local)) dest = join(a.local, basename(a.remote))
    mkdirSync(dirname(dest), { recursive: true })
    const tmp = dest + '.su-part'
    // Private (--sudo gets are often keys and secrets) and exclusive: an existing .su-part, maybe another user's
    // file or a symlink, would keep its own owner and mode. Sync, so a refusal is this host's error.
    rmSync(tmp, { force: true })
    const sink = createWriteStream(tmp, { fd: openSync(tmp, 'wx', 0o600) })
    const inner = `cat -- ${rpath(a.remote)}`
    let r
    try {
      r = await ctx.pool.with(name, async (conn) => {
        const w = a.sudo ? await withSudo(conn, server, inner) : { command: inner, prefix: '' }
        return rawExec(conn, { command: w.command, stdin: w.prefix || null, sink, timeoutMs: 60 * 60_000, signal: ctx.signal, wrap: /** @type {any} */ (w).wrap })
      })
    } catch (e) { // unreachable, auth, no sudo password...: the daemon lives on, so don't keep the fd or the file
      sink.destroy()
      rmSync(tmp, { force: true })
      throw e
    }
    await new Promise((res) => sink.end(res))
    if (r.exit === 0) renameSync(tmp, dest)
    else rmSync(tmp, { force: true })
    const bytes = r.exit === 0 ? statSync(dest).size : 0
    audit({ agent: ctx.agent, op: 'get', host: name, remote: a.remote, local: dest, bytes, exit: r.exit })
    return { host: name, ...r, local: dest, bytes }
  })
  return { results }
}

function isDir(/** @type {string} */ p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

