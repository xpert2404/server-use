# check.sh — what needs attention on this server? Read-only: writes nothing, uses no network.
# SU_CHECK (optional) holds words like  disk=95 inodes=95 mem=98 cert=7 skip=updates,ssh
#   disk, inodes, mem = warn threshold in % (disk and inodes turn crit 5 points higher); cert = warn within N days
#   (crit within 3); skip = kinds to leave out (disk also skips inodes).
# stdout, one finding per line:  item=<crit|warn|info>|<kind>|<id>|<text>   partial=<kind>:<reason>   now=<epoch>
# partial = that probe could not look (no rights, tool missing): the absence of its items then means nothing.
# No heredocs or temp files, so it works on a full disk. Every probe that can hang runs through t().
# Everything lives in functions and main runs with stdin from /dev/null: no child can swallow the script.
set -u
export LC_ALL=C
PATH=$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin
SU_DIR="$HOME/.server-use"

has() { command -v "$1" >/dev/null 2>&1; }
t() { if has timeout; then timeout 10 "$@"; else "$@"; fi; }
# findings are one line of | separated fields: control characters and | in a value become spaces
clean() { printf '%s' "$1" | tr '\001-\037' ' ' | tr '|' ' ' | cut -c1-200; }
item() { printf 'item=%s|%s|%s|%s\n' "$1" "$2" "$(clean "$3")" "$(clean "$4")"; }
part() { printf 'partial=%s:%s\n' "$1" "$(clean "$2")"; }
# is this kind switched off?
off() { case $skip in *,"$1",*) return 0 ;; esac; return 1; }
# within the last 24 h (find -mmin works on GNU and busybox)
recent() { [ -n "$(find "$1" -mmin -1440 2>/dev/null)" ]; }

settings() {
  w_disk=90 w_inodes=90 w_mem=95 w_cert=14 skip=, backups=
  local w v n
  set -f
  for w in ${SU_CHECK:-}; do
    v=${w#*=} n=
    case $v in '' | *[!0-9]*) ;; *) n=$v ;; esac
    case $w in
      disk=*) [ -z "$n" ] || w_disk=$n ;;
      inodes=*) [ -z "$n" ] || w_inodes=$n ;;
      mem=*) [ -z "$n" ] || w_mem=$n ;;
      cert=*) [ -z "$n" ] || w_cert=$n ;;
      skip=*) skip=$skip$v, ;;
      backup=*) backups="$backups $v" ;;
    esac
  done
  set +f
}

# $1 kind (disk|inodes), $2 df flag, $3 warn %. Virtual file systems and mounts of other kernels' views are left out;
# overlay only as the root of a container; several mounts of one device (bind mounts) count once, under the shortest path.
usage() {
  if off "$1" || off disk; then return 0; fi
  local out
  out=$(t df "$2" 2>/dev/null)
  if [ -z "$out" ]; then part "$1" "df failed"; return 0; fi
  printf '%s\n' "$out" | awk -v warn="$3" '
    NR > 1 {
      for (i = 3; i <= NF; i++) if ($i ~ /^[0-9]+%$/) break
      if (i > NF) next
      m = $(i + 1); for (j = i + 2; j <= NF; j++) m = m " " $j
      d = $1
      if (d ~ /^(tmpfs|devtmpfs|squashfs|ramfs|devfs|efivarfs)$/) next
      if (d == "overlay" && m != "/") next
      if (m ~ /^\/(dev|proc|sys|run|snap)(\/|$)/) next
      gsub(/\|/, " ", m)
      if (!(d in mp)) order[++n] = d
      if (!(d in mp) || length(m) < length(mp[d])) { mp[d] = m; pc[d] = $i + 0 }
    }
    END {
      crit = warn + 5; if (crit > 100) crit = 100
      for (k = 1; k <= n; k++) {
        d = order[k]; p = pc[d]
        if (p >= crit) print "crit|" mp[d] "|" p
        else if (p >= warn) print "warn|" mp[d] "|" p
      }
    }' | while IFS='|' read -r sev id p; do
    item "$sev" "$1" "$id" "$1 $id ${p}% used"
  done
}

p_mem() {
  off mem && return 0
  local pct
  # MemAvailable (kernels before 3.14: free + buffers + cached), as status.sh
  pct=$(awk '/^MemTotal:/ {t = $2} /^MemAvailable:/ {a = $2; have = 1} /^(MemFree|Buffers|Cached):/ {f += $2}
    END {if (!have) a = f; if (t) printf "%d", (t - a) * 100 / t + 0.5}' /proc/meminfo 2>/dev/null)
  case $pct in '' | *[!0-9]*) part mem "memory counters are unavailable"; return 0 ;; esac
  [ "$pct" -lt "$w_mem" ] || item warn mem ram "memory ${pct}% used"
}

p_oom() {
  off oom && return 0
  local out src hits n victim
  if [ -d "${SU_SYSD:-/run/systemd/system}" ] && has journalctl; then
    # without rights journalctl prints a hint and exits 0, so the answer would be a false "nothing"
    if [ "$(id -u)" != 0 ] && ! id -Gn 2>/dev/null | tr ' ' '\n' | grep -qxE 'adm|systemd-journal|wheel'; then
      part oom "no access to the kernel journal (needs root or the adm group; try --sudo)"; return 0
    fi
    out=$(t journalctl -k -q --no-pager --since '24 hours ago' 2>/dev/null) || { part oom "journalctl failed"; return 0; }
    src="in the last 24 h"
  elif has dmesg; then
    out=$(t dmesg 2>/dev/null) || { part oom "dmesg is not readable (needs root; try --sudo)"; return 0; }
    src="since boot"
  else
    part oom "neither journalctl nor dmesg is available"; return 0
  fi
  hits=$(printf '%s\n' "$out" | grep -E 'Killed process [0-9]+ \(')
  [ -n "$hits" ] || return 0
  n=$(printf '%s\n' "$hits" | awk 'END {print NR}')
  victim=$(printf '%s\n' "$hits" | sed -n 's/.*Killed process [0-9]* (\([^)]*\)).*/\1/p' | tail -n 1)
  item warn oom "${victim:-process}" "OOM killer ran $n time(s) $src, last victim ${victim:-unknown}"
}

p_units() {
  off unit && return 0
  local units total
  has systemctl || return 0
  units=$(t systemctl list-units --state=failed --no-legend --plain 2>/dev/null) || { part unit "systemctl failed (systemd is unavailable or access denied)"; return 0; }
  printf '%s\n' "$units" | awk 'NF && ++n <= 5 {print $1}' | while read -r u; do item warn unit "$u" "systemd unit $u failed"; done
  total=$(printf '%s\n' "$units" | awk 'NF {n++} END {print n + 0}')
  [ "$total" -le 5 ] || item warn unit more "$((total - 5)) more failed units"
}

p_containers() {
  off container && return 0
  has docker || return 0
  local out
  out=$(t docker ps -a --format '{{.Names}}|{{.Status}}' 2>/dev/null) || { part container "docker ps failed (no permission, or the daemon is not running)"; return 0; }
  printf '%s\n' "$out" | awk -F'|' '
    NF >= 2 {
      n = $1; s = $2
      if (s ~ /^Restarting/) print "crit|" n "|container " n ": " s
      else if (s ~ /^Exited \([1-9][0-9]*\)/) print "warn|" n "|container " n ": " s
      else if (s ~ /\(unhealthy\)/) print "warn|" n "|container " n ": " s
    }' | while IFS='|' read -r sev id text; do item "$sev" container "$id" "$text"; done
}

# server-use cron: the last "=== <ts> exit <rc>" line of each job's log
p_cron() {
  off cron && return 0
  local f n last ts rc
  for f in "$SU_DIR"/cron/*.sh; do
    [ -f "$f" ] || continue
    n=${f##*/}; n=${n%.sh}
    last=$(tail -c 1048576 "$SU_DIR/logs/cron-$n.log" 2>/dev/null | awk '/^=== [^ ]+ exit [0-9]+$/ {ts = $2; rc = $4} END {if (ts != "") print ts, rc}')
    [ -n "$last" ] || continue
    set -- $last
    ts=$1 rc=$2
    [ "$rc" = 0 ] || item warn cron "$n" "cron $n exit $rc at $ts"
  done
}

# server-use jobs that ended with an error in the last 24 h (143 = stopped with `job stop`)
p_jobs() {
  off job && return 0
  local d n rc
  for d in "$SU_DIR"/jobs/*/; do
    d=${d%/}; n=${d##*/}
    [ -s "$d/exit" ] || continue
    rc=$(cat "$d/exit" 2>/dev/null)
    case $rc in '' | 0 | 143 | *[!0-9]*) continue ;; esac
    recent "$d/finished" || continue
    item warn job "$n" "job $n exit $rc at $(cat "$d/finished" 2>/dev/null)"
  done
}

# deploy pull checks that skip a commit (failed deploy or rollback) since yesterday
p_deploy() {
  off deploy && return 0
  local f a
  for f in /opt/*/.server-use/watch-skip "$HOME"/apps/*/.server-use/watch-skip; do
    [ -f "$f" ] && recent "$f" || continue
    a=${f%/.server-use/watch-skip}; a=${a##*/}
    item warn deploy "$a" "deploy $a: pull check skips $(tail -n 1 "$f" 2>/dev/null | cut -c1-12) (failed deploy or rollback)"
  done
}

# Let's Encrypt and Caddy certificates; expiry by `openssl x509 -checkend`
p_certs() {
  off cert && return 0
  local top f id left unread=0 crit
  for top in /etc/letsencrypt/live /var/lib/caddy; do
    if [ -d "$top" ] && { [ ! -r "$top" ] || [ ! -x "$top" ]; }; then unread=1; fi
    # A readable top-level Caddy directory can contain private certificate subdirectories.
    if [ -d "$top" ] && ! t find "$top" -type d -print >/dev/null 2>&1; then unread=1; fi
  done
  [ "$unread" = 0 ] || part cert "certificate directories are not readable (needs root; try --sudo)"
  crit=3; [ "$w_cert" -ge 3 ] || crit=$w_cert
  for f in /etc/letsencrypt/live/*/cert.pem /var/lib/caddy/.local/share/caddy/certificates/*/*/*.crt; do
    [ -f "$f" ] || continue
    has openssl || { part cert "openssl is not installed"; return 0; }
    case $f in */cert.pem) id=${f%/cert.pem}; id=${id##*/} ;; *) id=${f##*/}; id=${id%.crt} ;; esac
    left=$(t openssl x509 -enddate -noout -in "$f" 2>/dev/null) || { part cert "certificate is unreadable or invalid"; continue; }
    left=$(printf '%s' "$left" | sed 's/^notAfter=//' | tr -s ' ')
    if ! openssl x509 -checkend 0 -noout -in "$f" >/dev/null 2>&1; then item crit cert "$id" "certificate $id expired ($left)"
    elif ! openssl x509 -checkend $((crit * 86400)) -noout -in "$f" >/dev/null 2>&1; then item crit cert "$id" "certificate $id expires within $crit days ($left)"
    elif ! openssl x509 -checkend $((w_cert * 86400)) -noout -in "$f" >/dev/null 2>&1; then item warn cert "$id" "certificate $id expires within $w_cert days ($left)"
    fi
  done
}

# Explicit backup=absolute/path:hours settings, or managed backups (default: 24 hours).
# Read only the file's mtime: no database commands, restores or network traffic.
p_backups() {
  off backup && return 0
  local spec path hours mins id
  set -f
  for spec in $backups; do
    path=${spec%:*} hours=${spec##*:}
    case $path:$hours in /*:[0-9]*) ;; *) part backup "invalid backup setting"; continue ;; esac
    case $hours in ''|*[!0-9]*) part backup "invalid backup age"; continue ;; esac
    id=${path##*/}; mins=$((hours * 60))
    if [ ! -e "$path" ]; then item warn backup "$id" "backup $id is missing"
    elif [ ! -r "$path" ]; then part backup "backup $id is not readable"
    elif [ -n "$(find "$path" -maxdepth 0 -mmin +"$mins" 2>/dev/null)" ]; then item warn backup "$id" "backup $id is older than $hours hours"
    fi
  done
  set +f
  [ -z "$backups" ] || return 0
  for path in "$SU_DIR"/backups/*; do
    [ -f "$path" ] || continue
    id=${path##*/}
    [ -z "$(find "$path" -maxdepth 0 -mmin +1440 2>/dev/null)" ] || item warn backup "$id" "backup $id is older than 24 hours"
  done
}

p_reboot() {
  off reboot && return 0
  if [ -e /var/run/reboot-required ]; then item info reboot required "reboot required"
  elif has needs-restarting && t needs-restarting -r 2>/dev/null | grep -q 'Reboot is required'; then item info reboot required "reboot required"
  fi
}

# from the package lists already on disk: no network
p_updates() {
  off updates && return 0
  local n
  if has apt-get; then
    n=$(t apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | awk '/^Inst .*[Ss]ecurity/ {n++} END {print n + 0}')
    [ "$n" = 0 ] || item info updates security "$n security updates pending"
  elif has dnf; then
    n=$(t dnf -q -C updateinfo list --security 2>/dev/null | awk 'NF {n++} END {print n + 0}')
    [ "$n" = 0 ] || item info updates security "$n security updates pending"
  elif has apk; then
    n=$(t apk version -l '<' 2>/dev/null | awk 'NR > 1 && NF {n++} END {print n + 0}')
    [ "$n" = 0 ] || item info updates packages "$n package updates pending"
  fi
}

# sshd -T needs root; as another user the answer is unknown and nothing is claimed
p_ssh() {
  off ssh && return 0
  [ "$(id -u)" = 0 ] && has sshd || return 0
  [ "$(t sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}')" = yes ] && item info ssh password "SSH password login is on"
  return 0
}

# the server-side watch (watch.sh): it must have run lately, and cron must be there to run it
p_watch() {
  off watch && return 0
  local w=$SU_DIR/watch every m ref
  [ -f "$w/watch.env" ] || return 0
  # Never source a watched user's file from a read-only check (especially with --sudo).
  every=$(sed -n "s/^WATCH_EVERY_S='\([0-9]*\)'$/\1/p" "$w/watch.env" 2>/dev/null)
  case $every in '' | *[!0-9]*) every=300 ;; esac
  m=$(((every * 3 + 59) / 60))
  ref=$w/last_run; [ -f "$ref" ] || ref=$w/watch.env
  [ -z "$(find "$ref" -mmin +"$m" 2>/dev/null)" ] || item warn watch stale "watch has not run for over $m min (every ${every}s)"
  [ ! -f "$w/notify_error" ] || item warn watch delivery "watch notification delivery failed; next run will retry"
  [ ! -f "$w/heartbeat_error" ] || item warn watch heartbeat "watch heartbeat request failed"
  if has pgrep && ! pgrep -x cron >/dev/null && ! pgrep -x crond >/dev/null; then item warn watch cron "no cron daemon is running, so watch cannot run"; fi
}

main() {
  settings
  usage disk -P "$w_disk"
  usage inodes -Pi "$w_inodes"
  p_mem
  p_oom
  p_units
  p_containers
  p_cron
  p_jobs
  p_deploy
  p_certs
  p_backups
  p_reboot
  p_updates
  p_ssh
  p_watch
  printf 'now=%s\n' "$(date +%s)"
}

[ "${SU_CHECK_LIB:-}" = 1 ] || main </dev/null
