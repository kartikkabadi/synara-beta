# Synara Beta Plan

Date: 2026-09-05. Status: plan only. No code changed.

Beta repo: https://github.com/kartikkabadi/synara-beta. It exists. It is public. It is empty. No commits yet.

## Choices made

- Beta repo holds full source. It is a mirror. Not release only.
- Beta is its own app. New name. New ID. It runs next to Stable.
- Beta builds ship from manual tags. Shape: `vX.Y.Z-beta.N`.
- Plan order: mirror sync, then releases, then import, then crash reports.
- Autonomous shipping 2026-09-06: Ship Beta autonomously today from `kartikkabadi/synara-beta` without waiting for upstream review or approvals. Upstream PRs (PR 1–5) will be prepared and submitted later as non-blocking cleanups.
- Code signing lifecycle: Ships unsigned initially (`ALLOW_UNSIGNED_BETA_PUBLICATION=true`). Signing credentials can be added to GitHub Secrets at any point later with zero code refactoring and zero user data loss.
- Telemetry & crash reporting: Self-hosted OpenAnalytics (`getopen.so`) on user's VPS for privacy-first, cookie-free, GDPR-compliant crash and usage metrics.

## Canary today

- Stable ships as signed downloads. Four targets: mac arm64 dmg, mac x64 dmg, linux AppImage, windows exe. One update channel named `synara`. Current cut is 0.8.1.
- Canary is a local build. No download. The user needs git, Bun, Node. The user runs `bun run canary:setup`. The build runs on their box.
- Canary has no version. No auto-update channel. `canary:update` is a manual script. Its mark is a commit hash.
- Canary starts with a blank data dir `~/.synara-canary`. Users take this for lost data. It is by design, but it reads as breakage.
- Canary needs terminal skills. Nothing on the site or in the app points to it.
- Five pains for plain users: long local build, terminal only, no versions or updates, blank start, unsigned build plus provider setup done by hand.

## OpenCode model

- Stable and Beta are two apps. Two names. Two IDs. Prod is `ai.opencode.desktop`. Beta is `ai.opencode.desktop.beta`. Both stay installed. Both run at once.
- Channel is set at build time. No in-app switch.
- Each app updates from its own repo. Stable polls `anomalyco/opencode`. Beta polls `anomalyco/opencode-beta`. Both use channel name `latest`. The split repo keeps feeds apart.
- Stable cuts by hand: `1.18.29`. Beta cuts auto per push: `v0.0.0-beta-19151`.
- Site serves both: `/download/stable/...` and `/download/beta/...`. Only Stable has buttons. Only Stable has a Homebrew cask. Beta is direct link only.
- Both lines are signed. Same trust.

## Coexistence & Runtime Isolation Audit

Stable and Beta can run simultaneously on the same machine without collisions:

- **Single Instance Lock:** Scoped by `app.setPath("userData", ...)` in `apps/desktop/src/main.ts` before `requestSingleInstanceLock()`. Beta sets `userData: "synara-beta"`, so OS-level instance locks on macOS, Linux, and Windows are completely independent.
- **Backend Ports:** Packaged desktop runs do not hardcode port 3773. `apps/desktop/src/main.ts` binds an ephemeral free port via `NetService` at startup, avoiding port collisions.
- **Browser Automation Named Pipes:** Browser IPC pipe paths in `apps/desktop/src/browserUsePipeServer.ts` incorporate `${pid}-${Crypto.randomUUID()}`, preventing socket collisions.
- **Secrets & Credentials:** Provider tokens live in file-based storage (`~/.synara/userdata/secrets/*.bin` vs `~/.synara-beta/userdata/secrets/*.bin`) with `0700` directory modes, completely separate.
- **OS Permissions (TCC):** macOS tracks permissions (microphone, notifications, screen recording) by bundle ID (`com.emanueledipietro.synara` vs `com.emanueledipietro.synara.beta`).
- **Git Worktrees:** Thread workspaces live in `~/.synara/worktrees/` vs `~/.synara-beta/worktrees/`. Unique thread branch names (`synara/<uuid>`) prevent Git multiple-checkout errors on shared repositories.
- **Windows NSIS Installer:** Dedicated GUID for Beta ensures `Add/Remove Programs` and registry entries do not overwrite Stable.

## Mirror sync plan

Terms:

- Upstream is prod truth: `Emanuele-web04/synara`, branch `main`.
- Downstream is the beta mirror: `kartikkabadi/synara-beta`. Its `main` is full source plus a beta-only overlay.
- Sync ref is one upstream `main` SHA per run. Each sync commit says `sync: upstream main @ <SHA>`.
- Overlay is the small file set that is beta only. It must live through each sync.

Direction:

- Forward: upstream `main` to beta `main`. Only this way.
- Back: beta fix to upstream only by small PR. Never push beta `main` to upstream.
- Beta never writes to upstream directly.

What syncs:

- Full source: `apps/*`, `packages/*`, `scripts/*`.
- Release path: `.github/workflows/release.yml`, `.github/actions/setup-workspace`, `scripts/resolve-release-update-policy.ts`, `scripts/lib/release-update-policy.ts`, `scripts/release-update-policy.json`, `scripts/verify-release-source-provenance.ts`, `scripts/prepare-release-update-feed.ts`, `scripts/merge-mac-update-manifests.ts`, `scripts/update-release-package-versions.ts`, `scripts/write-release-artifact-provenance.ts`, `scripts/release-smoke.ts`, `scripts/verify-packaged-desktop-startup.ts`, `scripts/build-desktop-artifact.ts`, `scripts/check-migration-lineage.ts`, `docs/release.md`.
- Manifests: root `package.json`, `bun.lock`, `turbo.json`, configs. `bun.lock` stays byte same on main. Tag commits carry their own regen, never merged.
- Tags never mirror. Sync fetches with `--no-tags`. Upstream tags stay upstream. Beta tags stay downstream.
- Only `main`. Never the ~200 feature branches. Tags travel with neither side.

What never syncs, the overlay list:

1. Identity: nothing to overlay once the flavor PR lands. Beta ID, name, scheme, data dir live upstream behind the flavor flag. Until then, overlay `packages/shared/src/desktopIdentity.ts` plus the build script plus updater allowPrerelease, and expect sync pauses.
2. Feed: no overlay needed. Channel stays `synara` across both Stable and Beta. Update repo falls back to the beta repo (`kartikkabadi/synara-beta`) in beta CI. Feeds live per repo, so names cannot clash and `release:smoke` stays clean.

How code moves, all by hand:

- Kartik pulls when he wants. Nothing runs on a timer. Three ways, same result: the Sync fork button on GitHub, `git fetch upstream` plus `git merge upstream/main`, or a script in the beta repo that runs those steps plus re-applies the overlay. Conflicts stop and wait for Kartik.
- Terms: upstream is `Emanuele-web04/synara` main. Downstream is `kartikkabadi/synara-beta` main. Sync ref is the merge commit of each pull. Overlay is the small set of files that must differ in beta.
- What syncs: `apps/*`, `packages/*`, `scripts/*`, configs, workflows, docs, tests, assets.
- What never syncs: `.git/` history rewrites, upstream tags, upstream releases, Stable signing secrets, Stable feed files.
- Conflict rule: upstream wins, except overlay files where beta wins and Kartik resolves by hand.
- Verify step after each pull: overlay files still differ as intended, build starts, tests pass on the beta copy.
- After each pull, compare beta main to upstream main. Only overlay files may differ. Else something leaked.

Fixes go back as normal requests:

- Kartik writes the fix, opens a request to upstream, Emanuele merges. No auto move. No cherry-pick machine.
- One fix per request. Beta-only parts stripped before opening.
- Small requests only. Big beta work stays in beta until split.
- Each request says which beta tag proved it.

## Beta releases plan

Tag shape:

- Tags look like `v0.8.2-beta.1`. Beta repo only. Never push them upstream.
- Core `X.Y.Z` must top `0.4.2`. `N` starts at 1 per core. `N` rises per cut.
- Stable `X.Y.Z` sorts above all its betas. The upgrade path stays clean.
- Policy code detects `-beta.N` as prerelease.
- The beta release workflow forces `make_latest: true` when publishing to GitHub Releases in `kartikkabadi/synara-beta`. Newest beta is latest in its own repo, keeping `releases/latest` links active for CDN updates.
- Check: run the resolve script on `0.8.2-beta.1`. See prerelease true, lane clean.

Trigger, beta copy only:

- Upstream fires on `v*.*.*`. That glob also hits beta tags. A beta tag pushed upstream would start a prod run.
- Rules: push beta tags only to `kartikkabadi/synara-beta`. Never set upstream as origin there.
- Stable-shaped tags pushed in beta would fire the synced copy too. The trigger guard covers this. See Trigger guard.
- Manual runs stay build-only by default. The runbook says the version must end `-beta.N`. Extra safety: a guard step that blocks stable versions.

Bump order, tag commits stay off main:

- From a clean beta main tip, set all four package files to `X.Y.Z-beta.N`. Regen the lock so frozen install passes. Commit. Tag that commit. Push tag only.
- The bump commit never merges to main. Main stays overlay-clean. The lock diff lives in the tag commit only.
- Provenance still passes: a tag checkout is clean, and versions match the tag.
- The auto-bump job stays off in beta. No per-tag main commits. This keeps many tags a day cheap.

What a tag push does:

- Preflight marks it publish. Gates run: brand check, lint, typecheck, test.
- The matrix builds all four targets. Each lane writes provenance and runs start smoke.
- The release job makes one GitHub prerelease. Prerelease true. `make_latest` true. The updater uses CDN files, skips API rate limits, keeps `releases/latest` links alive.
- Feed files (`synara-mac.yml`, `synara.yml`, `synara-linux.yml`) ship from the beta repo only. The stable feed stays clean.
- CLI publish stays off. npm trust points at upstream. Keep that var unset.

Pipeline copy (`release-beta.yml`):

- New file `release-beta.yml`. Copy of `release.yml`. Own trigger. Own concurrency name. Bridge and mirror steps out. CLI publish and auto-bump out.
- Matrix: mac arm64 dmg (`macos-14`), linux AppImage (`ubuntu-24.04`), win nsis (`windows-2022`). Note on macOS x64: `macos-15-intel` can be enabled once runner availability is confirmed on the account. Tarball kept for publish runs.
- **Unsigned Publication Override:** Upstream `release.yml` exits with `1` if `SYNARA_PUBLISH_RELEASE == "true"` and signing secrets are missing. `release-beta.yml` must explicitly allow publication of unsigned builds (e.g. `ALLOW_UNSIGNED_BETA_PUBLICATION=true`) so tag push runs succeed in publishing unsigned assets before certificates exist.
- Beta name and ID through the whole build: name Synara Beta, new bundle ID `com.emanueledipietro.synara.beta`, new Windows GUID, exec `synara-beta`, own data dirs `~/.synara-beta`, updater channel `synara` with prerelease allowed, feed repo pinned to `kartikkabadi/synara-beta`.
- Packaged flavor awareness: `build-desktop-artifact.ts` stamps `"synaraFlavor": "beta"` into `stagePackageJson` in `package.json`. In `apps/desktop/src/main.ts`, `resolveEmbeddedFlavor()` reads it at startup so installed builds know they are Beta without needing environment variables.
- Secrets to fill one day: six Apple items, eight Azure items. The github token comes free. No app keys. No npm OIDC.
- Until secrets exist, publish runs succeed with unsigned assets.

Tag command, one command:

- Shape: `bun run release:beta -- X.Y.Z [N] [--dry-run]`. Dry run prints all checks first.
- It asserts the remote is the beta repo. Tree clean. HEAD matches beta main tip after fetch. Name fits `vX.Y.Z-beta.N`. `N` is next free per `ls-remote`.
- It makes an annotated tag. Pushes tag only. Never branches.
- This script lives in the overlay. Upstream never sees it.

Pre-tag list, under two minutes:

- Fetch. HEAD must match beta main tip. If stale, sync first.
- Tree clean. Name and `N` in form. Remote is beta.
- Know the sign state: unsigned beta or beta certs. Write it in `BETA.md` once.

Post-tag checks:

- Run green on the tag. Provenance names tag, commit, lockfile.
- Release shows prerelease true, marked Latest in the beta repo. Six yml assets present. Mac manifest merged.
- Upstream stable and bridge untouched. Channel files synara-named, beta repo only.
- Update probe: install beta N on one box, confirm the updater offers N+1 through the beta feed. Sample, not each tag.
- Try the newest beta on one box now and then. At this pace, sample, not each tag.

Backout:

- Bad cut: ship `N+1`. Clients cant step down on their own.
- Yank: `gh release delete` with tag cleanup, beta repo only. Note the yanked `N` in the sync log. Ship `N+1` fast.
- Never reuse `N`. Never touch stable or bridge.

Pace rules:

- Auto-bump off. Narrow trigger. Prerelease only.
- One base `X.Y.Z` per sync window. `N` resets per base. Past a burst a day, batch instead.

Top risks:

- Wrong remote. A beta tag pushed upstream starts a prod run. Fix: remote allow-list in the tag command, `gh` repo pins, upstream remote read-only under a clear name.
- Feed mix. Wrong `make_latest`, channel, or repo var points beta bytes at stable users. Fix: repo-level feed isolation (`kartikkabadi/synara-beta`), channel stays `synara`, check Stable Latest untouched per tag.
- ID clash. Same bundle ID, GUID, or data dir takes over prod installs. Fix: new values through the whole chain, checked per tag; flavor baked into packaged `package.json`.
- Missed updates. `allowPrerelease` left false hides all betas. Fix: `apps/desktop/src/main.ts` sets `autoUpdater.allowPrerelease = (desktopFlavor === "beta")`.
- npm leak. The CLI publish var set in beta ships prerelease CLIs. Fix: keep it unset.

## Import plan

Terms: Stable home `~/.synara` is source. Beta home `~/.synara-beta` is target. Import is opt in. Stable is never written.

Architecture boundary:
- Import logic runs in `apps/server` (Node.js runtime with direct filesystem access and Effect atomic file writers).
- `apps/web` interacts via WebSocket RPC: `import.getAvailability`, `import.execute`, `import.undo`.
- This keeps filesystem operations out of React and allows comprehensive Vitest test coverage without spinning up Electron.

Scope call, made here: default copies settings, keybindings, skills. No chats. No history. This matches the stated need: configs and settings only.
One slice drew the line at settings plus skills. One drew it at settings plus full thread history. Default is the smaller set. History copy stays a later opt in, using the same safe machinery.

Safe to copy:

- `userdata/settings.json`, after sanitize:
  - Reset `providers.opencode.serverPasswordConfigured` to `false`.
  - Strip inline server passwords and transient credentials.
  - Preserve model selections, prompts, and disabled skills.
- `userdata/keybindings.json`, as is.
- Beta's own `<home>/skills`, as is. Copy symlinks as symlinks. Never follow them into outside repos. Screen names them Synara skills.
- Nothing else by default.

Never copy:

- `secrets/*.bin`. Beta mints its own. Provider screens show signed-out until the user signs in again.
- `state.sqlite` and all sidecars (`-wal`, `-shm`, locks). No threads cross by default.
- `server-runtime.json`, `quit-resume.json`, `environment-id`, `device-boot-ownership.json`. These are live identity. Beta makes its own.
- `logs/`, `worktrees/`, `codex-home-overlay/`, `cache/`, quarantine files, migration backups and markers.

When the screen shows:

- Beta first launch only. Beta has no `settings.json` yet. Stable has `userdata/settings.json`.
- Stable missing means skip the screen. Boot fresh.
- Show once. Never auto copy. A Beta-side marker (`.imported-from-stable`) notes the choice. Skip path always in view.

Screen steps:

- Step 1, Welcome. Names Beta a test build. Says plain: this build breaks. That is its job. Fixes ship fast, often same day. One line says Stable is untouched. Buttons: Copy my Stable setup. Start fresh.
- Step 2, Choices. Checkboxes, default on: provider setup, skills. A plain note says chats, logins, passwords never copy.
- Step 3, Progress. One line per item with check marks. Kill mid-copy leaves Beta bootable.
- Step 4, Done. Lists what copied and what needs the user. Repeats the promise: broke something, report it, fix lands fast. Button: Open Beta. Link: redo or undo. Done says check providers, then run a small test task.

Copy order: settings, keybindings, skills. Validate each file before commit. Bad JSON falls back to defaults with a warning, never a crash.

- Redo lives in Settings: import from Stable again. It replaces Beta settings and skills only. It names both before confirm.
- Undo offers two paths: restore pre-import Beta from snapshot, or erase and start fresh. Both touch Beta only. Stable is always the fallback source.
- Before any replace, snapshot Beta userdata to a timestamped backup. Keep 5, like migration backups do.
- No merge, ever. No row-level union of anything.

Refuse rules, refuse rather than limp:

- Stable and Beta resolve to the same dir. Stop. Say why.
- Beta already booted and has data. No auto prompt. Redo path only, with confirm.
- Free space under 2x the copy size. Stop. Say why.

Post-import checks, all pass before Done:

- Beta boots clean. Settings screen matches Stable. Skills list matches.
- Thread list empty. Stable files unchanged.
- `environment-id` differs from Stable. `secrets/` holds no Stable files.
- File modes 0700 dirs, 0600 files.

Beta promise, shown in onboarding and Settings:

- Beta ships often and breaks sometimes. That is the deal. Stable stays safe.
- Each break gets a fix fast. Report from the app. No account needed.
- Crash reports are opt in, preview first, 23 fixed fields, never prompts or keys or paths.
- No numbers promised. No dates promised. Just fast turns.

Top risks:

- User fears Stable damage. Fix: the Stable-untouched line on each step.
- Secret confusion. Fix: never copy secrets, say so up front, show signed-out state.
- Stale binary paths. Fix: Done screen says check provider status.
- Scope drift. Fix: copy allow-list, not block-list. Review it when settings gain fields.
- Nag on each launch. Fix: marker file once the user picks.

## Crash reports plan

Terms: shape fixed. Redaction allow-list based. User consents first. Off by default. No silent upload.

Today: no crash reporter exists. Logs hold raw paths. `server.log` has no scrub. Desktop tails pass backend text through. Provider native logs hold prompts by design. The diagnose bundle needs manual review per docs.

Integration hooks in Desktop:
- Hook into `apps/desktop/src/main.ts`:
  - `presentBackendStartupGiveUp`: Triggered when backend supervision fails after consecutive attempts.
  - `presentRendererCrashRecovery`: Triggered when renderer reload budget is exhausted.
- Add "Report crash" button to the native dialogs alongside "Open logs" and "Quit".

Fixed fields, 23. Nothing else leaves the box:

- `reportVersion` 1. `channel` synara. `flavor` beta. `bundleId` is `com.emanueledipietro.synara.beta`.
- `app.version` max 64 chars. `buildType` packaged or source. No paths.
- `os` darwin, linux, win32. `arch` x64, arm64.
- `failure.kind`: backend-start-failure, backend-give-up, renderer-crash, provider-spawn-failure. `attempt` and `consecutiveFailures` ints. `rendererReason` crashed or oom or null. `occurredAt` ISO. `uptimeMs` capped.
- `backend.summary` max 8 lines, 2000 chars. Built by the summarize helper, then scrubbed. Never the raw tail.
- `provider.kind` enum or null. `provider.version` trimmed, scrubbed, never the exe path. `provider.health` enum or null.
- `error.signature` from a fixed table only. `error.firstLine` max 200, null when nothing safe survives.
- `user.note` max 500, marked user-supplied.
- `consent.consentedAt` plus `wordingVersion`.

Redaction per field, reuses current scrubbers:

- Enums: reject out-of-enum values. No scrub needed.
- Versions: trim, cap, pass through credential key filter. Drop on fail.
- Signatures: map from the fixed table. Never copy raw text.
- Summary and first line, fixed order: summarize, strip flags and env assignments with fail closed on, strip URL creds and keys and headers, enforce bounds, replace home and data dir roots with placeholders. Cover Stable and Beta names. Cover both slash styles.
- Prompts: any session or prompt payload maps to one constant marker. No excerpt. No hash.
- `user.note` runs the same pipeline. Cap 500.

Never sent. Blocked at collection, not cleaned at send:

- Prompts, responses, tool calls, transcripts, summaries, diffs, file contents.
- Keys, OAuth and refresh tokens, session tokens, cookies, auth headers, gateway tokens, signing secrets, keychain content, credential files.
- Absolute paths, home dirs, usernames in paths, hostnames, machine names, private repo names, remote URLs.
- Secret store bytes, MCP credential stores, provider config files, full data dir, database, native NDJSON logs, raw protocol frames.
- IPs, bearer values, query secrets, internal hosts.
- Account, org, project, thread, task, request IDs. Counters and enums replace them.
- Screenshots and recordings stay out. Separate explicit attachment only.

Consent copy:

- Title: Send a crash report for Synara Beta.
- Body says: off unless approved. Lists what it holds. Lists what it never holds. User reads exact bytes first. Each crash asks again. Off switch in Settings.
- Controls: View report. Send report. Do not send. Remember-my-choice unchecked by default. Link opens the field list.
- Note warns: pasted secrets still need rotation.

Transport:

- Stage 1 (Immediate, zero-infra): Manual export of the staged file into a prefilled GitHub issue on `kartikkabadi/synara-beta`. Works immediately without deploying backends.
- Stage 2 (Self-Hosted Telemetry & Crash Reporting): OpenAnalytics (`https://getopen.so/`) hosted on user's VPS:
  - Privacy-first, open-source, cookie-free, GDPR-compliant.
  - Beta app exposes a transparent opt-in toggle in Settings: "Share anonymous crash and usage telemetry".
  - Dispatches lightweight event payloads (the scrubbed 23-field schema) directly to the self-hosted VPS endpoint (`https://<vps-domain-or-ip>/api/event`).
  - No commercial SaaS tracking SDKs (PostHog, Sentry) required.
- Stage 3 (Upstream PR integration): Sibling `/api/crash-report` route in `apps/marketing` plus `synara-beta://app` in CORS if merged into upstream prod.
- Local files 0600, dirs 0700. Preview shows exact bytes staged.
- Retention: max 10 staged. Small byte cap each. Older than 30 days pruned on start. Oldest first.
- Off means no file written. Crash UI shows local log paths only. On still needs per-report Send or opt-in telemetry toggle. Failed Send keeps the file and asks to retry. Never retries in background.
- Delete removes one file. Clear-all empties the dir. UI states remote copies cannot be pulled back.

Prove it:

- One sample per failure kind. Each key in the field list. Unknown keys rejected.
- Fixtures with keys, tokens, cookies, URLs, env assignments, home paths, prompt text. Only enums, placeholders, markers survive.
- Fresh Beta shows reports off. Decline sends zero bytes. Toggle off writes zero files.
- Trial crash with secrets in env and logs. None of the never-send strings appear.

Top risks:

- Novel secret shapes miss the key list. Fix: fail-closed remainder mode stays on. Review fixtures when providers change.
- Paths hide in cut lines. Windows paths evade handling. Fix: placeholder pass covers both slash styles, Stable plus Beta names.
- Notes reintroduce secrets. Fix: same pipeline plus rotation warning.
- Native logs tempt inclusion. Fix: never inputs. Shape has no blob field for them.
- Remember-me becomes blanket consent. Fix: still previews each crash before send.
- Delete overpromises. Fix: UI says local only.

## Upstream PRs first — to Emanuele, from Kartik

Beta is a second Synara app next to Stable. Same code. Own name, own ID, own data folder `~/.synara-beta`, own update feed from `kartikkabadi/synara-beta`. That repo mirrors your `main` one way. My fixes come back only as small PRs you approve. Stable is never touched. Guards at the end prove it.

Roles, stated plain. I write all five PRs. I have PR rights upstream. You review and merge. We both push to the beta repo directly. Only the merges wait on you.

1. **Flavor hook.** Files: `packages/shared/src/desktopIdentity.ts`, `scripts/build-desktop-artifact.ts`, `apps/desktop/src/main.ts`, `scripts/lib/desktop-platform-build-config.ts`.
   - Add `beta` to `SynaraDesktopFlavor`.
   - Define `SYNARA_BETA_BUNDLE_ID = "com.emanueledipietro.synara.beta"`, scheme `"synara-beta"`, home `".synara-beta"`, userData `"synara-beta"`.
   - Define distinct Windows NSIS GUID (e.g. static v4 UUID `a8e63b48-d4f3-4db5-9e12-368107afe65d`) and Linux executable name (`synara-beta`) in `desktop-platform-build-config.ts`.
   - Build script supports `--flavor` flag (defaults to `"production"`), and stamps `"synaraFlavor"` into staged `package.json`.
   - `main.ts` resolves flavor from embedded `package.json` when packaged, and sets `autoUpdater.allowPrerelease = true` for `beta`.
   - Why: eliminates brittle hand-edits to hot files after sync. Packaged builds are self-aware without env vars.
   - Proof: beta build exhibits beta ID, home dir, and updater allowPrerelease. Stable build completely unchanged.

2. **Trigger guard & release smoke.** Files: `.github/workflows/release.yml`, `scripts/release-smoke.ts`.
   - Add repository guard `if: github.repository == 'Emanuele-web04/synara'` to release jobs.
   - Update `verifyReleaseWorkflowSafety()` in `scripts/release-smoke.ts` to expect the repository guard so release smoke tests stay green in CI.
   - Why: `v*.*.*` trigger matches beta tags like `v0.8.2-beta.1`. One wrong push would otherwise trigger upstream stable pipeline.
   - Proof: push test beta tag in fork, upstream workflow remains quiet; `bun run release:smoke` passes locally and in CI.

3. **Lineage ignore.** Files: `scripts/check-migration-lineage.ts`, `scripts/check-migration-lineage.test.ts`.
   - In `resolveReleaseTags()`, filter out prerelease/beta tags (`!tag.includes("-")`).
   - Add unit test verifying prerelease tags are ignored while stable tags are retained.
   - Why: `v[0-9]*` glob matches beta tags. Experimental or rolled-back beta migrations would otherwise lock migration lineage permanently.
   - Proof: lineage tests green, beta-shaped tag ignored.

4. **Crash route & CORS.** Files: new `apps/marketing/src/app/api/crash-report/route.ts`, `apps/marketing/src/app/api/feedback/route.ts`.
   - Add `synara-beta://app` to allowed CORS origins in `corsOrigin()`.
   - Add sibling `/api/crash-report` route taking the 23-field schema.
   - Why: feedback route drops unknown fields, requires `details`, blocks beta origin, and is rate-limited to email.
   - Proof: sample report from beta origin accepted; feedback route untouched.

5. **Flavor-aware build assets.** Files: `scripts/lib/brand-assets.ts`, `scripts/build-desktop-artifact.ts`.
   - Allow `build-desktop-artifact.ts` to resolve flavor-specific icon assets (e.g. `assets/beta/*`, falling back cleanly to prod assets if missing).
   - Keep `scripts/check-brand-identity.ts` passing without changes (it only guards against retired predecessor clone terms and marketing screenshots).
   - Proof: brand checks green for both flavors; build stages correct platform icons.

Order: author PRs in parallel with mirror seeding using temporary overlay on hot files. Each merge deletes one overlay file. No idle wait.

Stable guards, in one place:

- Trigger guard above: upstream pipeline cannot fire from fork/beta repo.
- Feeds live per repo: Beta polls `kartikkabadi/synara-beta` only. Channel stays `synara` both sides. No clash.
- Tags never cross repos: sync fetches with `--no-tags`.
- Bumps live on tag commits only, never merged to any main.
- Backflow: fixes bake in beta first, arrive one fix per branch, strip beta parts, need Emanuele approval plus full green CI.

## Code Signing & Delegation Architecture

Beta starts completely unsigned and transitions seamlessly to official signing whenever credentials are added:

### Initial Unsigned Distribution
- Enabled via `ALLOW_UNSIGNED_BETA_PUBLICATION=true` in `release-beta.yml`.
- macOS: Users open via right-click -> Open or run `xattr -cr /Applications/Synara\ Beta.app` to clear Gatekeeper quarantine.
- Windows: Users bypass SmartScreen warning ("More info" -> "Run anyway").
- Linux: AppImage runs without code signing friction.

### Delegation Model with Emanuele (Later / Future Step)
- **Apple Developer Program:** Emanuele invites Kartik as an Organization Team Member (Developer or Admin) in App Store Connect. Kartik creates and manages his own Developer ID Application certificate and App Store Connect API keys directly under the Synara team identity. No raw private keys or personal Apple credentials are exchanged.
- **Azure Trusted Signing (Windows):** Emanuele assigns Kartik's Microsoft account the "Trusted Signing Certificate Profile Signer" RBAC role in Azure Portal. Windows builds sign via Azure CLI / GitHub Action without handling raw PFX certificates.

### Unsigned-to-Signed Transition Semantics
- **Zero Code Refactoring:** Packaging configuration (`desktop-platform-build-config.ts`) already has a clean `signed: true/false` toggle. Once secrets are populated in GitHub Secrets, the next tag build automatically signs and notarizes without any app code changes.
- **Zero Data Loss:** Beta user data is stored in `~/.synara-beta`, including SQLite databases and file-based secrets (`userdata/secrets/*.bin` with 0700 permissions). Because Synara avoids signature-locked macOS Keychain (`safeStorage`) and retains the identical bundle ID (`com.emanueledipietro.synara.beta`), migrating from unsigned to signed preserves 100% of user data, threads, settings, and credentials.
- **Auto-Updater Transition Caveat:** An unsigned running app cannot silently auto-update to a signed app in the background because macOS Squirrel.Mac (`ShipIt`) and Windows signature verifiers enforce code signature requirements on incoming updates. Users on initial unsigned builds will perform **one manual download** of the signed `.dmg` or `.exe` installer. Once installed, silent in-app auto-updates operate seamlessly for all subsequent releases.

## What changed

- 2026-09-05: Initial plan drafted.
- 2026-09-05: Review fixes applied:
  - Added Coexistence & Runtime Isolation section: audited single-instance locks, dynamic ports, named pipes, secret files, macOS TCC permissions, worktrees, and Windows NSIS GUID.
  - Fixed packaged app flavor detection: stamped into staged `package.json` instead of relying on env vars.
  - Aligned update channel to `"synara"` across both repos to prevent manifest clashes and `release:smoke` failures.
  - Resolved unsigned release trap: noted `ALLOW_UNSIGNED_BETA_PUBLICATION` in `release-beta.yml` so builds don't fail without Apple/Azure secrets.
  - Documented `macos-15-intel` runner contingency for beta release matrix.
  - Updated PR 2 scope to include `scripts/release-smoke.ts` string assertion updates to avoid breaking CI.
  - Clarified PR 5 target: `brand-assets.ts` and `build-desktop-artifact.ts` (instead of `check-brand-identity.ts`).
  - Architecture defined for data import (`apps/server` RPC) and crash report hooks (`apps/desktop` native crash dialogues).
- 2026-09-06: Autonomous shipping & infrastructure updates:
  - Shifted to autonomous shipping today from `kartikkabadi/synara-beta`; upstream PRs 1–5 made non-blocking for future upstream polish.
  - Documented Apple Developer Org team invite and Azure Trusted Signing RBAC delegation mechanics.
  - Audited and verified unsigned-to-signed transition: zero data loss guarantee (file-based secrets + unchanged bundle ID), verified one-time manual download updater caveat.
  - Integrated self-hosted OpenAnalytics (`getopen.so`) on user's VPS for privacy-first, cookie-free crash and usage telemetry.

## What was checked

- `synara-beta` empty via GitHub API contents 404.
- OpenCode live feeds: stable `1.18.29`, beta `0.0.0-beta-19151`.
- Upstream remote, `main`, tag lane, overlay files, trigger, policy, provenance, smoke, matrix, secret names. All read from the repo.
- Electron updater security (`electronUpdaterSecurity.ts`), Squirrel.Mac ShipIt constraints, and file-based secret storage audited.

## Execution Sequence

- **Phase 1:** Seed beta mirror repo (`kartikkabadi/synara-beta`) and establish `beta` remote.
- **Phase 2:** Beta identity, flavor flags, and desktop build packaging (`desktopIdentity.ts`, `desktop-platform-build-config.ts`, `build-desktop-artifact.ts`, `main.ts`).
- **Phase 3:** Beta release workflow (`.github/workflows/release-beta.yml` with `ALLOW_UNSIGNED_BETA_PUBLICATION=true`) and tagging preflight tool (`scripts/release-beta.ts`).
- **Phase 4:** Tag and ship initial Beta release (`v0.8.2-beta.1`).
- **Phase 5:** Self-hosted OpenAnalytics (`getopen.so`) deployment on VPS & import RPC.
- **Phase 6 (Non-blocking):** Prepare clean upstream PRs 1–5 for Emanuele.
