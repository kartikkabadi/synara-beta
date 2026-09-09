import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vitest";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-windows.ps1");
const script = NodeFS.readFileSync(scriptPath, "utf8");

describe("install-windows.ps1", () => {
  it("stops on every failed check", () => {
    NodeAssert.match(script, /^\$ErrorActionPreference = 'Stop'$/m);
  });

  it("requires Windows x64 and rejects ARM64", () => {
    NodeAssert.match(script, /\$env:PROCESSOR_ARCHITECTURE/);
    NodeAssert.match(script, /-ne 'AMD64'/);
    NodeAssert.match(script, /no Windows arm64 installer is published/);
  });

  it("requires TLS 1.2", () => {
    NodeAssert.match(script, /\[Net\.ServicePointManager\]::SecurityProtocol/);
    NodeAssert.match(script, /Tls12/);
  });

  it("supports a -Tag override and defaults to the newest beta prerelease", () => {
    NodeAssert.match(script, /\$Tag/);
    NodeAssert.match(script, /Invoke-RestMethod/);
    NodeAssert.match(
      script,
      /https:\/\/api\.github\.com\/repos\/kartikkabadi\/synara-beta\/releases\?per_page=100/,
    );
    NodeAssert.match(script, /tag_name -match '\^v\\d\+\\\.\\d\+\\\.\\d\+-beta\\\.\\d\+\$'/);
    NodeAssert.match(script, /if \(-not \$Tag\)/);
  });

  it("accepts only strict vX.Y.Z-beta.N tags", () => {
    NodeAssert.match(script, /\^v\\d\+\\\.\\d\+\\\.\\d\+-beta\\\.\\d\+\$/);
  });

  it("checks the installed version from beta-specific install metadata before downloading", () => {
    // The beta NSIS package records DisplayVersion under the beta app's
    // uninstall registry key; stable uses a different app id, so a Stable
    // install must never satisfy this check.
    NodeAssert.match(script, /DisplayVersion/);
    NodeAssert.match(
      script,
      /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a8e63b48-d4f3-4db5-9e12-368107afe65d/,
    );
    NodeAssert.match(
      script,
      /HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall/,
    );
    // The check must run before the release download starts.
    NodeAssert.ok(
      script.indexOf("DisplayVersion") <
        script.indexOf('Invoke-WebRequest -Uri "$base/SHA256SUMS"'),
      "installed-version check must run before the first download",
    );
  });

  it("uses the Windows beta installer GUID from the build config", () => {
    const configPath = NodePath.resolve(
      import.meta.dirname,
      "./lib/desktop-platform-build-config.ts",
    );
    const config = NodeFS.readFileSync(configPath, "utf8");
    const match = config.match(/WINDOWS_BETA_INSTALLER_GUID = "([^"]+)"/);
    NodeAssert.ok(match, "build config must declare WINDOWS_BETA_INSTALLER_GUID");
    const guid = match[1];
    if (!guid) throw new Error("WINDOWS_BETA_INSTALLER_GUID capture failed");
    const escaped = guid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    NodeAssert.match(script, new RegExp(escaped));
    NodeAssert.ok(
      script.indexOf(guid) < script.indexOf('Invoke-WebRequest -Uri "$base/SHA256SUMS"'),
      "installed-version check must run before the first download",
    );
  });

  it("implements -Force semantics for reinstall and downgrade", () => {
    NodeAssert.match(script, /-not \$Force/);
    NodeAssert.match(script, /is already installed\. Re-run with -Force to reinstall\./);
    NodeAssert.match(script, /is newer than \$Tag\. Pass -Force to downgrade\./);
    // Same-version and downgrade exits must happen before any download.
    const forceGate = script.indexOf("Re-run with -Force to reinstall");
    NodeAssert.ok(forceGate > -1);
    NodeAssert.ok(
      script.indexOf('Invoke-WebRequest -Uri "$base/SHA256SUMS"') > forceGate,
      "version checks must run before the first download",
    );
  });

  it("compares versions with a beta-aware sort key, not string order", () => {
    NodeAssert.match(script, /function Get-VersionKey/);
    NodeAssert.match(
      script,
      /\(Get-VersionKey \$installedVersion\) -gt \(Get-VersionKey \$version\)/,
    );
    // A stable release (no -beta.N) must sort after its betas, like the bash
    // installers' version_key. The all-nines sentinel keeps even beta.10000
    // below its stable release.
    NodeAssert.match(script, /else \{ 9999999999 \}/);
  });

  it("rejects beta numbers at the version-key sentinel before any download", () => {
    // beta.10000000000 would overflow the 10-digit beta field in
    // Get-VersionKey and could sort above its own stable release, silently
    // enabling a downgrade. The installer must refuse the tag outright,
    // including leading-zero spellings of the sentinel.
    NodeAssert.match(
      script,
      /beta number in '\$Tag' is at or beyond the 10\^10 version-key sentinel; refusing to install\./,
    );
    const sentinel = script.indexOf("beta number in '$Tag' is at or beyond");
    NodeAssert.ok(sentinel > -1, "sentinel rejection must exist");
    NodeAssert.ok(
      script.indexOf('Invoke-WebRequest -Uri "$base/SHA256SUMS"') > sentinel,
      "sentinel rejection must run before the first download",
    );
    NodeAssert.match(script, /-replace '\^0\+', ''/);
  });

  it("requires ssh-keygen with -Y support and gives actionable guidance", () => {
    NodeAssert.match(script, /Get-Command ssh-keygen -ErrorAction SilentlyContinue/);
    NodeAssert.match(script, /The OpenSSH client is required to verify the release signature/);
    NodeAssert.match(script, /Add-WindowsCapability -Online -Name OpenSSH\.Client~~~~0\.0\.1\.0/);
    // OpenSSH 8.9 introduced ssh-keygen -Y; stock Windows images ship 8.1.
    NodeAssert.ok(
      script.includes("OpenSSH(?:_for_Windows)?[_ ](\\d+)\\.(\\d+)"),
      "version probe must parse the OpenSSH version",
    );
    NodeAssert.match(script, /does not support 'ssh-keygen -Y' \(8\.9\+ required\)/);
    // The gate must run before anything is downloaded.
    NodeAssert.ok(
      script.indexOf("Get-Command ssh-keygen") <
        script.indexOf('Invoke-WebRequest -Uri "$base/SHA256SUMS"'),
      "ssh-keygen availability check must run before the first download",
    );
  });

  it("downloads SHA256SUMS and installer exe with basic parsing", () => {
    NodeAssert.match(
      script,
      /\$base = "https:\/\/github\.com\/kartikkabadi\/synara-beta\/releases\/download\/\$Tag"/,
    );
    NodeAssert.match(
      script,
      /Invoke-WebRequest -Uri "\$base\/SHA256SUMS" -OutFile \$checksumPath -UseBasicParsing/,
    );
    NodeAssert.match(
      script,
      /Invoke-WebRequest -Uri "\$base\/\$asset" -OutFile \$installerPath -UseBasicParsing/,
    );
  });

  it("verifies SHA256 checksum with Get-FileHash", () => {
    NodeAssert.match(script, /Select-String -Path \$checksumPath/);
    NodeAssert.match(script, /Get-FileHash -Path \$installerPath -Algorithm SHA256/);
    NodeAssert.match(script, /\$entries = @\(\$entries\[0\]\)/);
    const hashIndex = script.indexOf("Get-FileHash");
    NodeAssert.ok(hashIndex > -1);
    NodeAssert.ok(script.lastIndexOf("Unblock-File") > hashIndex);
  });

  it("unblocks and runs the installer with Start-Process", () => {
    NodeAssert.match(script, /^\s+Unblock-File -Path \$installerPath$/m);
    NodeAssert.match(script, /\$proc = Start-Process -FilePath \$installerPath -Wait -PassThru/);
    NodeAssert.match(script, /if \(\$proc\.ExitCode -ne 0\)/);
  });

  it("supports -Help", () => {
    NodeAssert.match(script, /\[switch\]\$Help/);
    NodeAssert.match(script, /if \(\$Help\)/);
    NodeAssert.match(script, /usage: install-windows\.ps1 \[-Tag vX\.Y\.Z-beta\.N\] \[-Force\]/);
  });

  it("prints success sentence", () => {
    NodeAssert.match(script, /Write-Output "Installed Synara Beta \$Tag\."/);
  });
});
