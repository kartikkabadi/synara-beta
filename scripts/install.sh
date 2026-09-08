#!/usr/bin/env bash
#
# Universal one-line installer bootstrap for Synara Beta.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash -s -- --tag v0.8.2-beta.1
#
# Detects the operating system and delegates to the platform installer.
# On Windows shells (Git Bash/Cygwin) it prints PowerShell instructions
# and exits 0 without installing anything.

set -euo pipefail

tag=""
tag_provided=0
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[i]}" == "--tag" ]]; then
    if ((i+1 >= ${#args[@]})) || [[ "${args[i+1]}" == -* ]]; then
      echo "install.sh: --tag requires a value." >&2
      exit 1
    fi
    tag="${args[i+1]}"
    tag_provided=1
    i=$((i+1))
  elif [[ "${args[i]}" == --tag=* ]]; then
    tag="${args[i]#--tag=}"
    if [ -z "$tag" ]; then
      echo "install.sh: --tag requires a value." >&2
      exit 1
    fi
    tag_provided=1
  fi
done

# Strict validation BEFORE any URL is built or anything is downloaded: the tag
# selects the ref the platform installer is fetched from, so a non-release ref
# like "main" must never reach a download URL.
if [ -n "$tag" ] && ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
  echo "install.sh: invalid tag '$tag'. Expected vX.Y.Z-beta.N." >&2
  exit 1
fi

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
    if [ -n "$tag" ]; then
      # Preserve the requested --tag: pin both the script download and the
      # installer invocation to it instead of silently resolving the latest
      # release. The tag is strictly validated above, so it is safe to embed.
      printf '  $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/%s/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag '"'"'%s'"'"' } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }\n' "$tag" "$tag"
    else
      echo '  $t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -match '"'"'^v\d+\.\d+\.\d+-beta\.\d+$'"'"' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }'
    fi
    echo ""
    exit 0
    ;;
  *)
    echo "install.sh: unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

if [ -z "$tag" ]; then
  # /releases/latest excludes prereleases, so list releases and pick the newest
  # beta tag. The pattern matches exactly the tags the beta release workflow
  # publishes (vX.Y.Z-beta.N) so unrelated prerelease names are never selected.
  tag="$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1 || true)"
fi

if [ -z "$tag" ]; then
  echo "install.sh: could not resolve a release tag (API rate-limited? pass --tag vX.Y.Z-beta.N)." >&2
  exit 1
fi

script_url="https://raw.githubusercontent.com/kartikkabadi/synara-beta/${tag}/scripts/install-${platform}.sh"

# Forward the resolved tag to the platform installer so it installs exactly
# the release the bootstrap already selected and verified. If the caller
# already passed --tag, do not override it.
pass_args=()
if [ "${#args[@]}" -gt 0 ]; then
  pass_args=("${args[@]}")
fi
if [ "$tag_provided" -ne 1 ]; then
  pass_args+=("--tag" "$tag")
fi

tmp_file="$(mktemp "/tmp/synara-beta-install-${platform}.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

if ! curl -fsSL -o "$tmp_file" "$script_url"; then
  echo "install.sh: failed to download ${script_url}" >&2
  exit 1
fi

bash "$tmp_file" ${pass_args[@]+"${pass_args[@]}"}
