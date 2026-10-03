# deploy.sh — git releases under <base>/releases, atomic <base>/current switch, build detection, start as a
# systemd unit, detached job or compose project, health check with rollback, keep-N pruning, deploy keys and
# a cron pull check. SU_ACTION deploy|ls|rollback|key|watch-check, SU_NAME, SU_REPO, SU_REF, SU_BASE, SU_BUILD,
# SU_RUN, SU_HEALTH, SU_KEEP (3), SU_WATCH, SU_SELF_B64. Last stdout line of a deploy: SU_RESULT base=… release=…
# sha=… service=…
#
# The script itself arrives on stdin, so everything lives in functions and the one call at the bottom runs with
# stdin from /dev/null: no child (npm, docker, a health command, …) can swallow the rest of the script.
set -u
# cron and non-login shells have a short PATH; uv installs into ~/.local/bin
PATH=$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:$HOME/.local/bin
GIT_TERMINAL_PROMPT=0
export PATH GIT_TERMINAL_PROMPT

die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }
su_b64d() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D 2>/dev/null || printf %s "$1" | openssl base64 -d -A; }
mask() { printf '%s' "$1" | sed 's#://[^/@]*@#://***@#'; }

releases() { ls -1 "$rel_dir" 2>/dev/null | grep '^[0-9]\{14\}-' | sort -r; }
current() { l=$(readlink "$base/current" 2>/dev/null) && printf '%s\n' "${l##*/}"; }

# ln -sfn to a temp name, then rename over `current`; busybox mv may lack -T, then rm + mv (not atomic).
switch() {
  ln -sfn "releases/$1" "$base/.current.tmp" || return 1
  mv -T "$base/.current.tmp" "$base/current" 2>/dev/null ||
    { rm -f "$base/current" && mv "$base/.current.tmp" "$base/current"; }
}

# One deploy per base at a time. flock's lock dies with the shell; without flock there is no lock.
lock() {
  [ -z "$locked" ] || return 0
  [ -w "$state" ] || die "cannot write $state (deployed as another user? try --sudo)"
  locked=1
  has flock || return 0
  exec 9>>"$state/lock"
  flock -n 9
}

git_setup() {
  url=${SU_REPO:-}
  [ -n "$url" ] || die "no repo given"
  case $url in "~/"*) url=$HOME/${url#"~/"} ;; esac
  if [ -f "$keyfile" ]; then
    GIT_SSH_COMMAND="ssh -i '$keyfile' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    export GIT_SSH_COMMAND
    case $url in https://github.com/*/*) r=${url#https://github.com/}; url=git@github.com:${r%.git}.git ;; esac
  fi
}

compose_file() {
  for c in compose.yml compose.yaml docker-compose.yml docker-compose.yaml; do [ -f "$1/$c" ] && return 0; done
  return 1
}
dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }
compose_up() { (cd "$1" && dc -p "$proj" up -d --build --remove-orphans); }

# Build in release dir $1. A compose project is started here too (svc=compose).
build() {
  cd "$1" || return 1
  if [ -n "${SU_BUILD:-}" ]; then
    say "build: $SU_BUILD"
    sh -c "$SU_BUILD"
  elif compose_file .; then
    has docker || { echo "compose file found but docker is not installed" >&2; return 1; }
    say "build: docker compose up -d --build (project $proj)"
    svc=compose
    compose_up .
  elif [ -f package.json ]; then
    has npm || { echo "package.json found but npm is not in PATH" >&2; return 1; }
    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then set -- ci; else set -- install; fi
    say "build: npm $1 && npm run build --if-present"
    npm "$1" && npm run build --if-present
  elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
    if [ -f pyproject.toml ]; then set -- .; else set -- -r requirements.txt; fi
    if has uv; then
      say "build: uv venv .venv && uv pip install $*"
      uv venv .venv && uv pip install --python .venv/bin/python "$@"
    else
      say "build: python3 -m venv .venv && pip install $*"
      python3 -m venv .venv && .venv/bin/pip install "$@"
    fi
  else
    say "build: nothing detected (no compose file, package.json, pyproject.toml or requirements.txt)"
  fi
}

# Stop the detached run from run.pid: TERM its process group (setsid made it a leader), KILL after 10 s.
# A pid whose argv no longer names our run.sh belongs to someone else by now and is left alone.
stop_job() {
  pid=$(cat "$state/run.pid" 2>/dev/null) || return 0
  rm -f "$state/run.pid"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  [ ! -r "/proc/$pid/cmdline" ] || grep -q 'server-use/run\.sh' "/proc/$pid/cmdline" || return 0
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
  kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  say "stopped the previous run (pid $pid)"
}

start_job() {
  stop_job
  cd "$base/current" || return 1
  say "run in background: sh $state/run.sh (log $state/run.log)"
  # fd 9 is the deploy lock: the run must not inherit it
  if has setsid; then setsid sh "$state/run.sh" </dev/null >>"$state/run.log" 2>&1 9>&- &
  else nohup sh "$state/run.sh" </dev/null >>"$state/run.log" 2>&1 9>&- &
  fi
  echo $! >"$state/run.pid"
  cd "$base" || return 1
}

# systemd unit text: % is a specifier, $ an env reference, \ and ' quoting; a newline becomes \n.
sd_escape() {
  printf '%s\n' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g" -e 's/\$/$$/g' -e 's/%/%%/g' |
    awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
}
write_unit() {
  b=$(printf '%s' "$base" | sed 's/%/%%/g')
  cat >"/etc/systemd/system/$unit" <<EOF || return 1
[Unit]
Description=server-use app $name
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$b/current
EnvironmentFile=-$b/shared/.env
ExecStart=/bin/sh -c '$(sd_escape "$SU_RUN")'
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable "$unit"
}

# (Re)start the app from $base/current: $1 = <unit>.service | job | compose | none
start() {
  case $1 in
    compose) say "docker compose up (project $proj)"; compose_up "$rel_dir/$(current)" ;;
    job) start_job ;;
    none | '') ;;
    *) stop_job; say "systemctl restart $1"; systemctl restart "$1" ;;
  esac
}

# The file that holds a service's run command, and stopping a service that the next one does not replace
# ($2 = the release dir a compose project was started from).
launch_file() { case $1 in job) echo "$state/run.sh" ;; *.service) echo "/etc/systemd/system/$1" ;; esac; }
stop_svc() {
  case $1 in
    job) stop_job ;;
    compose) say "docker compose down (project $proj)"; (cd "$2" && dc -p "$proj" down) ;;
    *.service) systemctl disable --now "$1" ;;
  esac
}

healthy() {
  [ -n "${SU_HEALTH:-}" ] || return 0
  n=1
  while :; do
    out=$(cd "$base/current" && sh -c "$SU_HEALTH" 2>&1) && { say "health ok (attempt $n)"; return 0; }
    [ $n -ge 10 ] && break
    n=$((n + 1))
    sleep 3
  done
  printf 'health check failed 10 times, last output:\n%s\n' "$out" | tail -n 20 >&2
  return 1
}

prune() {  # keep the newest $keep releases, never $1 (current) or $2 (previous)
  releases | awk -v k="$keep" 'NR > k' | while read -r r; do
    [ "$r" = "$1" ] || [ "$r" = "$2" ] || { rm -rf "${rel_dir:?}/$r" && rm -f "$state/service.$r" "$state/launch.$r" && say "pruned $r"; }
  done
}

# A pull check is active while its cron entry exists: `cron rm deploy-<name>` leaves deploy.env behind.
# CRLF crontab lines still run (the CR ends up in the comment), so match without it as cron.sh does.
watching() {
  [ -f "$state/deploy.env" ] && crontab -l 2>/dev/null |
    awk -v t=" # server-use:deploy-$name" '{ sub(/\r$/, "") } substr($0, length($0) - length(t) + 1) == t { f = 1 } END { exit !f }'
}

# Once a watch exists, every deploy refreshes its settings (last deploy wins): otherwise the next pull check
# would redeploy the old ref/run/build/health over a later deploy made without --watch.
persist_watch() {
  [ "${SU_WATCH:-}" = 1 ] || watching || return 0
  SU_WATCH=1
  if [ -n "${SU_SELF_B64:-}" ]; then
    su_b64d "$SU_SELF_B64" >"$state/deploy.sh.tmp" && mv -f "$state/deploy.sh.tmp" "$state/deploy.sh" ||
      die "cannot write $state/deploy.sh"
  fi
  SU_BASE=$base
  for v in SU_NAME SU_REPO SU_REF SU_BASE SU_BUILD SU_RUN SU_HEALTH SU_KEEP SU_WATCH; do
    eval "val=\${$v:-}"
    printf "export %s='%s'\n" "$v" "$(printf '%s\n' "$val" | sed "s/'/'\\\\''/g")"
  done >"$state/deploy.env" || die "cannot write $state/deploy.env"
  say "watch: pull check settings in $state/deploy.env"
}

do_deploy() {
  has git || die "git is not installed"
  mkdir -p "$rel_dir" "$base/shared" "$state" || die "cannot create $base (not root? try --sudo, or --base under your home)"
  chmod 700 "$state"
  [ -L "$base/current" ] || [ ! -e "$base/current" ] || die "$base/current exists and is not a symlink"
  lock || die "another deploy of $name is running"
  [ -e "$base/shared/.env" ] || (umask 077 && : >"$base/shared/.env") || die "cannot create $base/shared/.env"
  prev=$(current)
  [ -n "$prev" ] && [ -d "$rel_dir/$prev" ] || prev=
  git_setup
  ts=$(date -u +%Y%m%d%H%M%S)
  tmp=$rel_dir/.tmp-$ts-$$
  say "clone $(mask "$url")${SU_REF:+ ref $SU_REF}"
  git clone -q --depth 1 ${SU_REF:+--branch "$SU_REF"} -- "$url" "$tmp" || { rm -rf "$tmp"; die "git clone failed"; }
  sha=$(git -C "$tmp" rev-parse --short HEAD) || { rm -rf "$tmp"; die "cannot read the cloned commit"; }
  rel=$ts-$sha
  [ ! -e "$rel_dir/$rel" ] || { rm -rf "$tmp"; die "release $rel already exists"; }
  mv "$tmp" "$rel_dir/$rel" && ln -sfn ../../shared/.env "$rel_dir/$rel/.env" || die "cannot set up release $rel"
  say "release $rel"

  svc=none
  if ! build "$rel_dir/$rel"; then
    cd "$base" && rm -rf "${rel_dir:?}/$rel"
    # a failed `compose up` may have replaced containers already
    [ "$svc" = compose ] && [ -n "$prev" ] && start compose && echo "ROLLED BACK to $prev"
    die "build failed; release removed, current unchanged${prev:+ ($prev)}"
  fi
  cd "$base" || die "cannot cd to $base"

  switch "$rel" || die "cannot switch $base/current"
  say "current -> releases/$rel"
  old=$(cat "$state/service" 2>/dev/null)
  case $old in job | compose | *.service) ;; *) old=none ;; esac
  launch=
  if [ -n "${SU_RUN:-}" ]; then
    if [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ] && has systemctl; then
      svc=$unit launch=/etc/systemd/system/$unit
    else
      svc=job launch=$state/run.sh
    fi
    # a rollback restarts the previous release with its own command, so keep the file this one replaces
    rm -f "$state/launch.prev"
    [ ! -f "$launch" ] || cp -p "$launch" "$state/launch.prev" || die "cannot back up $launch"
    if [ "$svc" = job ]; then
      printf '%s\n' 'set -a; [ -r ./.env ] && . ./.env; set +a' "$SU_RUN" >"$launch" || die "cannot write $launch"
    else
      write_unit || die "cannot install $launch"
    fi
  elif [ "$svc" = none ]; then
    # no --run this time: keep running the app the way the last deploy set it up
    case $old in job | *.service) svc=$old ;; esac
  fi
  echo "$svc" >"$state/service"

  if ! { [ "$svc" = compose ] || start "$svc"; } || ! healthy; then
    [ -n "$prev" ] || die "start or health check failed; no previous release to roll back to"
    # stop this deploy's run unless the previous one replaces it, then put back the run.sh or unit it replaced
    [ "$svc" = "$old" ] || stop_svc "$svc" "$rel_dir/$rel"
    if [ -n "$launch" ]; then
      if [ -f "$state/launch.prev" ]; then cp -f "$state/launch.prev" "$launch"; else rm -f "$launch"; fi
      [ "$svc" = job ] || systemctl daemon-reload
    fi
    echo "$old" >"$state/service"
    switch "$prev" && start "$old" || echo "deploy: restarting $prev failed too" >&2
    rm -rf "${rel_dir:?}/$rel"
    echo "ROLLED BACK to $prev"
    exit 1
  fi

  # how this release runs, so a manual rollback to it restarts it the same way (prune drops both files)
  echo "$svc" >"$state/service.$rel"
  launch=$(launch_file "$svc")
  [ -z "$launch" ] || cp -p "$launch" "$state/launch.$rel"
  prune "$rel" "$prev"
  persist_watch
  printf 'SU_RESULT base=%s release=%s sha=%s service=%s\n' "$base" "$rel_dir/$rel" "$sha" "$svc"
}

do_ls() {
  [ -n "$(releases)" ] || die "no releases under $base"
  printf 'base %s  service %s\n' "$base" "$(cat "$state/service" 2>/dev/null || echo none)"
  releases | awk -v c="$(current)" '{ printf "%s %s  sha %s  %s-%s-%s %s:%s:%s UTC\n", ($0 == c ? "*" : " "), $0,
    substr($0, 16), substr($0, 1, 4), substr($0, 5, 2), substr($0, 7, 2), substr($0, 9, 2), substr($0, 11, 2), substr($0, 13, 2) }'
}

do_rollback() {
  cur=$(current)
  [ -n "$cur" ] || die "no current release under $base"
  lock || die "another deploy of $name is running"
  prev=$(releases | awk -v c="$cur" 'f { print; exit } $0 == c { f = 1 }')
  [ -n "$prev" ] || die "no release before $cur to roll back to"
  old=$(cat "$state/service" 2>/dev/null) || old=none
  # restart $prev with the service and run.sh/unit it was deployed with (releases from before this have no record)
  svc=$(cat "$state/service.$prev" 2>/dev/null) || svc=$old
  launch=$(launch_file "$svc")
  switch "$prev" || die "cannot switch $base/current"
  say "current -> releases/$prev"
  [ "$svc" = "$old" ] || stop_svc "$old" "$rel_dir/$cur"
  if [ -n "$launch" ] && [ -f "$state/launch.$prev" ]; then
    cp -f "$state/launch.$prev" "$launch" || die "cannot restore $launch"
    [ "$svc" = job ] || { systemctl daemon-reload && systemctl enable "$svc"; } || die "cannot install $launch"
  fi
  echo "$svc" >"$state/service"
  start "$svc" || die "current is $prev now, but restarting it ($svc) failed"
  echo "rolled back $name: $cur -> $prev"
  if watching; then
    echo "${cur#*-}" >>"$state/watch-skip"
    echo "watch: the pull check skips ${cur#*-} and deploys again on the next new commit"
  fi
}

do_key() {
  if [ ! -f "$keyfile" ]; then
    has ssh-keygen || die "ssh-keygen not found (install openssh-client)"
    mkdir -p -m 700 "$HOME/.ssh" || die "cannot create $HOME/.ssh"
    ssh-keygen -q -t ed25519 -N "" -C "server-use-deploy-$name@$(uname -n)" -f "$keyfile" || die "ssh-keygen failed"
    echo "created $keyfile"
  fi
  echo "public key ($keyfile.pub):"
  cat "$keyfile.pub" || die "cannot read $keyfile.pub"
  echo "add it to the repo as a read-only deploy key: save the line above to a file, then"
  echo "  gh repo deploy-key add <file> -R owner/repo --title server-use-$name"
  echo "or GitHub -> repo Settings -> Deploy keys -> Add deploy key. Deploys of $name then clone over SSH with it."
}

# Cron entry point: deploy only when the remote ref moved away from the current release's commit.
watch_check() {
  git_setup
  ref=${SU_REF:-HEAD}
  remote=$(git ls-remote "$url" "$ref" | awk -v r="$ref" '
    $2 == r || $2 == "refs/heads/" r { h = $1 } $2 == "refs/tags/" r "^{}" { p = $1 } $2 == "refs/tags/" r { t = $1 }
    END { print (h != "" ? h : p != "" ? p : t) }')
  [ -n "$remote" ] || die "cannot resolve $ref in $(mask "$url")"
  cur=$(current)
  case $cur in ?*-?*) case $remote in "${cur#*-}"*) return 0 ;; esac ;; esac
  # commits (full or short sha) that failed or were rolled back are not deployed again by the pull check
  awk -v r="$remote" '$0 != "" && index(r, $0) == 1 { f = 1 } END { exit !f }' "$state/watch-skip" 2>/dev/null && return 0
  lock || { echo "watch: a deploy of $name is running, skipped"; return 0; }
  log=$state/deploy.log
  printf '=== %s watch: %s -> %s\n' "$(date)" "${cur:-none}" "$remote" >>"$log"
  if (do_deploy) >>"$log" 2>&1; then
    rm -f "$state/watch-skip"
    echo "watch: deployed $remote (log $log)"
  else
    # retrying every cycle would restart the app each time; the next push is deployed again
    echo "$remote" >>"$state/watch-skip"
    die "pull check: deploy of $remote failed, see $log"
  fi
}

main() {
  action=${SU_ACTION:-deploy}
  if [ "$action" = watch-check ]; then
    b=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) && [ -f "$b/.server-use/deploy.env" ] ||
      die "watch-check runs as <base>/.server-use/deploy.sh with deploy.env next to it (got $0)"
    . "$b/.server-use/deploy.env"
    SU_BASE=$b
  fi
  name=${SU_NAME:-}
  case $name in ''|.*|*[!A-Za-z0-9_.-]*) die "bad app name '$name'" ;; esac
  if [ -n "${SU_BASE:-}" ]; then base=$SU_BASE
  elif [ -d "/opt/$name" ]; then base=/opt/$name
  elif [ -d "$HOME/apps/$name" ]; then base=$HOME/apps/$name
  elif [ "$(id -u)" = 0 ]; then base=/opt/$name
  else base=$HOME/apps/$name
  fi
  case $base in /*) ;; "~"|"~/"*) base=$HOME${base#"~"} ;; *) base=$HOME/$base ;; esac
  base=${base%/}
  rel_dir=$base/releases
  state=$base/.server-use
  unit=server-use-$name.service
  proj=$(printf '%s' "$name" | tr 'A-Z.' 'a-z-')  # compose project names are lowercase [a-z0-9_-]
  keyfile=$HOME/.ssh/server-use-deploy-$name
  keep=${SU_KEEP:-3}
  case $keep in ''|*[!0-9]*) keep=3 ;; esac
  [ "$keep" -ge 1 ] || keep=1
  locked=
  case $action in
    deploy) do_deploy ;;
    ls) do_ls ;;
    rollback) do_rollback ;;
    key) do_key ;;
    watch-check) watch_check ;;
    *) die "unknown action '$action' (deploy|ls|rollback|key|watch-check)" ;;
  esac
}

main </dev/null
