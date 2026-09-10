import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveStagedClientFaviconTarget } from "./desktop-artifact-staging.ts";

describe("resolveStagedClientFaviconTarget", () => {
  it("resolves staged client favicons under apps/server/dist/client", () => {
    const stageAppDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-desktop-stage-"));
    const clientDir = path.join(stageAppDir, "apps/server/dist/client");
    const target = path.join(clientDir, "favicon.ico");

    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(target, "beta");

    try {
      expect(resolveStagedClientFaviconTarget(stageAppDir, "dist/client/favicon.ico")).toBe(target);
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      fs.rmSync(stageAppDir, { recursive: true, force: true });
    }
  });
});
