# One-line Windows installer for Synara Beta (x64).
#
#   $t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+-beta\.\d+$' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }
#   install-windows.ps1 -Tag v0.8.2-beta.1
#
# Downloads the GitHub exe for the latest beta tag (or -Tag), verifies the
# signed SHA256SUMS, unblocks the file, then runs the installer. Re-running
# with a newer tag updates in place; the same version needs -Force to
# reinstall and downgrades are refused without -Force.
param(
  [string]$Tag = '',
  [switch]$Force,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Write-Output 'usage: install-windows.ps1 [-Tag vX.Y.Z-beta.N] [-Force]'
  Write-Output 're-running with a newer tag updates in place; ~/.synara-beta is never touched'
  exit 0
}

# Portable version key: vX.Y.Z-beta.N -> fixed-width sortable string where a
# stable release sorts after its beta previews (mirrors the bash installers).
function Get-VersionKey([string]$Version) {
  if ($Version -match '^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$') {
    $beta = if ($Matches[4]) { [long]$Matches[4] } else { 9999 }
    return '{0:D6}{1:D6}{2:D6}{3:D6}' -f [long]$Matches[1], [long]$Matches[2], [long]$Matches[3], $beta
  }
  return $Version
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
# Strict validation: the tag flows into URLs and regex patterns below.
if ($Tag -notmatch '^v\d+\.\d+\.\d+-beta\.\d+$') {
  throw "install-windows.ps1: invalid tag '$Tag'. Expected vX.Y.Z-beta.N."
}

$version = $Tag.TrimStart('v')

# Update semantics: re-running this installer is the update path. The beta NSIS
# package records its version as DisplayVersion under the beta app's uninstall
# registry key (the electron-builder GUID derived from the beta app id); skip
# when it already matches, refuse downgrades without -Force. The key is
# beta-specific - Synara Stable uses a different app id, so a Stable install is
# never mistaken for this one - and the app data directory ~/.synara-beta is
# never read or written here.
$uninstallKeyPaths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\a8e63b48-d4f3-4db5-9e12-368107afe65d',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\a8e63b48-d4f3-4db5-9e12-368107afe65d',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\a8e63b48-d4f3-4db5-9e12-368107afe65d'
)
$installedVersion = ''
foreach ($uninstallKeyPath in $uninstallKeyPaths) {
  $uninstallKey = Get-ItemProperty -Path $uninstallKeyPath -ErrorAction SilentlyContinue
  if ($uninstallKey -and $uninstallKey.DisplayVersion) {
    $installedVersion = [string]$uninstallKey.DisplayVersion
    break
  }
}
if ($installedVersion) {
  if ($installedVersion -eq $version -and -not $Force) {
    Write-Output "Synara Beta $installedVersion is already installed. Re-run with -Force to reinstall."
    exit 0
  }
  if (-not $Force -and (Get-VersionKey $installedVersion) -gt (Get-VersionKey $version)) {
    throw "install-windows.ps1: installed Synara Beta $installedVersion is newer than $Tag. Pass -Force to downgrade."
  }
}

Write-Output "Installing Synara Beta $Tag for Windows ($env:PROCESSOR_ARCHITECTURE)..."

$base = "https://github.com/kartikkabadi/synara-beta/releases/download/$Tag"
$checksumPath = Join-Path $env:TEMP ("SHA256SUMS-" + [Guid]::NewGuid().ToString("N"))
$signaturePath = Join-Path $env:TEMP ("SHA256SUMS.sig-" + [Guid]::NewGuid().ToString("N"))
$signersPath = Join-Path $env:TEMP ("allowed-signers-" + [Guid]::NewGuid().ToString("N"))
$installerPath = ''

# Every downloaded file is cleaned in the outer finally, whatever fails.
try {
  # ssh-keygen -Y arrived in OpenSSH 8.9, and Windows images still ship older
  # clients (8.1) where the flag is unknown - without a check every release
  # would fail signature verification with a confusing crypto error. Detect
  # that up front and point at the fix instead.
  if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    throw 'install-windows.ps1: ssh-keygen was not found. The OpenSSH client is required to verify the release signature; install it from an elevated PowerShell with "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0" (or Settings > Apps > Optional features > OpenSSH Client), then re-run this installer.'
  }
  $sshVersionText = cmd /c 'ssh -V' 2>&1 | Out-String
  if ($sshVersionText -match 'OpenSSH(?:_for_Windows)?[_ ](\d+)\.(\d+)') {
    if (([int]$Matches[1] -lt 8) -or ([int]$Matches[1] -eq 8 -and [int]$Matches[2] -lt 9)) {
      throw "install-windows.ps1: OpenSSH $($Matches[1]).$($Matches[2]) does not support 'ssh-keygen -Y' (8.9+ required). Update the OpenSSH client from Settings > Apps > Optional features, or run 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0' from an elevated PowerShell, then re-run this installer."
    }
  }

  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $checksumPath -UseBasicParsing

  # The release signature authenticates SHA256SUMS before any checksum is
  # trusted. The private key lives in the SYNARA_RELEASE_SIGNING_KEY repository
  # secret; the matching public key is pinned in scripts/release-signing.pub.
  $allowedSigners = 'synara-beta-releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFA61LZNkb3QTME3wdqznC/zghISZ9nsS2BnUMUQ1JRo'
  Invoke-WebRequest -Uri "$base/SHA256SUMS.sig" -OutFile $signaturePath -UseBasicParsing
  Set-Content -Path $signersPath -Value $allowedSigners -Encoding ascii
  Write-Output 'Verifying release signature...'
  # ssh-keygen -Y verify reads the signed content from stdin; PowerShell has no
  # < redirection, so route through cmd with the redirect attached.
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

  # GUID-qualified path: two concurrent installs of the same release must never
  # race on one temporary file.
  $installerPath = Join-Path $env:TEMP ("synara-beta-" + [Guid]::NewGuid().ToString("N") + "-" + $asset)
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
  if ($installerPath -ne '') {
    Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $checksumPath -Force -ErrorAction SilentlyContinue
  Remove-Item $signaturePath -Force -ErrorAction SilentlyContinue
  Remove-Item $signersPath -Force -ErrorAction SilentlyContinue
}
Write-Output "Installed Synara Beta $Tag."
