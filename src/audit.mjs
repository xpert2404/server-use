// @ts-check
// Append-only operation log. Dedicated credential channels are excluded; commands must not embed secrets.
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { file, ensureHome } from './paths.mjs'

export function audit(/** @type {Record<string, unknown>} */ rec) {
  ensureHome()
  const line = { ts: new Date().toISOString(), ...rec }
  if (typeof line.cmd === 'string' && line.cmd.length > 1000) line.cmd = line.cmd.slice(0, 1000) + '…'
  appendFileSync(file('audit.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 })
}

export function tail(n = 20) {
  const p = file('audit.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l))
}
