import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vitest";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-macos.sh");
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

describe("install-macos.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
    NodeAssert.doesNotMatch(script, /^set -x$/m);
  });

  it("gates on macOS", () => {
    NodeAssert.match(script, /^\[ "\$\(uname -s\)" = Darwin \]$/m);
    NodeAssert.match(script, /arm64\)/);
    NodeAssert.match(script, /x86_64\)/);
  });

  it("uses a temp dir cleaned by an EXIT trap", () => {
    NodeAssert.match(script, /^tmp="\$\(mktemp -d\)"$/m);
    NodeAssert.match(
      script,
      /^trap 'hdiutil detach "\$mnt" >\/dev\/null 2>&1 \|\| true; rm -rf "\$tmp"' EXIT$/m,
    );
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
      NodeAssert.match(help.stdout, /usage: install-macos\.sh \[--tag vX\.Y\.Z\]/);
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

  it("accepts valid vX.Y.Z and beta tags", () => {
    NodeAssert.match(script, /\[\[ "\$tag" =~ \^v\[0-9\]\+\.\* \]\]/);
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

  it("asserts the Synara bundle identifier before installing", () => {
    NodeAssert.match(script, /Print :CFBundleIdentifier/);
    NodeAssert.match(script, /com\.emanueledipietro\.synara\.beta/);
  });

  it("installs atomically to /Applications/Synara Beta.app", () => {
    NodeAssert.match(script, /app="\/Applications\/Synara Beta\.app"/);
    NodeAssert.match(script, /new_app="\/Applications\/\.Synara Beta\.app\.installing\.\$install_id"/);
    NodeAssert.match(script, /old_app="\/Applications\/\.Synara Beta\.app\.backup\.\$install_id"/);
  });

  it("clears quarantine on the installed app only", () => {
    NodeAssert.match(script, /^xattr -d com\.apple\.quarantine "\$app" 2>\/dev\/null \|\| true$/m);
    NodeAssert.doesNotMatch(script.toLowerCase(), /spctl/);
    NodeAssert.doesNotMatch(script.toLowerCase(), /master-disable/);
  });

  it("opens the app at the end and echoes success", () => {
    NodeAssert.match(script, /^open "\$app"$/m);
    NodeAssert.match(script, /^echo "Installed Synara Beta \$tag\."$/m);
  });
});
