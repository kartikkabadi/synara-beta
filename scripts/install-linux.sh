#!/usr/bin/env bash
#
# One-line Linux installer for Synara Beta (x86_64 and arm64).
#
#   t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
#   bash install-linux.sh --tag v0.8.2-beta.1
#
# Downloads the GitHub AppImage for the latest beta tag (or --tag), checks
# SHA256SUMS, then installs atomically to ~/.local/bin/synara-beta and registers
# a desktop entry.

set -euo pipefail

# Portable version key: vX.Y.Z-beta.N -> fixed-width sortable string where a
# stable release sorts after its beta. The beta field is 10 digits wide and a
# stable release uses the all-nines sentinel, so any beta below 10^10-1 sorts
# before its stable release.
version_key() {
  local v="${1#v}"
  local base="${v%%-*}"
  local beta="9999999999"
  case "$v" in
    *-beta.*) beta="${v#*-beta.}" ;;
  esac
  local a="" b="" c=""
  IFS=. read -r a b c <<KEY_EOF
$base
KEY_EOF
  printf '%06d%06d%06d%010d' "${a:-0}" "${b:-0}" "${c:-0}" "${beta:-9999999999}"
}


# Pinned release-signing public key (scripts/release-signing.pub at the tag the
# installer ships from). SHA256SUMS is signed with the matching private key
# during the release workflow; verification happens before any checksum is
# trusted. Rotate by updating the workflow secret and this line together.
ALLOWED_SIGNERS="synara-beta-releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFA61LZNkb3QTME3wdqznC/zghISZ9nsS2BnUMUQ1JRo"

force=0
tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      if [ "$#" -lt 2 ]; then
        echo "install-linux.sh: --tag requires a value (vX.Y.Z-beta.N)" >&2
        exit 1
      fi
      tag="$2"
      shift 2
      ;;
    --tag=*)
      tag="${1#--tag=}"
      shift
      ;;
    --force)
      force=1
      shift
      ;;
    -h|--help)
      echo "usage: install-linux.sh [--tag vX.Y.Z-beta.N] [--force]"
      echo "installs Synara Beta AppImage to ~/.local/bin/synara-beta"
      echo "re-running with a newer tag updates in place; ~/.synara-beta is never touched"
      exit 0
      ;;
    *)
      echo "install-linux.sh: unknown argument: $1" >&2
      echo "usage: install-linux.sh [--tag vX.Y.Z-beta.N] [--force]" >&2
      exit 1
      ;;
  esac
done

if [ "$(uname -s)" != Linux ]; then
  echo "install-linux.sh: unsupported operating system (need Linux)." >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)
    arch_pattern="x86_64|x64"
    default_arch="x86_64"
    ;;
  aarch64|arm64)
    # The release workflow publishes an arm64 AppImage alongside x86_64
    # (electron-builder names AppImages x86_64/arm64).
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
  # /releases/latest excludes prereleases, so list releases and pick the newest
  # beta tag. The pattern matches exactly the tags the beta release workflow
  # publishes (vX.Y.Z-beta.N) so unrelated prerelease names are never selected.
  tag="$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1 || true)"
fi

if [ -z "$tag" ]; then
  echo "install-linux.sh: could not resolve a release tag (API rate-limited? pass --tag vX.Y.Z-beta.N)." >&2
  exit 1
fi

# Strict validation: the tag flows into URLs and grep patterns below, so only
# the exact release shape is accepted (no metacharacters, no substitution).
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
  echo "install-linux.sh: invalid tag '$tag'. Expected vX.Y.Z-beta.N." >&2
  exit 1
fi

version="${tag#v}"

# Update semantics: re-running this installer is the update path. The installed
# version is stamped under XDG_STATE_HOME (never inside the app's ~/.synara-beta
# data directory); skip when it already matches, refuse downgrades without --force.
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/synara-beta-installer"
version_stamp="$state_dir/installed-version"
# A matching stamp only means "up to date" when the binary is actually present;
# if it was removed, fall through and reinstall.
if [ -f "$version_stamp" ] && [ -x "$HOME/.local/bin/synara-beta" ]; then
  installed_version="$(cat "$version_stamp" 2>/dev/null || echo "")"
  if [ -n "$installed_version" ]; then
    if [ "$installed_version" = "$version" ] && [ "$force" -ne 1 ]; then
      echo "Synara Beta $installed_version is already installed. Re-run with --force to reinstall."
      exit 0
    fi
    if [ "$force" -ne 1 ] && [ "$(version_key "$installed_version")" \> "$(version_key "$version")" ]; then
      echo "install-linux.sh: installed Synara Beta $installed_version is newer than $tag. Pass --force to downgrade." >&2
      exit 1
    fi
  fi
fi

echo "Installing Synara Beta $tag for Linux ($arch)..."

base="https://github.com/kartikkabadi/synara-beta/releases/download/${tag}"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || {
  echo "install-linux.sh: failed to fetch SHA256SUMS from $base/SHA256SUMS" >&2
  exit 1
}

curl -fsSL -o "$tmp/SHA256SUMS.sig" "$base/SHA256SUMS.sig" || {
  echo "install-linux.sh: failed to fetch SHA256SUMS.sig from $base/SHA256SUMS.sig" >&2
  exit 1
}

printf '%s\n' "$ALLOWED_SIGNERS" > "$tmp/allowed_signers"
echo "Verifying release signature..."
if ! ssh-keygen -Y verify -f "$tmp/allowed_signers" -I synara-beta-releases -s "$tmp/SHA256SUMS.sig" -n synara-beta < "$tmp/SHA256SUMS" >/dev/null 2>&1; then
  echo "install-linux.sh: release signature verification failed for SHA256SUMS. Refusing to install." >&2
  exit 1
fi

# Match candidate AppImage in SHA256SUMS
appimage="$(grep -E "[[:space:]]+\*?Synara.*(${arch_pattern})\.AppImage\$" "$tmp/SHA256SUMS" | head -1 | awk '{print $NF}' | sed 's/^\*//' || true)"
if [ -z "$appimage" ]; then
  appimage="Synara-${version}-${default_arch}.AppImage"
fi

if ! curl -fL -o "$tmp/$appimage" "$base/$appimage"; then
  echo "install-linux.sh: failed to download $appimage from $base" >&2
  exit 1
fi

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

# Register desktop entry. The Exec value is quoted so home paths containing
# spaces do not split into multiple arguments.
desktop_dir="$HOME/.local/share/applications"
if mkdir -p "$desktop_dir" 2>/dev/null; then
  cat << DESKTOP_ENTRY > "$desktop_dir/synara-beta.desktop" || echo "install-linux.sh: warning: could not write desktop entry" >&2
[Desktop Entry]
Name=Synara Beta
Comment=Coding Agent Workspace
Exec="$HOME/.local/bin/synara-beta" %U
Icon=synara-beta
Terminal=false
Type=Application
StartupWMClass=synara-beta
Categories=Development;
DESKTOP_ENTRY
  chmod +x "$desktop_dir/synara-beta.desktop" 2>/dev/null || true
fi

# Stamp the installed version so re-runs can detect "already up to date" and
# refuse downgrades. Lives under XDG_STATE_HOME, never inside ~/.synara-beta.
mkdir -p "$state_dir"
printf '%s\n' "$version" > "$version_stamp"

echo "Installed Synara Beta $tag."
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "install-linux.sh: $HOME/.local/bin is not on PATH; restart your shell or add it to PATH to run synara-beta." >&2 ;;
esac
