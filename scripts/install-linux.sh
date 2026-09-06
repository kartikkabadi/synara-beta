#!/usr/bin/env bash
#
# One-line Linux installer for Synara Beta (x86_64 and arm64).
#
#   t=$(curl -fsSL https://api.github.com/repos/kartikkabadi/synara-beta/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
#   bash install-linux.sh --tag v0.8.2-beta.1
#
# Downloads the GitHub AppImage for the latest beta tag (or --tag), checks
# SHA256SUMS, then installs atomically to ~/.local/bin/synara-beta and registers
# a desktop entry.

set -euo pipefail

tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      if [ "$#" -lt 2 ]; then
        echo "install-linux.sh: --tag requires a value (vX.Y.Z or vX.Y.Z-beta.N)" >&2
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
      echo "usage: install-linux.sh [--tag vX.Y.Z]"
      echo "installs Synara Beta AppImage to ~/.local/bin/synara-beta"
      exit 0
      ;;
    *)
      echo "install-linux.sh: unknown argument: $1" >&2
      echo "usage: install-linux.sh [--tag vX.Y.Z]" >&2
      exit 1
      ;;
  esac
done

[ "$(uname -s)" = Linux ]

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)
    arch_pattern="x86_64|x64"
    default_arch="x86_64"
    ;;
  aarch64|arm64)
    arch_pattern="arm64|aarch64"
    default_arch="arm64"
    ;;
  *)
    echo "install-linux.sh: unsupported architecture: $arch (need x86_64 or arm64)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ -z "$tag" ]; then
  tag="$(curl -fsSL https://api.github.com/repos/kartikkabadi/synara-beta/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi

if [ -z "$tag" ]; then
  echo "install-linux.sh: could not resolve a release tag." >&2
  exit 1
fi

[[ "$tag" =~ ^v[0-9]+.* ]]

version="${tag#v}"
echo "Installing Synara Beta $tag for Linux ($arch)..."

base="https://github.com/kartikkabadi/synara-beta/releases/download/${tag}"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || {
  echo "install-linux.sh: failed to fetch SHA256SUMS from $base/SHA256SUMS" >&2
  exit 1
}

# Match candidate AppImage in SHA256SUMS
appimage="$(grep -E "[[:space:]]+\*?Synara.*(${arch_pattern})\.AppImage\$" "$tmp/SHA256SUMS" | head -1 | awk '{print $NF}' | sed 's/^\*//')"
if [ -z "$appimage" ]; then
  appimage="Synara-Beta-${version}-${default_arch}.AppImage"
fi

curl -fL -o "$tmp/$appimage" "$base/$appimage" || {
  fallback_appimage="Synara-${version}-${default_arch}.AppImage"
  if [ "$appimage" != "$fallback_appimage" ]; then
    curl -fL -o "$tmp/$fallback_appimage" "$base/$fallback_appimage" && appimage="$fallback_appimage"
  else
    echo "install-linux.sh: failed to download $appimage from $base" >&2
    exit 1
  fi
}

echo "Verifying checksum..."
line="$(grep -E "^[a-fA-F0-9]{64}[[:space:]]+\*?${appimage}\$" "$tmp/SHA256SUMS")" || {
  echo "install-linux.sh: checksum entry missing for $appimage in SHA256SUMS" >&2
  exit 1
}
( cd "$tmp" && printf "%s\n" "$line" | sha256sum -c - )

echo "Installing..."
dest="$HOME/.local/bin/synara-beta"
mkdir -p "$HOME/.local/bin"
if [ -e "$dest" ] && [ ! -f "$dest" ]; then
  echo "install-linux.sh: refusing to overwrite non-regular file: $dest" >&2
  exit 1
fi

staged="$dest.new.$$"
trap 'rm -rf "$tmp"; rm -f "$staged"' EXIT
if ! cp -p "$tmp/$appimage" "$staged"; then
  rm -f "$staged"
  exit 1
fi

if ! chmod +x "$staged"; then
  rm -f "$staged"
  exit 1
fi

mv -f "$staged" "$dest"

# Register desktop entry
desktop_dir="$HOME/.local/share/applications"
if mkdir -p "$desktop_dir" 2>/dev/null; then
  cat << DESKTOP_ENTRY > "$desktop_dir/synara-beta.desktop"
[Desktop Entry]
Name=Synara Beta
Comment=Coding Agent Workspace
Exec=$HOME/.local/bin/synara-beta %U
Icon=synara-beta
Terminal=false
Type=Application
StartupWMClass=synara-beta
Categories=Development;
DESKTOP_ENTRY
  chmod +x "$desktop_dir/synara-beta.desktop" 2>/dev/null || true
fi

echo "Installed Synara Beta $tag."
