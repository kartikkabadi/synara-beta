# Installing Synara Beta

Synara Beta provides two ways to install:

1. **One-Line Fast Terminal Installer** (Recommended): Automated, release-pinned, and handles OS-specific permissions (Gatekeeper quarantine on macOS, desktop entry on Linux, unblocking on Windows). The release artifacts it downloads are checksum-verified against an SSH-signed `SHA256SUMS`; the installer scripts themselves are fetched over HTTPS and are not signature-verified (see [the trust model](#what-the-signature-and-checksum-verification-prove)).
2. **Manual Download**: Direct download from [GitHub Releases](https://github.com/kartikkabadi/synara-beta/releases).

---

## 1. Fast Terminal Installation (Recommended)

### macOS (Apple Silicon & Intel)

Run this one-liner in Terminal:

```bash
t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
```

Or using the universal installer:

```bash
curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
```

**What it does:**

- Resolves the newest `-beta.*` prerelease tag from `kartikkabadi/synara-beta` (the `/releases/latest` endpoint excludes prereleases, so the one-liner lists releases instead).
- Downloads the architecture-matched DMG (`arm64` for Apple Silicon, `x64` for Intel) and `SHA256SUMS`.
- Verifies the SSH signature on `SHA256SUMS` against the pinned release-signing key, then the cryptographic SHA-256 checksum before mounting.
- Verifies the bundle identifier is `com.emanueledipietro.synara.beta`.
- Atomically installs **Synara Beta.app** into `/Applications` with backup and rollback safeguards.
- Clears the quarantine attribute on the app so Gatekeeper does not report it as damaged (without changing system security settings). When `/Applications` is not writable, the privileged installer step removes the quarantine flag as root and fails if it cannot.
- Launches Synara Beta.

---

### Linux (x86_64 & arm64)

Run this one-liner in Terminal:

```bash
t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
```

Or using the universal installer:

```bash
curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
```

**What it does:**

- Resolves the newest `-beta.*` prerelease tag (the `/releases/latest` endpoint excludes prereleases, so the one-liner lists releases instead).
- Downloads the architecture-matched AppImage (`x86_64` for x86_64/amd64 hosts, `arm64` for aarch64/arm64 hosts) and `SHA256SUMS`.
- Verifies the SSH signature on `SHA256SUMS` against the pinned release-signing key, then the checksum using `sha256sum -c`.
- Atomically installs to `~/.local/bin/synara-beta` with executable permissions.
- Registers a desktop entry in `~/.local/share/applications/synara-beta.desktop` so Synara Beta appears in your application launcher.

---

### Windows 10 / 11 (x64)

Run this one-liner in **PowerShell**:

```powershell
$t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+-beta\.\d+$' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }
```

**What it does:**

- Resolves the newest `-beta.*` prerelease tag (the `/releases/latest` endpoint excludes prereleases, so the one-liner lists releases instead).
- Downloads the NSIS `.exe` installer and `SHA256SUMS`.
- Verifies the SSH signature on `SHA256SUMS` with `ssh-keygen -Y verify` before trusting any checksum. This needs the Windows OpenSSH client (8.9 or newer); if `ssh-keygen` is missing or too old, the installer stops with instructions to add it via `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0` or Settings > Apps > Optional features.
- Verifies the SHA-256 hash using `Get-FileHash`.
- Checks the installed version first: the same version prints "already installed" (pass `-Force` to reinstall) and downgrades are refused without `-Force`.
- Unblocks the downloaded installer (`Unblock-File`).
- Runs the installer and checks the process exit code.

---

### What the signature and checksum verification prove

Every release publishes `SHA256SUMS` **and an SSH signature (`SHA256SUMS.sig`)** produced by the release-signing key whose public half is pinned in `scripts/release-signing.pub` and embedded in the installers. Before any checksum is trusted, the installers run `ssh-keygen -Y verify` against that pinned key. That closes the integrity-vs-authenticity gap: a tampered release cannot swap a binary and its checksum together, because the signature check fails unless the holder of the release signing key produced the checksum file.

**What is not verified:** the one-line commands fetch the installer scripts themselves (`scripts/install.sh`, `scripts/install-macos.sh`, `scripts/install-linux.sh`, `scripts/install-windows.ps1`) over HTTPS from `raw.githubusercontent.com` and execute them directly. The platform installers are fetched at the resolved release tag; the universal `scripts/install.sh` bootstrap comes from `main`. Those scripts are not signature-verified - only the release artifacts they download are. The resolved tag pins which ref the scripts come from and HTTPS authenticates the transport, but a compromised tag or repository could serve a modified script. If your threat model includes a compromised repository, clone the repo at a tag you have audited and run the scripts locally instead (see [Standalone Script Usage](#2-standalone-script-usage)).

Keep the private signing key (`SYNARA_RELEASE_SIGNING_KEY` repository secret) private; rotate it by updating the secret, `scripts/release-signing.pub`, and the key embedded in all three installers in the same release. `node scripts/check-release-signing-sync.ts` (also run by the unit tests) fails when any of the four pinned copies drifts apart.

## Updating

Re-running the same one-line command **updates Synara Beta in place**:

- The installer resolves the newest `vX.Y.Z-beta.N` release, verifies its signature and checksums, and replaces the installed app atomically (macOS keeps a backup of the previous app until the swap succeeds, and restores it if anything interrupts the upgrade).
- Your data lives in `~/.synara-beta`. The installers never read, write, or delete that directory - settings, threads, and sessions survive every install and update.
- Re-running with the version you already have prints "already installed" (pass `--force` to reinstall, or `-Force` on Windows); installing an older tag is refused without it.
- The in-app update button uses the electron-updater feed for platforms where unsigned self-update works; on macOS the beta app is unsigned, so the supported update path is re-running the install command above.

## Data safety

Installers only ever write to the install targets listed above (`/Applications/Synara Beta.app`, `~/.local/bin`, `~/.local/share/applications`, `%LOCALAPPDATA%`/`%TEMP%` on Windows, and the installer state stamp under `XDG_STATE_HOME`). Your Synara Beta data lives in `~/.synara-beta`, which the installers never read, write, or delete - upgrades, reinstalls, and `--force` runs all leave it untouched.

## 2. Standalone Script Usage

If you have cloned the repository, you can run the scripts locally with a specific tag:

```bash
# macOS
bash scripts/install-macos.sh --tag v0.8.2-beta.1

# Linux
bash scripts/install-linux.sh --tag v0.8.2-beta.1

# Windows (PowerShell)
.\scripts\install-windows.ps1 -Tag v0.8.2-beta.1
```
