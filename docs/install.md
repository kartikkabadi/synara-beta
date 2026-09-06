# Installing Synara Beta

Synara Beta provides two ways to install:

1. **One-Line Fast Terminal Installer** (Recommended): Automated, release-pinned, SHA256 checksum-verified, and handles OS-specific permissions (Gatekeeper quarantine on macOS, desktop entry on Linux, unblocking on Windows).
2. **Manual Download**: Direct download from [GitHub Releases](https://github.com/kartikkabadi/synara-beta/releases).

---

## 1. Fast Terminal Installation (Recommended)

### macOS (Apple Silicon & Intel)

Run this one-liner in Terminal:

```bash
t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -- '-beta' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
```

Or using the universal installer:

```bash
curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
```

**What it does:**

- Resolves the newest `-beta.*` prerelease tag from `kartikkabadi/synara-beta` (the `/releases/latest` endpoint excludes prereleases, so the one-liner lists releases instead).
- Downloads the architecture-matched DMG (`arm64` for Apple Silicon, `x64` for Intel) and `SHA256SUMS`.
- Verifies the cryptographic SHA-256 checksum before mounting.
- Verifies the bundle identifier is `com.emanueledipietro.synara.beta`.
- Atomically installs **Synara Beta.app** into `/Applications` with backup and rollback safeguards.
- Clears the quarantine attribute on the app so Gatekeeper does not report it as damaged (without changing system security settings).
- Launches Synara Beta.

---

### Linux (x86_64)

Run this one-liner in Terminal:

```bash
t=$(curl -fsSL "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" | grep '"tag_name"' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | grep -- '-beta' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Synara Beta release." >&2; (exit 1); else f=$(mktemp /tmp/synara-beta-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/synara-beta-install-none}"; (exit $rc); fi
```

Or using the universal installer:

```bash
curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
```

**What it does:**

- Resolves the newest `-beta.*` prerelease tag (the `/releases/latest` endpoint excludes prereleases, so the one-liner lists releases instead).
- Downloads the x86_64 AppImage and `SHA256SUMS` (Linux arm64 is rejected: no arm64 AppImage is published).
- Verifies the checksum using `sha256sum -c`.
- Atomically installs to `~/.local/bin/synara-beta` with executable permissions.
- Registers a desktop entry in `~/.local/share/applications/synara-beta.desktop` so Synara Beta appears in your application launcher.

---

### Windows 10 / 11 (x64)

Run this one-liner in **PowerShell**:

```powershell
$t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -like '*-beta*' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }
```

**What it does:**

- Resolves the newest `-beta.*` prerelease tag (the `/releases/latest` endpoint excludes prereleases, so the one-liner lists releases instead).
- Downloads the NSIS `.exe` installer and `SHA256SUMS`.
- Verifies the SHA-256 hash using `Get-FileHash`.
- Unblocks the downloaded installer (`Unblock-File`).
- Runs the installer and checks the process exit code.

---

### What SHA-256 verification proves

The installers check the downloaded artifact against the `SHA256SUMS` file published in the same GitHub release, fetched over the same HTTPS connection. That check proves **integrity** (the download arrived complete and uncorrupted), not **authenticity**: `SHA256SUMS` is unsigned, so anyone able to replace a release binary can replace its checksum entry too. Before running a one-liner, confirm you expect the `-beta.*` tag it resolves.

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
