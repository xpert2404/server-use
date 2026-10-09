# job.sh — detached runs that survive the SSH channel closing. SU_ACTION start|ls|logs|stop|status|wait, SU_NAME,
# SU_LINES (100), SU_PAYLOAD_B64 + SU_MAX_TIME seconds (start), SU_TAIL=1 (wait: also tail while running).
# State in $SU_DIR/jobs/<name>/: cmd.sh out.log pid exit started finished t0 t1 (epoch seconds of start/end).
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
dur() { # seconds -> 42s | 3m05s | 2h13m ("?" when unknown)
  case $1 in ''|*[!0-9]*) printf '?'; return ;; esac
  if [ "$1" -ge 3600 ]; then printf '%dh%02dm' $(($1 / 3600)) $(($1 % 3600 / 60))
  elif [ "$1" -ge 60 ]; then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60))
  else printf '%ds' "$1"; fi
}
fsize() { # bytes -> 812 B | 12 KB | 12.3 MB
  if [ "$1" -ge 1048576 ]; then printf '%d.%d MB' $(($1 * 10 / 1048576 / 10)) $(($1 * 10 / 1048576 % 10))
  elif [ "$1" -ge 1024 ]; then printf '%d KB' $(($1 / 1024))
  else printf '%d B' "$1"; fi
}

case $action in
  ls) ;;
  start|logs|stop|status|wait) case $name in ''|.*|*[!A-Za-z0-9_.-]*) die "bad job name '$name'" ;; esac ;;
  *) die "unknown action '$action' (start|ls|logs|stop|status|wait)" ;;
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
  { tr '\0' '\n' <"/proc/$p/cmdline"; } 2>/dev/null | grep -qxF -- "$1"
}
state() {
  if [ -s "$1/exit" ]; then echo "exited $(cat "$1/exit")"
  elif alive "$1"; then echo running
  # The runner may have recorded its exit and disappeared during the liveness probe.
  elif [ -s "$1/exit" ]; then echo "exited $(cat "$1/exit")"
  else echo unknown; fi
}
# Seconds the job ran (so far); empty when unknown (a job started before t0 existed).
secs() {
  local a b
  a=$(cat "$1/t0" 2>/dev/null)
  b=
  [ -s "$1/exit" ] && b=$(cat "$1/t1" 2>/dev/null)
  case $b in ''|*[!0-9]*) b=$(date +%s) ;; esac
  case $a in ''|*[!0-9]*) return 0 ;; esac
  echo $((b - a))
}

case $action in
start)
  [ -n "${SU_PAYLOAD_B64:-}" ] || die "start needs a command"
  max=${SU_MAX_TIME:-}
  case $max in *[!0-9]*|0*) die "bad max time '$max'" ;; esac
  tmo=
  if [ -n "$max" ]; then
    if timeout -k 1 1 true </dev/null >/dev/null 2>&1; then tmo="timeout -k 30 $max"
    else die "--max-time requires a working timeout command with -k; job was not started"; fi
  fi
  alive "$dir" && die "$name is already running (pid $(cat "$dir/pid")); stop it first or pick another name"
  mkdir -p "$dir" && chmod 700 "$SU_DIR" || die "cannot create $dir"
  su_b64d "$SU_PAYLOAD_B64" >"$dir/cmd.sh" || die "cannot decode the command payload"
  rm -f "$dir/pid" "$dir/exit" "$dir/finished" "$dir/t1"
  now >"$dir/started"
  date +%s >"$dir/t0"
  sh=sh
  has bash && sh=bash
  detach=nohup
  has setsid && detach=setsid
  # No fd of the SSH channel may stay open in the runner, or the channel (and our caller) waits for the job.
  # The runner traps TERM so it outlives the command and records its exit code after `stop`. It raises its
  # oom_score_adj first (children inherit it; raising needs no privilege), so under memory pressure the OOM killer
  # takes the job before sshd or the app. $3 is the optional timeout prefix: the exit file then holds 124, or 137 after the KILL.
  $detach sh -c '[ -w /proc/self/oom_score_adj ] && { echo 500 >/proc/self/oom_score_adj; } 2>/dev/null; echo $$ >"$1/pid"; trap : TERM; $3 "$2" "$1/cmd.sh"; rc=$?; date +%s >"$1/t1"; echo $rc >"$1/exit"; date +%Y-%m-%dT%H:%M:%S%z >"$1/finished"' \
    su-job "$dir" "$sh" "$tmo" </dev/null >"$dir/out.log" 2>&1 &
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
    [ $found = 1 ] || printf '%-24s %-9s %-25s %-5s %s\n' NAME STATE STARTED EXIT ELAPSED
    found=1
    st=$(state "$d")
    printf '%-24s %-9s %-25s %-5s %s\n' "${d##*/}" "${st%% *}" "$(get "$d/started")" "$(get "$d/exit")" "$(dur "$(secs "$d")")"
  done
  [ $found = 1 ] || echo "no jobs"
  ;;
status)
  [ -d "$dir" ] || die "no job named '$name'"
  size=0
  [ -f "$dir/out.log" ] && size=$(($(wc -c <"$dir/out.log")))
  printf '%-9s %s\n' name "$name" state "$(state "$dir")" pid "$(get "$dir/pid")" started "$(get "$dir/started")" \
    finished "$(get "$dir/finished")" elapsed "$(dur "$(secs "$dir")")" log "$dir/out.log ($size bytes)"
  ;;
wait)
  # One look at the job; the daemon polls this, so no SSH session is held while the job runs.
  # The first line (SU_JOB state= code= started=) is for the daemon, the rest for the agent.
  [ -d "$dir" ] || die "no job named '$name'"
  st=$(state "$dir")
  code=
  case $st in exited*) code=${st#exited } ;; esac
  printf 'SU_JOB state=%s code=%s started=%s\n' "${st%% *}" "$code" "$(get "$dir/started")"
  [ "$st" = running ] && [ "${SU_TAIL:-}" != 1 ] && exit 0
  case $st in
    exited*) printf '%s exited %s after %s (started %s)\n' "$name" "$code" "$(dur "$(secs "$dir")")" "$(get "$dir/started")" ;;
    running)
      size=0
      [ -f "$dir/out.log" ] && size=$(($(wc -c <"$dir/out.log")))
      printf '%s still running after %s (pid %s, log %s); call job wait again\n' "$name" "$(dur "$(secs "$dir")")" "$(get "$dir/pid")" "$(fsize "$size")" ;;
    *) printf '%s unknown: runner gone without exit code (server rebooted?)\n' "$name" ;;
  esac
  [ -f "$dir/out.log" ] && tail -n "$n" "$dir/out.log"
  exit 0
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
  # A --max-time job runs under `timeout`, which leads a process group of its own: signal those groups as well.
  sig() {
    [ "$g" = "$p" ] && pkill -"$1" -P "$p" 2>/dev/null
    for c in $(pgrep -P "$p" 2>/dev/null); do kill -"$1" -"$c" 2>/dev/null; done
    kill -"$1" "$g" 2>/dev/null
  }
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
  [ -s "$dir/t1" ] || date +%s >"$dir/t1"
  [ -s "$dir/exit" ] || echo 137 >"$dir/exit"
  [ -s "$dir/finished" ] || now >"$dir/finished"
  echo "state $(state "$dir")"
  ;;
esac
