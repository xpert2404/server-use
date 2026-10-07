// @ts-check
// One read-only remote snapshot, ranked locally. Missing probes remain visible.
import * as inventory from '../inventory.mjs'
import { check } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { runScript } from '../remote.mjs'
import { fanOut } from './exec.mjs'
import { parseDuration, UsageError } from '../util.mjs'

export function redact(text) {
  return String(text).replace(/:\/\/[^\s/@]+@/g, '://***@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?)['"]?\s*[=:]\s*)(?:"(?:\\.|[^"\\\r\n])*(?:"|$)|'(?:\\.|[^'\\\r\n])*(?:'|$))/gim, '$1***')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?)['"]?\s*[=:]\s*['"]?)[^\s'",;&)}]+/gi, '$1***')
    .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|AKIA[A-Z0-9]{16}|xox[abprs]-[\w-]{10,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '***')
}

/** Decode the tab-separated snapshot without trusting text as code. */
export function parseDoctor(text) {
  /** @type {Record<string, string[]>} */ const sections = {}
  let section = ''
  for (const line of redact(text).split('\n')) {
    const head = /^== ([a-z_]+)$/.exec(line)
    if (head) { section = head[1]; sections[section] ||= []; continue }
    if (section && line) sections[section].push(line)
  }
  /** @type {Record<string,string>} */ const meta = {}
  for (const line of sections.meta || []) { const i = line.indexOf('='); if (i > 0) meta[line.slice(0, i)] = line.slice(i + 1) }
  if (!Number.isFinite(Number(meta.now)) || !meta.now || !meta.user) throw new UsageError('doctor returned an incomplete snapshot')
  /** @type {Record<string,string>} */ const host = {}
  for (const line of sections.host || []) { const i = line.indexOf('='); if (i > 0) host[line.slice(0, i)] = line.slice(i + 1) }
  /** @type {any[]} */ const findings = []
  const add = (severity, title, evidence, next) => findings.push({ severity, title, evidence, next })
  for (const line of sections.disk || []) {
    const [kind, mount, size, avail, used, inodes] = line.split('\t')
    if (kind !== 'disk') continue
    if (Number(used) >= 85) add(Number(used) >= 95 ? 'crit' : 'warn', `Disk ${mount} ${used}% full`, `${avail} KiB available of ${size} KiB`, `df -h; du -xhd1 ${quote(mount)}`)
    if (inodes && Number(inodes) >= 85) add(Number(inodes) >= 95 ? 'crit' : 'warn', `Inodes ${mount} ${inodes}% used`, 'New files may fail even with free disk space', 'df -i')
  }
  const mem = Number(host.mem_total_kb) ? Math.round(100 * (1 - Number(host.mem_avail_kb) / Number(host.mem_total_kb))) : 0
  if (mem >= 90) add(mem >= 98 ? 'crit' : 'warn', `Memory ${mem}% used`, `${host.mem_avail_kb} KiB available; swap ${host.swap_free_kb || '?'} KiB free`, 'free -m; ps -eo rss,comm --sort=-rss')
  const load = Number((host.load || '').split(' ')[0]), cpus = Number(host.cpus)
  if (cpus > 0 && load > cpus * 2) add('warn', `Load ${load} on ${cpus} CPUs`, `I/O wait ${host.iowait || '?'}%; memory pressure ${host.psi_memory || '?'}%`, 'vmstat 1 5')
  for (const line of sections.oom || []) { const [k, ts, process] = line.split('\t'); if (k === 'oom') add('crit', `OOM killed ${process}`, `Kernel event at epoch ${ts}`, 'journalctl -k --since "2 hours ago"') }
  for (const line of sections.units || []) {
    const [k, unit, count, state] = line.split('\t')
    if (k === 'failed') add('crit', `Failed unit ${unit}`, (sections.units || []).filter(x => x.startsWith(`unitlog\t${unit}\t`)).map(x => x.split('\t').slice(2).join('\t')).join('; ') || 'systemd reports failed', `journalctl -u ${quote(unit)} -n 50`)
    if (k === 'restart') add('warn', `Unit ${unit} restarting`, `${count} restarts; ${state}`, `journalctl -u ${quote(unit)} -n 50`)
  }
  for (const line of sections.containers || []) {
    const [k, name, state, exit, oom, restarts, started, finished, health] = line.split('\t')
    if (k !== 'ctr') continue
    if (oom === 'true' || state === 'dead' || state === 'restarting' || health === 'unhealthy' || (state === 'exited' && Number(exit) !== 0)) add('crit', `Container ${name} ${state}${health === 'unhealthy' ? ', unhealthy' : ''}`, `exit ${exit}; OOM ${oom}; restarts ${restarts}; started ${started}; finished ${finished}`, `docker logs --tail 100 ${quote(name)}`)
    else if (Number(restarts) > 0) add('warn', `Container ${name} restarted ${restarts} times`, `state ${state}; started ${started}`, `docker logs --tail 100 ${quote(name)}`)
  }
  for (const line of sections.errors || []) {
    const [k, count, source, first, last, signature, mode] = line.split('\t')
    if (k === 'err') add('warn', `${count} errors from ${source}${mode === 'file' ? ' (recent file tail)' : ''}`, `${signature} (${first || '?'} to ${last || '?'})${mode === 'file' ? '; recently modified file tail may include older entries' : ''}`, 'Inspect this source with server-use logs')
  }
  for (const line of sections.cron || []) {
    const [k, name, detail, finished] = line.split('\t')
    if (k === 'jobexit' && Number(detail)) add('warn', `Job ${name} exited ${detail}`, finished || 'Recent job failure', `server-use job logs <target> ${quote(name)}`)
    if (k === 'cronrun' && / exit [1-9]\d*$/.test(detail)) add('warn', `Cron ${name} failed`, detail, `server-use cron logs <target> ${quote(name)}`)
  }
  for (const line of sections.certs || []) { const [k, name, state, days] = line.split('\t'); if (k === 'cert' && state !== 'ok') add(state === 'expired' || state === 'lt3d' ? 'crit' : 'warn', `Certificate ${name} ${state}`, `${days || '?'} days remaining`, 'Inspect certificate renewal service and its logs') }
  if ((sections.ntp || []).includes('ntp_sync=no')) add('warn', 'Clock is not synchronized', 'timedatectl NTPSynchronized=no', 'timedatectl status')
  if (meta.reboot_required === 'yes') add('info', 'Reboot required', 'Package manager set /var/run/reboot-required', 'Plan a reboot with the user')
  const rank = { crit: 0, warn: 1, info: 2 }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity])
  const since = Number(meta.now) - Number(meta.since_min || 120) * 60
  const timestamp = stamp => {
    if (/^\d{10,}$/.test(stamp)) return Number(stamp)
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? stamp : stamp + (meta.tz || '+0000')
    return Date.parse(zoned) / 1000
  }
  const changes = (sections.changes || []).filter(line => {
    const [kind, stamp, value] = line.split('\t')
    if (kind === 'file') return Number(stamp) >= since
    if (kind === 'pkg' || kind === 'created') return timestamp(stamp) >= since
    if (kind === 'release') { const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(value || ''); return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) / 1000 >= since : false }
    return false
  }).map(line => line.split('\t').join(' · '))
  return { meta, findings, changes, partial: (sections.partial || []).map(line => line.replace('\t', ': ')), sections }
}

const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`

export function formatDoctor(data) {
  const lines = [`Incident snapshot: ${data.meta.hostname || data.meta.user} · last ${data.meta.since_min || 120}m`]
  if (!data.findings.length) lines.push('No incident findings in the available probes.')
  for (const f of data.findings) lines.push(`${f.severity.toUpperCase()} ${f.title}`, `  ${f.evidence}`, `  Next: ${f.next}`)
  if (data.changes.length) lines.push('Recent changes:', ...data.changes.map(x => `  ${x}`))
  if (data.partial.length) lines.push('Unavailable probes:', ...data.partial.map(x => `  ${x}`))
  return lines.join('\n') + '\n'
}

export async function doctor(ctx, a, deps = {}) {
  const duration = parseDuration(a.since || '2h')
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400_000) throw new UsageError('doctor --since must be between 1s and 7d')
  const results = await fanOut(inventory.resolveTargets(a.targets || a.target || 'all'), async host => {
    check(inventory.get(host), 'doctor')
    const r = await (deps.run || runScript)(ctx, host, 'doctor', { SU_SINCE_MIN: Math.max(1, Math.ceil(duration / 60_000)), SU_DEEP: a.deep ? 1 : 0 }, { sudo: a.sudo, timeoutMs: a.deep ? 300_000 : 120_000, full: true })
    if (r.exit !== 0 || r.error) return { host, ...r }
    const data = parseDoctor(r.stdout.text)
    audit({ agent: ctx.agent, op: 'doctor', host, findings: data.findings.length })
    return { host, ...r, data, stdout: { ...r.stdout, text: formatDoctor(data) } }
  })
  return { results }
}
