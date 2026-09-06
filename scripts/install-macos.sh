#!/usr/bin/env bash
#
# One-line macOS installer for Synara Beta (Apple Silicon and Intel).
#
#   t=$(curl -fsSL https://api.github.com/repos/kartikkabadi/synara-beta/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
#   bash install-macos.sh --tag v0.8.2-beta.1
#
# Downloads the GitHub DMG for the latest beta tag (or --tag), checks
# SHA256SUMS, then installs atomically with backup + rollback.

set -euo pipefail

tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      if [ "$#" -lt 2 ]; then
        echo "install-macos.sh: --tag requires a value (vX.Y.Z or vX.Y.Z-beta.N)" >&2
        exit 1
      fi
      tag="$2"
      shift 2
      ;;
    --tag=*)
      tag="${1#--tag=}"
      shift
      ;;
    -h|--help)
      echo "usage: install-macos.sh [--tag vX.Y.Z]"
      echo "installs Synara Beta to /Applications/Synara Beta.app"
      exit 0
      ;;
    *)
      echo "install-macos.sh: unknown argument: $1" >&2
      echo "usage: install-macos.sh [--tag vX.Y.Z]" >&2
      exit 1
      ;;
  esac
done

[ "$(uname -s)" = Darwin ]

arch="$(uname -m)"
case "$arch" in
  arm64)
    arch_suffix="arm64"
    ;;
  x86_64)
    arch_suffix="x64"
    ;;
  *)
    echo "install-macos.sh: unsupported architecture: $arch (need arm64 or x86_64)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
mnt="$tmp/mnt"
trap 'hdiutil detach "$mnt" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
mkdir -p "$mnt"

if [ -z "$tag" ]; then
  tag="$(curl -fsSL https://api.github.com/repos/kartikkabadi/synara-beta/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi

if [ -z "$tag" ]; then
  echo "install-macos.sh: could not resolve a release tag." >&2
  exit 1
fi

[[ "$tag" =~ ^v[0-9]+.* ]]

version="${tag#v}"
echo "Installing Synara Beta $tag for macOS ($arch_suffix)..."

base="https://github.com/kartikkabadi/synara-beta/releases/download/${tag}"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || {
  echo "install-macos.sh: failed to fetch SHA256SUMS from $base/SHA256SUMS" >&2
  exit 1
}

dmg="$(grep -E "[[:space:]]+\*?Synara.*${arch_suffix}\.dmg\$" "$tmp/SHA256SUMS" | head -1 | awk '{print $NF}' | sed 's/^\*//')"
if [ -z "$dmg" ]; then
  dmg="Synara-Beta-${version}-${arch_suffix}.dmg"
fi

curl -fL -o "$tmp/$dmg" "$base/$dmg" || {
  fallback_dmg="Synara-${version}-${arch_suffix}.dmg"
  if [ "$dmg" != "$fallback_dmg" ]; then
    curl -fL -o "$tmp/$fallback_dmg" "$base/$fallback_dmg" && dmg="$fallback_dmg"
  else
    echo "install-macos.sh: failed to download $dmg from $base" >&2
    exit 1
  fi
}

echo "Verifying checksum..."
line="$(grep -E "^[a-fA-F0-9]{64}[[:space:]]+\*?${dmg}\$" "$tmp/SHA256SUMS")" || {
  echo "install-macos.sh: checksum entry missing for $dmg in SHA256SUMS" >&2
  exit 1
}
( cd "$tmp" && printf "%s\n" "$line" | shasum -a 256 -c - )

echo "Installing..."
hdiutil attach "$tmp/$dmg" -nobrowse -readonly -mountpoint "$mnt"

source_app=""
if [ -d "$mnt/Synara Beta.app" ]; then
  source_app="$mnt/Synara Beta.app"
elif [ -d "$mnt/Synara.app" ]; then
  source_app="$mnt/Synara.app"
else
  source_app="$(find "$mnt" -maxdepth 1 -name "*.app" | head -1)"
fi

if [ -z "$source_app" ] || [ ! -d "$source_app" ]; then
  echo "install-macos.sh: could not locate application bundle inside DMG." >&2
  exit 1
fi

app="/Applications/Synara Beta.app"
prepared_app="$tmp/Synara Beta.app"
ditto "$source_app" "$prepared_app"

identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$prepared_app/Contents/Info.plist" 2>/dev/null || echo "")"
if [ "$identifier" != "com.emanueledipietro.synara.beta" ] && [ "$identifier" != "com.emanueledipietro.synara" ]; then
  echo "install-macos.sh: unexpected bundle identifier: $identifier" >&2
  exit 1
fi

install_id="$(uuidgen)"
new_app="/Applications/.Synara Beta.app.installing.$install_id"
old_app="/Applications/.Synara Beta.app.backup.$install_id"

if [ -w "/Applications" ]; then
  rm -rf "$new_app" "$old_app"
  ditto "$prepared_app" "$new_app"
  if [ -e "$app" ]; then
    mv "$app" "$old_app"
  fi
  if mv "$new_app" "$app"; then
    rm -rf "$old_app"
  else
    if [ -e "$old_app" ]; then
      mv "$old_app" "$app"
    fi
    rm -rf "$new_app"
    echo "install-macos.sh: installation failed." >&2
    exit 1
  fi
else
  osascript - "$prepared_app" "$new_app" "$old_app" "$app" <<'APPLESCRIPT'
on run argv
  set preparedApp to quoted form of item 1 of argv
  set newApp to quoted form of item 2 of argv
  set oldApp to quoted form of item 3 of argv
  set installedApp to quoted form of item 4 of argv
  do shell script "rm -rf " & newApp & " " & oldApp & " && test ! -e " & newApp & " && test ! -e " & oldApp & " && { ditto " & preparedApp & " " & newApp & " || { rm -rf " & newApp & "; exit 1; }; } && { test ! -e " & installedApp & " || mv " & installedApp & " " & oldApp & "; } && { mv " & newApp & " " & installedApp & " || { test ! -e " & oldApp & " || mv " & oldApp & " " & installedApp & " || { rm -rf " & newApp & "; echo Previous application remains at " & oldApp & " >&2; exit 1; }; rm -rf " & newApp & "; exit 1; }; } && rm -rf " & oldApp with administrator privileges
end run
APPLESCRIPT
fi

xattr -d com.apple.quarantine "$app" 2>/dev/null || true
open "$app"
echo "Installed Synara Beta $tag."
