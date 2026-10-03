# status.sh — health snapshot as key=value lines (read by statusLine in src/ops/scripts.mjs). Unknown keys are left out.
# No heredocs or temp files: this must still work when the disk is full.
set -u
export LC_ALL=C

has() { command -v "$1" >/dev/null 2>&1; }
# a hung docker daemon or dbus must not stall the whole fleet status
t() { if has timeout; then timeout 10 "$@"; else "$@"; fi; }
kv() { [ -z "$2" ] || printf '%s=%s\n' "$1" "$2"; }

kv uptime_s "$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)"
kv load1 "$(awk '{print $1}' /proc/loadavg 2>/dev/null)"
# kernels before 3.14 have no MemAvailable: fall back to free + buffers + cached
kv mem_used_pct "$(awk '/^MemTotal:/ {t = $2} /^MemAvailable:/ {a = $2} /^(MemFree|Buffers|Cached):/ {f += $2}
  END {if (!a) a = f; if (t) printf "%d", (t - a) * 100 / t + 0.5}' /proc/meminfo 2>/dev/null)"
kv disk_root_used_pct "$(df -P / 2>/dev/null | awk 'NR == 2 {print $(NF - 1) + 0}')"

failed=- list=
if [ -d /run/systemd/system ] && units=$(t systemctl list-units --state=failed --no-legend --plain 2>/dev/null); then
  failed=$(printf '%s\n' "$units" | awk 'NF {n++} END {print n + 0}')
  list=$(printf '%s\n' "$units" | awk 'NF && ++n <= 5 {printf "%s%s", (n > 1 ? "," : ""), $1}')
fi
kv failed_units "$failed"
kv failed_list "$list"

running=- total=-
if has docker && ps=$(t docker ps -a --format '{{.Status}}' 2>/dev/null); then
  set -- $(printf '%s\n' "$ps" | awk 'NF {n++} /^Up/ {r++} END {print r + 0, n + 0}')
  running=$1 total=$2
fi
kv containers_running "$running"
kv containers_total "$total"

reboot=no
if [ -e /var/run/reboot-required ]; then reboot=yes
elif has needs-restarting && t needs-restarting -r 2>/dev/null | grep -q 'Reboot is required'; then reboot=yes; fi
kv reboot_required "$reboot"
