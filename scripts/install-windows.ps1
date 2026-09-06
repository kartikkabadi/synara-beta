# One-line Windows installer for Synara Beta (x64).
#
#   $t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -like '*-beta*' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }
#   install-windows.ps1 -Tag v0.8.2-beta.1
#
# Downloads the GitHub exe for the latest beta tag (or -Tag), checks
# SHA256SUMS, unblocks the file, then runs the installer.
param(
  [string]$Tag = '',
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Write-Output 'usage: install-windows.ps1 [-Tag vX.Y.Z]'
  exit 0
}

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw "install-windows.ps1: unsupported architecture: '$($env:PROCESSOR_ARCHITECTURE)'. x64 (AMD64) required (no Windows arm64 installer is published)."
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if (-not $Tag) {
  # /releases/latest excludes prereleases, so list releases and pick the newest -beta tag.
  $Tag = ((Invoke-RestMethod -Uri 'https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100' -UseBasicParsing) | Where-Object { $_.tag_name -like '*-beta*' } | Select-Object -First 1).tag_name
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
  $installerPath = Join-Path $env:TEMP $asset
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

  Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
} finally {
  Remove-Item $checksumPath -Force -ErrorAction SilentlyContinue
}
Write-Output "Installed Synara Beta $Tag."
