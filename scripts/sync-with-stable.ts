#!/usr/bin/env bun
// FILE: sync-with-stable.ts
// Purpose: CLI tool to synchronize settings, keybindings, skills, and projects between Synara Stable and Beta.
// Usage: bun run sync:stable [options]

import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  checkSyncAvailability,
  performStableSync,
  resolveSyncPaths,
  undoStableSync,
} from "@synara/shared/stableSync";

/** Poll interval for --watch mode. */
const WATCH_POLL_INTERVAL_MS = 10_000;

export interface SyncCliOptions {
  readonly statusMode: boolean;
  readonly undoMode: boolean;
  readonly dryRun: boolean;
  readonly watchMode: boolean;
  readonly includeProjects: boolean;
  readonly includeSettings: boolean;
  readonly includeSkills: boolean;
  readonly force: boolean;
  readonly stableHome: string | undefined;
  readonly betaHome: string | undefined;
  readonly help: boolean;
  readonly unknownOption: string | undefined;
}

const DEFAULT_CLI_OPTIONS: SyncCliOptions = {
  statusMode: false,
  undoMode: false,
  dryRun: false,
  watchMode: false,
  includeProjects: true,
  includeSettings: true,
  includeSkills: true,
  force: false,
  stableHome: undefined,
  betaHome: undefined,
  help: false,
  unknownOption: undefined,
};

/**
 * Parses sync CLI arguments without side effects, so tests can exercise
 * flag handling directly instead of string-matching this source file.
 */
export function parseSyncArgs(args: readonly string[]): SyncCliOptions {
  const parsed: { -readonly [K in keyof SyncCliOptions]: SyncCliOptions[K] } = {
    ...DEFAULT_CLI_OPTIONS,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--status") parsed.statusMode = true;
    else if (arg === "--undo") parsed.undoMode = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--watch") parsed.watchMode = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--no-projects") parsed.includeProjects = false;
    else if (arg === "--no-settings") parsed.includeSettings = false;
    else if (arg === "--no-skills") parsed.includeSkills = false;
    else if (arg === "--stable-home" && i + 1 < args.length) {
      parsed.stableHome = args[++i];
    } else if (arg === "--beta-home" && i + 1 < args.length) {
      parsed.betaHome = args[++i];
    } else if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else {
      parsed.unknownOption = arg;
      break;
    }
  }
  return parsed;
}

/** Summarizes one directory tree as name:size:mtime entries for change detection. */
function summarizeTree(root: string, entries: string[]): void {
  let dirents: fsSync.Dirent[];
  try {
    dirents = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    entries.push(`${root}:missing`);
    return;
  }
  const sorted = dirents.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of sorted) {
    const full = path.join(root, dirent.name);
    if (dirent.isSymbolicLink()) {
      try {
        entries.push(`${full}:link:${fsSync.readlinkSync(full)}`);
      } catch {
        entries.push(`${full}:link:unreadable`);
      }
    } else if (dirent.isDirectory()) {
      summarizeTree(full, entries);
    } else {
      try {
        const stat = fsSync.statSync(full);
        entries.push(`${full}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        entries.push(`${full}:unreadable`);
      }
    }
  }
}

/** Stats one file as size:mtime for change detection. */
function summarizeFile(filePath: string): string {
  try {
    const stat = fsSync.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Fingerprints the Stable assets sync reads, so --watch can skip polls where
 * Stable has not changed instead of overwriting Beta edits on every tick.
 */
export function getStableFingerprint(stableHome: string): string {
  const entries: string[] = [];
  entries.push(`settings:${summarizeFile(path.join(stableHome, "userdata", "settings.json"))}`);
  entries.push(
    `keybindings:${summarizeFile(path.join(stableHome, "userdata", "keybindings.json"))}`,
  );
  const skillsEntries: string[] = [];
  summarizeTree(path.join(stableHome, "skills"), skillsEntries);
  entries.push(`skills:${skillsEntries.join(",")}`);
  const mcpEntries: string[] = [];
  summarizeTree(path.join(stableHome, "mcp"), mcpEntries);
  entries.push(`mcp:${mcpEntries.join(",")}`);
  entries.push(`db:${summarizeFile(path.join(stableHome, "userdata", "state.sqlite"))}`);
  return entries.join("|");
}

function printUsage(): void {
  console.log(`
Synara Stable <-> Beta Coexistence Sync Utility

Usage:
  bun run sync:stable [options]

Commands:
  --status        Check sync availability between Stable and Beta
  --undo          Revert to the latest pre-sync snapshot
  --dry-run       Preview what would be synchronized without making changes
  --watch         Run continuous background sync when Stable configuration changes

Options:
  --stable-home <dir>   Path to Synara Stable home (default: ~/.synara)
  --beta-home <dir>     Path to Synara Beta home (default: ~/.synara-beta)
  --no-projects         Skip SQLite project synchronization
  --no-settings         Skip settings synchronization
  --no-skills           Skip skills synchronization
  --force               Force synchronization even if already imported
  -h, --help            Show this help message

Examples:
  bun run sync:stable
  bun run sync:stable --status
  bun run sync:stable --dry-run
  bun run sync:stable --undo
`);
}

async function main(): Promise<void> {
  const cli = parseSyncArgs(process.argv.slice(2));
  if (cli.help) {
    printUsage();
    process.exit(0);
  }
  if (cli.unknownOption !== undefined) {
    console.error(`Unknown option: ${cli.unknownOption}`);
    printUsage();
    process.exit(1);
  }
  const { stableHome, betaHome } = cli;

  const paths = resolveSyncPaths({ stableHome, betaHome });

  if (cli.statusMode || cli.dryRun) {
    console.log("Checking Synara synchronization status...\n");
    console.log(`  Stable directory: ${paths.stableHome}`);
    console.log(`  Beta directory:   ${paths.betaHome}\n`);

    const availability = await checkSyncAvailability({ stableHome, betaHome });

    console.log(`  Stable directory found:    ${availability.stableExists ? "✓ Yes" : "✗ No"}`);
    console.log(
      `  Stable settings.json:      ${availability.stableSettingsExists ? "✓ Present" : "✗ Missing"}`,
    );
    console.log(
      `  Stable keybindings.json:   ${availability.stableKeybindingsExists ? "✓ Present" : "✗ Missing"}`,
    );
    console.log(
      `  Stable custom skills:      ${availability.stableSkillsCount > 0 ? `✓ ${availability.stableSkillsCount} skills` : "✗ None"}`,
    );
    console.log(
      `  Stable MCP configurations: ${availability.stableMcpExists ? "✓ Present" : "✗ None"}`,
    );
    console.log(
      `  Stable process state:      ${availability.isStableProcessRunning ? `● Active (PID ${availability.stablePid})` : "○ Stopped"}`,
    );
    console.log(
      `  Previously imported:       ${availability.hasBeenImportedBefore ? "Yes (.imported-from-stable marker)" : "No (First sync)"}\n`,
    );

    if (cli.dryRun) {
      console.log("[Dry Run] Items that would be synced:");
      if (cli.includeSettings && availability.stableSettingsExists)
        console.log("  • userdata/settings.json (sanitized: opencode server password removed)");
      if (availability.stableKeybindingsExists)
        console.log("  • userdata/keybindings.json (verbatim)");
      if (cli.includeSkills && availability.stableSkillsCount > 0)
        console.log(`  • skills/ (${availability.stableSkillsCount} skills)`);
      if (availability.stableMcpExists) console.log("  • mcp/ (custom server configurations)");
      if (cli.includeProjects) {
        const stableDbPath = path.join(paths.stableHome, "userdata", "state.sqlite");
        if (availability.isStableProcessRunning) {
          console.log(
            "  • projects: SQLite database is currently locked by active Stable process; will safely skip project rows.",
          );
        } else if (fsSync.existsSync(stableDbPath)) {
          console.log("  • projects: SQLite state accessible; project records will be imported.");
        } else {
          console.log("  • projects: no readable Stable database; project import will be skipped.");
        }
      }
    }
    return;
  }

  if (cli.undoMode) {
    console.log(`Attempting to undo synchronization for ${paths.betaHome}...`);
    const undoResult = await undoStableSync({ betaHome });
    if (undoResult.success) {
      console.log(`✓ ${undoResult.message}`);
    } else {
      console.error(`✗ ${undoResult.message}`);
      process.exit(1);
    }
    return;
  }

  console.log("Synchronizing from Synara Stable into Synara Beta...");
  console.log(`  Source (Stable): ${paths.stableHome}`);
  console.log(`  Target (Beta):   ${paths.betaHome}\n`);

  const result = await performStableSync({
    stableHome,
    betaHome,
    includeSettings: cli.includeSettings,
    includeSkills: cli.includeSkills,
    includeProjects: cli.includeProjects,
    force: cli.force,
  });

  for (const item of result.items) {
    const symbol = item.status === "synced" ? "✓" : item.status === "skipped" ? "○" : "✗";
    console.log(`  ${symbol} [${item.item}] ${item.detail}`);
  }

  console.log("");
  if (result.success) {
    console.log(`✓ ${result.message}`);
  } else {
    console.error(`✗ ${result.message}`);
  }

  if (cli.watchMode) {
    console.log(
      "\n[Watch Mode] Monitoring Synara Stable for configuration changes (polling every 10s)...",
    );
    console.log("Watch stays alive and retries: an empty initial sync is not fatal.");
    let lastFingerprint = getStableFingerprint(paths.stableHome);
    let syncInFlight = false;
    setInterval(() => {
      void (async () => {
        if (syncInFlight) return;
        syncInFlight = true;
        try {
          const currentFingerprint = getStableFingerprint(paths.stableHome);
          if (currentFingerprint === lastFingerprint) return;
          lastFingerprint = currentFingerprint;
          // Watch never forces: the same-path refusal stays unconditional.
          const watchResult = await performStableSync({
            stableHome,
            betaHome,
            includeSettings: cli.includeSettings,
            includeSkills: cli.includeSkills,
            includeProjects: cli.includeProjects,
          });
          console.log(`[Watch] ${watchResult.message}`);
        } catch {
          // Suppress transient poll errors; the next tick retries.
        } finally {
          syncInFlight = false;
        }
      })();
    }, WATCH_POLL_INTERVAL_MS);
    return;
  }

  if (!result.success) {
    process.exit(1);
  }
}

// CLI entrypoint when run directly; importing the module (e.g. tests) runs nothing.
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("Sync error:", err);
    process.exit(1);
  });
}
