import * as NodeAssert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";

import { importStableDatabase } from "./stableDatabaseImport";

describe("stableDatabaseImport", () => {
  it("imports the Stable database and attachments over Beta without leaving a stale WAL", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-db-import-"));
    const stableHome = path.join(rootTmp, ".synara");
    const betaHome = path.join(rootTmp, ".synara-beta");
    const stableUserdata = path.join(stableHome, "userdata");
    const betaUserdata = path.join(betaHome, "userdata");
    try {
      await fs.mkdir(stableUserdata, { recursive: true });
      await fs.mkdir(path.join(stableUserdata, "attachments"), { recursive: true });
      await fs.mkdir(betaUserdata, { recursive: true });
      await fs.writeFile(path.join(stableUserdata, "state.sqlite"), "stable-db");
      await fs.writeFile(path.join(stableUserdata, "state.sqlite-wal"), "stable-wal");
      await fs.writeFile(path.join(stableUserdata, "attachments", "image.png"), "png-bytes");
      await fs.writeFile(path.join(betaUserdata, "state.sqlite"), "beta-db");
      await fs.writeFile(path.join(betaUserdata, "state.sqlite-wal"), "beta-wal");
      await fs.writeFile(path.join(betaUserdata, "state.sqlite-shm"), "beta-shm");

      const result = await importStableDatabase({ stableHome, betaHome });

      NodeAssert.equal(result.success, true);
      NodeAssert.equal(result.copiedDatabase, true);
      NodeAssert.equal(result.copiedWriteAheadLog, true);
      NodeAssert.equal(result.copiedAttachments, true);
      NodeAssert.equal(
        await fs.readFile(path.join(betaUserdata, "state.sqlite"), "utf8"),
        "stable-db",
      );
      NodeAssert.equal(
        await fs.readFile(path.join(betaUserdata, "state.sqlite-wal"), "utf8"),
        "stable-wal",
      );
      await NodeAssert.rejects(fs.stat(path.join(betaUserdata, "state.sqlite-shm")));
      NodeAssert.equal(
        await fs.readFile(path.join(betaUserdata, "attachments", "image.png"), "utf8"),
        "png-bytes",
      );
      const leftovers = (await fs.readdir(betaUserdata)).filter((name) =>
        name.includes(".partial"),
      );
      NodeAssert.deepEqual(leftovers, []);
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });

  it("refuses the database import when Stable and Beta point to the same directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-db-import-same-"));
    try {
      const result = await importStableDatabase({ stableHome: tmp, betaHome: tmp });
      NodeAssert.equal(result.success, false);
      NodeAssert.match(result.message, /same location/i);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports a missing Stable database instead of failing", async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "synara-db-import-missing-"));
    const stableHome = path.join(rootTmp, ".synara");
    const betaHome = path.join(rootTmp, ".synara-beta");
    try {
      await fs.mkdir(stableHome, { recursive: true });
      const result = await importStableDatabase({ stableHome, betaHome });
      NodeAssert.equal(result.success, false);
      NodeAssert.match(result.message, /No Stable database found/);
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true });
    }
  });
});
