import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vitest";
import { tryBash } from "./install-test-helper.ts";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-linux.sh");
const script = NodeFS.readFileSync(scriptPath, "utf8");

describe("install-linux.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
    NodeAssert.doesNotMatch(script, /^set -x$/m);
  });

  it("gates on Linux x86_64 and rejects arm64", () => {
    NodeAssert.match(script, /^if \[ "\$\(uname -s\)" != Linux \]; then$/m);
    NodeAssert.match(script, /x86_64\|amd64\)/);
    NodeAssert.match(script, /aarch64\|arm64\)/);
    NodeAssert.match(script, /no Linux arm64 AppImage is published/);
    NodeAssert.doesNotMatch(script, /default_arch="arm64"/);
  });

  it("uses a temp dir cleaned by an EXIT trap", () => {
    NodeAssert.match(script, /^tmp="\$\(mktemp -d\)"$/m);
    NodeAssert.match(script, /^trap 'rm -rf "\$tmp"' EXIT$/m);
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
    NodeAssert.match(help.stdout, /usage: install-linux\.sh \[--tag vX\.Y\.Z\]/);

    const unknown = tryBash(scriptPath, ["--bogus"]);
    NodeAssert.equal(unknown.status, 1);
    NodeAssert.match(unknown.stderr, /unknown argument/);

    const missing = tryBash(scriptPath, ["--tag"]);
    NodeAssert.equal(missing.status, 1);
    NodeAssert.match(missing.stderr, /--tag requires a value/);
  });

  it("downloads SHA256SUMS and AppImage with a pipefail-safe fallback", () => {
    NodeAssert.match(
      script,
      /base="https:\/\/github\.com\/kartikkabadi\/synara-beta\/releases\/download\/\$\{tag\}"/,
    );
    NodeAssert.match(script, /curl -fsSL -o "\$tmp\/SHA256SUMS" "\$base\/SHA256SUMS"/);
    NodeAssert.match(script, /curl -fL -o "\$tmp\/\$appimage" "\$base\/\$appimage"/);
    NodeAssert.match(script, /\| sed 's\/\^\\\*\/\/' \|\| true\)/);
  });

  it("verifies the exact checksum line before installing", () => {
    NodeAssert.match(
      script,
      /line="\$\(grep -E "\^\[a-fA-F0-9\]\{64\}\[\[:space:\]\]\+\\\*\?\$\{appimage\}\\\$" "\$tmp\/SHA256SUMS"\)"/,
    );
    NodeAssert.match(script, /sha256sum -c -/);
  });

  it("installs atomically to ~/.local/bin/synara-beta with staging", () => {
    NodeAssert.match(script, /dest="\$HOME\/\.local\/bin\/synara-beta"/);
    NodeAssert.match(script, /mkdir -p "\$HOME\/\.local\/bin"/);
    NodeAssert.match(script, /staged="\$dest\.new\.\$\$"/);
    NodeAssert.match(script, /cp -p "\$tmp\/\$appimage" "\$staged"/);
    NodeAssert.match(script, /chmod \+x "\$staged"/);
    NodeAssert.match(script, /mv -f "\$staged" "\$dest"/);
  });

  it("creates a desktop entry for launcher integration", () => {
    NodeAssert.match(script, /synara-beta\.desktop/);
    NodeAssert.match(script, /StartupWMClass=synara-beta/);
    NodeAssert.match(script, /Categories=Development;/);
  });

  it("prints success message", () => {
    NodeAssert.match(script, /^echo "Installed Synara Beta \$tag\."$/m);
  });

  it("installs a stubbed release into a sandboxed HOME", () => {
    const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "synara-linux-install-"));
    try {
      const home = NodePath.join(sandbox, "home");
      const stubBin = NodePath.join(sandbox, "bin");
      NodeFS.mkdirSync(home, { recursive: true });
      NodeFS.mkdirSync(stubBin, { recursive: true });
      const dataDir = NodePath.join(home, ".synara-beta");
      NodeFS.mkdirSync(dataDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dataDir, "state.sqlite"), "user-data");

      const tag = "v9.9.9-beta.9";
      const payload = "stubbed-synara-appimage-bytes";
      const digest = NodeCrypto.createHash("sha256").update(payload).digest("hex");
      const asset = "Synara-Beta-9.9.9-beta.9-x86_64.AppImage";
      NodeFS.writeFileSync(NodePath.join(sandbox, "SHA256SUMS"), `${digest}  ${asset}\n`);
      NodeFS.writeFileSync(NodePath.join(sandbox, "payload"), payload);

      // Sign the checksums with a throwaway key and pin its public half in a
      // copy of the installer, exercising the real verification path.
      const signingKey = NodePath.join(sandbox, "signing-key");
      NodeChildProcess.execFileSync(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-C", "test", "-f", signingKey],
        { stdio: "ignore" },
      );
      NodeChildProcess.execFileSync(
        "ssh-keygen",
        ["-Y", "sign", "-f", signingKey, "-n", "synara-beta", NodePath.join(sandbox, "SHA256SUMS")],
        { stdio: "ignore" },
      );
      const publicKey = NodeFS.readFileSync(`${signingKey}.pub`, "utf8").trim();
      const installerCopy = NodePath.join(sandbox, "install-linux-under-test.sh");
      NodeFS.writeFileSync(
        installerCopy,
        script.replace(
          /^ALLOWED_SIGNERS=".*$/m,
          `ALLOWED_SIGNERS="synara-beta-releases ${publicKey}"`,
        ),
      );
      NodeFS.writeFileSync(
        NodePath.join(stubBin, "uname"),
        '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; elif [ "$1" = "-m" ]; then echo x86_64; else exit 1; fi\n',
      );
      NodeFS.writeFileSync(
        NodePath.join(stubBin, "curl"),
        '#!/bin/sh\nout=""\nurl=""\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2;;\n    -*) shift;;\n    *) url="$1"; shift;;\n  esac\ndone\ncase "$url" in\n  */SHA256SUMS.sig) cat "$STUB_SIG" > "$out";;\n  */SHA256SUMS) cat "$STUB_SUMS" > "$out";;\n  *) cat "$STUB_PAYLOAD" > "$out";;\nesac\n',
      );
      try {
        NodeChildProcess.execFileSync("sha256sum", ["--version"], { stdio: "ignore" });
      } catch {
        NodeFS.writeFileSync(
          NodePath.join(stubBin, "sha256sum"),
          '#!/bin/sh\nexec shasum -a 256 "$@"\n',
        );
      }
      for (const stub of ["uname", "curl", "sha256sum"]) {
        const stubPath = NodePath.join(stubBin, stub);
        if (NodeFS.existsSync(stubPath)) NodeFS.chmodSync(stubPath, 0o755);
      }

      const result = tryBash(installerCopy, ["--tag", tag], {
        ...process.env,
        PATH: `${stubBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        STUB_SUMS: NodePath.join(sandbox, "SHA256SUMS"),
        STUB_SIG: NodePath.join(sandbox, "SHA256SUMS.sig"),
        STUB_PAYLOAD: NodePath.join(sandbox, "payload"),
      });
      NodeAssert.equal(result.status, 0);
      NodeAssert.match(result.stdout, /Installed Synara Beta v9\.9\.9-beta\.9\./);

      const dest = NodePath.join(home, ".local", "bin", "synara-beta");
      NodeAssert.equal(NodeFS.readFileSync(dest, "utf8"), payload);
      NodeAssert.ok(
        (NodeFS.statSync(dest).mode & 0o111) !== 0,
        "installed binary must be executable",
      );

      const desktop = NodeFS.readFileSync(
        NodePath.join(home, ".local", "share", "applications", "synara-beta.desktop"),
        "utf8",
      );
      NodeAssert.match(desktop, /StartupWMClass=synara-beta/);
      NodeAssert.ok(desktop.includes(`Exec="${home}/.local/bin/synara-beta" %U`));

      const stateStamp = NodePath.join(home, ".local", "state", "synara-beta-installer", "installed-version");
      NodeAssert.equal(NodeFS.readFileSync(stateStamp, "utf8").trim(), "9.9.9-beta.9");

      // The installer must never touch the app data directory.
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(dataDir, "state.sqlite")), true);
      NodeAssert.equal(NodeFS.readFileSync(NodePath.join(dataDir, "state.sqlite"), "utf8"), "user-data");
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
