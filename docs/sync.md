# Synara Beta & Stable Coexistence Sync Engine

Synara Beta is designed to operate seamlessly alongside Synara Stable on the same machine without port collisions, process interference, or database corruption.

The **Coexistence Sync Engine** allows users to automatically synchronize their preferences, keybindings, custom skills, MCP tools, and project workspaces from Stable (`~/.synara`) into Beta (`~/.synara-beta`).

---

## 1. Safety Architecture & Safeguards

### Safe to Synchronize

- **Settings (`userdata/settings.json`)**: Synchronizes provider options, model choices, UI themes, custom instructions, and typography. Automatically sanitized: the opencode provider's inline `serverPassword` is removed and `serverPasswordConfigured` is reset so Beta mints independent credentials. Other credential fields copy as-is; re-authenticate remaining providers inside Beta.
- **Keybindings (`userdata/keybindings.json`)**: Verbatim atomic copy of custom keybindings.
- **Custom Skills (`skills/`)**: User-defined agent skills copied safely (symlinks preserved as symlinks without traversing outside).
- **MCP Tool Configurations (`mcp/`)**: External model context protocol servers and tools.
- **Project Registry (`projection_projects`)**: Synchronizes registered project workspaces from SQLite when the Stable database is accessible.

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
3. Automatically creates pre-sync timestamped snapshot backups in `userdata/backups/pre-sync-<timestamp>` before modifying any Beta files, allowing instant undo. Snapshots cover settings, keybindings, skills, MCP configs, and `state.sqlite` (plus absence metadata for assets Beta did not have), and project merges additionally keep a `state.sqlite.pre-merge-backup` beside the Beta database.

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

Synchronizes settings, keybindings, skills, and MCP configurations, creating a backup snapshot first.

### Undo Last Sync

```bash
bun run sync:stable --undo
```

Reverts Beta's configuration back to the pre-sync snapshot.

### Continuous Auto-Sync (Watch Mode)

```bash
bun run sync:stable --watch
```

Polls for updates in Stable and keeps Beta continuously in sync.

### Path Overrides

For custom environments:

```bash
bun run sync:stable --stable-home /path/to/stable --beta-home /path/to/beta
```
