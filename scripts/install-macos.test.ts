import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vitest";
import { tryBash } from "./install-test-helper.ts";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-macos.sh");
const script = NodeFS.readFileSync(scriptPath, "utf8");

describe("install-macos.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
    NodeAssert.doesNotMatch(script, /^set -x$/m);
  });

  it("gates on macOS", () => {
    NodeAssert.match(script, /^if \[ "\$\(uname -s\)" != Darwin \]; then$/m);
    NodeAssert.match(script, /arm64\)/);
    NodeAssert.match(script, /x86_64\)/);
  });

  it("uses a temp dir cleaned by an EXIT trap that restores interrupted upgrades", () => {
    NodeAssert.match(script, /^tmp="\$\(mktemp -d\)"$/m);
    NodeAssert.match(script, /^trap restore_on_exit EXIT$/m);
    NodeAssert.match(
      script,
      /if \[ -n "\$\{swap_started:-\}" \] && \[ ! -d "\$app" \] && \[ -d "\$old_app" \]; then/,
    );
    NodeAssert.match(script, /previous installation restored/);
  });

  it("verifies the release signature before trusting checksums", () => {
    NodeAssert.match(
      script,
      /ssh-keygen -Y verify -f "\$tmp\/allowed_signers" -I synara-beta-releases -s "\$tmp\/SHA256SUMS\.sig" -n synara-beta < "\$tmp\/SHA256SUMS"/,
    );
    NodeAssert.match(script, /release signature verification failed/);
    NodeAssert.match(script, /ALLOWED_SIGNERS="synara-beta-releases ssh-ed25519 /);
  });

  it("detects the installed version and refuses same-version and downgrade installs", () => {
    NodeAssert.match(script, /CFBundleShortVersionString/);
    NodeAssert.match(script, /is already installed/);
    NodeAssert.match(script, /Pass --force to downgrade/);
    NodeAssert.match(script, /--force\)/);
  });

  it("supports a --tag override and defaults to the newest beta prerelease", () => {
    NodeAssert.match(script, /--tag\)/);
    NodeAssert.match(script, /--tag=\*\)/);
    NodeAssert.match(
      script,
      /curl -fsSL "https:\/\/api\.github\.com\/repos\/kartikkabadi\/synara-beta\/releases\?per_page=100"/,
    );
    NodeAssert.match(
      script,
      /grep -E '\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-beta\\\.\[0-9\]\+\$'/,
    );
    NodeAssert.match(script, /if \[ -z "\$tag" \]; then/);
  });

  it("parses --help and rejects unknown args", () => {
    const help = tryBash(scriptPath, ["--help"]);
    NodeAssert.equal(help.status, 0);
    NodeAssert.match(
      help.stdout,
      /usage: install-macos\.sh \[--tag vX\.Y\.Z-beta\.N\] \[--force\]/,
    );

    const unknown = tryBash(scriptPath, ["--bogus"]);
    NodeAssert.equal(unknown.status, 1);
    NodeAssert.match(unknown.stderr, /unknown argument/);

    const missing = tryBash(scriptPath, ["--tag"]);
    NodeAssert.equal(missing.status, 1);
    NodeAssert.match(missing.stderr, /--tag requires a value/);
  });

  it("refuses to run on non-Darwin hosts", () => {
    const sandbox = NodeFS.mkdtempSync("/tmp/synara-macos-non-darwin-");
    const stubBin = NodePath.join(sandbox, "bin");
    NodeFS.mkdirSync(stubBin, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stubBin, "uname"),
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else exit 1; fi\n',
    );
    NodeFS.chmodSync(NodePath.join(stubBin, "uname"), 0o755);
    try {
      const result = tryBash(scriptPath, [], {
        ...process.env,
        PATH: `${stubBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      });
      NodeAssert.equal(result.status, 1);
      NodeAssert.match(result.stderr, /unsupported operating system/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("reports a clear error when the release list contains no beta tag", () => {
    const sandbox = NodeFS.mkdtempSync("/tmp/synara-macos-no-release-");
    const stubBin = NodePath.join(sandbox, "bin");
    NodeFS.mkdirSync(stubBin, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stubBin, "uname"),
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; elif [ "$1" = "-m" ]; then echo arm64; else exit 1; fi\n',
    );
    NodeFS.writeFileSync(NodePath.join(stubBin, "curl"), '#!/bin/sh\necho "[]"\n');
    for (const stub of ["uname", "curl"]) {
      NodeFS.chmodSync(NodePath.join(stubBin, stub), 0o755);
    }
    try {
      const result = tryBash(scriptPath, [], {
        ...process.env,
        PATH: `${stubBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      });
      NodeAssert.equal(result.status, 1);
      NodeAssert.match(result.stderr, /could not resolve a release tag/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("accepts only strict vX.Y.Z-beta.N tags", () => {
    NodeAssert.match(
      script,
      /\[\[ "\$tag" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-beta\\\.\[0-9\]\+\$ \]\]/,
    );
  });

  it("downloads SHA256SUMS and DMG from release base", () => {
    NodeAssert.match(
      script,
      /base="https:\/\/github\.com\/kartikkabadi\/synara-beta\/releases\/download\/\$\{tag\}"/,
    );
    NodeAssert.match(script, /curl -fsSL -o "\$tmp\/SHA256SUMS" "\$base\/SHA256SUMS"/);
    NodeAssert.match(script, /curl -fL -o "\$tmp\/\$dmg" "\$base\/\$dmg"/);
  });

  it("verifies the exact checksum line before mounting", () => {
    NodeAssert.match(
      script,
      /line="\$\(grep -E "\^\[a-fA-F0-9\]\{64\}\[\[:space:\]\]\+\\\*\?\$\{dmg\}\\\$" "\$tmp\/SHA256SUMS"\)"/,
    );
    NodeAssert.match(script, /printf "%s\\n" "\$line" \| shasum -a 256 -c -/);
    NodeAssert.match(
      script,
      /hdiutil attach "\$tmp\/\$dmg" -nobrowse -readonly -mountpoint "\$mnt"/,
    );
  });

  it("requires the exact beta bundle identifier before installing", () => {
    NodeAssert.match(script, /Print :CFBundleIdentifier/);
    NodeAssert.match(
      script,
      /^if \[ "\$identifier" != "com\.emanueledipietro\.synara\.beta" \]; then$/m,
    );
  });

  it("installs atomically to /Applications/Synara Beta.app", () => {
    NodeAssert.match(script, /app="\/Applications\/Synara Beta\.app"/);
    NodeAssert.match(
      script,
      /new_app="\/Applications\/\.Synara Beta\.app\.installing\.\$install_id"/,
    );
    NodeAssert.match(script, /old_app="\/Applications\/\.Synara Beta\.app\.backup\.\$install_id"/);
  });

  it("marks a privileged swap for restore_on_exit", () => {
    NodeAssert.match(script, /swap_started=1/);
  });

  it("clears quarantine on the installed app only, including root-owned installs", () => {
    // User-owned installs: remove the flag directly, then verify it is really
    // gone instead of hiding a failed removal behind `|| true`.
    NodeAssert.match(script, /^if \[ -w "\$app" \]; then$/m);
    NodeAssert.match(
      script,
      /^  xattr -d com\.apple\.quarantine "\$app" >\/dev\/null 2>&1 \|\| true$/m,
    );
    NodeAssert.match(script, /quarantine flag is still present/);
    // Root-owned installs (non-writable /Applications): the privileged
    // AppleScript removes the flag itself and fails loudly if it cannot, since
    // an xattr run as the invoking user cannot clear a root-owned app.
    NodeAssert.match(
      script,
      /xattr -d com\.apple\.quarantine " & installedApp & " >\/dev\/null 2>&1; if xattr " & installedApp & " 2>\/dev\/null \| grep -q com\.apple\.quarantine/,
    );
    NodeAssert.match(script, /could not remove the quarantine flag from the installed app/);
    NodeAssert.doesNotMatch(script.toLowerCase(), /spctl/);
    NodeAssert.doesNotMatch(script.toLowerCase(), /master-disable/);
  });

  it("keeps the previous app as a privileged rollback until quarantine removal succeeds", () => {
    const quarantine = script.indexOf('xattr -d com.apple.quarantine " & installedApp & "');
    NodeAssert.ok(quarantine > -1, "privileged AppleScript must clear quarantine");
    const lastBackupRemove = script.lastIndexOf('rm -rf " & oldApp');
    NodeAssert.ok(
      lastBackupRemove > quarantine,
      "privileged AppleScript must remove the backup only after quarantine succeeds",
    );
  });

  it("restores the previous app when quarantine removal fails", () => {
    const quarantineFailure = script.indexOf("grep -q com.apple.quarantine; then mv");
    NodeAssert.ok(
      quarantineFailure > -1,
      "privileged AppleScript must react to quarantine failure",
    );
    NodeAssert.match(script, /then mv " & installedApp & " " & newApp/);
    NodeAssert.match(script, /mv " & oldApp & " " & installedApp/);
  });

  it("opens the app at the end and echoes success", () => {
    NodeAssert.match(script, /^open "\$app" 2>\/dev\/null \|\| echo /m);
    NodeAssert.match(script, /could not open it automatically/);
    NodeAssert.match(script, /^echo "Installed Synara Beta \$tag\."$/m);
  });
});
