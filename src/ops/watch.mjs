// @ts-check
// Watch installs a self-contained check plus a managed cron entry. Secret-bearing values travel on SSH stdin.
import { randomBytes } from 'node:crypto'
import * as inventory from '../inventory.mjs'
import { check as policy } from '../guard.mjs'
import { audit } from '../audit.mjs'
import { runScript, scriptSource, b64 } from '../remote.mjs'
import { fanOut } from './exec.mjs'
import { parseDuration, UsageError } from '../util.mjs'

/** Validate URLs without including their potentially secret text in an error. */
export function watchUrl(/** @type {string} */ text) {
  try {
    const u = new URL(text)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || /[\x00-\x20\x7f"\\]/.test(text)) throw new Error()
    return text
  } catch { throw new UsageError('watch URLs must be HTTP(S), without credentials, whitespace, quotes or backslashes') }
}

/** Validate before resolving targets or changing anything; returned values are only streamed to the server. */
export function watchSettings(/** @type {any} */ a) {
  const every = parseDuration(a.every ?? '5m')
  if (every < 60_000 || every > 3_600_000 || every % 60_000 !== 0 || 60 % (every / 60_000) !== 0) throw new UsageError('watch --every must divide one hour in whole minutes (1m, 2m, 3m, 4m, 5m, 6m, 10m, 12m, 15m, 20m, 30m, 1h)')
  if (a.secret !== undefined && (typeof a.secret !== 'string' || /[\x00-\x1f\x7f]/.test(a.secret))) throw new UsageError('watch secret must be a single line without control characters')
  if (a.notify !== undefined && typeof a.notify !== 'string') throw new UsageError('watch --notify must be a provider string')
  const notify = a.notify || 'ntfy'
  let mode, endpoint, chat = ''
  if (notify === 'ntfy') { mode = 'ntfy'; endpoint = `https://ntfy.sh/server-use-${randomBytes(18).toString('hex')}` }
  else if (notify.startsWith('ntfy:')) { mode = 'ntfy'; endpoint = watchUrl(notify.slice(5)) }
  else if (notify.startsWith('webhook:')) { mode = 'webhook'; endpoint = watchUrl(notify.slice(8)) }
  else if (notify.startsWith('telegram:')) {
    mode = 'telegram'; chat = notify.slice(9)
    if (!/^-?\d{1,24}$/.test(chat) || !/^\d+:[A-Za-z0-9_-]+$/.test(a.secret || '')) throw new UsageError('Telegram needs telegram:<numeric chat_id> and a bot token supplied on stdin')
    endpoint = 'https://api.telegram.org'
  } else throw new UsageError('watch --notify accepts ntfy, ntfy:<url>, telegram:<chat_id> or webhook:<url>')
  if (a.urls !== undefined && !Array.isArray(a.urls)) throw new UsageError('watch HTTP probes must be an array of URLs')
  const urls = (a.urls || []).map((/** @type {string} */ text) => {
    if (typeof text !== 'string') throw new UsageError('watch HTTP probes must be URL strings')
    const m = /^(.*)=([1-5]\d\d)$/.exec(text)
    return `${m ? m[2] : 'ok'}|${watchUrl(m ? m[1] : text)}`
  })
  if (urls.length > 20) throw new UsageError('watch supports at most 20 HTTP probes')
  return { mode, endpoint, chat, every: every / 1000, schedule: every === 3_600_000 ? '0 * * * *' : `*/${every / 60_000} * * * *`, urls: urls.join('\n'), heartbeat: a.heartbeat ? watchUrl(a.heartbeat) : '' }
}

/** @param {{pool: import('../pool.mjs').Pool, agent: string, signal?: AbortSignal, runId: string}} ctx @param {any} a */
export async function watch(ctx, a) {
  const sub = a.sub || a.action
  if (!['on', 'off', 'ls', 'test', 'mute'].includes(sub)) throw new UsageError('watch action: on | off | ls | test | mute')
  const settings = sub === 'on' ? watchSettings(a) : undefined
  let until
  if (sub === 'mute') {
    if (typeof a.key !== 'string' || !/^(all|[a-z][a-z0-9_-]*:[^|\r\n\x00-\x1f]{1,200})$/.test(a.key)) throw new UsageError('watch mute needs all or kind:id')
    const duration = parseDuration(a.for ?? '2h')
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > 365 * 86_400_000) throw new UsageError('watch mute duration must be between 0 and 365 days')
    until = duration ? Math.ceil(duration / 1000) : 0
  }
  const names = inventory.resolveTargets(a.targets || a.target)
  const results = await fanOut(names, async (name) => {
    const server = inventory.get(name)
    policy(server, `watch.${sub}`, { yes: a.yes, always: sub === 'ls' ? undefined : `watch ${sub}` })
    const r = await runScript(ctx, name, 'watch', {
      SU_ACTION: sub, SU_LABEL: name, SU_CHECK: server.check || '', SU_SECRET: settings ? a.secret || '' : undefined,
      SU_MODE: settings?.mode, SU_ENDPOINT: settings?.endpoint, SU_CHAT: settings?.chat, SU_EVERY: settings?.every,
      SU_SCHEDULE: settings?.schedule, SU_URLS_B64: settings ? b64(settings.urls) : undefined, SU_HEARTBEAT: settings?.heartbeat,
      SU_WATCH_B64: settings ? b64(scriptSource('watch')) : undefined, SU_CHECK_B64: settings ? b64(scriptSource('check')) : undefined,
      SU_CRON_B64: ['on', 'off'].includes(sub) ? b64(scriptSource('cron')) : undefined, SU_MUTE_KEY: a.key, SU_MUTE_FOR: until,
    }, { timeoutMs: 120_000 })
    // Deliberately do not audit endpoints, probes, heartbeat URLs, payloads or provider credentials.
    audit({ agent: ctx.agent, op: `watch.${sub}`, host: name, exit: r.exit })
    return { host: name, ...r }
  })
  return { results }
}
