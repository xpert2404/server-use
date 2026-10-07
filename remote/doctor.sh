# doctor.sh — incident snapshot: one read-only pass over the server, printed as "== section" blocks of
# tab-separated lines that src/ops/doctor.mjs turns into ranked findings. SU_SINCE_MIN (window in minutes, 120),
# SU_DEEP (1 = du of nearly full mounts). All probes are read-only.
#
# No heredocs and no temp files, so it still works on a full disk. Every probe is time-boxed and niced, and the
# whole output goes through a redactor (Bearer/Basic, password=/token=/secret=/api_key= values, sk- ghp_ AKIA
# xox eyJ keys, user:pass@ in URLs). The script itself arrives on stdin, so main runs with stdin from /dev/null.
set -u
PATH=$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin
export PATH
export LC_ALL=C

since=${SU_SINCE_MIN:-120}
case $since in ''|*[!0-9]*) since=120 ;; esac
[ "$since" -ge 1 ] || since=1
deep=${SU_DEEP:-0}
logdir=${SU_LOGDIR:-/var/log} # test hook; the server's log directory
T=$(printf '\t')
nl='
'

has() { command -v "$1" >/dev/null 2>&1; }
sec() { printf '== %s\n' "$1"; }
LOW=
if has nice && nice -n 19 true 2>/dev/null; then LOW="nice -n 19"; fi
if has ionice && ionice -c3 true 2>/dev/null; then LOW="$LOW ionice -c3"; fi
# t: a hung docker daemon, dbus or NFS mount must not stall the snapshot; tl for du
t() { if has timeout; then $LOW timeout 10 "$@"; else $LOW "$@"; fi; }
tl() { if has timeout; then $LOW timeout 60 "$@"; else $LOW "$@"; fi; }
mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
dukb() { tl du -sk "$@" 2>/dev/null | awk '{s += $1} END {printf "%d", s}'; }
PARTIAL=
part() { PARTIAL="$PARTIAL$1$T$2$nl"; } # something not looked at, and why (main shell only, never in a pipeline)

# awk library: redaction, signature normalisation, leading timestamp, size parsing.
# Dynamic regexes instead of {n,m}: mawk (Debian's default awk) has no interval expressions.
AWKLIB='
function rep(s, n,   r) { r = ""; while (n-- > 0) r = r s; return r }
function ci(w,   i, c, r) {
  r = ""
  for (i = 1; i <= length(w); i++) {
    c = substr(w, i, 1)
    r = r (c ~ /[A-Za-z]/ ? "[" tolower(c) toupper(c) "]" : "[" c "]")
  }
  return r
}
function lib_init(   h, an) {
  h = "[0-9a-fA-F]"
  an = "[A-Za-z0-9_-]"
  RE_UUID = rep(h, 8) "-" rep(h, 4) "-" rep(h, 4) "-" rep(h, 4) "-" rep(h, 12)
  RE_HEX = rep(h, 8) h "*"
  RE_TS = "^\\[?" rep("[0-9]", 4) "[-/]" rep("[0-9]", 2) "[-/]" rep("[0-9]", 2) "[T ]" rep("[0-9]", 2) ":" rep("[0-9]", 2) ":" rep("[0-9]", 2) "([.,][0-9]+)?(Z|[+-][0-9][0-9]:?[0-9][0-9])?\\]?"
  RE_KEY = "(" ci("password") "|" ci("passwd") "|" ci("secret") "|" ci("token") "|" ci("api") "[_-]?" ci("key") "|" ci("access") "[_-]?" ci("key") "|" ci("private") "[_-]?" ci("key") "|" ci("authorization") "|" ci("credential") "[sS]?" ")[\"\047]?[ ]*[=:][ ]*"
  RE_KV = RE_KEY "(\"([^\"\\\\]|\\\\.)*(\"|$)|\047([^\047\\\\]|\\\\.)*(\047|$)|[^ \"\047,;&)}]+)"
  NPRE = 6
  PRE[1] = "sk-" rep(an, 16) an "*"
  PRE[2] = "gh[pousr]_" rep("[A-Za-z0-9]", 20) "[A-Za-z0-9]*"
  PRE[3] = "github_pat_" rep("[A-Za-z0-9_]", 20) "[A-Za-z0-9_]*"
  PRE[4] = "AKIA" rep("[0-9A-Z]", 16)
  PRE[5] = "xox[abprs]-" rep("[A-Za-z0-9-]", 10) "[A-Za-z0-9-]*"
  PRE[6] = "eyJ" an "+\\." an "+\\." an "+"
}
BEGIN { lib_init() }
# key=value / "key":"value": keep the key and the separator, drop the value
function redkv(s,   out, st, ln, m, p, q) {
  out = ""
  while (match(s, RE_KV)) {
    st = RSTART; ln = RLENGTH
    m = substr(s, st, ln)
    p = index(m, "="); q = index(m, ":")
    if (p == 0 || (q > 0 && q < p)) p = q
    out = out substr(s, 1, st - 1) substr(m, 1, p) "***"
    s = substr(s, st + ln)
  }
  return out s
}
# token shapes that must not follow a letter (so "task-..." is not an sk- key); the leading blank is the "start of line"
function redpre(s, body,   out, st, ln) {
  out = ""
  s = " " s
  while (match(s, "[^A-Za-z0-9_]" body)) {
    st = RSTART; ln = RLENGTH
    out = out substr(s, 1, st) "***"
    s = substr(s, st + ln)
  }
  return substr(out s, 2)
}
function red(s,   i, l) {
  l = tolower(s)
  if (index(s, "://")) gsub("://[^/@ ]+@", "://***@", s)
  if (index(l, "bearer ")) gsub("[Bb][Ee][Aa][Rr][Ee][Rr] +[A-Za-z0-9._~+/=-]+", "Bearer ***", s)
  if (index(l, "basic ")) gsub("[Bb][Aa][Ss][Ii][Cc] +" rep("[A-Za-z0-9+/=]", 6) "[A-Za-z0-9+/=]*", "Basic ***", s)
  if (l ~ /passw|secret|token|key|authorization|credential/) s = redkv(s)
  if (s ~ /sk-|gh[pousr]_|github_pat_|AKIA|xox|eyJ/) for (i = 1; i <= NPRE; i++) s = redpre(s, PRE[i])
  return s
}
# the part of a log line that stays the same between occurrences
function norm(s) {
  gsub(RE_UUID, "UUID", s)
  gsub(/0[xX][0-9a-fA-F]+/, "HEX", s)
  gsub(RE_HEX, "HEX", s)
  gsub(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/, "IP", s)
  gsub(/[0-9]+/, "N", s)
  gsub(/[ \t]+/, " ", s)
  sub(/^ /, "", s); sub(/ $/, "", s)
  return s
}
# leading timestamp (ISO, 2026/10/07 14:02:11, docker RFC3339, [..]) → TS; the rest of the line → REST
function lead_ts(s,   t) {
  TS = ""; REST = s
  if (match(s, RE_TS)) {
    t = substr(s, 1, RLENGTH)
    REST = substr(s, RLENGTH + 1)
    gsub(/\[/, "", t); gsub(/\]/, "", t); gsub("/", "-", t); sub(/ /, "T", t); sub(/,/, ".", t)
    TS = t
  } else if (match(s, /^[A-Z][a-z][a-z] +[0-9]+ [0-9][0-9]:[0-9][0-9]:[0-9][0-9] /)) {
    REST = substr(s, RLENGTH + 1) # syslog time has no year: nothing to compare with
  }
  sub(/^ +/, "", REST)
}
function tokb(s,   n, u) {
  sub(/^ +/, "", s)
  if (!match(s, /^[0-9.]+/)) return 0
  n = substr(s, 1, RLENGTH) + 0
  u = toupper(substr(s, RLENGTH + 1, 1))
  if (u == "K") return n
  if (u == "M") return n * 1024
  if (u == "G") return n * 1048576
  if (u == "T") return n * 1073741824
  return n / 1024
}
'

# Error signatures per source. mode journal|docker|file, src = container or file name.
SIGAWK='
BEGIN { ERRRE = "error|fatal|panic|exception|refused|denied|timeout|traceback|segfault|out of memory|oom-kill|killed" }
{
  line = $0
  if (mode != "journal" && tolower(line) !~ ERRRE) next
  lead_ts(line)
  ts = TS; msg = REST; s = src
  if (mode == "journal") { # "<ts> <host> <ident>[pid]: message"
    if (ts == "") next
    sub(/^[^ ]+ +/, "", msg)
    s = msg; sub(/ .*/, "", s)
    msg = substr(msg, length(s) + 2)
    sub(/\[[0-9]+\]:?$/, "", s); sub(/:$/, "", s)
  }
  sig = norm(red(msg))
  if (sig == "") next
  if (length(sig) > 160) sig = substr(sig, 1, 160)
  total++
  k = s "\t" sig
  if (!(k in cnt)) {
    if (nk >= 3000) next # ponytail: the first 3000 distinct signatures per source; later ones are not counted
    nk++; S[k] = s; G[k] = sig; F[k] = ts; cnt[k] = 0
  }
  cnt[k]++
  if (F[k] == "") F[k] = ts
  if (ts != "") L[k] = ts
}
END {
  for (k in cnt) printf "err\t%d\t%s\t%s\t%s\t%s\t%s\n", cnt[k], S[k], F[k], L[k], G[k], mode
  printf "errsum\t%d\t%s\n", total + 0, mode
}'
sigs() { awk -v mode="$1" -v src="$2" "$AWKLIB$SIGAWK"; }

# ---- probes (main shell: they set the variables the sections use and record what could not be looked at)

probe() {
  now=$(date +%s)
  me=$(id -un 2>/dev/null)
  uid=$(id -u 2>/dev/null)
  root=0
  [ "$uid" = 0 ] && root=1
  up=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)
  case $up in ''|*[!0-9]*) up=0 ;; esac
  sysd=
  [ -d /run/systemd/system ] && has systemctl && sysd=1

  jok=
  if ! has journalctl || ! { [ -d /run/systemd/journal ] || [ -d /var/log/journal ]; }; then
    part journal "no journald on this host (errors come from $logdir)"
  elif [ $root = 1 ] || id -Gn 2>/dev/null | tr ' ' '\n' | grep -qxE 'systemd-journal|adm|wheel'; then jok=1
  else part journal "needs root or the systemd-journal group (retry with --sudo)"; fi

  kok=
  if [ -z "$jok" ]; then
    if has dmesg && dmesg >/dev/null 2>&1; then kok=1; else part oom "kernel log not readable as $me (retry with --sudo)"; fi
  fi

  dockok= cinfo= troubled=
  if ! has docker; then part docker "not installed"
  elif ids=$(t docker ps -aq 2>/dev/null </dev/null); then
    dockok=1
    # name|status|exit|oomkilled|restarts|started|finished|health|created
    [ -z "$ids" ] || cinfo=$(t docker inspect -f '{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.Created}}' $ids 2>/dev/null </dev/null)
    troubled=$(printf '%s\n' "$cinfo" | awk -F'|' '
      { name = $1; sub(/^\//, "", name); st = $2; ex = $3 + 0; rc = $5 + 0 }
      st == "restarting" || $4 == "true" || $8 == "unhealthy" { print "0\t" name; next }
      st == "dead" || (st == "exited" && ex != 0) { print "1\t" name; next }
      rc > 0 { print "2\t" name }' | sort | head -n 5 | cut -f2)
  else part docker "installed but not usable as $me (retry with --sudo)"; fi

  files= unreadable=
  cand=$(find "$logdir" -maxdepth 2 -type f \( -name '*.log' -o -name syslog -o -name messages \) -mmin "-$since" 2>/dev/null |
    grep -Ev '/(apt|installer|journal|private)/|/(dpkg|alternatives|bootstrap|lastlog|faillog)(\.log)?$' | head -n 40)
  # syslog and messages mirror the journal where there is one
  [ -z "$jok" ] || cand=$(printf '%s\n' "$cand" | grep -Ev '/(syslog|messages)$')
  IFS=$nl
  for f in $cand; do
    if [ -r "$f" ]; then files="$files$f$nl"; else unreadable=1; fi
  done
  unset IFS
  [ -z "$unreadable" ] || part varlog "some files in $logdir are not readable as $me (retry with --sudo)"

  certdir=
  for d in /etc/letsencrypt/live /var/lib/caddy/.local/share/caddy/certificates "$HOME/.local/share/caddy/certificates"; do
    [ -d "$d" ] || continue
    certdir=1
    [ -r "$d" ] && [ -x "$d" ] || part certs "$d is not readable as $me (retry with --sudo)"
  done
  [ -z "$certdir" ] || has openssl || part certs "openssl is not installed"
}

# ---- sections

emit_meta() {
  sec meta
  printf 'now=%s\nsince_min=%s\nuser=%s\nuid=%s\nroot=%s\ntz=%s\nuptime_s=%s\nhostname=%s\n' \
    "$now" "$since" "$me" "$uid" "$root" "$(date +%z)" "$up" "$(hostname 2>/dev/null)"
  if [ -e /var/run/reboot-required ]; then echo reboot_required=yes; fi
}

emit_host() {
  sec host
  if read -r l1 l5 l15 _ 2>/dev/null </proc/loadavg; then printf 'load=%s %s %s\n' "$l1" "$l5" "$l15"; fi
  printf 'cpus=%s\n' "$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
  # kernels before 3.14 have no MemAvailable: free + buffers + cached
  awk '/^MemTotal:/ {t = $2} /^MemAvailable:/ {a = $2} /^(MemFree|Buffers|Cached):/ {f += $2}
    /^SwapTotal:/ {st = $2} /^SwapFree:/ {sf = $2}
    END {if (t) {if (!a) a = f; printf "mem_total_kb=%d\nmem_avail_kb=%d\nswap_total_kb=%d\nswap_free_kb=%d\n", t, a, st, sf}}' /proc/meminfo 2>/dev/null
  for r in cpu memory io; do
    [ -r /proc/pressure/$r ] && awk -v r="$r" '$1 == "some" {for (i = 2; i <= NF; i++) if ($i ~ /^avg60=/) {sub(/avg60=/, "", $i); printf "psi_%s=%s\n", r, $i}}' /proc/pressure/$r
  done
  t vmstat 1 2 2>/dev/null | tail -n 1 | awk 'NF >= 16 {printf "swap_in=%s\nswap_out=%s\niowait=%s\n", $7, $8, $16}'
}

disk_lines() {
  { t df -Pk 2>/dev/null; echo @@inodes; t df -Pi 2>/dev/null; } | awk '
    function keep(fs, m) {
      if (fs ~ /^(tmpfs|devtmpfs|squashfs|udev|shm|none|efivarfs|devfs|run|tmp)$/ || fs ~ /^(cgroup|map )/) return 0
      if (fs == "overlay" && m != "/") return 0
      return m !~ /^\/(dev|proc|sys|run|snap)(\/|$)/
    }
    /^@@inodes/ {inode = 1; next}
    /^Filesystem/ || NF < 6 {next}
    {
      m = $6
      if (!keep($1, m)) next
      if (!inode) {if (!(m in sz)) {sz[m] = $2; av[m] = $4; pc[m] = $5 + 0; ord[++n] = m}}
      else if (m in sz) ip[m] = ($5 == "-" ? "" : $5 + 0)
    }
    END {for (i = 1; i <= n; i++) {m = ord[i]; printf "disk\t%s\t%s\t%s\t%s\t%s\n", m, sz[m], av[m], pc[m], ip[m]}}'
}
emit_disk() { sec "$1"; [ -z "$dfout" ] || printf '%s\n' "$dfout"; }

emit_sizes() {
  sec sizes
  maxpct=$(printf '%s\n' "$dfout" | awk -F"$T" '$1 == "disk" && $5 + 0 > m {m = $5 + 0} END {print m + 0}')
  # only worth the time when something is filling up
  if [ "$maxpct" -ge 80 ] ; then
    if [ -n "$jok" ]; then
      t journalctl --disk-usage 2>/dev/null | awk "$AWKLIB"'match($0, /[0-9.]+[KMGT]/) {printf "size\tjournal\t%d\n", tokb(substr($0, RSTART, RLENGTH))}'
    fi
    if [ -n "$dockok" ]; then
      t docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null |
        awk -F'|' "$AWKLIB"'NF >= 3 {printf "size\tdocker %s\t%d\t%d\n", tolower($1), tokb($2), tokb($3)}'
    fi
    tl du -sxk /var/log /var/cache /var/tmp /tmp 2>/dev/null | awk '{printf "size\t%s\t%d\n", $2, $1}'
  fi
  if [ "$deep" = 1 ]; then
    printf '%s\n' "$dfout" | awk -F"$T" '$1 == "disk" && $5 + 0 >= 85 {print $2}' | while IFS= read -r m; do
      tl du -x -k -d 1 "$m" 2>/dev/null | sort -nr | head -n 9 | awk -v m="$m" '{kb = $1; sub(/^[0-9]+[ \t]+/, ""); if ($0 != m) printf "deep\t%s\t%d\t%s\n", m, kb, $0}'
    done
  fi
}

emit_top() {
  sec top
  # busybox ps has no pcpu: memory only. Summed per command name, so "node 1.8G" is every node process together.
  topout=$({ ps -eo rss,pcpu,comm 2>/dev/null || ps -o rss,comm 2>/dev/null; } | awk '
    NR == 1 {next}
    {
      if (NF >= 3 && $2 ~ /^[0-9.]+$/) {cpu = $2 + 0; c = $3; i0 = 4} else {cpu = 0; c = $2; i0 = 3}
      for (i = i0; i <= NF; i++) c = c " " $i
      mem[c] += $1; pc[c] += cpu; np[c]++
    }
    END {for (c in mem) {printf "mem\t%d\t%s\t%d\n", mem[c], c, np[c]; if (pc[c] >= 1) printf "cpu\t%.1f\t%s\t%d\n", pc[c], c, np[c]}}')
  printf '%s\n' "$topout" | grep '^mem' | sort -t "$T" -k2,2nr | head -n 5
  printf '%s\n' "$topout" | grep '^cpu' | sort -t "$T" -k2,2nr | head -n 5
}

emit_units() {
  sec units
  [ -n "$sysd" ] || return 0
  fl=$(t systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk 'NF {print $1}' | head -n 5)
  for u in $fl; do
    printf 'failed\t%s\n' "$u"
    [ -z "$jok" ] || t journalctl -u "$u" -n 3 -o cat -q --no-pager 2>/dev/null | awk -v u="$u" 'NF {printf "unitlog\t%s\t%s\n", u, $0}'
  done
  # restart loops: a unit waiting to restart, or one with restarts that has only been up for part of the window
  t systemctl show --property=Id,NRestarts,SubState,ActiveEnterTimestampMonotonic '*.service' 2>/dev/null | awk -v up="$up" -v win="$((since * 60))" '
    BEGIN {RS = ""; FS = "\n"}
    {
      id = ""; n = 0; sub_ = ""; mono = 0
      for (i = 1; i <= NF; i++) {
        p = index($i, "="); k = substr($i, 1, p - 1); v = substr($i, p + 1)
        if (k == "Id") id = v; else if (k == "NRestarts") n = v + 0; else if (k == "SubState") sub_ = v
        else if (k == "ActiveEnterTimestampMonotonic") mono = v + 0
      }
      act = mono > 0 ? up - mono / 1000000 : -1
      if (id != "" && (sub_ == "auto-restart" || (n >= 2 && act >= 0 && act < win))) printf "restart\t%s\t%d\t%s\t%d\n", id, n, sub_, act
    }' | sort -t "$T" -k3,3nr | head -n 5
}

emit_containers() {
  sec containers
  [ -n "$dockok" ] || return 0
  printf '%s\n' "$cinfo" | awk -F'|' '
    NF < 9 {next}
    { name = $1; sub(/^\//, "", name); n++; if ($2 == "running") r++
      if ($2 != "running" || $4 == "true" || $8 == "unhealthy" || $5 + 0 > 0)
        printf "ctr\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", name, $2, $3, $4, $5, $6, $7, $8 }
    END {printf "ctrcount\t%d\t%d\n", r + 0, n + 0}' | head -n 25
}

emit_oom() {
  sec oom
  lo=$((now - since * 60))
  if [ -n "$jok" ]; then
    t journalctl -k -q --no-pager --since "$since min ago" -o short-unix 2>/dev/null | grep -i 'killed process' | tail -n 20 |
      awk -v lo="$lo" '{t = int($1); if (match($0, /[Kk]illed process [0-9]+ \([^)]*\)/)) {v = substr($0, RSTART, RLENGTH); sub(/^[^(]*\(/, "", v); sub(/\)$/, "", v); if (t >= lo) printf "oom\t%d\t%s\n", t, v}}'
  elif [ -n "$kok" ]; then
    # dmesg stamps are seconds since boot
    dmesg 2>/dev/null | grep -i 'killed process' | tail -n 20 |
      awk -v lo="$lo" -v boot="$((now - up))" '{if (match($0, /^\[ *[0-9.]+\]/)) {t = int(boot + substr($0, RSTART + 1, RLENGTH - 2) + 0)} else next
        if (match($0, /[Kk]illed process [0-9]+ \([^)]*\)/)) {v = substr($0, RSTART, RLENGTH); sub(/^[^(]*\(/, "", v); sub(/\)$/, "", v); if (t >= lo) printf "oom\t%d\t%s\n", t, v}}'
  fi
}

emit_errors() {
  sec errors
  {
    if [ -n "$jok" ]; then t journalctl -p err --since "$since min ago" -o short-iso -q --no-pager 2>/dev/null | tail -n 20000 | sigs journal journal; fi
    for c in $troubled; do t docker logs --since "${since}m" --timestamps --tail 2000 "$c" 2>&1 </dev/null | sigs docker "$c"; done
    IFS=$nl
    for f in $files; do tail -c 2000000 "$f" 2>/dev/null | sigs file "${f##*/}"; done
    unset IFS
  } | sort -t "$T" -k2,2nr | awk -F"$T" '/^errsum/ || ++n <= 15'
}

emit_changes() {
  sec changes
  # server-use releases: the client keeps the ones inside the window
  for rd in /opt/*/releases /home/*/apps/*/releases "$HOME"/apps/*/releases; do
    [ -d "$rd" ] || continue
    base=${rd%/releases}
    cur=$(readlink "$base/current" 2>/dev/null)
    ls -1 "$rd" 2>/dev/null | grep '^[0-9]\{14\}-' | sort -r | head -n 4 |
      awk -v a="${base##*/}" -v c="${cur##*/}" '{printf "release\t%s\t%s\t%s\n", a, $0, ($0 == c ? "current" : "")}'
  done
  # package manager activity
  if [ -r /var/log/apt/history.log ]; then
    awk '
      /^Start-Date: / {d = substr($0, 13); sub(/  +/, "T", d); cmd = "unattended"; u = i = r = 0}
      /^Commandline: / {cmd = substr($0, 14)}
      /^Upgrade: / {u = gsub(/\(/, "(")}
      /^Install: / {i = gsub(/\(/, "(")}
      /^(Remove|Purge): / {r += gsub(/\(/, "(")}
      /^End-Date: / {printf "pkg\t%s\t%s (upgrade %d, install %d, remove %d)\n", d, cmd, u, i, r}' /var/log/apt/history.log | tail -n 6
  elif has rpm; then
    t rpm -qa --qf '%{INSTALLTIME} %{NAME}\n' 2>/dev/null | sort -nr | head -n 40 |
      awk -v lo="$((now - since * 60))" '$1 >= lo {n++; if (!t) t = $1; if (n <= 3) names = names (n > 1 ? "," : "") $2} END {if (n) printf "pkg\t%d\trpm: %d packages installed or updated (%s%s)\n", t, n, names, (n > 3 ? ",..." : "")}'
  elif [ -r /var/log/pacman.log ]; then
    grep '\[PACMAN\] Running' /var/log/pacman.log | tail -n 4 | awk '{ts = $1; gsub(/\[/, "", ts); gsub(/\]/, "", ts); sub(/^[^ ]+ \[PACMAN\] Running /, ""); printf "pkg\t%s\t%s\n", ts, $0}'
  fi
  # files edited in the window: unit files, cron, /etc
  { find /etc/systemd/system -maxdepth 2 -type f -mmin "-$since" 2>/dev/null | head -n 10
    find /etc -xdev -maxdepth 3 -type f -mmin "-$since" 2>/dev/null | grep -Ev '^/etc/systemd/system/|/(resolv\.conf|mtab|ld\.so\.cache|adjtime|machine-id|\.pwd\.lock|ld\.so\.conf\.d/.*\.conf\.dpkg)|^/etc/(alternatives|ssl/certs|ca-certificates|pki|apparmor\.d/cache)|/(passwd|shadow|group|gshadow)-$' | head -n 20
    find /var/spool/cron -maxdepth 2 -type f -mmin "-$since" 2>/dev/null | head -n 5
  } | while IFS= read -r f; do
    case $f in /etc/systemd/system/*) k=unitfile ;; /etc/cron*|/var/spool/cron/*) k=cronfile ;; *) k=conf ;; esac
    printf '%s\t%s\t%s\n' "$(mt "$f")" "$k" "$f"
  done | sort -nr | head -n 10 | awk -F"$T" '{printf "file\t%s\t%s\t%s\n", $1, $2, $3}'
  # containers: creation times (the client keeps the ones inside the window)
  [ -z "$cinfo" ] || printf '%s\n' "$cinfo" | awk -F'|' 'NF >= 9 {n = $1; sub(/^\//, "", n); printf "created\t%s\t%s\n", $9, n}' | sort -t "$T" -k2,2r | head -n 8
}

emit_cron() {
  sec cron
  sud=$HOME/.server-use
  # server-use cron wrappers log "=== <ts> exit <rc>" after every run; a removed job keeps its log but has no wrapper
  for f in "$sud"/logs/cron-*.log; do
    [ -f "$f" ] || continue
    n=${f##*/cron-}
    n=${n%.log}
    [ -f "$sud/cron/$n.sh" ] || continue
    last=$(tail -n 400 "$f" | grep '^=== .* exit [0-9][0-9]*$' | tail -n 1)
    [ -z "$last" ] || printf 'cronrun\t%s\t%s\n' "$n" "$last"
  done | head -n 30
  find "$sud/jobs" -maxdepth 2 -name exit -mmin "-$since" 2>/dev/null | head -n 20 | while IFS= read -r f; do
    d=${f%/exit}
    rc=$(cat "$f" 2>/dev/null)
    [ "$rc" = 0 ] || printf 'jobexit\t%s\t%s\t%s\n' "${d##*/}" "$rc" "$(cat "$d/finished" 2>/dev/null)"
  done
}

emit_ports() {
  sec ports
  { if has ss; then ss -tlnp 2>/dev/null; elif has netstat; then netstat -tlnp 2>/dev/null || netstat -tln 2>/dev/null; fi; } | awk '
    $1 == "LISTEN" {loc = $4}
    $1 ~ /^tcp/ && $6 == "LISTEN" {loc = $4}
    loc == "" {next}
    {
      port = loc; sub(/.*:/, "", port); addr = loc; sub(/:[^:]*$/, "", addr); name = ""
      if (match($0, /\(\("[^"]+"/)) name = substr($0, RSTART + 3, RLENGTH - 4)
      else if ($1 ~ /^tcp/ && $7 ~ /\//) {name = $7; sub(/^[0-9]+\//, "", name)}
      if (!seen[addr ":" port]++) printf "port\t%s\t%s\t%s\n", port, addr, name
      loc = ""
    }' | sort -t "$T" -k2,2n | head -n 30
}

emit_certs() {
  sec certs
  has openssl || return 0
  for f in /etc/letsencrypt/live/*/cert.pem /var/lib/caddy/.local/share/caddy/certificates/*/*/*.crt "$HOME"/.local/share/caddy/certificates/*/*/*.crt; do
    [ -f "$f" ] && [ -r "$f" ] || continue
    case $f in */cert.pem) n=${f%/cert.pem}; n=${n##*/} ;; *) n=${f##*/} ;; esac
    if ! openssl x509 -noout -checkend 0 -in "$f" >/dev/null 2>&1; then b=expired
    elif ! openssl x509 -noout -checkend 259200 -in "$f" >/dev/null 2>&1; then b=lt3d
    elif ! openssl x509 -noout -checkend 1209600 -in "$f" >/dev/null 2>&1; then b=lt14d
    else b=ok; fi
    days=
    end=$(openssl x509 -noout -enddate -in "$f" 2>/dev/null)
    if exp=$(date -d "${end#notAfter=}" +%s 2>/dev/null); then days=$(((exp - now) / 86400)); fi
    printf 'cert\t%s\t%s\t%s\n' "$n" "$b" "$days"
  done | head -n 20
}

emit_ntp() {
  sec ntp
  has timedatectl || return 0
  printf 'ntp_sync=%s\n' "$(t timedatectl show -p NTPSynchronized --value 2>/dev/null)"
}

main() {
  probe
  emit_meta
  emit_host
  dfout=$(disk_lines)
  emit_disk disk
  emit_sizes
  emit_top
  emit_units
  emit_containers
  emit_oom
  emit_errors
  emit_changes
  emit_cron
  emit_ports
  emit_certs
  emit_ntp
  sec partial
  printf '%s' "$PARTIAL"
}

main </dev/null | awk "$AWKLIB"'{print red($0)}'
