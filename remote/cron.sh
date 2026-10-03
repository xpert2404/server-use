# cron.sh — cron entries in a managed block of the user's crontab. SU_ACTION ls|add|rm|run|logs, SU_NAME,
# SU_SCHEDULE + SU_PAYLOAD_B64 (add), SU_LOCK 1|0, SU_LINES (100). Lines outside the block are never changed.
set -u

SU_DIR="$HOME/.server-use"
BEGIN='# >>> server-use (managed block — edit with `server-use cron`) >>>'
END='# <<< server-use <<<'
action=${SU_ACTION:-}
name=${SU_NAME:-}
n=${SU_LINES:-100}
case $n in ''|*[!0-9]*) n=100 ;; esac
die() { printf 'cron: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
su_b64d() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D 2>/dev/null || printf %s "$1" | openssl base64 -d -A; }

case $action in
  ls) ;;
  add|rm|run|logs) case $name in ''|.*|*[!A-Za-z0-9_.-]*) die "bad cron job name '$name'" ;; esac ;;
  *) die "unknown action '$action' (ls|add|rm|run|logs)" ;;
esac
c="$SU_DIR/cron/$name" # + .cmd (the command) .sh (wrapper) .lock
log="$SU_DIR/logs/cron-$name.log"
t="$SU_DIR/cron/.crontab.$$"
ld= # the mkdir lock we hold, if any

# add/rm rewrite the whole crontab, so parallel calls would drop each other's entry: they take a lock held until
# exit. flock is released however we die. ponytail: the mkdir fallback (no flock, e.g. macOS) is taken over after
# ~30 s, since a holder killed by a signal never removes it; a holder slower than that would overlap.
locktab() {
  if has flock; then exec 8>"$SU_DIR/cron/.lock" && flock 8 && return; fi
  i=0
  while ! mkdir "$SU_DIR/cron/.lockdir" 2>/dev/null && [ $i -lt 30 ]; do i=$((i + 1)); sleep 1; done
  ld="$SU_DIR/cron/.lockdir"
}

# Current crontab → $t. Only a "no crontab" error counts as empty; anything else aborts before we write.
readtab() {
  has crontab || die "no crontab command on this server; install cron (Debian/Ubuntu: apt install cron; RHEL/Fedora/Arch: cronie; Alpine: busybox crond)"
  mkdir -p "$SU_DIR/cron" "$SU_DIR/logs" && chmod 700 "$SU_DIR" || die "cannot create $SU_DIR/cron"
  trap 'rm -f "$t" "$t.new" "$t.err" "$c.cmd.new" "$c.sh.new"; [ -z "$ld" ] || rmdir "$ld" 2>/dev/null' EXIT
  [ "$action" = ls ] || locktab
  LC_ALL=C crontab -l >"$t" 2>"$t.err" && return
  case $(cat "$t.err") in
    *'no crontab'*|*'No such file'*) : >"$t" ;; # cronie/vixie/macOS, busybox
    *) die "crontab -l failed: $(cat "$t.err")" ;;
  esac
}

# $t → $t.new with entry $1 set (replacing the same name in place) or, if $1 is empty, the entry removed.
# The block is appended when missing and dropped when empty. Lines are re-joined with \n and the file keeps
# its trailing newline only if it had one, so everything outside the block is byte-identical (CRLF included).
# Exit 3 = broken block (two begin markers / no end marker), 4 = nothing to remove.
rewrite() {
  local nl=1
  [ -n "$(tail -c 1 "$t")" ] && nl=0
  N=$name L=$1 B=$BEGIN E=$END LC_ALL=C awk -v nl=$nl '
    function out(s) { if (o++) printf "\n"; printf "%s", s }
    { a[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        l = a[i]; sub(/\r$/, "", l)
        if (index(l, "# >>> server-use") == 1) { if (b) exit 3; b = i }
        else if (index(l, "# <<< server-use") == 1 && b && !e) e = i
      }
      if (b && !e) exit 3
      if (!b) b = e = NR + 1
      tag = " # server-use:" ENVIRON["N"]; L = ENVIRON["L"]
      for (i = b + 1; i < e; i++) {
        l = a[i]; sub(/\r$/, "", l)
        if (substr(l, length(l) - length(tag) + 1) != tag) k[++m] = a[i]
        else if (!done++ && L != "") k[++m] = L
      }
      if (L == "" && !done) exit 4
      if (L != "" && !done) k[++m] = L
      for (i = 1; i < b; i++) out(a[i])
      if (m) { out(ENVIRON["B"]); for (j = 1; j <= m; j++) out(k[j]); out(ENVIRON["E"]) }
      for (i = e + 1; i <= NR; i++) out(a[i])
      if (o && nl) printf "\n"
    }' "$t" >"$t.new"
}
broken() { die "the server-use block in the crontab is broken (two begin markers or no end marker); fix it with crontab -e"; }
putcron() { crontab - <"$t.new" || die "installing the new crontab failed"; }

case $action in
add)
  lock=1
  [ "${SU_LOCK:-1}" = 0 ] && lock=0
  [ -n "${SU_PAYLOAD_B64:-}" ] || die "add needs a command"
  # Normalise whitespace (no newline can reach the crontab) and allow only schedule characters (no %).
  set -f
  set -- ${SU_SCHEDULE:-}
  set +f
  case $#:${1:-} in 1:@*|5:*) ;; *) die "bad schedule '${SU_SCHEDULE:-}' (5 fields like '0 6 * * 1-5' or @daily)" ;; esac
  for f; do case $f in *[!0-9A-Za-z*/,@-]*) die "bad schedule field '$f'" ;; esac; done
  sched=$*
  # cron turns % into newlines (and not every cron honours \%), so a % in the path is refused outright.
  case $c in *%*|*'
'*) die "the path $c.sh contains % or a newline, which cron cannot run" ;; esac
  q="$c.sh"
  case $q in *[!A-Za-z0-9_./-]*) q="'$(printf %s "$q" | sed "s/'/'\\\\''/g")'" ;; esac
  readtab
  su_b64d "$SU_PAYLOAD_B64" >"$c.cmd.new" || die "cannot decode the command payload"
  # The wrapper derives every path from $0, so it holds no quoting-sensitive text.
  { echo '#!/bin/sh'; echo '# server-use cron wrapper (generated by `server-use cron add`)'; echo "lock=$lock"; cat <<'EOF'
c=${0%.sh}
d=${c%/cron/*}
mkdir -p "$d/logs"
exec </dev/null >>"$d/logs/cron-${c##*/}.log" 2>&1
cd "$HOME" 2>/dev/null || cd /
echo "=== $(date +%Y-%m-%dT%H:%M:%S%z) start"
if [ "$lock" = 1 ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$c.lock"
  flock -n 9 || { echo "skipped: previous run still active"; exit 0; }
fi
if command -v bash >/dev/null 2>&1; then bash "$c.cmd" 9>&-; else sh "$c.cmd" 9>&-; fi
rc=$?
echo "=== $(date +%Y-%m-%dT%H:%M:%S%z) exit $rc"
exit $rc
EOF
  } >"$c.sh.new" || die "cannot write $c.sh"
  rewrite "$sched /bin/sh $q # server-use:$name" || broken
  # Files go live only after the crontab was accepted, so a rejected schedule leaves the old entry intact.
  putcron
  mv -f "$c.cmd.new" "$c.cmd" && mv -f "$c.sh.new" "$c.sh" || die "crontab updated but moving $c.cmd/.sh into place failed"
  echo "cron $name: $sched"
  echo "log $log"
  [ $lock = 0 ] || has flock || echo "note: flock is not installed, so runs may overlap"
  has pgrep && ! pgrep -x cron >/dev/null && ! pgrep -x crond >/dev/null && echo "warning: no cron daemon seems to be running"
  :
  ;;
rm)
  readtab
  rewrite ''
  case $? in
    0) putcron; had=1 ;;
    4) had=0 ;;
    *) broken ;;
  esac
  [ -e "$c.cmd" ] || [ -e "$c.sh" ] && had=1
  [ $had = 1 ] || die "no cron job named '$name'"
  rm -f "$c.cmd" "$c.sh" "$c.lock"
  echo "removed cron job $name (log kept: $log)"
  ;;
ls)
  readtab
  tz=
  if [ -L /etc/localtime ]; then
    tz=$(readlink /etc/localtime)
    case $tz in *zoneinfo/*) tz=${tz#*zoneinfo/} ;; *) tz= ;; esac
  fi
  if [ -z "$tz" ] && [ -r /etc/timezone ]; then tz=$(head -n 1 /etc/timezone); fi
  [ -n "$tz" ] || tz=$(date +%Z)
  echo "tz=$tz"
  echo "time=$(date +%Y-%m-%dT%H:%M:%S%z)"
  LC_ALL=C awk '
    { l = $0; sub(/\r$/, "", l) }
    index(l, "# >>> server-use") == 1 { inb = 1; next }
    index(l, "# <<< server-use") == 1 && inb { inb = 0; next }
    inb && match(l, / # server-use:[^ ]+$/) {
      split(l, f, " "); s = f[1]
      if (s !~ /^@/) s = s " " f[2] " " f[3] " " f[4] " " f[5]
      print substr(l, RSTART + 14) "|" s; e++; next
    }
    !inb && l !~ /^[ \t]*(#|$)/ { x++ }
    END { if (!e) print "#none|"; print "#foreign|" x + 0 }' "$t" |
  while IFS='|' read -r en es; do
    case $en in
      '#none') echo "no server-use cron entries" ;;
      '#foreign') echo "foreign crontab lines: $es (not managed by server-use, left untouched)" ;;
      *)
        if [ -f "$SU_DIR/cron/$en.cmd" ]; then cmd=$(tr '\n\r\t' '   ' <"$SU_DIR/cron/$en.cmd" | cut -c1-80); else cmd="(missing $en.cmd)"; fi
        printf '%-20s  %-15s  %s\n' "$en" "$es" "$cmd" ;;
    esac
  done
  ;;
run)
  [ -f "$c.sh" ] || die "no cron job named '$name'"
  mkdir -p "$SU_DIR/logs"
  size=0
  [ -f "$log" ] && size=$(($(wc -c <"$log")))
  /bin/sh "$c.sh" </dev/null
  rc=$?
  tail -c +$((size + 1)) "$log"
  exit $rc
  ;;
logs)
  if [ -f "$log" ]; then tail -n "$n" "$log"
  elif [ -f "$c.cmd" ]; then echo "no runs logged yet ($log)"
  else die "no cron job named '$name'"; fi
  ;;
esac
