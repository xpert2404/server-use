// @ts-check
// Text for `server-use check`, shared by the CLI and the MCP server. Loads nothing (the CLI starts fast).
// Next to format.mjs on purpose: this is the only place that knows which command follows which kind of finding.

/** The command that goes with a finding, or '' when there is none. */
export function hint(/** @type {string} */ host, /** @type {{kind: string, id: string}} */ i) {
  switch (i.kind) {
    case 'disk': case 'inodes': case 'mem': case 'oom': case 'unit': case 'container': case 'cert': return `server-use doctor ${host}`
    case 'cron': return `server-use cron logs ${host} ${i.id}`
    case 'job': return `server-use job logs ${host} ${i.id}`
    case 'deploy': return `server-use deploy ls ${host} ${i.id}`
    case 'connect': return `server-use show ${host}`
    case 'ssh': return `server-use harden ${host} --lock-password`
    case 'watch': return `server-use watch ls ${host}`
    case 'backup': return `server-use doctor ${host}`
    default: return ''
  }
}

const stamp = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 16) + 'Z'
const label = (/** @type {{kind: string, id: string}} */ i) => (i.kind === 'connect' ? 'unreachable' : i.id ? `${i.kind} ${i.id}` : i.kind)
const plural = (/** @type {number} */ n) => `${n} ${n === 1 ? 'server' : 'servers'}`

/**
 * What `check` prints. Healthy fleet: one line. Otherwise one block per affected server, worst first, and a last
 * line for the rest. With changed and nothing new or resolved: one line naming what is still open.
 * @param {{results: any[], changed?: boolean, code: number}} r  the "check" op's result
 */
export function formatCheck(r) {
  const res = r.results
  const open = (/** @type {any} */ x) => x.items.filter((/** @type {any} */ i) => i.sev !== 'info')
  const affected = res.filter((/** @type {any} */ x) => open(x).length)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(open(b).some((/** @type {any} */ i) => i.sev === 'crit')) - Number(open(a).some((/** @type {any} */ i) => i.sev === 'crit')))
  if (r.changed && r.code === 0 && affected.length) {
    const list = affected.flatMap((/** @type {any} */ x) => open(x).map((/** @type {any} */ i) => `${x.host} ${i.text}`)).join('; ')
    return `no change since the last check · still open: ${list.length > 300 ? list.slice(0, 300) + '…' : list}\n`
  }
  const w = Math.max(0, ...affected.map((/** @type {any} */ x) => x.host.length))
  /** @type {string[]} */ const lines = []
  for (const x of affected) {
    /** @type {string[]} */ const body = open(x)
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.sev === b.sev ? 0 : a.sev === 'crit' ? -1 : 1))
      .map((/** @type {any} */ i) => {
        const h = hint(x.host, i)
        return `${i.sev.toUpperCase()} ${i.text}${i.state === 'new' ? ' (new)' : ''}${h ? ` → ${h}` : ''}`
      })
    const info = x.items.filter((/** @type {any} */ i) => i.sev === 'info').map((/** @type {any} */ i) => `info ${i.text}`)
    if (info.length) body.push(info.join(' · '))
    if (x.partial.length) body.push(`not checked: ${x.partial.map((/** @type {any} */ p) => p.probe).join(', ')} (try --sudo; reasons in --json)`)
    const mark = open(x).some((/** @type {any} */ i) => i.sev === 'crit') ? '✗' : '!'
    body.forEach((l, k) => lines.push(`${k ? ' '.repeat(w + 4) : `${mark} ${x.host.padEnd(w)}  `}${l}`))
  }
  const rest = res.filter((/** @type {any} */ x) => !affected.includes(x))
  /** @type {string[]} */ const tail = []
  if (rest.length) tail.push(affected.length ? `${rest.length} other ${rest.length === 1 ? 'server' : 'servers'} ok` : `all ${plural(rest.length)} ok`)
  const resolved = res.flatMap((/** @type {any} */ x) => x.resolved.map((/** @type {any} */ i) => `${x.host} ${label(i)} (since ${stamp(i.since)})`))
  if (resolved.length) tail.push(`resolved: ${resolved.join(', ')}`)
  const blind = rest.filter((/** @type {any} */ x) => x.partial.length).map((/** @type {any} */ x) => `${x.host} ${x.partial.map((/** @type {any} */ p) => p.probe).join(',')}`)
  if (blind.length) tail.push(`not checked: ${blind.join('; ')} (try --sudo)`)
  const info = rest.filter((/** @type {any} */ x) => x.items.length).map((/** @type {any} */ x) => `${x.host} (${x.items.map((/** @type {any} */ i) => i.text).join(', ')})`)
  if (info.length) tail.push(`info: ${info.join(', ')}`)
  if (tail.length) lines.push(tail.join(' · '))
  return lines.join('\n') + '\n'
}
