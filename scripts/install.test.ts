import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vitest";
import { tryBash } from "./install-test-helper.ts";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install.sh");
const script = NodeFS.readFileSync(scriptPath, "utf8");

/**
 * Builds a sandbox whose `uname` and `curl` are stubs so install.sh runs for
 * real: the stub curl serves a release list, then writes a sentinel platform
 * script that records how it was invoked. `platformScript` is the body of the
 * delegated installer the stub curl serves.
 */
interface InstallSandbox {
  sandbox: string;
  recordPath: string;
  selfPath: string;
}

function makeSandbox(options: {
  uname: string;
  releases: string;
  platformScript?: string;
}): InstallSandbox {
  const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "synara-install-router-"));
  const stubBin = NodePath.join(sandbox, "bin");
  NodeFS.mkdirSync(stubBin, { recursive: true });
  const recordPath = NodePath.join(sandbox, "delegated-invocation.txt");
  const selfPath = NodePath.join(sandbox, "delegated-self.txt");
  const stagedScript = NodePath.join(sandbox, "staged-platform-script.sh");
  NodeFS.writeFileSync(
    stagedScript,
    options.platformScript ??
      `#!/usr/bin/env bash\nprintf '%s\\n' "$0" > ${JSON.stringify(selfPath)}\nprintf '%s\\n' "$*" > ${JSON.stringify(recordPath)}\n`,
  );
  const releasesFile = NodePath.join(sandbox, "releases.json");
  NodeFS.writeFileSync(releasesFile, `${options.releases}\n`);
  NodeFS.writeFileSync(NodePath.join(stubBin, "uname"), `#!/bin/sh\necho "${options.uname}"\n`);
  NodeFS.writeFileSync(
    NodePath.join(stubBin, "curl"),
    [
      "#!/bin/sh",
      "out=''",
      "url=''",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2;;',
      "    -*) shift;;",
      '    *) url="$1"; shift;;',
      "  esac",
      "done",
      'if [ -z "${out:-}" ]; then',
      `  cat ${JSON.stringify(releasesFile)}`,
      "else",
      `  printf '%s\\n' "$url" >> ${JSON.stringify(NodePath.join(sandbox, "fetched-urls.txt"))}`,
      `  cp ${JSON.stringify(stagedScript)} "$out"`,
      "fi",
      "",
    ].join("\n"),
  );
  for (const stub of ["uname", "curl"]) {
    NodeFS.chmodSync(NodePath.join(stubBin, stub), 0o755);
  }
  return { sandbox, recordPath, selfPath };
}

function sandboxEnv(sandbox: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${NodePath.join(sandbox, "bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  };
}

// The GitHub API returns pretty-printed JSON: one field per line. The
// resolvers grep per line, so the fixture must match that shape.
const RELEASES = [
  "{",
  '  "tag_name": "v9.9.9-beta.9",',
  '  "prerelease": true',
  "},",
  "{",
  '  "tag_name": "v1.2.3",',
  '  "prerelease": false',
  "},",
  "{",
  '  "tag_name": "nightly-beta",',
  '  "prerelease": true',
  "},",
  "{",
  '  "tag_name": "v0.8.2-beta.1",',
  '  "prerelease": true',
  "}",
].join("\n");

describe("install.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
  });

  it("runs the macos installer for Darwin and the linux installer for Linux", () => {
    for (const [uname, expectedScript] of [
      ["Darwin", "install-macos.sh"],
      ["Linux", "install-linux.sh"],
    ] as const) {
      const { sandbox, recordPath } = makeSandbox({ uname, releases: RELEASES });
      try {
        const result = tryBash(scriptPath, [], sandboxEnv(sandbox));
        NodeAssert.equal(result.status, 0);
        const fetched = NodeFS.readFileSync(NodePath.join(sandbox, "fetched-urls.txt"), "utf8");
        NodeAssert.match(
          fetched,
          new RegExp(
            `raw\\.githubusercontent\\.com/kartikkabadi/synara-beta/[^/]+/scripts/${expectedScript}`,
          ),
        );
        NodeAssert.equal(NodeFS.existsSync(recordPath), true);
        const invocation = NodeFS.readFileSync(recordPath, "utf8");
        NodeAssert.match(invocation, /--tag v9\.9\.9-beta\.9/);
      } finally {
        NodeFS.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("resolves only strict vX.Y.Z-beta.N tags, never loose -beta names", () => {
    const { sandbox } = makeSandbox({ uname: "Darwin", releases: RELEASES });
    try {
      const result = tryBash(scriptPath, [], sandboxEnv(sandbox));
      NodeAssert.equal(result.status, 0);
      const fetched = NodeFS.readFileSync(NodePath.join(sandbox, "fetched-urls.txt"), "utf8");
      // v9.9.9-beta.9 sorts newest; "nightly-beta" and plain releases must be skipped.
      NodeAssert.match(fetched, /synara-beta\/v9\.9\.9-beta\.9\//);
      NodeAssert.doesNotMatch(fetched, /synara-beta\/nightly-beta\//);
      NodeAssert.doesNotMatch(fetched, /synara-beta\/v1\.2\.3\//);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("appends the resolved tag when --force is passed without --tag", () => {
    const { sandbox, recordPath } = makeSandbox({ uname: "Linux", releases: RELEASES });
    try {
      const result = tryBash(scriptPath, ["--force"], sandboxEnv(sandbox));
      NodeAssert.equal(result.status, 0);
      const invocation = NodeFS.readFileSync(recordPath, "utf8");
      NodeAssert.match(invocation, /--tag v9\.9\.9-beta\.9/);
      NodeAssert.match(invocation, /--force/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("passes --tag through to the platform installer and honors --tag=", () => {
    for (const [args, expected] of [
      [["--tag", "v1.2.3-beta.4"], "--tag v1.2.3-beta.4"],
      [["--tag=v1.2.3-beta.4"], "--tag=v1.2.3-beta.4"],
    ] as const) {
      const { sandbox, recordPath } = makeSandbox({ uname: "Linux", releases: RELEASES });
      try {
        const result = tryBash(scriptPath, [...args], sandboxEnv(sandbox));
        NodeAssert.equal(result.status, 0);
        const invocation = NodeFS.readFileSync(recordPath, "utf8");
        NodeAssert.match(invocation, new RegExp(expected.replace(/\./g, "\\.")));
      } finally {
        NodeFS.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("removes the downloaded platform script on exit", () => {
    const { sandbox, selfPath } = makeSandbox({ uname: "Linux", releases: RELEASES });
    try {
      const result = tryBash(scriptPath, [], sandboxEnv(sandbox));
      NodeAssert.equal(result.status, 0);
      const recordedSelf = NodeFS.readFileSync(selfPath, "utf8").trim();
      NodeAssert.ok(recordedSelf.length > 0);
      NodeAssert.equal(NodeFS.existsSync(recordedSelf), false);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("prints PowerShell instructions and exits 0 on Windows shells", () => {
    const { sandbox } = makeSandbox({ uname: "MINGW64_NT-10.0", releases: RELEASES });
    try {
      const result = tryBash(scriptPath, [], sandboxEnv(sandbox));
      NodeAssert.equal(result.status, 0);
      NodeAssert.match(result.stdout, /install-windows\.ps1/);
      NodeAssert.match(result.stdout, /PowerShell/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("pins a requested --tag into the printed PowerShell command on Windows shells", () => {
    for (const args of [["--tag", "v1.2.3-beta.4"], ["--tag=v1.2.3-beta.4"]]) {
      const { sandbox } = makeSandbox({ uname: "MINGW64_NT-10.0", releases: RELEASES });
      try {
        const result = tryBash(scriptPath, [...args], sandboxEnv(sandbox));
        NodeAssert.equal(result.status, 0);
        // The tag must pin both the script download URL and the -Tag argument
        // instead of being dropped in favor of the newest release.
        NodeAssert.match(
          result.stdout,
          /raw\.githubusercontent\.com\/kartikkabadi\/synara-beta\/v1\.2\.3-beta\.4\/scripts\/install-windows\.ps1/,
        );
        NodeAssert.match(result.stdout, /& \$f -Tag 'v1\.2\.3-beta\.4'/);
        NodeAssert.doesNotMatch(result.stdout, /Invoke-RestMethod/);
      } finally {
        NodeFS.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("appends -Force to the printed PowerShell command when --force is passed on Windows shells", () => {
    for (const args of [["--force"], ["--tag", "v1.2.3-beta.4", "--force"]]) {
      const { sandbox } = makeSandbox({ uname: "MINGW64_NT-10.0", releases: RELEASES });
      try {
        const result = tryBash(scriptPath, [...args], sandboxEnv(sandbox));
        NodeAssert.equal(result.status, 0);
        // The -Force flag must appear inside the try block, before the closing brace,
        // not as part of the final cleanup Remove-Item.
        NodeAssert.match(result.stdout, /try \{ & \$f -Tag .*?-Force \} finally/);
      } finally {
        NodeFS.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("does not append -Force to the printed PowerShell command when --force is absent on Windows shells", () => {
    const { sandbox } = makeSandbox({ uname: "MINGW64_NT-10.0", releases: RELEASES });
    try {
      const result = tryBash(scriptPath, [], sandboxEnv(sandbox));
      NodeAssert.equal(result.status, 0);
      NodeAssert.doesNotMatch(result.stdout, /try \{ & \$f -Tag .*?-Force \} finally/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects --tag without a value before resolving anything", () => {
    for (const args of [["--tag"], ["--tag="], ["--tag", "--force"]]) {
      const { sandbox } = makeSandbox({ uname: "Linux", releases: RELEASES });
      try {
        const result = tryBash(scriptPath, [...args], sandboxEnv(sandbox));
        NodeAssert.equal(result.status, 1);
        NodeAssert.match(result.stderr, /--tag requires a value/);
        // Nothing may be fetched: the missing value must stop the script early.
        NodeAssert.equal(NodeFS.existsSync(NodePath.join(sandbox, "fetched-urls.txt")), false);
      } finally {
        NodeFS.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("refuses non-release refs before building any download URL", () => {
    for (const args of [["--tag", "main"], ["--tag=main"]]) {
      const { sandbox } = makeSandbox({ uname: "Linux", releases: RELEASES });
      try {
        const result = tryBash(scriptPath, [...args], sandboxEnv(sandbox));
        NodeAssert.equal(result.status, 1);
        NodeAssert.match(result.stderr, /invalid tag 'main'\. Expected vX\.Y\.Z-beta\.N\./);
        // Nothing may be fetched: the ref must never select executable code.
        NodeAssert.equal(NodeFS.existsSync(NodePath.join(sandbox, "fetched-urls.txt")), false);
      } finally {
        NodeFS.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("fails with a clear error on unsupported operating systems", () => {
    const { sandbox } = makeSandbox({ uname: "SunOS", releases: RELEASES });
    try {
      const result = tryBash(scriptPath, [], sandboxEnv(sandbox));
      NodeAssert.equal(result.status, 1);
      NodeAssert.match(result.stderr, /unsupported operating system/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("fails with a clear error when no beta release can be resolved", () => {
    const { sandbox } = makeSandbox({ uname: "Linux", releases: '[{"tag_name": "v1.2.3"}]' });
    try {
      const result = tryBash(scriptPath, [], sandboxEnv(sandbox));
      NodeAssert.equal(result.status, 1);
      NodeAssert.match(result.stderr, /could not resolve a release tag/);
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
