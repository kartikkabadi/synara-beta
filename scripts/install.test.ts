import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vitest";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install.sh");
const script = NodeFS.readFileSync(scriptPath, "utf8");

describe("install.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
  });

  it("detects Darwin and Linux platforms", () => {
    NodeAssert.match(script, /Darwin\)/);
    NodeAssert.match(script, /platform="macos"/);
    NodeAssert.match(script, /Linux\)/);
    NodeAssert.match(script, /platform="linux"/);
  });

  it("provides Windows PowerShell instructions on Windows shells", () => {
    NodeAssert.match(script, /MINGW\*\|MSYS\*\|CYGWIN\*\)/);
    NodeAssert.match(script, /install-windows\.ps1/);
  });

  it("extracts --tag argument when provided", () => {
    NodeAssert.match(script, /--tag/);
    NodeAssert.match(script, /--tag=\*/);
  });

  it("uses a temp file with EXIT cleanup", () => {
    NodeAssert.match(script, /tmp_file="\$\(mktemp /);
    NodeAssert.match(script, /trap 'rm -f "\$tmp_file"' EXIT/);
  });

  it("fetches the platform installer and executes it", () => {
    NodeAssert.match(script, /curl -fsSL -o "\$tmp_file"/);
    NodeAssert.match(script, /bash "\$tmp_file" "\$\{args\[@\]\}"/);
  });
});
