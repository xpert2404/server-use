# env.sh — the .env of an app, <base>/shared/.env (mode 600). SU_ACTION ls|set|rm, SU_APP, SU_KEY,
# SU_PAYLOAD_B64 (set: the value), SU_BASE. Values are never printed.
set -u

die() { printf 'env: %s\n' "$*" >&2; exit 1; }
su_b64d() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D 2>/dev/null || printf %s "$1" | openssl base64 -d -A; }

app=${SU_APP:-}
key=${SU_KEY:-}
case $app in ''|.*|*[!A-Za-z0-9_.-]*) die "bad app name '$app'" ;; esac
if [ -n "${SU_BASE:-}" ]; then base=$SU_BASE
elif [ -d "/opt/$app" ]; then base=/opt/$app
elif [ -d "$HOME/apps/$app" ]; then base=$HOME/apps/$app
elif [ "$(id -u)" = 0 ]; then base=/opt/$app
else base=$HOME/apps/$app
fi
case $base in /*) ;; "~"|"~/"*) base=$HOME${base#"~"} ;; *) base=$HOME/$base ;; esac
f=$base/shared/.env

# Keys in file order; tolerates blanks and an `export ` prefix, skips comments.
keys() { awk '{ sub(/^[ \t]*(export[ \t]+)?/, "") } /^[A-Za-z_][A-Za-z0-9_]*=/ { print substr($0, 1, index($0, "=") - 1) }' "$f"; }

# Replace the KEY line(s) with $1 in place (first occurrence keeps its position; append when absent),
# or drop them when $1 is empty. Written through a temp file, then copied over so owner and mode stay.
rewrite() {
  L=$1 K=$key awk '
    { k = $0; sub(/^[ \t]*(export[ \t]+)?/, "", k) }
    index(k, ENVIRON["K"] "=") == 1 { if (!done && ENVIRON["L"] != "") print ENVIRON["L"]; done = 1; next }
    { print }
    END { if (!done && ENVIRON["L"] != "") print ENVIRON["L"] }' "$f" >"$f.tmp.$$" &&
    cat "$f.tmp.$$" >"$f"
  rc=$?
  rm -f "$f.tmp.$$"
  return $rc
}

need_key() { case $key in ''|[0-9]*|*[!A-Za-z0-9_]*) die "bad key '$key'" ;; esac; }

case ${SU_ACTION:-} in
ls)
  [ -f "$f" ] || { echo "file $f (does not exist yet)"; exit 0; }
  echo "file $f"
  keys || exit 1
  ;;
set)
  need_key
  [ -n "${SU_PAYLOAD_B64+x}" ] || die "set needs a value"
  val=$(su_b64d "$SU_PAYLOAD_B64") || die "cannot decode the value"
  case $val in *'
'*) die "values with line breaks are not supported" ;; esac
  case $val in *[!A-Za-z0-9_./:@-]*) val="'$(printf '%s\n' "$val" | sed "s/'/'\\\\''/g")'" ;; esac
  mkdir -p "$base/shared" || die "cannot create $base/shared (not root? try --sudo, or --base under your home)"
  umask 077
  [ -e "$f" ] || : >"$f" || die "cannot create $f"
  if keys | grep -qx "$key"; then verb=updated; else verb=added; fi
  rewrite "$key=$val" || die "cannot write $f"
  echo "$verb $key in $f"
  ;;
rm)
  need_key
  [ -f "$f" ] && keys | grep -qx "$key" || die "$key is not set in $f"
  umask 077
  rewrite "" || die "cannot write $f"
  echo "removed $key from $f"
  ;;
*) die "unknown action '${SU_ACTION:-}' (ls|set|rm)" ;;
esac
