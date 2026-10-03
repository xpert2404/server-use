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
