#!/usr/bin/env bash
# Run on the AutoDL Linux host, not on Windows.
# Usage: bash bootstrap.sh [--root /root/autodl-tmp/research-hub] [--proxy-port 17897]
# No packages are installed and no credentials are copied.
set -euo pipefail
umask 077

hub_root="${HOME}/autodl-tmp/research-hub"
proxy_port=""
while (($#)); do
  case "$1" in
    --root) [[ $# -ge 2 ]] || { echo 'Missing --root value' >&2; exit 2; }; hub_root="$2"; shift 2 ;;
    --proxy-port) [[ $# -ge 2 ]] || { echo 'Missing --proxy-port value' >&2; exit 2; }; proxy_port="$2"; shift 2 ;;
    --help) sed -n '2,4p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# Generated startup snippets deliberately accept a simple absolute Linux path.
[[ "$hub_root" =~ ^/[A-Za-z0-9_./-]+$ && "$hub_root" != *'..'* ]] || {
  echo 'Root must be an absolute Linux path using letters, digits, /, _, -, or .' >&2; exit 2;
}
hub_root="${hub_root%/}"
case "$hub_root" in ''|/|/root|/home|/tmp|/usr|/etc|/var) echo 'Choose a dedicated research-hub directory.' >&2; exit 2 ;; esac
if [[ -n "$proxy_port" ]]; then
  [[ "$proxy_port" =~ ^[0-9]{1,5}$ ]] && ((10#$proxy_port >= 1024 && 10#$proxy_port <= 65535)) || {
    echo 'Proxy port must be 1024-65535.' >&2; exit 2;
  }
  proxy_port="$((10#$proxy_port))"
fi

login_shell="${SHELL:-}"
if command -v getent >/dev/null 2>&1; then
  login_shell="$(getent passwd "$(id -u)" | cut -d: -f7)"
fi
[[ "$login_shell" == */bash ]] || {
  echo 'This setup requires a Bash login shell. No shell configuration has been changed.' >&2; exit 2;
}
rc_path="${HOME}/.bashrc"
env_path="${hub_root}/env.sh"
source_line="[ ! -r '${env_path}' ] || . '${env_path}' # AutoDL Research Hub environment"
[[ ! -L "$rc_path" && ! -L "$hub_root" && ! -L "$env_path" ]] || {
  echo 'Refusing to replace a symbolic-link configuration path.' >&2; exit 2;
}
if [[ -f "$env_path" ]] && ! grep -qFx '# Managed by AutoDL Research Hub bootstrap.' "$env_path"; then
  echo 'An existing env.sh belongs to another setup; leaving it untouched.' >&2; exit 2
fi
if [[ -f "$rc_path" ]] && grep -qF '# AutoDL Research Hub environment' "$rc_path" && ! grep -qFx "$source_line" "$rc_path"; then
  echo 'A different Research Hub is already linked from .bashrc; leaving it untouched.' >&2; exit 2
fi

mkdir -p "$hub_root" "$hub_root/projects" "$hub_root/outputs" "$hub_root/tmp" \
  "$hub_root/cache/pip" "$hub_root/cache/huggingface" "$hub_root/cache/torch" \
  "$hub_root/codex" "$hub_root/vscode-server"
chmod 700 "$hub_root/codex" "$hub_root/tmp"

env_tmp="$(mktemp "${hub_root}/.env.XXXXXX")"
rc_tmp=""
cleanup() {
  [[ -z "$env_tmp" || ! -f "$env_tmp" ]] || rm -- "$env_tmp"
  [[ -z "$rc_tmp" || ! -f "$rc_tmp" ]] || rm -- "$rc_tmp"
}
trap cleanup EXIT
cat > "$env_tmp" <<EOF
# Managed by AutoDL Research Hub bootstrap.
# This file is sourced by Bash before its non-interactive early return.
export AUTODL_RESEARCH_HUB='${hub_root}'
export CODEX_HOME='${hub_root}/codex'
export VSCODE_AGENT_FOLDER='${hub_root}/vscode-server'
export TMPDIR='${hub_root}/tmp'
export XDG_CACHE_HOME='${hub_root}/cache'
export PIP_CACHE_DIR='${hub_root}/cache/pip'
export HF_HOME='${hub_root}/cache/huggingface'
export TORCH_HOME='${hub_root}/cache/torch'
# AutoDL's base Python may be absent from non-interactive SSH PATH.
# Keep an existing Python/activated environment when one is already available.
if ! command -v python >/dev/null 2>&1 && [ -x "\$HOME/miniconda3/bin/python" ]; then
  export PATH="\$HOME/miniconda3/bin:\$PATH"
fi
EOF
if [[ -n "$proxy_port" ]]; then
  cat >> "$env_tmp" <<EOF
# Requires the platform's separate SSH reverse tunnel to remain connected.
export HTTP_PROXY='http://127.0.0.1:${proxy_port}'
export HTTPS_PROXY="\$HTTP_PROXY"
export http_proxy="\$HTTP_PROXY"
export https_proxy="\$HTTP_PROXY"
export NO_PROXY='localhost,127.0.0.1,::1'
export no_proxy="\$NO_PROXY"
EOF
fi
bash -n "$env_tmp"
chmod 600 "$env_tmp"
mv -- "$env_tmp" "$env_path"
env_tmp=""

if [[ ! -e "${hub_root}/codex/config.toml" ]]; then
  printf '%s\n' 'cli_auth_credentials_store = "file"' > "${hub_root}/codex/config.toml"
  chmod 600 "${hub_root}/codex/config.toml"
fi

if [[ ! -f "$rc_path" ]] || ! grep -qFx "$source_line" "$rc_path"; then
  if [[ -f "$rc_path" && ! -e "${hub_root}/bashrc.before-research-hub" ]]; then
    cp -p -- "$rc_path" "${hub_root}/bashrc.before-research-hub"
  fi
  rc_tmp="$(mktemp "${hub_root}/.bashrc.XXXXXX")"
  printf '%s\n' "$source_line" > "$rc_tmp"
  [[ ! -f "$rc_path" ]] || cat -- "$rc_path" >> "$rc_tmp"
  bash -n "$rc_tmp"
  # Write in place to retain the original file's permissions and ownership.
  cat -- "$rc_tmp" > "$rc_path"
fi

printf 'Prepared remote research root: %s\n' "$hub_root"
printf 'Remote Codex state: %s/codex\n' "$hub_root"
printf 'Remote VS Code install path: %s/vscode-server\n' "$hub_root"
printf 'Proxy: %s\n' "${proxy_port:-unchanged (no proxy configured by this script)}"
printf '%s\n' \
  'Reconnect after stopping this host VS Code Server so it inherits the new environment.' \
  'Use local Codex with SSH, or choose the optional remote Codex launcher.' \
  'This script does not install software, copy login tokens, or start paid compute.'
