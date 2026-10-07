// @ts-check
// Per-server policy. "confirm" stops commands that look destructive until the caller passes yes=true
// (the skills tell the agent to ask the user first). This is a speed bump, NOT a security boundary:
// the real boundaries are the host agent's approval prompt and a low-privilege user on the server.
import { SuError } from './util.mjs'

/** @type {[RegExp, string][]} */
const DESTRUCTIVE = [
  [/\brm\s+(?:-{1,2}[\w-]+\s+)*-{1,2}(?:[a-zA-Z]*[rRf][a-zA-Z]*|recursive|force)\b/, 'rm -r/-f'],
  [/\b(?:mkfs(?:\.\w+)?|wipefs|fdisk|sfdisk|parted|mkswap)\b/, 'disk formatting'],
  [/\bdd\b[^\n;|&]*\bof=/, 'dd of='],
  [/\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/, 'shutdown/reboot'],
  [/\bsystemctl\s+(?:--\S+\s+)*(?:stop|disable|mask|kill|isolate|poweroff|reboot|halt)\b/, 'systemctl stop/disable'],
  [/\bdocker(?:-compose|\s+compose)?\b[^\n;|&]*\b(?:rm|rmi|kill|down|prune)\b/, 'docker rm/down/prune'],
  [/\b(?:drop|truncate)\s+(?:table|database|schema|index)\b/i, 'SQL drop/truncate'],
  [/\bdelete\s+from\b/i, 'SQL delete'],
  [/\b(?:ufw|iptables|ip6tables|nft|firewall-cmd)\b/, 'firewall change'],
  [/\bcrontab\s+(?:-\w+\s+)*-r\b/, 'crontab -r'],
  [/\b(?:userdel|deluser|groupdel|passwd|chpasswd|usermod)\b/, 'user/password change'],
  [/\bchmod\s+(?:-\w+\s+)*[0-7]?777\b|\bch(?:own|mod)\s+-R\b[^\n;|&]*\s\/(?:\s|$)/, 'recursive chmod/chown'],
  [/>\s*\/dev\/(?:sd|nvme|vd|xvd|mmcblk)/, 'write to block device'],
  [/>\s*\/etc\//, 'overwrite /etc'],
  [/\b(?:killall|pkill)\b|\bkill\s+-(?:9|KILL)\b/, 'kill processes'],
  [/:\(\)\s*\{/, 'fork bomb'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|push\b[^\n;|&]*(?:--force|-f\b))/, 'git reset/clean/force-push'],
  [/\b(?:apt(?:-get)?|aptitude)\s+(?:-\S+\s+)*(?:remove|purge|autoremove)\b|\b(?:yum|dnf|zypper)\s+(?:remove|erase)\b|\bapk\s+del\b|\bpacman\s+-R/, 'package removal'],
  [/\bmv\b[^\n;|&]*\s\/(?:etc|usr|bin|sbin|boot|lib|lib64|var)(?:\/|\s|$)/, 'move system directory'],
]

/** @returns {string | null} what matched */
export function destructive(/** @type {string | undefined} */ text) {
  if (!text) return null
  for (const [re, label] of DESTRUCTIVE) if (re.test(text)) return label
  return null
}

/** Operations that only read. Everything else writes. */
export const READ_OPS = new Set(['status', 'logs', 'get', 'facts', 'cron.ls', 'cron.logs', 'job.ls', 'job.logs', 'job.status', 'job.wait', 'env.ls', 'deploy.ls', 'check', 'doctor', 'watch.ls'])

/**
 * Throws CONFIRM / READONLY when the server's policy forbids the operation.
 * @param {{name: string, policy?: string}} server
 * @param {string} op
 * @param {{text?: string, yes?: boolean, always?: string}} what  `always` = op is risky regardless of text
 */
export function check(server, op, { text, yes, always } = {}) {
  const policy = server.policy || 'confirm'
  if (policy === 'readonly' && !READ_OPS.has(op)) {
    throw new SuError('READONLY', `${server.name} is readonly — "${op}" is not allowed (change with: server-use set ${server.name} policy=confirm)`)
  }
  if (policy === 'open' || yes) return
  const hit = always || destructive(text)
  if (hit) {
    throw new SuError('CONFIRM', `${server.name} (policy confirm): "${hit}" needs confirmation. Ask the user, then repeat with --yes.`, { match: hit })
  }
}
