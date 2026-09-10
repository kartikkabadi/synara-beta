import * as path from "node:path";

export function resolveStagedClientFaviconTarget(
  stageAppDir: string,
  targetRelativePath: string,
): string {
  return path.join(stageAppDir, "apps/server", targetRelativePath);
}
