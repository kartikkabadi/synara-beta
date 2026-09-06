# Synara Beta & Stable Coexistence Sync Engine

Synara Beta is designed to operate seamlessly alongside Synara Stable on the same machine without port collisions, process interference, or database corruption.

The **Coexistence Sync Engine** allows users to automatically synchronize their preferences, keybindings, custom skills, MCP tools, and project workspaces from Stable (`~/.synara`) into Beta (`~/.synara-beta`).

---

## 1. Safety Architecture & Safeguards

### Safe to Synchronize

- **Settings (`userdata/settings.json`)**: Synchronizes provider options, model choices, UI themes, custom instructions, and typography. Automatically sanitized: the opencode provider's inline `serverPassword` is removed and `serverPasswordConfigured` is reset so Beta mints independent credentials. Other credential fields copy as-is; re-authenticate remaining providers inside Beta.
- **Keybindings (`userdata/keybindings.json`)**: Verbatim atomic copy of custom keybindings. The payload is JSON-validated before Beta is touched; a corrupt Stable file records a failed item instead of breaking Beta.
- **Custom Skills (`skills/`)**: User-defined agent skills copied safely (symlinks preserved as symlinks without traversing outside). Destination symlinks are replaced, never followed, and every created directory is verified by realpath to stay inside Beta. Source owner-execute bits are preserved so skill scripts stay runnable; group/other bits stay private. Absolute symlinks from Stable are recreated verbatim: only sync from a Stable home you trust.
- **MCP Tool Configurations (`mcp/`)**: External model context protocol servers and tools, copied with the same symlink and permission rules as skills.
- **Project Registry (`projection_projects`)**: Synchronizes registered project workspaces from SQLite when the Stable database is accessible. Merges run inside one transaction and are skipped while Stable or Beta is running; `deleted_at` is never written so Beta-side soft deletes survive re-import.

### Never Synchronized (Strict Isolation)

- **Secrets (`userdata/secrets/*.bin`)**: Beta creates its own independent secrets directory. Provider credentials must be authenticated within Beta.
- **Process Identity Files**: `server-runtime.json`, `quit-resume.json`, `environment-id`, `device-boot-ownership.json`.
- **Active Lock Files**: `.lifecycle-lock/`, `state.sqlite-wal`, `state.sqlite-shm`.
- **Runtime Directories**: `worktrees/`, `logs/`, `cache/`, `codex-home-overlay/`.

### Concurrency Trap Prevention

Stable Synara runs with `PRAGMA locking_mode = EXCLUSIVE;` and creates `state.sqlite.lifecycle-lock`. A raw filesystem copy while Stable is running would copy torn pages and unsynchronized WAL state, permanently corrupting the database.

The sync engine:

1. Detects whether Stable's process PID is alive.
2. If Stable is running, it safely synchronizes settings, keybindings, and skills using atomic temporary files (`*.partial` + `fsync` + `rename`), and skips live SQLite rows without blocking.
3. Automatically creates pre-sync timestamped snapshot backups in `userdata/backups/pre-sync-<timestamp>` before modifying any Beta files, allowing instant undo. Snapshots cover settings, keybindings, skills, MCP configs, `state.sqlite`, and the import marker bytes (plus absence metadata for assets Beta did not have). When Beta itself is running, the live `state.sqlite` is left out of the snapshot and project rows are skipped rather than storing a torn copy.

---

## 2. CLI Usage

### Check Sync Status

```bash
bun run sync:stable --status
```

Outputs the presence of Stable files, skill counts, and whether a Stable process is actively running.

### Dry Run (Preview Changes)

```bash
bun run sync:stable --dry-run
```

Shows exactly what will be synchronized without altering any files.

### Execute Synchronization

```bash
bun run sync:stable
```

Synchronizes settings, keybindings, skills, MCP configurations, and projects by default, creating a backup snapshot first. Opt out per asset:

```bash
bun run sync:stable --no-settings --no-keybindings --no-skills --no-mcp --no-projects
```

`--force` runs even when Stable reports no syncable assets. It never bypasses the same-path refusal: Stable and Beta resolving to the same directory always aborts.

### Undo Last Sync

```bash
bun run sync:stable --undo
```

Reverts Beta's configuration back to the pre-sync snapshot.

### Continuous Auto-Sync (Watch Mode)

```bash
bun run sync:stable --watch
```

Polls Stable every 10 seconds and syncs only when its fingerprint (file sizes/mtimes plus skills/MCP trees) changes, so idle ticks never overwrite Beta-side edits or rotate snapshots. Overlapping polls are skipped, watch never forces, and the loop stays alive across transient failures (errors are logged, the next tick retries).

### Path Overrides

For custom environments:

```bash
bun run sync:stable --stable-home /path/to/stable --beta-home /path/to/beta
```
