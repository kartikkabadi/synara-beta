import * as path from "node:path";

/**
 * The bundled server dist is staged under `apps/server` inside a packaged
 * desktop app. Favicon overrides that are expressed relative to the server
 * dist root (`dist/client/...`) must therefore be resolved through this
 * prefix so they land in the actual bundled client directory.
 */
export const STAGED_SERVER_DIST_PREFIX = "apps/server";

/**
 * Resolve the absolute target path for a client favicon override inside a
 * staged desktop app.
 *
 * The `targetRelativePath` is relative to the server dist root, e.g.
 * `dist/client/favicon.ico`. The packaged layout places the server dist at
 * `<stageAppDir>/apps/server/dist`, so the resulting path is
 * `<stageAppDir>/apps/server/dist/client/favicon.ico`.
 */
export function resolveStagedClientFaviconTarget(
  stageAppDir: string,
  targetRelativePath: string,
): string {
  return path.join(stageAppDir, STAGED_SERVER_DIST_PREFIX, targetRelativePath);
}
