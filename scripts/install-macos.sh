#!/usr/bin/env bash
#
# One-line macOS installer for Synara Beta (Apple Silicon and Intel).
#
#   t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
#   bash install-macos.sh --tag v0.8.2-beta.1
#
# Downloads the GitHub DMG for the latest beta tag (or --tag), checks
# SHA256SUMS, then installs atomically with backup + rollback.

set -euo pipefail

# Portable version key: vX.Y.Z-beta.N -> fixed-width sortable string where a
# stable release sorts after its beta previews. Avoids GNU sort -V, which the
# stock macOS sort does not support.
version_key() {
  local v="${1#v}"
  local base="${v%%-*}"
  local beta="9999"
  case "$v" in
    *-beta.*) beta="${v#*-beta.}" ;;
  esac
  local a="" b="" c=""
  IFS=. read -r a b c <<KEY_EOF
$base
KEY_EOF
  printf '%06d%06d%06d%06d' "${a:-0}" "${b:-0}" "${c:-0}" "${beta:-9999}"
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
        echo "install-macos.sh: --tag requires a value (vX.Y.Z-beta.N)" >&2
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
      echo "usage: install-macos.sh [--tag vX.Y.Z-beta.N] [--force]"
      echo "installs Synara Beta to /Applications/Synara Beta.app"
      echo "re-running with a newer tag updates in place; ~/.synara-beta is never touched"
      exit 0
      ;;
    *)
      echo "install-macos.sh: unknown argument: $1" >&2
      echo "usage: install-macos.sh [--tag vX.Y.Z-beta.N] [--force]" >&2
      exit 1
      ;;
  esac
done

if [ "$(uname -s)" != Darwin ]; then
  echo "install-macos.sh: unsupported operating system (need macOS)." >&2
  exit 1
fi

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
# If the script dies between moving the old app aside and moving the new one
# into place, restore the old app so the installation never disappears.
restore_on_exit() {
  if [ -n "${swap_started:-}" ] && [ ! -d "$app" ] && [ -d "$old_app" ]; then
    mv "$old_app" "$app" 2>/dev/null || true
    echo "install-macos.sh: interrupted - previous installation restored." >&2
  fi
  hdiutil detach "$mnt" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap restore_on_exit EXIT
mkdir -p "$mnt"

if [ -z "$tag" ]; then
  # /releases/latest excludes prereleases, so list releases and pick the newest
  # beta tag. The pattern matches exactly the tags the beta release workflow
  # publishes (vX.Y.Z-beta.N) so unrelated prerelease names are never selected.
  tag="$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1 || true)"
fi

if [ -z "$tag" ]; then
  echo "install-macos.sh: could not resolve a release tag (API rate-limited? pass --tag vX.Y.Z-beta.N)." >&2
  exit 1
fi

# Strict validation: the tag flows into URLs and grep patterns below, so only
# the exact release shape is accepted (no metacharacters, no substitution).
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
  echo "install-macos.sh: invalid tag '$tag'. Expected vX.Y.Z-beta.N." >&2
  exit 1
fi

version="${tag#v}"
app="/Applications/Synara Beta.app"

# Update semantics: re-running this installer is the update path. Skip when the
# installed version already matches; refuse downgrades without --force. The
# ~/.synara-beta data directory is never read or written here, so user data
# survives every install.
if [ -d "$app" ]; then
  installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo "")"
  if [ -n "$installed_version" ]; then
    if [ "$installed_version" = "$version" ] && [ "$force" -ne 1 ]; then
      echo "Synara Beta $installed_version is already installed. Re-run with --force to reinstall."
      exit 0
    fi
    if [ "$force" -ne 1 ] && [[ "$(version_key "$installed_version")" > "$(version_key "$version")" ]]; then
      echo "install-macos.sh: installed Synara Beta $installed_version is newer than $tag. Pass --force to downgrade." >&2
      exit 1
    fi
  fi
fi

echo "Installing Synara Beta $tag for macOS ($arch_suffix)..."

base="https://github.com/kartikkabadi/synara-beta/releases/download/${tag}"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || {
  echo "install-macos.sh: failed to fetch SHA256SUMS from $base/SHA256SUMS" >&2
  exit 1
}

curl -fsSL -o "$tmp/SHA256SUMS.sig" "$base/SHA256SUMS.sig" || {
  echo "install-macos.sh: failed to fetch SHA256SUMS.sig from $base/SHA256SUMS.sig" >&2
  exit 1
}

printf '%s\n' "$ALLOWED_SIGNERS" > "$tmp/allowed_signers"
echo "Verifying release signature..."
if ! ssh-keygen -Y verify -f "$tmp/allowed_signers" -I synara-beta-releases -s "$tmp/SHA256SUMS.sig" -n synara-beta < "$tmp/SHA256SUMS" >/dev/null 2>&1; then
  echo "install-macos.sh: release signature verification failed for SHA256SUMS. Refusing to install." >&2
  exit 1
fi

dmg="$(grep -E "[[:space:]]+\*?Synara.*${arch_suffix}\.dmg\$" "$tmp/SHA256SUMS" | head -1 | awk '{print $NF}' | sed 's/^\*//' || true)"
if [ -z "$dmg" ]; then
  dmg="Synara-${version}-${arch_suffix}.dmg"
fi

if ! curl -fL -o "$tmp/$dmg" "$base/$dmg"; then
  echo "install-macos.sh: failed to download $dmg from $base" >&2
  exit 1
fi

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
  source_app="$(find "$mnt" -maxdepth 1 -name "*.app" | head -1 || true)"
fi

if [ -z "$source_app" ] || [ ! -d "$source_app" ]; then
  echo "install-macos.sh: could not locate application bundle inside DMG." >&2
  exit 1
fi

app="/Applications/Synara Beta.app"
prepared_app="$tmp/Synara Beta.app"
ditto "$source_app" "$prepared_app"

identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$prepared_app/Contents/Info.plist" 2>/dev/null || echo "")"
if [ "$identifier" != "com.emanueledipietro.synara.beta" ]; then
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
    swap_started=1
    mv "$app" "$old_app"
  fi
  if mv "$new_app" "$app"; then
    swap_started=""
    rm -rf "$old_app"
  else
    if [ -e "$old_app" ]; then
      mv "$old_app" "$app"
    fi
    swap_started=""
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

# The beta app is unsigned, so Gatekeeper would block first launch with a
# damaged-file warning. Removing the quarantine flag from the installed app
# only (never changing system security settings) lets it start; the checksum
# and release-signature verification above are the integrity/authenticity gate.
xattr -d com.apple.quarantine "$app" 2>/dev/null || true
open "$app" 2>/dev/null || echo "install-macos.sh: installed $app but could not open it automatically." >&2
echo "Installed Synara Beta $tag."
