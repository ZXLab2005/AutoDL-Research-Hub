#!/usr/bin/env bash
set -euo pipefail
requested_root="${1-}"
project="${2-}"
safe_path() { [[ "$1" == /* && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *$'\t'* && "$1" != *"/../"* && "$1" != */.. && "$1" != *"/./"* && "$1" != */. ]]; }
no_links() {
  local part current=""
  IFS='/' read -r -a components <<< "$1"
  for part in "${components[@]}"; do
    [[ -z "$part" ]] && continue
    current="$current/$part"
    [[ ! -L "$current" ]] || { printf 'Refusing linked remote directory: %s\n' "$current" >&2; exit 2; }
  done
}
[[ "$(uname -s)" == Linux ]] || { printf 'Remote Codex requires Linux.\n' >&2; exit 2; }
case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) printf 'Unsupported remote architecture.\n' >&2; exit 2 ;; esac
safe_path "$HOME" || { printf 'Remote HOME is not a safe absolute path.\n' >&2; exit 2; }
if [[ -n "$requested_root" ]]; then hub_root="$requested_root"
elif [[ -d "$HOME/autodl-tmp" ]]; then hub_root="$HOME/autodl-tmp/research-hub"
else hub_root="$HOME/.local/share/autodl-research-hub"
fi
safe_path "$hub_root" && safe_path "$project" || { printf 'Invalid remote path.\n' >&2; exit 2; }
no_links "$hub_root"
if [[ -e "$hub_root" ]]; then
  [[ -d "$hub_root" && -O "$hub_root" && -w "$hub_root" ]] || { printf 'RemoteRoot must be a writable directory owned by this SSH user.\n' >&2; exit 2; }
fi
binary=""
version=""
for candidate in "$hub_root/tools/codex/current/bin/codex" "$(command -v codex || true)"; do
  [[ "$candidate" == /* && -x "$candidate" ]] || continue
  if [[ "$candidate" == "$hub_root/tools/codex/current/bin/codex" ]]; then
    [[ -f "$hub_root/tools/codex/current/codex-package.json" && -x "$hub_root/tools/codex/current/bin/codex-code-mode-host" && -x "$hub_root/tools/codex/current/codex-path/rg" && -x "$hub_root/tools/codex/current/codex-resources/bwrap" ]] || continue
  fi
  found_version="$("$candidate" --version 2>/dev/null || true)"
  case "$found_version" in codex-cli\ [0-9]*|codex\ [0-9]*) binary="$candidate"; version="$found_version"; break ;; esac
done
printf 'HUB_REMOTE_V1\t%s\t%s\t%s\t%s\n' "$arch" "$hub_root" "$binary" "$version"
