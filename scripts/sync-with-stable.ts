#!/usr/bin/env bun
// FILE: sync-with-stable.ts
// Purpose: CLI tool to synchronize settings, keybindings, skills, and projects between Synara Stable and Beta.
// Usage: bun run sync:stable [options]

import {
  checkSyncAvailability,
  performStableSync,
  resolveSyncPaths,
  undoStableSync,
} from "@synara/shared/stableSync";

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
  const args = process.argv.slice(2);
  let statusMode = false;
  let undoMode = false;
  let dryRun = false;
  let watchMode = false;
  let includeProjects = true;
  let includeSettings = true;
  let includeSkills = true;
  let force = false;
  let stableHome: string | undefined;
  let betaHome: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--status") statusMode = true;
    else if (arg === "--undo") undoMode = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--watch") watchMode = true;
    else if (arg === "--force") force = true;
    else if (arg === "--no-projects") includeProjects = false;
    else if (arg === "--no-settings") includeSettings = false;
    else if (arg === "--no-skills") includeSkills = false;
    else if (arg === "--stable-home" && i + 1 < args.length) {
      stableHome = args[++i];
    } else if (arg === "--beta-home" && i + 1 < args.length) {
      betaHome = args[++i];
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  const paths = resolveSyncPaths({ stableHome, betaHome });

  if (statusMode || dryRun) {
    console.log("Checking Synara synchronization status...\n");
    console.log(`  Stable directory: ${paths.stableHome}`);
    console.log(`  Beta directory:   ${paths.betaHome}\n`);

    const availability = await checkSyncAvailability({ stableHome, betaHome });

    console.log(`  Stable directory found:    ${availability.stableExists ? "✓ Yes" : "✗ No"}`);
    console.log(`  Stable settings.json:      ${availability.stableSettingsExists ? "✓ Present" : "✗ Missing"}`);
    console.log(`  Stable keybindings.json:   ${availability.stableKeybindingsExists ? "✓ Present" : "✗ Missing"}`);
    console.log(`  Stable custom skills:      ${availability.stableSkillsCount > 0 ? `✓ ${availability.stableSkillsCount} skills` : "✗ None"}`);
    console.log(`  Stable MCP configurations: ${availability.stableMcpExists ? "✓ Present" : "✗ None"}`);
    console.log(`  Stable process state:      ${availability.isStableProcessRunning ? `● Active (PID ${availability.stablePid})` : "○ Stopped"}`);
    console.log(`  Previously imported:       ${availability.hasBeenImportedBefore ? "Yes (.imported-from-stable marker)" : "No (First sync)"}\n`);

    if (dryRun) {
      console.log("[Dry Run] Items that would be synced:");
      if (includeSettings && availability.stableSettingsExists) console.log("  • userdata/settings.json (sanitized: passwords stripped)");
      if (availability.stableKeybindingsExists) console.log("  • userdata/keybindings.json (verbatim)");
      if (includeSkills && availability.stableSkillsCount > 0) console.log(`  • skills/ (${availability.stableSkillsCount} skills)`);
      if (availability.stableMcpExists) console.log("  • mcp/ (custom server configurations)");
      if (includeProjects) {
        if (availability.isStableProcessRunning) {
          console.log("  • projects: SQLite database is currently locked by active Stable process; will safely skip project rows.");
        } else {
          console.log("  • projects: SQLite state accessible; project records will be imported.");
        }
      }
    }
    return;
  }

  if (undoMode) {
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
    includeSettings,
    includeSkills,
    includeProjects,
    force,
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
    process.exit(1);
  }

  if (watchMode) {
    console.log("\n[Watch Mode] Monitoring Synara Stable for configuration changes (polling every 10s)...");
    setInterval(async () => {
      try {
        await performStableSync({ stableHome, betaHome, includeSettings, includeSkills, includeProjects, force: true });
      } catch {
        // Suppress transient poll errors
      }
    }, 10_000);
  }
}

main().catch((err) => {
  console.error("Sync error:", err);
  process.exit(1);
});
