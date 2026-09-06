import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vitest";
import { tryBash } from "./install-test-helper.ts";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install.sh");
const script = NodeFS.readFileSync(scriptPath, "utf8");

describe("install.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
  });

  it("maps Darwin to macos and Linux to linux", () => {
    const darwinBranch = script.indexOf("Darwin)");
    const linuxBranch = script.indexOf("Linux)");
    const macosAssign = script.indexOf('platform="macos"');
    const linuxAssign = script.indexOf('platform="linux"');
    NodeAssert.ok(darwinBranch > -1, "install.sh must detect Darwin");
    NodeAssert.ok(linuxBranch > -1, "install.sh must detect Linux");
    NodeAssert.ok(
      macosAssign > darwinBranch && macosAssign < linuxBranch,
      "Darwin branch must assign platform=macos",
    );
    NodeAssert.ok(linuxAssign > linuxBranch, "Linux branch must assign platform=linux");
  });

  it("provides Windows PowerShell instructions on Windows shells", () => {
    NodeAssert.match(script, /MINGW\*\|MSYS\*\|CYGWIN\*\)/);
    NodeAssert.match(script, /install-windows\.ps1/);
  });

  it("extracts --tag argument when provided", () => {
    NodeAssert.match(script, /--tag/);
    NodeAssert.match(script, /--tag=\*/);
    NodeAssert.match(script, /tag="\$\{args\[i\+1\]\}"/);
  });

  it("uses a temp file with EXIT cleanup", () => {
    NodeAssert.match(script, /tmp_file="\$\(mktemp /);
    NodeAssert.match(script, /trap 'rm -f "\$tmp_file"' EXIT/);
  });

  it("resolves the newest beta tag and fails instead of falling back to main", () => {
    NodeAssert.match(
      script,
      /curl -fsSL "https:\/\/api\.github\.com\/repos\/kartikkabadi\/synara-beta\/releases\?per_page=100"/,
    );
    NodeAssert.match(script, /grep -- '-beta'/);
    NodeAssert.match(script, /install\.sh: could not resolve a release tag/);
    NodeAssert.match(script, /install\.sh: failed to download/);
    NodeAssert.doesNotMatch(script, /main\/scripts\/install-/);
    NodeAssert.match(script, /curl -fsSL -o "\$tmp_file"/);
    // Empty-array safe under `set -u` on bash 3.2 (stock macOS): the bare
    // `"${args[@]}"` form exits unbound-variable with zero args.
    NodeAssert.match(script, /bash "\$tmp_file" \$\{args\[@\]\+"\$\{args\[@\]\}"\}/);
  });

  it("delegates with zero args without tripping set -u", () => {
    const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "synara-install-router-"));
    try {
      const stubBin = NodePath.join(sandbox, "bin");
      NodeFS.mkdirSync(stubBin, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(stubBin, "uname"),
        '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; elif [ "$1" = "-m" ]; then echo x86_64; else exit 1; fi\n',
      );
      NodeFS.writeFileSync(
        NodePath.join(stubBin, "curl"),
        '#!/bin/sh\nout=\'\'\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2;;\n    -*) shift;;\n    *) shift;;\n  esac\ndone\nif [ -z "$out" ]; then\n  printf \'[{"tag_name": "v9.9.9-beta.9"}]\n\'\nelse\n  printf \'#!/usr/bin/env bash\necho "stub-platform received $# args"\n\' > "$out"\nfi\n',
      );
      for (const stub of ["uname", "curl"]) {
        NodeFS.chmodSync(NodePath.join(stubBin, stub), 0o755);
      }
      const result = tryBash(scriptPath, [], {
        ...process.env,
        PATH: `${stubBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      });
      NodeAssert.equal(result.status, 0);
      NodeAssert.match(result.stdout, /stub-platform received 0 args/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
