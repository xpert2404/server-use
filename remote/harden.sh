# harden.sh — SU_ACTION install-key|lock-password|unlock-password|agent-user|check (contract: remote/README.md).
# lock-password leaves the sshd config as it was whenever it exits non-zero.
set -u
export LC_ALL=C
umask 077
PATH=$PATH:/usr/sbin:/sbin:/usr/local/sbin

CFG=/etc/ssh/sshd_config
DROPIN=/etc/ssh/sshd_config.d/00-server-use.conf
BAK=$CFG.server-use.bak
GECOS='server-use agent'
DROPIN_TEXT='# server-use harden --lock-password: key-only SSH login. Delete this file to allow passwords again.
PasswordAuthentication no
KbdInteractiveAuthentication no'
BLOCK='# >>> server-use (harden --lock-password) >>>
PasswordAuthentication no
KbdInteractiveAuthentication no
# <<< server-use <<<'

has() { command -v "$1" >/dev/null 2>&1; }
die() { printf 'harden: %s\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "${SU_ACTION:-} needs root (re-run with sudo)"; }
pw() { awk -F: -v u="$1" -v f="$2" '$1 == u { print $f; exit }' /etc/passwd; }

# Rebuild SU_PUBKEY as one "type base64 [comment]" line, so a newline in the value cannot add a second entry.
parse_key() {
  set -f; set -- ${SU_PUBKEY:-}; set +f
  KTYPE=${1:-} KB64=${2:-}
  case $KTYPE in ssh-*|ecdsa-*|sk-*) ;; *) die 'SU_PUBKEY is not an OpenSSH public key' ;; esac
  case $KB64 in ''|*[!A-Za-z0-9+/=]*) die 'SU_PUBKEY is not an OpenSSH public key' ;; esac
  shift 2
  KEY="$KTYPE $KB64${*:+ $*}"
  export KTYPE KB64 KEY
}

# A program for its own sh (KTYPE KB64 KEY from the environment): agent-user runs it as the target user, so root
# never writes or chowns through a ~/.ssh that user controls (symlink swap, hardlink to a root file).
INSTALL_KEY=$(cat <<'EOF'
d=$HOME/.ssh f=$HOME/.ssh/authorized_keys
mkdir -p "$d" && chmod 700 "$d" && touch "$f" && chmod 600 "$f" || exit 1
# match type + base64 as adjacent fields, so option-prefixed lines count and comments do not matter
if awk -v t="$KTYPE" -v k="$KB64" '{ for (i = 1; i < NF; i++) if ($i == t && $(i + 1) == k) found = 1 }
  END { exit !found }' "$f"; then
  echo 'key already present'
else
  [ -n "$(tail -c 1 "$f")" ] && echo >> "$f"
  printf '%s\n' "$KEY" >> "$f" || exit 1
  echo 'key installed'
fi
command -v restorecon >/dev/null 2>&1 && restorecon -R "$d" 2>/dev/null
exit 0
EOF
)

locked_by_us() { [ -f "$DROPIN" ] || grep -q '^# >>> server-use' "$CFG" 2>/dev/null; }

undo_lock() {
  rm -f "$DROPIN" || return 1
  grep -q '^# >>> server-use' "$CFG" 2>/dev/null || return 0
  grep -q '^# <<< server-use' "$CFG" || { echo "harden: the server-use block in $CFG lost its end marker" >&2; return 1; }
  cp -p "$CFG" "$CFG.su-tmp" && sed '/^# >>> server-use/,/^# <<< server-use/d' "$CFG" > "$CFG.su-tmp" &&
    mv -f "$CFG.su-tmp" "$CFG" && rm -f "$BAK"
}

effective() { "$SSHD" -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication) '; }

reload_sshd() {
  [ "$(uname -s)" = Darwin ] && return 0 # launchd starts sshd per connection, nothing to reload
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null ||
    service ssh reload >/dev/null 2>&1 || service sshd reload >/dev/null 2>&1 ||
    kill -HUP "$(cat /run/sshd.pid 2>/dev/null || cat /var/run/sshd.pid 2>/dev/null || pgrep -o -x sshd)" 2>/dev/null
}

fail() {
  rm -f "$CFG.su-tmp"
  if [ "$changed" = 1 ]; then undo_lock || die "$1; undoing the change FAILED, check $CFG and $DROPIN by hand"; fi
  die "$1; the sshd config is unchanged"
}

lock() {
  need_root
  SSHD=$(command -v sshd) || die 'sshd not found'
  [ -f "$CFG" ] || die "$CFG not found"
  changed=0
  if locked_by_us; then
    echo 'server-use password lock already in place'
  elif grep -Eiq '^[[:space:]]*Include[[:space:]].*sshd_config\.d/\*' "$CFG"; then
    # 00- sorts before e.g. 50-cloud-init.conf (PasswordAuthentication yes); sshd keeps the first value
    changed=1
    mkdir -p "${DROPIN%/*}" && printf '%s\n' "$DROPIN_TEXT" > "$DROPIN" || fail "cannot write $DROPIN"
    echo "wrote $DROPIN"
  else
    changed=1
    cp -p "$CFG" "$BAK" && cp -p "$CFG" "$CFG.su-tmp" && { printf '%s\n' "$BLOCK"; cat "$BAK"; } > "$CFG.su-tmp" &&
      mv -f "$CFG.su-tmp" "$CFG" || fail "cannot rewrite $CFG"
    echo "added the settings at the top of $CFG (backup: $BAK)"
  fi
  out=$("$SSHD" -t 2>&1) || fail "sshd -t rejected the config: $out"
  eff=$(effective)
  printf '%s\n' "$eff" | grep -qx 'passwordauthentication no' ||
    fail "password login would stay on (sshd -T: $(printf '%s' "$eff" | tr '\n' ' ')); set in: $(grep -iE '^[[:space:]]*PasswordAuthentication' "$CFG" /etc/ssh/sshd_config.d/*.conf 2>/dev/null | tr '\n' ' ')"
  reload_sshd || fail 'could not reload sshd (systemctl, service and kill -HUP failed)'
  sleep 1 # sshd re-executes on SIGHUP; let it listen again before the client's key-only probe
  printf '%s\n' "$eff"
}

unlock() {
  need_root
  SSHD=$(command -v sshd) || die 'sshd not found'
  locked_by_us || { echo 'nothing to undo: server-use has not locked password login here'; return 0; }
  undo_lock || die 'could not undo the lock'
  out=$("$SSHD" -t 2>&1) || die "sshd -t rejects the config, not reloading: $out"
  reload_sshd || die 'could not reload sshd; password login returns at the next sshd restart'
  echo 'server-use password lock removed'
  effective
}

agent_user() {
  need_root
  parse_key
  u=${SU_AGENT_USER:-}
  case $u in ''|-*|*[!a-z0-9_-]*) die "bad SU_AGENT_USER '$u'" ;; esac
  if id "$u" >/dev/null 2>&1; then
    # never touch an account we did not create (an admin, root, a service user)
    [ "$(pw "$u" 5)" = "$GECOS" ] || die "user $u already exists and was not created by server-use; choose another name"
    echo "user $u exists (created by server-use)"
  else
    sh=/bin/sh
    [ -x /bin/bash ] && sh=/bin/bash
    if has useradd; then useradd -m -s "$sh" -c "$GECOS" "$u"; else adduser -D -s "$sh" -g "$GECOS" "$u"; fi ||
      die "could not create user $u (needs useradd or busybox adduser)"
    echo "created user $u (login shell $sh, no sudo)"
  fi
  home=$(pw "$u" 6)
  [ -n "$home" ] && [ -d "$home" ] || die "home directory of $u not found"
  # "*" rather than "!": sshd without PAM (Alpine) rejects even key logins for "!"-locked accounts
  printf '%s:*\n' "$u" | chpasswd -e 2>/dev/null || usermod -p '*' "$u" || die "could not lock the password of $u"
  echo "password login disabled for $u"
  # root needs no password for su (util-linux and busybox); without -l it keeps the env and sets HOME to $home.
  # </dev/null: a PAM prompt must not eat the rest of this script from stdin
  su -s /bin/sh -c "$INSTALL_KEY" "$u" </dev/null || die "could not install the key for $u (as $u, via su)"
}

opt() { # effective sshd setting from `sshd -T`
  v=$(printf '%s\n' "$T" | awk -v k="$1" '$1 == k { print $2; exit }')
  printf '%s' "${v:-unknown}"
}

check() {
  T=
  SSHD=$(command -v sshd) && T=$("$SSHD" -T 2>/dev/null)
  [ -n "$T" ] || echo 'ssh settings: unknown (sshd -T needs root)'
  echo "ssh root login: $(opt permitrootlogin)"
  echo "ssh password auth: $(opt passwordauthentication) (keyboard-interactive: $(opt kbdinteractiveauthentication))"
  echo "ssh pubkey auth: $(opt pubkeyauthentication)"

  if ! has fail2ban-client; then f2b='not installed'
  elif systemctl is-active --quiet fail2ban 2>/dev/null || pgrep -f fail2ban-server >/dev/null 2>&1; then f2b='installed, active'
  else f2b='installed, not running'; fi
  echo "fail2ban: $f2b"

  if has ufw; then s=$(ufw status 2>/dev/null | sed -n 's/^Status: //p'); fw="ufw ${s:-unknown}"
  elif has firewall-cmd; then fw="firewalld $(firewall-cmd --state 2>&1)"
  elif has nft; then
    if n=$(nft list tables 2>/dev/null); then fw="nftables, $(printf '%s\n' "$n" | grep -c .) tables"; else fw='nftables, unknown'; fi
  else fw='none found (ufw/firewalld/nft)'; fi
  echo "firewall: $fw"

  if has apt-config; then
    ua=off
    [ -x /usr/bin/unattended-upgrade ] && apt-config dump 2>/dev/null | grep -q '^APT::Periodic::Unattended-Upgrade "1"' &&
      ua='on (unattended-upgrades)'
  elif systemctl is-enabled dnf-automatic.timer dnf-automatic-install.timer dnf5-automatic.timer 2>/dev/null | grep -qx enabled; then
    ua='on (dnf-automatic)'
  else ua=off; fi
  echo "unattended upgrades: $ua"

  rb=no
  if [ -f /var/run/reboot-required ]; then rb=yes
  elif has needs-restarting; then needs-restarting -r >/dev/null 2>&1; [ $? = 1 ] && rb=yes; fi
  echo "reboot pending: $rb"

  if has ss; then l=$(ss -tlnp 2>/dev/null); else l=$(netstat -tlnp 2>/dev/null || netstat -tln 2>/dev/null); fi
  # both put the address in $4; ss prints users:(("name",pid=..)), netstat -p "pid/name" (name may contain spaces)
  l=$(printf '%s\n' "$l" | awk '$4 ~ /:[0-9]+$/ {
      p = ""
      if (match($0, /users:\(\("[^"]*"/)) p = substr($0, RSTART + 9, RLENGTH - 10)
      else for (i = 5; i <= NF; i++) if ($i ~ /^[0-9]+\//) { p = substr($i, index($i, "/") + 1); sub(/:$/, "", p); break }
      print $4 (p == "" ? "" : "(" p ")") }' | sort -u | tr '\n' ' ')
  echo "listening tcp: ${l:-unknown}"
}

case ${SU_ACTION:-} in
  install-key) parse_key; sh -c "$INSTALL_KEY" || die "could not write $HOME/.ssh/authorized_keys" ;;
  lock-password) lock ;;
  unlock-password) unlock ;;
  agent-user) agent_user ;;
  check) check ;;
  *) die 'SU_ACTION must be install-key, lock-password, unlock-password, agent-user or check' ;;
esac
