#!/usr/bin/env bash
set -euo pipefail
umask 077
hub_root="$1"; project="$2"; binary="$3"; proxy_port="$4"; mode="$5"
[[ "$hub_root" == /* && "$hub_root" != / && "$hub_root" != *"/../"* && "$hub_root" != */.. ]] || exit 2
[[ "$project" == /* && "$project" != *"/../"* && "$project" != */.. ]] || exit 2
[[ "$binary" == /* && -x "$binary" ]] || { printf 'Remote Codex binary is unavailable.\n' >&2; exit 2; }
[[ "$proxy_port" =~ ^[0-9]+$ && "$proxy_port" -le 65535 ]] || exit 2
no_links() {
  local part current=""
  IFS='/' read -r -a components <<< "$1"
  for part in "${components[@]}"; do
    [[ -z "$part" ]] && continue
    current="$current/$part"
    [[ ! -L "$current" ]] || { printf 'Refusing linked Codex credential directory.\n' >&2; exit 2; }
  done
}
export CODEX_HOME="$hub_root/codex-remote"
no_links "$CODEX_HOME"
no_links "$hub_root/cache"
no_links "$hub_root/tmp"
mkdir -p -- "$CODEX_HOME" "$hub_root/cache" "$hub_root/tmp"
[[ -d "$CODEX_HOME" && -O "$CODEX_HOME" ]] || { printf 'CODEX_HOME must belong to this SSH user.\n' >&2; exit 2; }
chmod 700 -- "$CODEX_HOME"
[[ ! -L "$CODEX_HOME/auth.json" && ! -L "$CODEX_HOME/config.toml" ]] || { printf 'Refusing linked Codex authentication or config file.\n' >&2; exit 2; }
if [[ ! -e "$CODEX_HOME/config.toml" ]]; then
  printf 'cli_auth_credentials_store = "file"\n' > "$CODEX_HOME/config.toml"
  chmod 600 "$CODEX_HOME/config.toml"
fi
export XDG_CACHE_HOME="$hub_root/cache"
export TMPDIR="$hub_root/tmp"
if [[ "$proxy_port" -gt 0 ]]; then
  export HTTP_PROXY="http://127.0.0.1:$proxy_port" HTTPS_PROXY="http://127.0.0.1:$proxy_port"
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY"
  export NO_PROXY="localhost,127.0.0.1,::1" no_proxy="localhost,127.0.0.1,::1"
fi
logged_in() { "$binary" login status >/dev/null 2>&1; }
case "$mode" in
  status)
    if logged_in; then printf 'HUB_AUTH_V1\tstored-login-recognized\n'; else exit 10; fi
    ;;
  receive-auth)
    if logged_in; then printf 'HUB_AUTH_V1\texisting-login-preserved\n'; exit 0; fi
    [[ ! -e "$CODEX_HOME/auth.json" || ( -f "$CODEX_HOME/auth.json" && -O "$CODEX_HOME/auth.json" ) ]] || { printf 'Invalid authentication target.\n' >&2; exit 2; }
    auth_temp="$(mktemp "$CODEX_HOME/.auth.XXXXXXXXXX")"
    trap 'rm -f -- "$auth_temp"' EXIT
    chmod 600 -- "$auth_temp"
    cat > "$auth_temp"
    [[ -s "$auth_temp" && "$(stat -c %s "$auth_temp")" -le 262144 ]] || { printf 'Invalid authentication payload size.\n' >&2; exit 2; }
    [[ ! -L "$CODEX_HOME/auth.json" ]] || { printf 'Authentication target became a link.\n' >&2; exit 2; }
    mv -fT -- "$auth_temp" "$CODEX_HOME/auth.json"
    trap - EXIT
    if logged_in; then printf 'HUB_AUTH_V1\ttransferred-login-recognized\n'
    else printf 'Transferred auth.json was not recognized by Codex login status.\n' >&2; exit 11
    fi
    ;;
  launch)
    if ! logged_in; then
      printf 'Complete the Codex device login shown below. No local credentials were printed.\n'
      "$binary" login --device-auth
      logged_in || { printf 'Codex has no recognized login after device authentication.\n' >&2; exit 10; }
    fi
    mkdir -p -- "$project"
    cd -- "$project"
    printf '[Remote Codex] host=%s user=%s cwd=%s\n' "$(hostname)" "$(id -un)" "$PWD"
    printf '[Remote Codex] CODEX_HOME=%s\n' "$CODEX_HOME"
    if ! "$binary" sandbox linux /bin/true >/dev/null 2>&1; then
      printf '[Remote Codex] Sandbox self-check did not pass on this host.\n'
      printf '[Remote Codex] Some containers block Linux namespaces. Keep normal approvals; request approval for a specific command if needed.\n'
      printf '[Remote Codex] The launcher has not disabled the sandbox or changed kernel settings. Windows Codex + SSH remains available.\n'
    fi
    exec "$binary" --sandbox workspace-write --ask-for-approval on-request
    ;;
  *) printf 'Unknown remote session action.\n' >&2; exit 2 ;;
esac
