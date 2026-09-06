import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vitest";

const scriptPath = NodePath.resolve(import.meta.dirname, "./sync-with-stable.ts");
const script = NodeFS.readFileSync(scriptPath, "utf8");

describe("sync-with-stable.ts", () => {
  it("imports sync functions from @synara/shared/stableSync", () => {
    NodeAssert.match(script, /from "@synara\/shared\/stableSync"/);
    NodeAssert.match(script, /checkSyncAvailability/);
    NodeAssert.match(script, /performStableSync/);
    NodeAssert.match(script, /undoStableSync/);
  });

  it("supports --status, --undo, --dry-run, and --watch options", () => {
    NodeAssert.match(script, /--status/);
    NodeAssert.match(script, /--undo/);
    NodeAssert.match(script, /--dry-run/);
    NodeAssert.match(script, /--watch/);
  });

  it("handles path overrides for stable and beta directories", () => {
    NodeAssert.match(script, /--stable-home/);
    NodeAssert.match(script, /--beta-home/);
  });
});
