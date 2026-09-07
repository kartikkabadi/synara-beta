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
