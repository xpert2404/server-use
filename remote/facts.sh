# facts.sh — OS and tooling facts as key=value lines (read by src/ops/servers.mjs). Empty value = unknown.
set -u
export LC_ALL=C

has() { command -v "$1" >/dev/null 2>&1; }
yn() { if has "$1"; then echo yes; else echo no; fi; }
# first version-looking token of `<tool> --version`, "no" when the tool is missing or fails
ver() {
  local out
  has "$1" && out=$("$@" 2>/dev/null) || { echo no; return; }
  printf '%s\n' "$out" | sed -n 's/^[^0-9]*\([0-9][0-9A-Za-z.+~-]*\).*/\1/p' | head -n 1
}

os=
[ -r /etc/os-release ] && os=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d "\"'")
[ -n "$os" ] || os=$(uname -sr)

if [ -d /run/systemd/system ]; then init=systemd
elif [ -d /run/openrc ]; then init=openrc
else init=other; fi

compose=no
if has docker && docker compose version >/dev/null 2>&1 || has docker-compose; then compose=yes; fi

tz=
if [ -L /etc/localtime ]; then
  tz=$(readlink /etc/localtime)
  case $tz in *zoneinfo/*) tz=${tz#*zoneinfo/} ;; *) tz= ;; esac
fi
if [ -z "$tz" ] && [ -r /etc/timezone ]; then tz=$(head -n 1 /etc/timezone); fi
[ -n "$tz" ] || tz=$(date +%Z)

pkg=none
for p in apt-get dnf yum apk pacman zypper brew; do
  if has "$p"; then pkg=${p%-get}; break; fi
done

uid=$(id -u)
if [ "$uid" = 0 ]; then sudo=root
elif ! has sudo; then sudo=none
elif sudo -n true </dev/null >/dev/null 2>&1; then sudo=nopasswd
else sudo=password; fi

printf '%s\n' \
  "os=$os" \
  "arch=$(uname -m)" \
  "kernel=$(uname -r)" \
  "init=$init" \
  "docker=$(ver docker --version)" \
  "compose=$compose" \
  "git=$(ver git --version)" \
  "python3=$(ver python3 --version)" \
  "node=$(ver node --version)" \
  "uv=$(yn uv)" \
  "tz=$tz" \
  "cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)" \
  "mem_mb=$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d", $1 / 1048576}')" \
  "disk_root_free_gb=$(df -Pk / 2>/dev/null | awk 'NR == 2 {printf "%.1f", $(NF - 2) / 1048576}')" \
  "pkg=$pkg" \
  "user=$(id -un 2>/dev/null)" \
  "uid=$uid" \
  "home=${HOME:-}" \
  "sudo=$sudo" \
  "crontab=$(yn crontab)" \
  "flock=$(yn flock)" \
  "setsid=$(yn setsid)"
