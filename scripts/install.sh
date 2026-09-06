#!/usr/bin/env bash
#
# Universal one-line installer bootstrap for Synara Beta.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash -s -- --tag v0.8.2-beta.1
#
# Detects operating system and delegates to the platform-specific installer script.

set -euo pipefail

OS="$(uname -s)"
case "$OS" in
  Darwin)
    platform="macos"
    ;;
  Linux)
    platform="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "Synara Beta installation on Windows should be run in PowerShell:"
    echo ""
    echo '  $t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -like '"'"'*-beta*'"'"' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }'
    echo ""
    exit 0
    ;;
  *)
    echo "install.sh: unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

tag=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[i]}" == "--tag" && $((i+1)) -lt ${#args[@]} ]]; then
    tag="${args[i+1]}"
  elif [[ "${args[i]}" == --tag=* ]]; then
    tag="${args[i]#--tag=}"
  fi
done

if [ -z "$tag" ]; then
  # /releases/latest excludes prereleases, so list releases and pick the newest -beta tag.
  tag="$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -- '-beta' | head -1 || true)"
fi

if [ -z "$tag" ]; then
  echo "install.sh: could not resolve a release tag." >&2
  exit 1
fi

script_url="https://raw.githubusercontent.com/kartikkabadi/synara-beta/${tag}/scripts/install-${platform}.sh"

tmp_file="$(mktemp "/tmp/synara-beta-install-${platform}.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

if ! curl -fsSL -o "$tmp_file" "$script_url"; then
  echo "install.sh: failed to download ${script_url}" >&2
  exit 1
fi

bash "$tmp_file" "${args[@]}"
