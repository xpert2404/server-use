# job.sh — detached runs that survive the SSH channel closing. SU_ACTION start|ls|logs|stop|status, SU_NAME,
# SU_LINES (100), SU_PAYLOAD_B64 (start). State in $SU_DIR/jobs/<name>/: cmd.sh out.log pid exit started finished.
set -u

SU_DIR="$HOME/.server-use"
action=${SU_ACTION:-}
name=${SU_NAME:-}
n=${SU_LINES:-100}
case $n in ''|*[!0-9]*) n=100 ;; esac
die() { printf 'job: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
now() { date +%Y-%m-%dT%H:%M:%S%z; }
su_b64d() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D 2>/dev/null || printf %s "$1" | openssl base64 -d -A; }
get() { cat "$1" 2>/dev/null || echo -; }

case $action in
  ls) ;;
  start|logs|stop|status) case $name in ''|.*|*[!A-Za-z0-9_.-]*) die "bad job name '$name'" ;; esac ;;
  *) die "unknown action '$action' (start|ls|logs|stop|status)" ;;
esac
dir="$SU_DIR/jobs/$name"

# The runner is alive when its pid exists and (where /proc exists) still carries the job dir in its argv,
# so a pid reused after a reboot is never mistaken for the job (nor signalled by stop).
alive() {
  local p
  p=$(cat "$1/pid" 2>/dev/null) || return 1
  case $p in ''|*[!0-9]*|0|1) return 1 ;; esac
  kill -0 "$p" 2>/dev/null || return 1
  [ -r "/proc/$p/cmdline" ] || return 0
  tr '\0' '\n' <"/proc/$p/cmdline" | grep -qxF -- "$1"
}
state() {
  if [ -s "$1/exit" ]; then echo "exited $(cat "$1/exit")"
  elif alive "$1"; then echo running
  else echo unknown; fi
}

case $action in
start)
  [ -n "${SU_PAYLOAD_B64:-}" ] || die "start needs a command"
  alive "$dir" && die "$name is already running (pid $(cat "$dir/pid")); stop it first or pick another name"
  mkdir -p "$dir" && chmod 700 "$SU_DIR" || die "cannot create $dir"
  su_b64d "$SU_PAYLOAD_B64" >"$dir/cmd.sh" || die "cannot decode the command payload"
  rm -f "$dir/pid" "$dir/exit" "$dir/finished"
  now >"$dir/started"
  sh=sh
  has bash && sh=bash
  detach=nohup
  has setsid && detach=setsid
  # No fd of the SSH channel may stay open in the runner, or the channel (and our caller) waits for the job.
  # The runner traps TERM so it outlives the command and records its exit code after `stop`.
  $detach sh -c 'echo $$ >"$1/pid"; trap : TERM; "$2" "$1/cmd.sh"; echo $? >"$1/exit"; date +%Y-%m-%dT%H:%M:%S%z >"$1/finished"' \
    su-job "$dir" "$sh" </dev/null >"$dir/out.log" 2>&1 &
  pid=$!
  i=0
  while [ ! -s "$dir/pid" ] && [ $i -lt 30 ]; do sleep 0.1 2>/dev/null || sleep 1; i=$((i + 1)); done
  [ -s "$dir/pid" ] && pid=$(cat "$dir/pid")
  echo "started $name pid $pid"
  echo "log $dir/out.log"
  ;;
ls)
  found=0
  for d in "$SU_DIR"/jobs/*/; do
    [ -d "$d" ] || continue
    d=${d%/}
    [ $found = 1 ] || printf '%-24s %-9s %-25s %s\n' NAME STATE STARTED EXIT
    found=1
    st=$(state "$d")
    printf '%-24s %-9s %-25s %s\n' "${d##*/}" "${st%% *}" "$(get "$d/started")" "$(get "$d/exit")"
  done
  [ $found = 1 ] || echo "no jobs"
  ;;
status)
  [ -d "$dir" ] || die "no job named '$name'"
  size=0
  [ -f "$dir/out.log" ] && size=$(($(wc -c <"$dir/out.log")))
  printf '%-9s %s\n' name "$name" state "$(state "$dir")" pid "$(get "$dir/pid")" started "$(get "$dir/started")" \
    finished "$(get "$dir/finished")" log "$dir/out.log ($size bytes)"
  ;;
logs)
  [ -f "$dir/out.log" ] || die "no job named '$name'"
  tail -n "$n" "$dir/out.log"
  ;;
stop)
  [ -d "$dir" ] || die "no job named '$name'"
  alive "$dir" || { echo "$name is not running ($(state "$dir"))"; exit 0; }
  p=$(cat "$dir/pid")
  # setsid made the runner a group leader; with the nohup fallback signal the runner and its children instead.
  if kill -0 -"$p" 2>/dev/null; then g=-$p what="process group $p"; else g=$p what="pid $p and its children"; fi
  sig() { [ "$g" = "$p" ] && pkill -"$1" -P "$p" 2>/dev/null; kill -"$1" "$g" 2>/dev/null; }
  sig TERM
  i=0
  while kill -0 "$g" 2>/dev/null && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
  if kill -0 "$g" 2>/dev/null; then
    sig KILL
    sleep 1
    echo "$name: sent TERM to $what, still running after 10 s, sent KILL"
  else
    echo "$name: sent TERM to $what, gone after ${i} s"
  fi
  [ -s "$dir/exit" ] || echo 137 >"$dir/exit"
  [ -s "$dir/finished" ] || now >"$dir/finished"
  echo "state $(state "$dir")"
  ;;
esac
