# logs.sh — last lines of a file, a docker container or a systemd unit. SU_SOURCE, SU_LINES (200), SU_SINCE.
set -u

src=${SU_SOURCE:-}
n=${SU_LINES:-200}
since=${SU_SINCE:-}
has() { command -v "$1" >/dev/null 2>&1; }
[ -n "$src" ] || { echo "logs: no source given" >&2; exit 1; }
case $n in ''|*[!0-9]*) echo "logs: bad line count '$n'" >&2; exit 1 ;; esac
case $src in "~/"*) src=${HOME:-}/${src#"~/"} ;; esac
me=$(id -un 2>/dev/null)

# 90s / 30m / 2h / 1d (bare number = seconds) → "2 hours ago" for journalctl, Go duration for docker.
# Anything else (a timestamp, "today") is passed through unchanged.
jsince=$since dsince=$since
unit=${since##*[0-9.]}
num=${since%"$unit"}
case $num in
  ''|*[!0-9.]*) ;;
  *) case $unit in
       ''|s) jsince="$num seconds ago" dsince=${num}s ;;
       m) jsince="$num minutes ago" ;;
       h) jsince="$num hours ago" ;;
       d) jsince="$num days ago" dsince=$(awk -v n="$num" 'BEGIN {print n * 24}')h ;;
     esac ;;
esac

if [ -f "$src" ]; then
  [ -r "$src" ] || { echo "logs: $src is not readable as $me (retry with --sudo)" >&2; exit 1; }
  [ -z "$since" ] || echo "logs: --since is ignored for files" >&2
  exec tail -n "$n" -- "$src"
fi
# containers and units never contain a slash
case $src in */*)
  if [ -d "$src" ]; then
    { echo "logs: $src is a directory; newest entries:"; ls -lt -- "$src" | head -n 20; } >&2
  else
    echo "logs: no such file: $src" >&2
    [ "$(id -u)" = 0 ] || echo "logs: looked as $me; retry with --sudo if the path is not readable for $me" >&2
  fi
  exit 1 ;;
esac

if has docker && docker inspect --type container -- "$src" >/dev/null 2>&1; then
  set -- --tail "$n"
  [ -z "$since" ] || set -- "$@" --since "$dsince"
  exec docker logs "$@" -- "$src" 2>&1
fi

systemd=
[ -d /run/systemd/system ] && has systemctl && systemd=1
if [ -n "$systemd" ]; then
  case $(systemctl show -p LoadState -- "$src" 2>/dev/null) in
    LoadState=|LoadState=not-found) ;;
    LoadState=*)
      set -- -u "$src" -n "$n" --no-pager
      [ -z "$since" ] || set -- "$@" --since "$jsince"
      exec journalctl "$@" ;;
  esac
fi

{
  echo "logs: '$src' is not a file, docker container or systemd unit"
  if has docker; then
    if c=$(docker ps --format '{{.Names}}' 2>/dev/null); then echo "running containers:" ${c:-none}
    else echo "docker is installed but not usable as $me (retry with --sudo)"; fi
  fi
  if [ -n "$systemd" ]; then
    s=$(systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk -v s="$src" 'index(tolower($1), tolower(s)) {print $1}')
    echo "services containing '$src':" ${s:-none}
  fi
} >&2
exit 1
