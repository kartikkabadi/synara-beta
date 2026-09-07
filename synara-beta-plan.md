# Synara Beta Plan

**Date:** 2026-09-08  
**Status:** Active Implementation — Core Phases 1–3 merged, Phase 5 Auto-Sync engine merged, Cross-Platform Installer open in PR #2, Release cut & OpenAnalytics pending.  
**Beta Repository:** https://github.com/kartikkabadi/synara-beta (tracks and mirrors upstream [`Emanuele-web04/synara`](https://github.com/Emanuele-web04/synara) with connected commit history).  
**Canonical Document:** Root `synara-beta-plan.md` is the canonical plan; `plans/synara-beta-plan.md` is maintained as an exact synchronized copy.

---

## Choices Made

- **Full Mirror Repository:** The beta repository holds full source code. It is an active mirror, not a release-only asset repo.
- **Dedicated Independent App:** Beta is its own application with its own identity. Different name (`Synara Beta`), bundle ID (`com.emanueledipietro.synara.beta`), executable (`synara-beta`), and data directory (`~/.synara-beta`). Runs side-by-side with Stable without port or lock conflicts.
- **Connected Git History:** Upstream commit history was connected directly to `main` via PR #22 (`chore(sync): connect upstream history to beta main`). This eliminates shallow/disconnected history problems and enables clean bidirectional cherry-picks and upstream pull requests.
- **PR-Based Sync Doctrine:** Upstream updates are pulled exclusively through reviewed PR branches (`sync/upstream-*`). The GitHub UI "Sync Fork" button and direct merges to `main` are strictly prohibited.
- **Autonomous Shipping:** Beta ships autonomously from `kartikkabadi/synara-beta`. Releases do not block on upstream approvals or upstream release cadences.
- **Progressive Code Signing Lifecycle:** Beta ships unsigned initially (`ALLOW_UNSIGNED_BETA_PUBLICATION=true`). Signing credentials (Apple Developer Org team invite and Azure Trusted Signing RBAC) can be populated in GitHub Secrets later with zero code refactoring and zero user data loss.
- **Cross-Platform One-Line Installers:** Added in PR #2 (`feat: cross-platform one-line installer for macOS, Linux, and Windows`) providing `curl -fsSL ... | sh` and PowerShell installation, in-place atomic updates, Gatekeeper quarantine stripping, and SSH-signed checksum verification (`SHA256SUMS.sig`).
- **Coexistence Auto-Sync Engine:** Merged in PR #3 (`feat: coexistence auto-sync engine between Synara Stable and Beta`) via `@synara/shared/stableSync` and `bun run sync:stable`. Safely synchronizes configurations and registered project records from `~/.synara` to `~/.synara-beta` with SQLite lifecycle lock detection and instant rollback snapshots.
- **Self-Hosted Privacy Telemetry (Planned):** Privacy-first, cookie-free crash and usage analytics will be powered by self-hosted OpenAnalytics (`getopen.so`) on the user's VPS using an explicit opt-in toggle and a 23-field scrubbed payload (VPS infrastructure and client dispatch hooks are currently planned under Phase 5C).

---

## Architecture & Current Landscape

### Stable vs. Canary vs. Beta

| Dimension                 | Stable (`Synara`)                                     | Canary (`bun run canary:*`)                       | Beta (`Synara Beta`)                                             |
| :------------------------ | :---------------------------------------------------- | :------------------------------------------------ | :--------------------------------------------------------------- |
| **Distribution**          | Signed desktop binaries (`.dmg`, `.AppImage`, `.exe`) | Local source checkout; user compiles locally      | Standalone signed/unsigned binary releases + one-line installers |
| **Identity & Data**       | `com.emanueledipietro.synara` (`~/.synara`)           | Local checkout (`~/.synara-canary`)               | `com.emanueledipietro.synara.beta` (`~/.synara-beta`)            |
| **Release Cadence**       | Manual releases by upstream maintainer                | Commit-based manual rebuilds                      | Automated GitHub releases on `vX.Y.Z-beta.N` tags                |
| **Update Mechanism**      | Native `electron-updater`                             | Terminal command (`bun run canary:update`)        | Dual: in-place one-line installer update or in-app updater       |
| **Installation Friction** | Zero (standard app installer)                         | High (requires Git, Bun, Node, native toolchains) | Low (one-line curl/PowerShell command or downloaded binary)      |
| **Coexistence**           | Primary application                                   | Runs locally, blank slate by default              | Runs side-by-side with Stable; auto-syncs config safely          |

---

## Coexistence & Runtime Isolation Audit

Stable and Beta can run simultaneously on the same machine without collisions:

- **Single Instance Lock:** Scoped by `app.setPath("userData", ...)` in `apps/desktop/src/main.ts` before calling `requestSingleInstanceLock()`. Beta uses `userData: "synara-beta"`, making OS-level instance locks on macOS, Linux, and Windows completely independent.
- **Dynamic Backend Ports:** Packaged desktop runs do not hardcode port 3773. `apps/desktop/src/main.ts` binds an ephemeral free port via `NetService` at startup, avoiding port collisions.
- **Browser Automation Named Pipes:** Browser IPC pipe paths in `apps/desktop/src/browserUsePipeServer.ts` incorporate `${pid}-${Crypto.randomUUID()}`, preventing socket collisions between concurrent Stable and Beta sessions.
- **Secrets & Credentials:** Provider tokens live in file-based storage (`~/.synara/userdata/secrets/*.bin` vs `~/.synara-beta/userdata/secrets/*.bin`) with `0700` directory modes, completely isolated.
- **OS Permissions (TCC):** macOS tracks permissions (microphone, notifications, screen recording) by bundle ID (`com.emanueledipietro.synara` vs `com.emanueledipietro.synara.beta`).
- **Git Worktrees:** Thread workspaces live in `~/.synara/worktrees/` vs `~/.synara-beta/worktrees/`. Unique thread branch names (`synara/<uuid>`) prevent Git multiple-checkout errors on shared repositories.
- **Windows NSIS Installer:** Dedicated static GUID (`a8e63b48-d4f3-4db5-9e12-368107afe65d`) ensures `Add/Remove Programs` and registry entries do not overwrite Stable.
- **SQLite Concurrency & Locking:** Stable Synara locks `state.sqlite` with `PRAGMA locking_mode = EXCLUSIVE;` and `DatabaseLifecycleLock`. Beta maintains its own database, and the Coexistence Sync Engine checks the active lifecycle lock before reading from Stable to avoid torn WAL reads.

---

## Repository Mirror & Sync Plan

### Upstream and Downstream Roles

- **Upstream (Production Source):** `Emanuele-web04/synara`, branch `main`.
- **Downstream (Beta Mirror):** `kartikkabadi/synara-beta`, branch `main`.
- **Connected History:** As of PR #22, downstream `main` shares commit ancestry with upstream `main`.

### Sync Rules & Doctrine

1. **All syncs go through PRs:** Upstream updates are fetched into a branch named `sync/upstream-<date>` (or `sync/upstream-vX.Y.Z`). A PR is opened against beta `main`, verified via CI, and merged.
2. **Never push directly to `main`:** Direct commits or pushes to `main` are strictly disabled.
3. **Never use GitHub's "Sync Fork" button:** GitHub's UI sync creates unpredictable merge commits that can clobber beta overlay files.
4. **Overlay Files Win:** When upstream changes conflict with beta-specific overlay files, the beta configuration is preserved:
   - `packages/shared/src/desktopIdentity.ts`
   - `scripts/lib/desktop-platform-build-config.ts`
   - `scripts/build-desktop-artifact.ts`
   - `apps/desktop/src/main.ts`
   - `.github/workflows/release-beta.yml`
   - `scripts/release-beta.ts`
   - `scripts/install*`
   - `packages/shared/src/sync/stableSync.ts`
   - `scripts/sync-with-stable.ts`
   - `AGENTS.md` and `CLAUDE.md`
   - `synara-beta-plan.md` and `plans/synara-beta-plan.md`
   - `.agents/`

### Pulling Upstream Changes (Step-by-Step)

Matching the sync discipline in `AGENTS.md`:

```console
# 1. Fetch upstream work including tags and prune deleted branches
git fetch upstream --prune --tags

# 2. Inspect new upstream commits
git log --oneline main..upstream/main

# 3. Create a dedicated sync branch from latest beta main
git checkout -b sync/upstream-$(date +%Y-%m-%d) origin/main

# 4. Merge upstream main into the sync branch (conflicts stop for human review)
git merge upstream/main

# 5. Confirm that ONLY overlay files differ from upstream
git diff upstream/main HEAD

# 6. Run local validation
bun run test

# 7. Push sync branch and open a reviewed Pull Request
git push -u origin sync/upstream-$(date +%Y-%m-%d)
gh pr create --title "sync: upstream main @ $(git rev-parse --short upstream/main)"
```

### Review-Fix Loop & Machine Review Protocol

All pull requests are reviewed by automated reviewers (`devin-ai-integration[bot]`, `cubic-dev-ai[bot]`, and `coderabbitai[bot]` where enabled):

- **Convergence Standard:** A PR is only ready to merge when:
  1. All CI checks pass (`Static Checks (fast)`, `oxfmt --check`, test suites).
  2. All machine review comments have been addressed at their root cause.
  3. Explanations and evidence have been posted to review threads, and threads are formally resolved.
- **Review Triggering:**
  - `cubic`: Triggers automatically on push; re-trigger with comment `@cubic review` if needed.
  - `Devin`: Initialized via `https://app.devin.ai/review` using the PR URL.
  - `CodeRabbit`: Reviews automatically on qualifying repositories.
- **Root-Cause Resolution:** Fixes must address architectural root causes rather than applying surface patches or suppressing linter warnings without explanation.

---

## One-Line Cross-Platform Installer Architecture (PR #2)

Implemented in [PR #2](https://github.com/kartikkabadi/synara-beta/pull/2) (`feat: cross-platform one-line installer for macOS, Linux, and Windows`), the installer provides a fast, robust, single-command installation and update path for all desktop platforms.

### Architecture & Scripts

- **Universal Entrypoint (`scripts/install.sh`):** Detects operating system (`uname -s`) and architecture (`uname -m`), delegates to the platform-specific shell script, or instructs Windows users to invoke the PowerShell one-liner.
- **macOS Installer (`scripts/install-macos.sh`):**
  - Targets Apple Silicon (`arm64`) and Intel (`x64`).
  - Downloads the corresponding `.dmg` asset from GitHub Releases.
  - Mounts DMG, stages `/Applications/Synara Beta.app` atomically with rollback protection (if an upgrade fails mid-copy, the previous working version is restored).
  - Clears Gatekeeper quarantine (`xattr -cr`) to eliminate unsigned application launch dialog hurdles.
  - Asserts bundle identifier `com.emanueledipietro.synara.beta`.
- **Linux Installer (`scripts/install-linux.sh`):**
  - Targets `x86_64` / `amd64`.
  - Downloads `.AppImage`, moves it atomically to `~/.local/bin/synara-beta`.
  - Registers FreeDesktop `.desktop` launcher and application icons.
  - Records installed release tag in `$XDG_STATE_HOME/synara-beta/installed-version`.
- **Windows Installer (`scripts/install-windows.ps1`):**
  - Targets 64-bit Windows (handles 32-bit PowerShell running on 64-bit OS via `PROCESSOR_ARCHITEW6432`).
  - Downloads the NSIS `.exe` installer.
  - Verifies file integrity and launches the installer.

### Quick Command Reference

> [!NOTE]
> The one-line installer scripts are introduced in open [PR #2](https://github.com/kartikkabadi/synara-beta/pull/2). The `main` branch URLs below become active once PR #2 is merged into `main`. For pre-merge verification on branch `feat/one-line-installer`, substitute `main` with `feat/one-line-installer`.

- **macOS (Apple Silicon & Intel):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
  ```
- **Linux (x86_64):**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/kartikkabadi/synara-beta/main/scripts/install.sh | bash
  ```
- **Windows 10 / 11 (x64 PowerShell):**
  ```powershell
  $t = ((Invoke-RestMethod "https://api.github.com/repos/kartikkabadi/synara-beta/releases?per_page=100" -UseBasicParsing -ErrorAction Stop) | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+-beta\.\d+$' } | Select-Object -First 1).tag_name; if ($t) { $f = Join-Path $env:TEMP $("synara-beta-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/kartikkabadi/synara-beta/$t/scripts/install-windows.ps1" -UseBasicParsing -OutFile $f -ErrorAction Stop; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Unblock-File -Path $f; try { & $f -Tag $t } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } } else { throw "Could not resolve the latest Synara Beta release." }
  ```

### Cryptographic Verification (Proposed in PR #2)

- **Introduced in Open PR #2:** Proposes automated generation of `SHA256SUMS` across all compiled distribution artifacts in `.github/workflows/release-beta.yml`.
- **Signing Pipeline (Planned):** In PR #2, the release workflow signs `SHA256SUMS` using `ssh-keygen -Y sign` with a private SSH key stored in GitHub Repository Secrets (`SYNARA_RELEASE_SIGNING_KEY`).
- **Client-Side Verification:** Installers in PR #2 verify authenticity via `ssh-keygen -Y verify` against the public key committed in `scripts/release-signing.pub` on that branch.
- **Current Baseline on main:** The merged release workflow (`.github/workflows/release-beta.yml`) on `main` currently publishes unsigned assets without checksum signatures until PR #2 is merged and the repository secret is configured.

### In-Place Updates & Downgrade Protection

- Re-running the installation command acts as an in-place updater.
- The installer resolves the latest `vX.Y.Z-beta.N` tag on GitHub Releases (using `releases?per_page=100` because `/releases/latest` excludes prereleases).
- If the current installed version matches the latest release, it outputs "Already up to date" (bypassable via `--force`).
- Attempts to install an older tag are refused without `--force`.
- User data in `~/.synara-beta` is never modified or erased during installs or upgrades.

---

## Coexistence Auto-Sync Engine (PR #3)

Implemented and merged in [PR #3](https://github.com/kartikkabadi/synara-beta/pull/3), the sync engine enables users to seamlessly synchronize their configurations, models, prompts, and skills from Synara Stable (`~/.synara`) to Synara Beta (`~/.synara-beta`).

### Architecture & Boundaries

- **Core Module:** `packages/shared/src/sync/stableSync.ts` (exported as `@synara/shared/stableSync`).
- **CLI Runner:** `scripts/sync-with-stable.ts` (runnable via `bun run sync:stable`).
- **Non-Destructive Guarantee:** Stable (`~/.synara`) is opened strictly read-only and is **never modified**.

### Sanitization & Copy Allow-List

- **Safe Configuration (`userdata/settings.json`):**
  - Sanitizes inline server passwords.
  - Resets `providers.opencode.serverPasswordConfigured` to `false`.
  - Preserves provider configurations, model selections, custom system prompts, and disabled skills list.
- **Keybindings (`userdata/keybindings.json`):** Copied as-is.
- **Skills (`skills/` and `userdata/skills/`):** Symlinks and custom skills copied safely (owner-execute preserved, realpath boundaries verified).
- **MCP Servers (`mcp/`):** Agent MCP configurations transferred safely.
- **Project Records (`projection_projects` in `state.sqlite`):**
  - When Stable is not active, the engine safely reads registered project rows from Stable's database and upserts them into Beta's `state.sqlite` (supporting project definitions without copying transcripts).
  - When Stable or Beta is running (detected via lifecycle locks), project sync is automatically skipped to protect against torn WAL reads.
- **Strict Exclusions (Never Copied):**
  - Thread histories, chat transcripts, and turn events (`state.sqlite` thread/session rows).
  - `userdata/secrets/*.bin`: Beta creates its own credentials.
  - Process metadata (`server-runtime.json`, `quit-resume.json`, `environment-id`).

### Concurrency Protection (SQLite Lifecycle Lock)

Stable Synara runs with SQLite exclusive locking mode (`PRAGMA locking_mode = EXCLUSIVE;`). Reading raw SQLite files while Stable is active can result in torn WAL pages. The sync engine checks `~/.synara/state.sqlite.lifecycle-lock` and verifies if the Stable process PID is currently alive:

- Skips SQLite database access while Stable is running.
- Restricts synchronization to decoupled configuration files (`settings.json`, `keybindings.json`, `skills/`).

### CLI Command Reference

- **Inspect sync availability and process lock status:**
  ```bash
  bun run sync:stable --status
  ```
- **Preview changes without copying:**
  ```bash
  bun run sync:stable --dry-run
  ```
- **Execute standard synchronization:**
  ```bash
  bun run sync:stable
  ```
- **Revert to the pre-sync snapshot:**
  ```bash
  bun run sync:stable --undo
  ```
- **Continuous auto-sync daemon (10s poll):**
  ```bash
  bun run sync:stable --watch
  ```
- **Selective synchronization exclusions:**
  ```bash
  bun run sync:stable --no-projects --no-skills --no-mcp
  ```

---

## Beta Release Automation

### Tagging Convention

- Tags follow the format `vX.Y.Z-beta.N` (e.g. `v0.8.3-beta.1`).
- The base `X.Y.Z` aligns with or tops the latest upstream stable release (e.g. `0.8.3`).
- `N` starts at `1` and increments per beta build.
- Stable releases always sort semantically above their corresponding beta tags.

### Tag & Release Tool (`scripts/release-beta.ts`)

Run via `bun run release:beta -- <version> [betaNumber] [options]`.

- Asserts that local and remote tags do not already exist.
- Unless `--skip-bump` is passed, bumps package versions across workspace manifests (`package.json`, `apps/desktop/package.json`, `apps/server/package.json`, `apps/web/package.json`, `packages/contracts/package.json`) and refreshes `bun.lock`.
- Creates a version-bump git commit: `chore(release): prepare <tag>`.
- Creates an annotated tag locally: `vX.Y.Z-beta.N`.
- Prompts the operator to push the tag (`git push beta <tag>`), leaving tag publication under deliberate human control.

### Release Workflow (`.github/workflows/release-beta.yml`)

- **Trigger:** Fired on push of `v*-beta.*` tags to `kartikkabadi/synara-beta`.
- **Matrix Targets:**
  - macOS Apple Silicon (`macos-14`, DMG)
  - macOS Intel (`macos-15-intel`, DMG)
  - Linux x86_64 (`ubuntu-24.04`, AppImage)
  - Windows x64 (`windows-2022`, NSIS `.exe`)
  - Linux ARM64 (under review in PR #29)
- **Unsigned Publication Flag:** Includes `ALLOW_UNSIGNED_BETA_PUBLICATION=true` to allow successful publishing before official Apple and Azure signing certificates are introduced.
- **Feed Isolation:** Feed files (`synara-mac.yml`, `synara.yml`, `synara-linux.yml`) target `kartikkabadi/synara-beta`, keeping Stable update channels completely decoupled.

### Release Execution Procedure (Phase 4 Cut)

1. **Prerequisites:**
   - Configure git remote `beta` (required by `scripts/release-beta.ts` preflight):
     ```bash
     git remote add beta https://github.com/kartikkabadi/synara-beta.git
     ```
   - For signed checksums: Generate SSH ed25519 signing key (`ssh-keygen -t ed25519 -C "synara-beta-release-signing"`), set repository secret `SYNARA_RELEASE_SIGNING_KEY`, and commit public key to `scripts/release-signing.pub` (included in PR #2).
2. **Execute release preflight:**
   ```bash
   bun run release:beta -- 0.8.3 1 --dry-run
   bun run release:beta -- 0.8.3 1
   ```
3. **Publish to GitHub Releases:**
   ```bash
   git push beta v0.8.3-beta.1
   ```

---

## Code Signing & Platform Trust Architecture

### Initial Phase: Unsigned Builds

- macOS: Users clear Gatekeeper quarantine via the one-line installer or `xattr -cr "/Applications/Synara Beta.app"`.
- Windows: Users bypass SmartScreen via "More info" -> "Run anyway" (handled smoothly via the PowerShell installer).
- Linux: AppImage runs without code signing restrictions.

### Progressive Delegation (Future Phase)

- **Apple Developer Program:** Maintainer invites Kartik as an Organization Team Member in App Store Connect. Kartik generates Developer ID Application credentials under the Synara team ID. No private keys are exchanged.
- **Azure Trusted Signing (Windows):** Maintainer assigns Azure RBAC "Trusted Signing Certificate Profile Signer" role to Kartik's Microsoft account. Builds sign directly through Azure CLI in CI.

### Zero Refactoring & Zero Data Loss Guarantee

- **Zero Code Changes:** Switching to signed releases requires only setting `signed: true` and adding GitHub Secrets; app logic is unchanged.
- **Zero Data Loss:** Beta user data resides in `~/.synara-beta`, and secrets are stored in `userdata/secrets/*.bin`. Because the bundle identifier remains `com.emanueledipietro.synara.beta`, upgrading from an unsigned to a signed build preserves 100% of user data and credentials.
- **Auto-Updater Transition Caveat:** Squirrel.Mac and Windows signature verifiers reject unsigned-to-signed in-place background updates. The first transition from unsigned to signed requires a single run of the one-line installer.

---

## Telemetry & Crash Reporting Plan (OpenAnalytics)

### Architecture

- **Engine:** Self-hosted OpenAnalytics instance (`https://getopen.so/`) hosted on the user's VPS.
- **Privacy Core:** Open-source, cookie-free, GDPR-compliant, no third-party tracking scripts.
- **User Control:** Disabled by default. An explicit toggle in Beta Settings allows opt-in: _"Share anonymous crash and performance telemetry"_.
- **Target Endpoint:** `https://<vps-domain-or-ip>/api/event`
- **Integration Points:**
  - `apps/desktop/src/main.ts`: `presentBackendStartupGiveUp` (backend supervision failure) and `presentRendererCrashRecovery` (renderer process exhaustion).

### 23-Field Scrubbed Schema

- **Metadata:** `reportVersion: 1`, `channel: "synara"`, `flavor: "beta"`, `bundleId: "com.emanueledipietro.synara.beta"`, `app.version`, `os` (`darwin` | `linux` | `win32`), `arch` (`x64` | `arm64`).
- **Failure Context:** `failure.kind` (`backend-start-failure` | `renderer-crash` | `provider-spawn-failure`), `attempt`, `consecutiveFailures`, `uptimeMs`.
- **Error Signature:** Error code mapped strictly from a predefined known-error enum table.
- **Sanitized Diagnostics:** Max 8 lines of summarized backend log (2,000 char cap); all user paths replaced with `<HOME>` placeholders; auth headers, tokens, and prompt excerpts stripped.

### Strict Data Privacy Boundaries (Never Sent)

- **Prompt & Response Payloads:** Transcripts, user prompts, assistant completions, tool inputs/outputs, and code diffs are never captured or sent.
- **Secrets & Credentials:** API keys, tokens, session IDs, cookies, keychain secrets, and passwords are unconditionally stripped.
- **Filesystem Content:** File paths, usernames, hostnames, repo names, and local workspace trees are replaced with anonymous placeholders (`<HOME>`, `<WORKSPACE>`).

---

## Active Pull Request Inventory

### Open Pull Requests

| PR #    | Branch                                    | Title                                                                        | Status               |
| :------ | :---------------------------------------- | :--------------------------------------------------------------------------- | :------------------- |
| **#2**  | `feat/one-line-installer`                 | Cross-platform one-line installer for macOS, Linux, and Windows              | **Open (In Review)** |
| **#23** | `feat/anti-slop-ratchet`                  | Enforce anti-slop rules on every PR via ratchet                              | **Open**             |
| **#25** | `sync/upstream-2026-09-06`                | Sync upstream main @ 8599826d7 (`v0.8.3`)                                    | **Open**             |
| **#26** | `docs/agents-review-loop`                 | External review bots and the review-fix loop                                 | **Open**             |
| **#27** | `agent/automations-count-badge`           | Count automations, not unresolved runs, in sidebar badge                     | **Open**             |
| **#28** | `agent/review-comment-skill`              | Add review-comment skill                                                     | **Open**             |
| **#29** | `devin/1788779215-linux-arm64`            | Add Linux arm64 beta desktop releases                                        | **Open**             |
| **#30** | `feat/auto-reclaim-worktrees-after-merge` | Auto-reclaim managed worktrees after PR merge                                | **Open**             |
| **#31** | `agent/provider-config-overlay`           | Mirror user config directory overlay for isolated provider sessions          | **Open**             |
| **#32** | `docs/overhaul-beta-plan`                 | Overhaul Synara Beta plan with connected history, installer, and sync engine | **Open (Active PR)** |

### Foundational Merged Pull Requests

| PR #    | Branch                          | Title                                                           | Status     |
| :------ | :------------------------------ | :-------------------------------------------------------------- | :--------- |
| **#1**  | `docs/modernize-readme`         | Modernize README with rich layout, subheadings, and UI previews | **Merged** |
| **#3**  | `feat/stable-sync-engine`       | Coexistence auto-sync engine between Synara Stable and Beta     | **Merged** |
| **#11** | `docs/overhaul-agents-md`       | Rewrite agent guidance for beta and add agent skills            | **Merged** |
| **#12** | `docs/upstream-history-reset`   | Explain the upstream history reset and how to read upstream     | **Merged** |
| **#13** | `docs/readme-light-images`      | Always show light README screenshots                            | **Merged** |
| **#22** | `sync/connect-upstream-history` | Connect upstream history to beta main                           | **Merged** |

---

## Implementation Roadmap & Milestone Status

### Current Progress Matrix (2026-09-08)

| Phase        | Description                       | Key Deliverables                                                                                                                               | Status                          |
| :----------- | :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------ |
| **Phase 1**  | Mirror & Connected Git History    | PR #22 (connected upstream ancestry), PR #11 (agent guidance), PR #12 (upstream sync docs).                                                    | **Completed & Merged**          |
| **Phase 2**  | Beta Identity & Packaging         | `desktopIdentity.ts`, `desktop-platform-build-config.ts`, `main.ts`, embedded `synaraFlavor` merged; Linux arm64 packaging in review (PR #29). | **Core Merged (PR #29 Open)**   |
| **Phase 3**  | Release Automation                | `release-beta.yml` baseline, `scripts/release-beta.ts` preflight & tag bump.                                                                   | **Completed & Merged**          |
| **Phase 4**  | Initial Beta Release Cut          | Push initial tag (`v0.8.3-beta.1`) to `origin`, trigger CI release run, publish GitHub Release.                                                | **Ready for Execution**         |
| **Phase 5A** | Coexistence Auto-Sync Engine      | PR #3 (`@synara/shared/stableSync`, `bun run sync:stable`, `--undo`, `--watch`, `docs/sync.md`).                                               | **Completed & Merged**          |
| **Phase 5B** | One-Line Cross-Platform Installer | PR #2 (`install.sh`, `install-macos.sh`, `install-linux.sh`, `install-windows.ps1`, SHA256SUMS + SSH signing, `docs/install.md`).              | **Open (PR #2)**                |
| **Phase 5C** | Telemetry & Crash Reporting       | Deploy OpenAnalytics on VPS; add settings toggle and 23-field crash reporter in `apps/desktop`.                                                | **Pending Design / Deployment** |
| **Phase 6**  | Clean Upstream PRs                | Non-blocking backports to upstream `Emanuele-web04/synara`.                                                                                    | **Deferred / Non-blocking**     |

---

## Related Documentation

- **Installation Guide (`docs/install.md`):** Complete one-line terminal installer and manual download instructions (introduced in open [PR #2](https://github.com/kartikkabadi/synara-beta/pull/2); viewable on branch [`feat/one-line-installer`](https://github.com/kartikkabadi/synara-beta/blob/feat/one-line-installer/docs/install.md)).
- **[Coexistence Sync Guide](docs/sync.md):** Safe synchronization commands, safeguards, and watch daemon.
- **[Release Guide](docs/release.md):** Release build checklists, manifest specifications, and update feed structure.
- **[Agent Guidance](AGENTS.md):** PR-first workflows, stack rules, and model selection doctrine.

---

## Change Log

- **2026-09-05:** Initial plan created (status: plan only, empty repository).
- **2026-09-06:**
  - Autonomous shipping model adopted; upstream PRs made non-blocking.
  - Repository seeded and full commit history connected to upstream `Emanuele-web04/synara` via PR #22.
  - Beta desktop packaging and flavor identity implemented.
  - Coexistence Auto-Sync Engine created and merged in PR #3 (`@synara/shared/stableSync`, `bun run sync:stable`).
  - Cross-platform one-line installer developed in PR #2 with SSH-signed checksums.
  - README modernized with light/dark adaptive UI previews (PR #1, PR #13).
- **2026-09-07:**
  - PR-based upstream sync doctrine reinforced; PR #25 opened tracking upstream `v0.8.3`.
  - Submitted Linux arm64 desktop packaging support in PR #29.
  - Worktree auto-reclaim after merge developed in PR #30.
- **2026-09-08:**
  - Full plan overhaul reflecting completed mirror connection, merged sync engine, installer PR, bot review resolutions, and active PR inventory.
