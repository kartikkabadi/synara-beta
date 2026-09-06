import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vitest";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-linux.sh");
const script = NodeFS.readFileSync(scriptPath, "utf8");

function tryBash(args: string[]): { status: number; stdout: string; stderr: string } | null {
  try {
    const stdout = NodeChildProcess.execFileSync("bash", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: unknown;
      stderr?: unknown;
      code?: string;
    };
    if (failure.code === "ENOENT") return null;
    return {
      status: failure.status ?? 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}

describe("install-linux.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
    NodeAssert.doesNotMatch(script, /^set -x$/m);
  });

  it("gates on Linux", () => {
    NodeAssert.match(script, /^\[ "\$\(uname -s\)" = Linux \]$/m);
    NodeAssert.match(script, /x86_64\|amd64\)/);
  });

  it("uses a temp dir cleaned by an EXIT trap", () => {
    NodeAssert.match(script, /^tmp="\$\(mktemp -d\)"$/m);
    NodeAssert.match(script, /^trap 'rm -rf "\$tmp"' EXIT$/m);
  });

  it("supports a --tag override and defaults to the latest release", () => {
    NodeAssert.match(script, /--tag\)/);
    NodeAssert.match(script, /--tag=\*\)/);
    NodeAssert.match(
      script,
      /curl -fsSL https:\/\/api\.github\.com\/repos\/kartikkabadi\/synara-beta\/releases\/latest/,
    );
    NodeAssert.match(script, /if \[ -z "\$tag" \]; then/);
  });

  it("parses --help and rejects unknown args", () => {
    const help = tryBash(["--help"]);
    if (help !== null) {
      NodeAssert.equal(help.status, 0);
      NodeAssert.match(help.stdout, /usage: install-linux\.sh \[--tag vX\.Y\.Z\]/);
    }

    const unknown = tryBash(["--bogus"]);
    if (unknown !== null) {
      NodeAssert.equal(unknown.status, 1);
      NodeAssert.match(unknown.stderr, /unknown argument/);
    }

    const missing = tryBash(["--tag"]);
    if (missing !== null) {
      NodeAssert.equal(missing.status, 1);
      NodeAssert.match(missing.stderr, /--tag requires a value/);
    }
  });

  it("downloads SHA256SUMS and AppImage", () => {
    NodeAssert.match(
      script,
      /base="https:\/\/github\.com\/kartikkabadi\/synara-beta\/releases\/download\/\$\{tag\}"/,
    );
    NodeAssert.match(script, /curl -fsSL -o "\$tmp\/SHA256SUMS" "\$base\/SHA256SUMS"/);
    NodeAssert.match(script, /curl -fL -o "\$tmp\/\$appimage" "\$base\/\$appimage"/);
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
});
