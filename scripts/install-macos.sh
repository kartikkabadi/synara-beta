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
# stock macOS sort does not support. The beta field is 10 digits wide and a
# stable release uses the all-nines sentinel, so any beta below 10^10-1 sorts
# before its stable release. The installer rejects beta numbers at or beyond
# the sentinel instead of letting them overflow the field and mis-sort.
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
ALLOWED_SIGNERS="synara-beta-releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINi8kB8J9c2PSQ7D+UGgCp1LsQZg75r6rT31sb+l5ik0 synara-beta-release-signing"

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
# into place, restore the old app so the installation never disappears. The
# backup may be root-owned after a privileged install, in which case the
# unprivileged move will fail and we leave the backup path in place.
restore_on_exit() {
  if [ -n "${swap_started:-}" ] && [ ! -d "$app" ] && [ -d "$old_app" ]; then
    if mv "$old_app" "$app" 2>/dev/null; then
      echo "install-macos.sh: interrupted - previous installation restored." >&2
    else
      # The backup may be root-owned after a privileged install. We cannot
      # prompt for admin privileges from an EXIT trap, so leave the backup
      # path in place; the user can move it back manually or re-run.
      echo "install-macos.sh: interrupted - previous installation remains at $old_app" >&2
    fi
  fi
  hdiutil detach "$mnt" >/dev/null 2>&1 || true
  rm -rf "$tmp"
  if [ -n "${lock_held:-}" ]; then
    rm -rf "${lock_dir:-}"
  fi
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

# The version key gives the beta field 10 digits; a beta number at or beyond
# the 10^10 sentinel would overflow the field and could sort above its own
# stable release, silently enabling a downgrade. Reject it outright.
beta_digits="${tag##*-beta.}"
beta_value="${beta_digits#"${beta_digits%%[1-9]*}"}"
if [ "${#beta_value}" -gt 10 ] || [ "${beta_value}" = "9999999999" ]; then
  echo "install-macos.sh: beta number in '$tag' is at or beyond the 10^10 version-key sentinel; refusing to install." >&2
  exit 1
fi

version="${tag#v}"
app="/Applications/Synara Beta.app"

# Serialize concurrent installs: the installed-version check and the app swap
# below must commit together, or two overlapping updates can both pass the
# version check against the same old app and the older one can finish last,
# replacing the newer app and deleting it as its backup. mkdir is atomic, so
# it works as a lock on stock macOS (no flock). A lock whose owner is gone is
# stolen; a live holder is waited out with a timeout instead of blocking
# forever. The lock is released when the process exits.
lock_dir="${XDG_STATE_HOME:-$HOME/.local/state}/synara-beta-installer/install.lock"
mkdir -p "${lock_dir%/*}"
acquire_install_lock() {
  local waited=0 owner
  while :; do
    if mkdir "$lock_dir" 2>/dev/null; then
      echo "$$" > "$lock_dir/pid"
      lock_held=1
      return 0
    fi
    owner="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock_dir" # owner exited without cleanup: steal the stale lock
      continue
    fi
    if [ "$waited" -ge 900 ]; then
      echo "install-macos.sh: another install is holding $lock_dir; timed out waiting." >&2
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}
if ! acquire_install_lock; then
  exit 1
fi

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
if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "install-macos.sh: ssh-keygen is required to verify the release signature. OpenSSH ships with macOS; if it is missing, install it and retry." >&2
  exit 1
fi
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
  else
    if [ -e "$old_app" ]; then
      mv "$old_app" "$app"
    fi
    swap_started=""
    rm -rf "$new_app"
    echo "install-macos.sh: installation failed." >&2
    exit 1
  fi
  # The backup is kept until the installed app passes the final launchability
  # check: a failed quarantine removal would leave the replacement blocked by
  # Gatekeeper with no working app, so the previous installation is restored
  # and the backup is only deleted once the flag is verified gone.
  xattr -d com.apple.quarantine "$app" >/dev/null 2>&1 || true
  if xattr "$app" 2>/dev/null | grep -q com.apple.quarantine; then
    if [ -e "$old_app" ]; then
      # Mark the swap in progress again so an interruption mid-restore still
      # brings the previous installation back via the EXIT trap.
      swap_started=1
      mv "$app" "$new_app"
      mv "$old_app" "$app"
      swap_started=""
    fi
    rm -rf "$new_app"
    echo "install-macos.sh: could not remove the quarantine flag from the installed app; the previous installation was restored. First launches may be blocked by Gatekeeper." >&2
    exit 1
  fi
  rm -rf "$old_app"
else
  # /Applications is not writable: the AppleScript installs as root, so the
  # quarantine flag must also be removed inside the privileged shell - an
  # xattr run as the invoking user cannot clear a root-owned app, and hiding
  # that failure would leave the unsigned beta blocked by Gatekeeper. The
  # privileged step keeps the previous backup until quarantine removal succeeds,
  # and restores the backup if quarantine cannot be cleared.
  swap_started=1
  if ! osascript - "$prepared_app" "$new_app" "$old_app" "$app" <<'APPLESCRIPT'
on run argv
  set preparedApp to quoted form of item 1 of argv
  set newApp to quoted form of item 2 of argv
  set oldApp to quoted form of item 3 of argv
  set installedApp to quoted form of item 4 of argv
  set cmd to "rm -rf " & newApp & " " & oldApp & " && test ! -e " & newApp & " && test ! -e " & oldApp & " && { ditto " & preparedApp & " " & newApp & " || { rm -rf " & newApp & "; exit 1; }; } && { test ! -e " & installedApp & " || mv " & installedApp & " " & oldApp & "; } && { mv " & newApp & " " & installedApp & " || { test ! -e " & oldApp & " || mv " & oldApp & " " & installedApp & " || { rm -rf " & newApp & "; echo 'install-macos.sh: previous application remains at the backup path' >&2; exit 1; }; rm -rf " & newApp & "; exit 1; }; } && { xattr -d com.apple.quarantine " & installedApp & " >/dev/null 2>&1; if xattr " & installedApp & " 2>/dev/null | grep -q com.apple.quarantine; then mv " & installedApp & " " & newApp & " && { test ! -e " & oldApp & " || mv " & oldApp & " " & installedApp & "; } && rm -rf " & newApp & " && echo 'install-macos.sh: could not remove the quarantine flag from the installed app - first launch may be blocked by Gatekeeper' >&2 && exit 1; fi; } && rm -rf " & oldApp
  do shell script cmd with administrator privileges
end run
APPLESCRIPT
  then
    swap_started=""
    echo "install-macos.sh: privileged installation or quarantine removal failed; see the message above." >&2
    exit 1
  fi
  swap_started=""
fi

# The beta app is unsigned, so Gatekeeper would block first launch with a
# damaged-file warning. Removing the quarantine flag from the installed app
# only (never changing system security settings) lets it start; the checksum
# and release-signature verification above are the integrity/authenticity gate.
# Writable installs already removed the flag and rolled back on failure while
# the backup was still held; root-owned installs were handled in the
# privileged AppleScript. This final check only reports a flag that somehow
# survived, instead of hiding a failed removal behind `|| true`.
if [ -w "$app" ]; then
  xattr -d com.apple.quarantine "$app" >/dev/null 2>&1 || true
fi
if xattr "$app" 2>/dev/null | grep -q com.apple.quarantine; then
  echo "install-macos.sh: warning: the quarantine flag is still present on $app; first launch may be blocked by Gatekeeper." >&2
fi
open "$app" 2>/dev/null || echo "install-macos.sh: installed $app but could not open it automatically." >&2
echo "Installed Synara Beta $tag."
