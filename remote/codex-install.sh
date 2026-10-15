#!/usr/bin/env bash
set -euo pipefail
umask 077
action="$1"; hub_root="$2"; version="$3"; target="$4"; sha256="$5"; nonce="$6"
[[ "$hub_root" == /* && "$hub_root" != / && "$hub_root" != *"/../"* && "$hub_root" != */.. ]] || exit 2
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || exit 2
[[ "$target" == x86_64-unknown-linux-musl || "$target" == aarch64-unknown-linux-musl ]] || exit 2
[[ "$sha256" =~ ^[a-f0-9]{64}$ && "$nonce" =~ ^[a-f0-9]{24}$ ]] || exit 2
no_links() {
  local part current=""
  IFS='/' read -r -a components <<< "$1"
  for part in "${components[@]}"; do
    [[ -z "$part" ]] && continue
    current="$current/$part"
    [[ ! -L "$current" ]] || { printf 'Refusing linked installation path.\n' >&2; exit 2; }
  done
}
base="$hub_root/tools/codex"
no_links "$base/versions"
mkdir -p -- "$base/versions"
[[ -O "$hub_root" && -O "$base" && -O "$base/versions" ]] || { printf 'Installation directories must belong to this SSH user.\n' >&2; exit 2; }
stage="$base/.stage-$nonce"
release="$base/versions/$version-$target"
case "$action" in
  prepare)
    [[ ! -e "$stage" && ! -L "$stage" ]] || { printf 'Staging directory already exists.\n' >&2; exit 2; }
    mkdir -m 700 -- "$stage"
    printf 'HUB_STAGE_V1\t%s\n' "$stage"
    ;;
  install)
    [[ -d "$stage" && ! -L "$stage" && -O "$stage" ]] || { printf 'Invalid staging directory.\n' >&2; exit 2; }
    trap 'rm -rf -- "$stage"' EXIT
    archive="$stage/package.tar.gz"
    [[ -f "$archive" && ! -L "$archive" ]] || exit 2
    printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c - >/dev/null
    tar -tzf "$archive" > "$stage/members"
    while IFS= read -r member; do
      case "$member" in /*|../*|*/../*|*/..|*\\*) printf 'Unsafe archive member.\n' >&2; exit 2 ;; esac
    done < "$stage/members"
    if tar -tvzf "$archive" | LC_ALL=C grep -vE '^[-d]' > /dev/null; then printf 'Archive contains unsupported links or special files.\n' >&2; exit 2; fi
    mkdir -m 700 -- "$stage/unpacked"
    tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$stage/unpacked"
    for file in codex-package.json bin/codex bin/codex-code-mode-host codex-path/rg codex-resources/bwrap; do
      [[ -f "$stage/unpacked/$file" && ! -L "$stage/unpacked/$file" ]] || { printf 'Incomplete official Codex package: %s\n' "$file" >&2; exit 2; }
    done
    chmod 755 "$stage/unpacked/bin/codex" "$stage/unpacked/bin/codex-code-mode-host" "$stage/unpacked/codex-path/rg" "$stage/unpacked/codex-resources/bwrap"
    installed_version="$("$stage/unpacked/bin/codex" --version)"
    [[ "$installed_version" == "codex-cli $version" || "$installed_version" == "codex $version" ]] || { printf 'Downloaded CLI version does not match metadata.\n' >&2; exit 2; }
    if [[ -e "$release" || -L "$release" ]]; then
      [[ -d "$release" && ! -L "$release" && -O "$release" ]] || { printf 'Invalid existing release path.\n' >&2; exit 2; }
      existing_version="$("$release/bin/codex" --version 2>/dev/null || true)"
      if [[ "$existing_version" == "$installed_version" && -f "$release/codex-package.json" && -x "$release/bin/codex-code-mode-host" && -x "$release/codex-path/rg" && -x "$release/codex-resources/bwrap" ]]; then :
      else mv -- "$release" "$release.invalid-$nonce"; mv -- "$stage/unpacked" "$release"
      fi
    else mv -- "$stage/unpacked" "$release"
    fi
    if [[ -e "$base/current" && ! -L "$base/current" ]]; then printf 'Refusing to replace a non-link current directory.\n' >&2; exit 2; fi
    ln -s -- "versions/$version-$target" "$base/.current-$nonce"
    mv -Tf -- "$base/.current-$nonce" "$base/current"
    printf 'HUB_INSTALLED_V1\t%s\t%s\n' "$base/current/bin/codex" "$installed_version"
    ;;
  *) printf 'Unknown installation action.\n' >&2; exit 2 ;;
esac
