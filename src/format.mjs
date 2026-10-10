// @ts-check
// Agent-friendly text for results, shared by the CLI and the MCP server.
import { EXIT } from './util.mjs'

/**
 * Per-host blocks: "── host · exit 0 · 0.18s", then stdout, then [stderr]. Several hosts get a summary line.
 * @param {any[]} list @param {{raw?: boolean}} [o]
 * @returns {{text: string, code: number}}
 */
export function formatResults(list, o = {}) {
  if (o.raw && list.length === 1 && !list[0].error) return { text: list[0].stdout?.text || '', code: worst(list) }
  const out = []
  for (const r of list) {
    if (r.error && (r.exit === null || r.exit === undefined)) { out.push(`── ${r.host} · ${r.error.code}: ${r.error.message}`); continue }
    const cut = [r.stdout?.log && `full stdout: ${r.stdout.log}`, r.stderr?.log && `full stderr: ${r.stderr.log}`].filter(Boolean).join(' · ')
    out.push(`── ${r.host} · exit ${r.exit}${r.ms !== undefined ? ` · ${(r.ms / 1000).toFixed(2)}s` : ''}${cut ? ` · ${cut}` : ''}`)
    if (r.error) out.push(`${r.error.code}: ${r.error.message}`)
    if (r.stdout?.text) out.push(r.stdout.text.replace(/\n$/, ''))
    if (r.stderr?.text?.trim()) out.push(`[stderr]\n${r.stderr.text.replace(/\n$/, '')}`)
  }
  if (list.length > 1) {
    const bad = list.filter((r) => r.error || r.exit !== 0).map((r) => r.host)
    out.push(`${list.length - bad.length} ok${bad.length ? ` · ${bad.length} failed (${bad.join(', ')})` : ''}`)
  }
  return { text: out.join('\n') + (out.length ? '\n' : ''), code: worst(list) }
}

/** One line per server for `status`. */
export function formatStatus(/** @type {any[]} */ list) {
  const w = Math.max(0, ...list.map((x) => x.host.length))
  const text = list.map((x) => x.error
    ? `✗ ${x.host.padEnd(w)}  ${x.error.code}: ${x.error.message}`
    : x.exit !== 0 ? `✗ ${x.host.padEnd(w)}  status script failed (exit ${x.exit}) ${x.stderr?.text?.trim() || ''}`
      : `${x.ok ? '✓' : '!'} ${x.host.padEnd(w)}  ${x.line}`).join('\n') + '\n'
  return { text, code: worst(list) }
}

/** First failing host decides the exit status. */
export function worst(/** @type {any[]} */ list) {
  for (const r of list) {
    if (r.error && (r.exit === null || r.exit === undefined || r.error.code === 'TIMEOUT')) return EXIT[/** @type {keyof EXIT} */ (r.error.code)] ?? 1
    if (r.exit) return Math.min(r.exit, 255)
  }
  return 0
}

export function table(/** @type {string[][]} */ rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)))
  return rows.map((r) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n')
}

/** op "servers.import" → what `import` and the MCP `servers(import)` print: one line per Host entry, warnings, hint. */
export function formatImport(/** @type {any} */ r) {
  const key = (/** @type {any} */ s) => {
    if (!s.key) return ''
    const st = s.keyStatus
    return `  key ${s.key}${st ? ` (${!st.exists ? 'file missing' : st.encrypted ? 'encrypted: needs ssh-agent or a passphrase' : st.type || 'found'})` : ''}`
  }
  const rows = r.servers.map((/** @type {any} */ s) => `  ${s.action.padEnd(18)} ${s.name}  ${s.user}@${s.host}:${s.port}${s.userDefaulted ? ' (no User in the config: default user)' : ''}${key(s)}`)
  return [`from ${r.path}:`, ...(rows.length ? rows : ['  no Host entries found']), ...(r.warnings || []).map((/** @type {string} */ w) => `warning: ${w}`), r.hint].filter(Boolean).join('\n')
}

/**
 * op "servers.keys" → private keys found on this machine (metadata only, never contents) and the ssh-agent.
 * `next` is the caller's wording of what to do with them (CLI verbs or MCP actions).
 */
export function formatKeys(/** @type {any} */ r, /** @type {string} */ next) {
  const keys = r.keys || []
  const agent = r.agent || {}
  const note = (/** @type {any} */ k) => [k.source === 'server-use' ? "server-use's own key" : k.source === 'inventory' ? 'named by the inventory' : '', k.usable === false ? 'not usable' : '', k.note].filter(Boolean).join('; ')
  const out = [`ssh dir: ${r.sshDir}`]
  out.push(keys.length
    ? table([['KEY', 'TYPE', 'ENCRYPTED', 'FINGERPRINT', 'USED BY', 'NOTE'], ...keys.map((/** @type {any} */ k) => [k.path, k.type || k.format, k.encrypted ? 'yes' : 'no', k.fingerprint || '-', (k.usedBy || []).join(',') || '-', note(k)])])
    : 'no private keys found')
  const ids = agent.identities || []
  out.push(!agent.configured ? 'ssh-agent: not configured'
    : !agent.reachable ? `ssh-agent: ${agent.path || 'configured'} is not reachable`
      : `ssh-agent: ${ids.length} identit${ids.length === 1 ? 'y' : 'ies'}${ids.map((/** @type {any} */ i) => `\n  ${i.type} ${i.fingerprint} ${i.comment || ''}`.trimEnd()).join('')}`)
  if (keys.some((/** @type {any} */ k) => k.encrypted)) out.push('hint: an encrypted key needs its passphrase: load it into ssh-agent, or let the user enter it locally (a masked prompt of the host, or server-use add --ask-passphrase). Never ask for it in chat.')
  if (!keys.some((/** @type {any} */ k) => k.usable !== false) && !ids.length) out.push('hint: no usable key. Create one in your own terminal (ssh-keygen -t ed25519), or onboard with a password locally (server-use add <name> <user@host> --ask): server-use then installs its own key.')
  if (next) out.push(`next: ${next}`)
  return out.join('\n')
}

/** op "audit.tail" → one line per entry. */
export function formatAudit(/** @type {any[]} */ entries) {
  return entries.map((e) => `${e.ts.slice(0, 19).replace('T', ' ')} ${String(e.agent).padEnd(11)} ${String(e.op).padEnd(14)} ${e.host || ''} ${e.cmd ? JSON.stringify(e.cmd) : ''}${e.exit !== undefined ? ` exit ${e.exit}` : ''}`).join('\n') || 'nothing yet'
}
