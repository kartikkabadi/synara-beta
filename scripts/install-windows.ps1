# One-line Windows installer for Synara Beta (x64).
#
#   $t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+-beta\.\d+$' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }
#   install-windows.ps1 -Tag v0.8.2-beta.1
#
# Downloads the GitHub exe for the latest beta tag (or -Tag), checks
# SHA256SUMS, unblocks the file, then runs the installer.
param(
  [string]$Tag = '',
  [switch]$Force,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Write-Output 'usage: install-windows.ps1 [-Tag vX.Y.Z] [-Force]'
  Write-Output 're-running with a newer tag updates in place; ~/.synara-beta is never touched'
  exit 0
}

# 32-bit PowerShell on x64 Windows reports PROCESSOR_ARCHITECTURE as x86 while
# PROCESSOR_ARCHITEW6432 carries the real architecture, so prefer the latter.
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') {
  throw "install-windows.ps1: unsupported architecture: '$architecture'. x64 (AMD64) required (no Windows arm64 installer is published)."
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if (-not $Tag) {
  # /releases/latest excludes prereleases, so list releases and pick the newest
  # beta tag. The pattern matches exactly the tags the beta release workflow
  # publishes (vX.Y.Z-beta.N) so unrelated prerelease names are never selected.
  $releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100' -UseBasicParsing
  $Tag = ($releases | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+-beta\.\d+$' } | Select-Object -First 1).tag_name
}
if (-not $Tag) {
  throw 'install-windows.ps1: could not resolve a release tag (API rate-limited? pass -Tag vX.Y.Z-beta.N).'
}
if ($Tag -notmatch '^v\d+.*') {
  throw "install-windows.ps1: invalid tag '$Tag'. Expected vX.Y.Z or vX.Y.Z-beta.N."
}

$version = $Tag.TrimStart('v')
Write-Output "Installing Synara Beta $Tag for Windows ($env:PROCESSOR_ARCHITECTURE)..."

$base = "https://github.com/kartikkabadi/synara-beta/releases/download/$Tag"
$checksumPath = Join-Path $env:TEMP ("SHA256SUMS-" + [Guid]::NewGuid().ToString("N"))
Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $checksumPath -UseBasicParsing

# The release signature authenticates SHA256SUMS before any checksum is trusted.
# The private key lives in the SYNARA_RELEASE_SIGNING_KEY repository secret; the
# matching public key is pinned in scripts/release-signing.pub and inlined below.
$allowedSigners = 'synara-beta-releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFA61LZNkb3QTME3wdqznC/zghISZ9nsS2BnUMUQ1JRo'
$signaturePath = Join-Path $env:TEMP ("SHA256SUMS.sig-" + [Guid]::NewGuid().ToString("N"))
Invoke-WebRequest -Uri "$base/SHA256SUMS.sig" -OutFile $signaturePath -UseBasicParsing
$signersPath = Join-Path $env:TEMP ("allowed-signers-" + [Guid]::NewGuid().ToString("N"))
Set-Content -Path $signersPath -Value $allowedSigners
Write-Output 'Verifying release signature...'
# ssh-keygen -Y verify reads the signed content from stdin; PowerShell has no <
# redirection, so route through cmd with the redirect attached to the command.
$verifyOutput = cmd /c "ssh-keygen -Y verify -f `"$signersPath`" -I synara-beta-releases -s `"$signaturePath`" -n synara-beta < `"$checksumPath`"" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Output $verifyOutput
  throw 'install-windows.ps1: release signature verification failed for SHA256SUMS. Refusing to install.'
}

$asset = "Synara-$version-x64.exe"
$entries = @(Select-String -Path $checksumPath -Pattern ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($asset) + '$'))
if ($entries.Count -eq 0) {
  # Match any Synara x64 exe in this release.
  $entries = @(Select-String -Path $checksumPath -Pattern '^[a-fA-F0-9]{64}\s+\*?(Synara.*x64\.exe)$')
  if ($entries.Count -gt 0) {
    $asset = ($entries[0].Line -split '\s+')[-1].TrimStart('*')
  }
}

if ($entries.Count -eq 0) {
  throw "install-windows.ps1: SHA256SUMS contains no matching entry for a Synara x64 installer."
}
$entries = @($entries[0])

try {
  # GUID-qualified path: two concurrent installs of the same release must never
  # race on one temporary file.
  $installerPath = Join-Path $env:TEMP ("synara-beta-" + [Guid]::NewGuid().ToString("N") + "-" + $asset)
  try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $installerPath -UseBasicParsing

    Write-Output 'Verifying checksum...'
    $expected = ($entries[0].Line -split '\s+')[0]
    $actual = (Get-FileHash -Path $installerPath -Algorithm SHA256).Hash
    if ($actual.ToLowerInvariant() -ne $expected.ToLowerInvariant()) {
      throw "install-windows.ps1: checksum mismatch for '$asset'."
    }

    Unblock-File -Path $installerPath

    Write-Output 'Installing...'
    $proc = Start-Process -FilePath $installerPath -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      throw "install-windows.ps1: installer exited with code $($proc.ExitCode)."
    }
  } finally {
    Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item $checksumPath -Force -ErrorAction SilentlyContinue
  Remove-Item $signaturePath -Force -ErrorAction SilentlyContinue
  Remove-Item $signersPath -Force -ErrorAction SilentlyContinue
}
Write-Output "Installed Synara Beta $Tag."
