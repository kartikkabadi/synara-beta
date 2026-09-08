import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveStagedClientFaviconTarget,
  STAGED_SERVER_DIST_PREFIX,
} from "./desktop-artifact-staging.ts";

describe("resolveStagedClientFaviconTarget", () => {
  it("places staged client favicons under apps/server/dist/client", () => {
    const stageAppDir = "/tmp/synara-desktop-stage/app";
    const targetRelativePath = "dist/client/favicon.ico";

    const target = resolveStagedClientFaviconTarget(stageAppDir, targetRelativePath);

    expect(target).toBe(path.join(stageAppDir, "apps/server/dist/client/favicon.ico"));
  });

  it("keeps the staging prefix isolated so overrides stay relative to the server dist", () => {
    expect(STAGED_SERVER_DIST_PREFIX).toBe("apps/server");
  });
});
