# watch.sh — managed cron monitoring. Setup and secrets are streamed on stdin, never process arguments.
# Installed copies default to run; management actions: on, off, ls, test, mute.
set -u
umask 077
export LC_ALL=C
SU_DIR="$HOME/.server-use"
w="$SU_DIR/watch"
action=${SU_ACTION:-run}
has() { command -v "$1" >/dev/null 2>&1; }
die() { printf 'watch: %s\n' "$1" >&2; exit 1; }
b64d() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D 2>/dev/null; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
setting() { printf '%s=' "$1"; quote "$2"; printf '\n'; }
# A privileged process must never read/write/follow a lower-privileged user's managed path.
safe() {
  local p root
  root=$(id -u)
  if [ "$root" = 0 ]; then
    # Validate every ancestor too: a root-owned directory beneath a user's writable parent can be swapped.
    p=$HOME
    case $p in /*) ;; *) die "root's managed home must be an absolute path" ;; esac
    while [ "$p" != / ]; do
      [ ! -L "$p" ] || die "refusing a symlink in the managed home ancestry"
      [ "$(stat -c %u "$p" 2>/dev/null)" = 0 ] || die "root's managed home ancestry must be owned by root"
      if [ ! -k "$p" ]; then
        [ -z "$(find "$p" -maxdepth 0 -perm /022 2>/dev/null)" ] || die "root's managed home ancestry must not be writable by other users"
      fi
      p=${p%/*}; [ -n "$p" ] || p=/
    done
  fi
  for p in "$HOME" "$SU_DIR" "$w" "$SU_DIR/cron" "$SU_DIR/logs" "$SU_DIR/logs/cron-watch.log"; do
    [ ! -L "$p" ] || die "refusing a symlink in the managed path"
    if [ -e "$p" ] && [ "$root" = 0 ]; then
      [ "$(stat -c %u "$p" 2>/dev/null)" = 0 ] || die "managed paths must be owned by root when run as root"
      [ -z "$(find "$p" -maxdepth 0 -perm /022 2>/dev/null)" ] || die "managed paths must not be writable by other users"
    fi
  done
  if [ -d "$w" ] || [ -d "$SU_DIR/cron" ]; then
    for p in "$w"/* "$w"/.[!.]* "$SU_DIR/cron"/* "$SU_DIR/cron"/.[!.]*; do
      [ -e "$p" ] || [ -L "$p" ] || continue
      [ ! -L "$p" ] || die "refusing a symlink in watch files"
      if [ "$root" = 0 ]; then
        [ "$(stat -c %u "$p" 2>/dev/null)" = 0 ] || die "watch files must be owned by root"
        [ -z "$(find "$p" -maxdepth 0 -perm /022 2>/dev/null)" ] || die "watch files must not be writable by other users"
      fi
    done
  fi
}
safe
case $action in on|off|ls|test|mute|run) ;; *) die "unknown watch action" ;; esac
if [ "$action" = ls ]; then
  if [ ! -f "$w/watch.env" ]; then echo 'watch off'; exit 0; fi
  . "$w/watch.env"
  printf 'watch on: every %ss, notify %s\n' "$WATCH_EVERY_S" "$WATCH_MODE"
  [ ! -f "$w/last_run" ] || printf 'last run: %s\n' "$(cat "$w/last_run")"
  [ ! -f "$w/last_notify" ] || printf 'last notification: %s\n' "$(cat "$w/last_notify")"
  [ ! -f "$w/notify_error" ] || echo 'notification delivery failed; the next run retries'
  [ ! -f "$w/heartbeat_error" ] || echo 'heartbeat request failed'
  [ ! -s "$w/mutes" ] || awk -F'|' -v now="$(date +%s)" '$2 > now {print "muted " $1 " until " $2}' "$w/mutes"
  exit 0
fi
if [ "$action" = on ]; then
  has curl || die "curl is required for watch"
  [ "${SU_MODE:-}" != webhook ] || [ -z "${SU_SECRET:-}" ] || has python3 || die "signed webhooks require python3 (stdlib HMAC)"
  case $w in *%*|*'
'*) die "managed path contains a character cron cannot run" ;; esac
  mkdir -p "$w" || die "cannot create watch directory"
  chmod 700 "$SU_DIR" "$w" || die "cannot secure watch directory"
  # The same lock protects management and cron runs; never replace a live check's config.
else
  if [ "$action" = off ] && [ ! -f "$w/watch.env" ]; then echo 'watch off'; exit 0; fi
  [ -f "$w/watch.env" ] || die "watch is off; use watch on first"
fi
has flock || die "flock is required for watch (util-linux)"
exec 9>"$w/.lock"
flock -w 15 9 || die "another watch operation is still running"
trap 'rm -f "$w"/*.new "$w/curl.conf" "$w/body" "$w/events" "$w/probe" "$w/http" "$w/cron-helper"' EXIT

if [ "$action" = on ]; then
  { setting WATCH_LABEL "${SU_LABEL:-server}"; setting WATCH_MODE "${SU_MODE:-ntfy}"; setting WATCH_ENDPOINT "${SU_ENDPOINT:-}";
    setting WATCH_CHAT "${SU_CHAT:-}"; setting WATCH_EVERY_S "${SU_EVERY:-300}"; setting WATCH_CHECK "${SU_CHECK:-}";
    setting WATCH_HEARTBEAT "${SU_HEARTBEAT:-}"; } >"$w/watch.env.new" || die "cannot write watch settings"
  printf %s "${SU_SECRET:-}" >"$w/secret.new" || die "cannot write credential file"
  b64d "$SU_URLS_B64" >"$w/urls.new" && b64d "$SU_WATCH_B64" >"$w/run.sh.new" && b64d "$SU_CHECK_B64" >"$w/check.sh.new" && b64d "$SU_CRON_B64" >"$w/cron-helper" || die "cannot decode watch scripts"
  cmd="/bin/sh $(quote "$w/run.sh")"
  SU_ACTION=add SU_NAME=watch SU_SCHEDULE="$SU_SCHEDULE" SU_PAYLOAD_B64=$(printf %s "$cmd" | base64 | tr -d '\n') /bin/sh "$w/cron-helper" >/dev/null 2>&1 || die "installing the managed cron entry failed; previous settings kept"
  for f in watch.env secret urls run.sh check.sh; do mv -f "$w/$f.new" "$w/$f" || die "cannot activate watch files"; done
  printf 'watch on: every %ss, notify %s\n' "$SU_EVERY" "$SU_MODE"
  [ "$SU_MODE" != ntfy ] || printf 'subscribe: %s\n' "$SU_ENDPOINT"
  exit 0
fi
if [ "$action" = off ]; then
  b64d "$SU_CRON_B64" >"$w/cron-helper" || die "cannot decode cron helper"
  SU_ACTION=rm SU_NAME=watch /bin/sh "$w/cron-helper" >/dev/null 2>&1 || die "removing the managed cron entry failed; watch kept"
  rm -f "$w/watch.env" "$w/secret" "$w/urls" "$w/run.sh" "$w/check.sh" "$w/state" "$w/mutes" "$w/notify_error" "$w/heartbeat_error"
  echo 'watch off (run and notification timestamps kept)'; exit 0
fi
. "$w/watch.env"
now=$(date +%s)
if [ "$action" = mute ]; then
  until=0; [ "${SU_MUTE_FOR:-0}" = 0 ] || until=$((now + SU_MUTE_FOR))
  [ -f "$w/mutes" ] || : >"$w/mutes"
  awk -F'|' -v key="$SU_MUTE_KEY" '$1 != key' "$w/mutes" >"$w/mutes.new"
  [ "$until" = 0 ] || printf '%s|%s\n' "$SU_MUTE_KEY" "$until" >>"$w/mutes.new"
  mv -f "$w/mutes.new" "$w/mutes" || die "cannot update mute"
  if [ "$until" = 0 ]; then printf 'unmuted %s\n' "$SU_MUTE_KEY"; else printf 'muted %s for %ss\n' "$SU_MUTE_KEY" "$SU_MUTE_FOR"; fi
  exit 0
fi

# curl gets the URL and every sensitive header from a private config on stdin. Suppress provider responses/errors.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
cfg() { printf '%s = "%s"\n' "$1" "$(esc "$2")"; }
fetch() {
  { cfg url "$1"; cfg connect-timeout 5; cfg max-time 15; printf 'silent\n'; } >"$w/curl.conf"
  curl --disable --config - --output /dev/null --write-out '%{http_code}' <"$w/curl.conf" 2>/dev/null
}
notify() {
  local signature secret endpoint
  secret=$(cat "$w/secret")
  endpoint=$WATCH_ENDPOINT
  [ "$WATCH_MODE" != telegram ] || endpoint="$endpoint/bot$secret/sendMessage"
  { cfg url "$endpoint"; cfg connect-timeout 5; cfg max-time 15; printf 'silent\nfail\n';
    case $WATCH_MODE in
      ntfy) cfg request POST; cfg header "Title: server-use $WATCH_LABEL"; [ -z "$secret" ] || cfg header "Authorization: Bearer $secret"; cfg data-binary "@$w/body" ;;
      telegram) cfg request POST; cfg data-urlencode "chat_id=$WATCH_CHAT"; cfg data-urlencode "text@$w/body" ;;
      webhook)
        cfg request POST; cfg header 'Content-Type: application/json'; cfg data-binary "@$w/body"
        if [ -n "$secret" ]; then
          signature=$(python3 -c 'import sys,hmac,hashlib; from pathlib import Path; p=Path(sys.argv[1]); print(hmac.new((p/"secret").read_bytes(),(p/"body").read_bytes(),hashlib.sha256).hexdigest())' "$w" 2>/dev/null) || return 1
          cfg header "X-Server-Use-Signature: sha256=$signature"
        fi ;;
      *) return 1 ;;
    esac
  } >"$w/curl.conf"
  curl --disable --config - --output /dev/null <"$w/curl.conf" 2>/dev/null
}
body() {
  if [ "$WATCH_MODE" = webhook ]; then
    # Check text is one line with controls removed; JSON strings still need quotes/backslashes escaped.
    awk -v host="$WATCH_LABEL" 'function json(s, i,c) {for(i=1;i<=length(s);i++) {c=substr(s,i,1); if(c=="\\" || c=="\"") printf "\\"; printf "%s",c}} BEGIN {printf "{\"host\":\""; json(host); printf "\",\"message\":\""} {if(NR>1) printf "\\n"; json($0)} END {print "\"}"}' "$1" >"$w/body"
  else cat "$1" >"$w/body"; fi
}
if [ "$action" = test ]; then
  printf 'server-use %s: test notification\n' "$WATCH_LABEL" >"$w/events"
  body "$w/events"
  notify || { printf '%s\n' "$now" >"$w/notify_error"; die "test notification failed (check destination and credential)"; }
  rm -f "$w/notify_error"
  printf '%s\n' "$now" >"$w/last_notify"
  echo 'watch test notification sent'; exit 0
fi

if ! SU_CHECK="$WATCH_CHECK" /bin/sh "$w/check.sh" >"$w/probe" 2>/dev/null || ! tail -n 1 "$w/probe" | grep -q '^now=[1-9][0-9]*$'; then
  printf 'item=crit|check|script|watch check failed or returned incomplete output\npartial=all:check failed\nnow=%s\n' "$now" >"$w/probe"
fi
n=0
while IFS='|' read -r code url || [ -n "${url:-}" ]; do
  [ -n "$url" ] || continue
  n=$((n + 1)); got=$(fetch "$url") || got=000
  if [ "$code" = ok ]; then case $got in 2??|3??) continue ;; esac; else [ "$got" != "$code" ] || continue; fi
  printf 'item=warn|http|%s|HTTP probe %s returned %s (expected %s)\n' "$n" "$n" "$got" "$code" >>"$w/probe"
done <"$w/urls"
[ -f "$w/state" ] || : >"$w/state"
[ -f "$w/mutes" ] || : >"$w/mutes"
: >"$w/events"
# State: kind|id|severity|text|consecutive failures|clean runs|active|last notification|notified severity.
# Partial probes retain previous findings. A new fault and a recovery each need two consecutive observations.
awk -F'|' -v now="$now" -v events="$w/events" '
  function rank(s) {return s=="crit" ? 2 : s=="warn" ? 1 : 0}
  function muted(k) {return m["all"] > now || m[k] > now}
  FILENAME==ARGV[1] {m[$1]=$2; next}
  FILENAME==ARGV[2] {k=$1 ":" $2; old[k]=$0; next}
  /^partial=/ {p=substr($0,9); sub(/:.*/,"",p); blind[p]=1; next}
  /^item=(warn|crit)\|/ {k=$2 ":" $3; kind[k]=$2; id[k]=$3; sev[k]=substr($1,6); text[k]=$4; seen[k]=1}
  END {
    for(k in old) if (!(k in seen)) {
      split(old[k],v,"|")
      if (blind[v[1]] || (blind["disk"] && v[1]=="inodes") || (blind["all"] && v[1]!="check" && v[1]!="http")) {
        print v[1] "|" v[2] "|" v[3] "|" v[4] "|0|0|" v[7] "|" v[8] "|" v[9]; continue
      }
      clean=v[6]+1
      if (v[7] && clean < 2) {v[5]=0; v[6]=clean; print v[1] "|" v[2] "|" v[3] "|" v[4] "|0|" clean "|" v[7] "|" v[8] "|" v[9]}
      else if (v[7] && v[9]!="" && !muted(k)) {print "RESOLVED " k >>events}
    }
    for(k in seen) {
      split(old[k],v,"|"); count=(v[3]==sev[k] ? v[5]+1 : 1); active=v[7]+0; last=v[8]+0; sent=v[9]
      if (count>=2) active=1
      if (count>=2 && !muted(k) && (sent=="" || rank(sev[k])>rank(sent) || now-last>=21600)) {
        print toupper(sev[k]) " " k ": " text[k] >>events; last=now; sent=sev[k]
      }
      print kind[k] "|" id[k] "|" sev[k] "|" text[k] "|" count "|0|" active "|" last "|" sent
    }
  }' "$w/mutes" "$w/state" "$w/probe" >"$w/state.new" || die "cannot update watch observations"
sent=0
if [ -s "$w/events" ]; then
  body "$w/events"
  if notify; then sent=1; printf '%s\n' "$now" >"$w/last_notify"; rm -f "$w/notify_error"
  else
    # Keep old delivery markers so the next run retries; retain resolved records until delivery succeeds.
    awk -F'|' 'FILENAME==ARGV[1] {k=$1 ":" $2; old[k]=$0; next} {k=$1 ":" $2; have[k]=1; split(old[k],v,"|"); print $1 "|" $2 "|" $3 "|" $4 "|" $5 "|" $6 "|" $7 "|" v[8] "|" v[9]} END {for(k in old) if (!(k in have)) {split(old[k],v,"|"); if (v[7] && v[9]!="") print old[k]}}' "$w/state" "$w/state.new" >"$w/retry.new"
    mv -f "$w/retry.new" "$w/state.new"
    printf '%s\n' "$now" >"$w/notify_error"
    echo 'watch notification failed; next run will retry'
  fi
fi
mv -f "$w/state.new" "$w/state" || die "cannot save watch state"
printf '%s\n' "$now" >"$w/last_run"
heartbeat=none
if [ -n "$WATCH_HEARTBEAT" ]; then
  heartbeat=failed
  got=$(fetch "$WATCH_HEARTBEAT") || got=000
  case $got in 2??|3??) heartbeat=ok ;; esac
  if [ "$heartbeat" = ok ]; then rm -f "$w/heartbeat_error"; else printf '%s\n' "$now" >"$w/heartbeat_error"; fi
fi
printf 'watch checked: notification=%s heartbeat=%s\n' "$sent" "$heartbeat"
