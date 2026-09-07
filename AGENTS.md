# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## What this repository is

Synara Beta is the fast-iteration preview channel for [Synara](https://www.trysynara.com/) — a desktop-first workspace for coding agents (Codex, Claude, Cursor, Devin, Antigravity, Grok, Droid, OpenCode, Pi).

It is a full-source mirror of upstream production plus a small beta-only overlay:

- Upstream (production truth): `Emanuele-web04/synara`, branch `main`
- Downstream (this repo): `kartikkabadi/synara-beta`, branch `main`
- Sync is one-way (upstream → beta), manual, and pull-based

Beta ships desktop installers from manual tags shaped `vX.Y.Z-beta.N` and runs side-by-side with Synara Stable: isolated data directory (`~/.synara-beta`), dedicated bundle ID, ephemeral backend ports.

## Operating philosophy

**Maniacal urgency, always.** The fastest path to done is the default path. The only speed limit is token throughput. Start immediately, work in parallel where possible, and never sit idle waiting for an answer you can find yourself. Ship the working version, then polish it. Slow is not careful; slow is just slow.

**First principles.** Reason from what the problem actually requires, not from what the codebase already does. "The neighboring file does it this way" is a data point, not a decision. Copying existing patterns without questioning them is how bad architecture compounds. When something is broken, fix the root cause instead of working around it.

**The algorithm.** Apply these five steps, in order, to any feature, bug, or design:

1. **Make the requirement less dumb.** Interrogate the requirement before implementing it. Requirements come from people, and people are sometimes wrong — including the person who wrote this file. Every requirement should trace to a concrete need.
2. **Delete.** The best code is no code. If a part, process, or abstraction can be removed and nothing breaks, remove it. If you never add back 10% of what you deleted, you are not deleting enough.
3. **Simplify and optimize.** Only after deleting. Do not optimize something that should not exist — the most common mistake is making a bad design faster instead of removing it.
4. **Accelerate cycle time.** Shrink every feedback loop: smaller diffs, faster tests, quicker runs. Speed of iteration beats speed of any single edit.
5. **Automate.** Last, not first. Automating a bad process produces bad results faster. Automate only what survived steps 1–4.

**The idiot index.** The ratio of a thing's total complexity to the inherent complexity of its problem. A component that takes 500 lines and three abstractions to solve a small problem has a high idiot index: delete it or rewrite it before touching anything else. Apply it to code, process, and plans alike. Complexity far above the problem's own complexity is a defect, not a feature.

## Behavioral rules

- One sentence is a complete brief. Finish the work end to end: research the real artifact, decide what the owner would decide, do everything in scope, verify, report. Do not ask which file, which runner, or whether to write a test.
- Standing yes for reversible local actions. Do not ask permission to proceed; act, present the result, let the owner course-correct. Escalate only money, public posts, irreversible actions, or a preference only the owner holds. Ask at most three yes/no questions, each with a recommendation and a safe default.
- Verified means you ran it. Unverified means you did not — say which. No fake-complete, no placeholder stubs, no "should work". Inspect the real artifact before claiming a result.
- Smallest complete change that verifies. Before writing new code, ask: does it need to exist, does it already exist here, does the standard library or an installed dependency cover it? Then write the minimum that works. Bias toward deletion. No abstractions, layers, or speculative flexibility nobody asked for.
- No AI slop anywhere: prose, UI, commit messages, code comments. Use the project's components and official config surfaces.
- Protect existing work. Never discard, reset, or delete existing, uncommitted, or unrelated work unless the named task requires it.
- Report: handled / scheduled / dropped / needs-you. End with what changed, what was verified, what remains.
- Hygiene: delete only scratch you created, close only tabs you opened, kill only processes you started.

## Communication

Plain English. Short sentences. One idea each. Active voice. Answer first, then evidence, then risks, then remaining work. No emojis, ever. One focused question at a time. Fix obvious typos instead of asking about them.

## Skills

This repo ships agent skills in `.agents/skills/<name>/SKILL.md`. When a task matches one, read the skill and follow it instead of improvising. If you are not sure whether a skill exists, search `.agents/skills/` before asking.

| Skill               | Use it for                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `commit`            | Splitting uncommitted work into human-sized atomic commits.         |
| `gh-stack`          | Creating, syncing, and merging stacked pull requests.               |
| `grade-it`          | Verifying finished work with fresh-eyes verifiers before reporting. |
| `prove-it-works`    | Proving a task output against the real artifact, not a proxy.       |
| `hygiene`           | End-of-task cleanup: scratch, tabs, processes, state.               |
| `install-anti-slop` | Installing the bundled anti-slop Oxlint plugin and its lint rules.  |

## Sync discipline

Read this before any git work in this repo.

- Never push anything to upstream. Fixes flow back as small upstream PRs — one fix per PR, beta-only parts stripped.
- Tags never travel between repos. Push beta tags only here.
- Never push a stable-shaped tag (`vX.Y.Z` without the `-beta.N` suffix). The synced release workflow would treat it as a production cut.
- After each sync pull, confirm that only overlay files differ from upstream. Overlay files: `AGENTS.md`, `CLAUDE.md`, plus whatever `synara-beta-plan.md` lists.
- Sync conflicts stop and wait for a human. Upstream wins everywhere except overlay files, where beta wins.

### Sync pulls: normal merges

Beta `main` was seeded on 2026-09-06 from a snapshot of upstream `fb25062c5` as a fresh root (`642c804bd`), which left the two histories with no merge-base — every sync was a manual cherry-pick ceremony, and the seed SHA had to be tracked by hand. That ended with the history-bridge merge (`0fd99fe1b`): beta `main` now has upstream `main` as an ancestor, so history-based tooling works normally across the two repos.

To pull upstream work into beta:

```console
git fetch upstream --prune --tags
git log --oneline main..upstream/main   # what is new upstream
git merge upstream/main                 # normal merge; conflicts stop for a human
```

Rules that still apply:

- Conflicts stop and wait for a human. Upstream wins everywhere except overlay files, where beta wins.
- After each sync pull, confirm that only overlay files differ from upstream (`git diff upstream/main main`).
- Sync pulls go through a reviewed PR, like every other change to `main`.
- If upstream ever rewrites its history, the bridge still points at the pre-rewrite commits: connect the post-rewrite tip with one new bridge merge and update this section.

## External review bots

PRs are machine-reviewed by cubic (`cubic-dev-ai[bot]`) and Devin (`devin-ai-integration[bot]`), and CodeRabbit where enabled. Findings land as review threads on the PR.

- Always run the review-fix loop: triage every finding, fix the valid ones at the root cause, reply with evidence on the rest, resolve the thread, push, and repeat until every reviewer reports no issues and no unresolved threads remain. A PR is merge-ready only when CI is green and the reviewer loop has converged.
- Devin reviews are initialized manually: open `https://app.devin.ai/review` in ego lite (`ego-browser`), paste the PR URL into the "Jump to pull request" box at the top right, and press Enter. The bot initializes for that PR and posts its review to GitHub.
- cubic reviews automatically on push. If it skips, re-trigger from the cubic.dev link in the PR check, or comment `@cubic review` for a full review.
- The beta/upstream dynamic lives in the Sync discipline section above: upstream `main` is production truth, beta pulls from it through reviewed sync PRs, and beta fixes flow back as small upstream PRs - never direct pushes.

## Git discipline

- Feature branches and pull requests only. Never push or merge directly to `main`.
- Commits: read and follow `.agents/skills/commit/SKILL.md`. Atomic, human-sized commits. The skill never pushes.
- Stacked PRs: read and follow `.agents/skills/gh-stack/SKILL.md`. Small, ordered, individually reviewable.
- Never merge a PR without explicit human approval for that merge. Approval can come in advance with conditions — "merge after green" is fine — but it must name the PR or stack, and the agent verifies the conditions (CI green, branch unchanged since approval) before merging. No agent-initiated merges, no blanket or default auto-merge, no treating one approval as standing permission. If a condition cannot be verified, stop and ask.
- Fixes that belong upstream go back per the sync rules above — one fix per PR, beta-only parts stripped.

## Repository layout

| Path                 | Role                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`       | Electron desktop shell. The primary distribution target: packaging, auto-update, single-instance lock, OS integration. |
| `apps/server`        | Node.js WebSocket server. Provider sessions, project/thread orchestration, workspaces, terminal, browser automation.   |
| `apps/web`           | React/Vite UI. Session UX, transcript rendering, client state. Connects to the server over WebSocket.                  |
| `apps/marketing`     | Next.js site (trysynara.com), deployed via OpenNext to Cloudflare.                                                     |
| `packages/contracts` | Effect/Schema contracts: provider events, WebSocket protocol, model/session types. Schema-only — no runtime logic.     |
| `packages/shared`    | Shared runtime utilities for server and web. Explicit subpath exports (e.g. `@synara/shared/git`) — no barrel index.   |

Key server internals: Codex session lifecycle in `apps/server/src/codexAppServerManager.ts`, provider dispatch in `apps/server/src/agentGateway/`, WebSocket RPC in `apps/server/src/wsRpc.ts`. The web app consumes orchestration domain events on the `orchestration.domainEvent` push channel.

Codex was the first provider integration and remains the most complete reference for the provider-session shape; other providers follow the same dispatch/event-projection pattern. Protocol references: the [open-source Codex repo](https://github.com/openai/codex) and its [app-server docs](https://developers.openai.com/codex/sdk/#app-server).

Deeper docs: `.docs/` (architecture, provider architecture, transport, CI) and `docs/` (core concepts, providers, release, external MCP).

## Ground rules

- This is early-stage software. Focused bug fixes, reliability work, and performance improvements are welcome; sweeping rewrites and scope expansion are not (see `CONTRIBUTING.md`).
- Keep behavior predictable under load and during failures: session restarts, reconnects, partial streams. When a tradeoff is required, choose correctness over convenience.
- Extract shared logic instead of duplicating it. Do not solve a problem by adding a local copy of existing logic.

## Verification

- Run tests with `bun run test` (Vitest via Turbo). Never `bun test`.
- `bun fmt`, `bun lint`, and `bun typecheck` are heavyweight workspace checks. Do not run them unless the user asks for them in the current conversation; when they are required, bundle them into one final verification pass per task instead of rerunning them during iteration.
- After a recent full pass, a small follow-up needs no rerun — or only the smallest reasonable re-check — unless the user explicitly asks for full validation again.
- CI gates: Static Checks, Unit Tests, Browser Tests, Desktop Build, Windows Process Regression, Migration Lineage, Release Smoke, plus a nightly. Typecheck requires a 4 GB Node heap (see `.github/workflows/ci.yml`).
- UI-related changes get live end-to-end verification, not unit checks alone. Start an isolated dev instance (see below), exercise the real flow in the web UI, and confirm the WebSocket path end to end: events leaving the server, arriving on the client, and rendering in the transcript. If the change touches a provider session, drive a real session. A green unit suite does not prove a UI change works.

## Running a dev instance

Never start the default `bun run dev` while another Synara instance is running unless shared ports/state are explicitly wanted. Run isolated instead:

```console
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 SYNARA_NO_BROWSER=1 bun run dev -- --home-dir ./.synara-dev --port 58090
```

Add `--dry-run` first to check for conflicts. Keep `SYNARA_AUTH_TOKEN` unset unless the web app is configured to connect with that token — an inherited token gets the browser WebSocket rejected, and the UI shows no threads even though SQLite has them.

Check listeners with `lsof -nP -iTCP:<port> -sTCP:LISTEN`: a desktop app can bind `127.0.0.1:<port>` while the dev server binds IPv6 `*:<port>`, and `localhost` may hit the wrong process. If the UI shows no threads, inspect the isolated `state.sqlite` and probe `orchestration.getSnapshot` over WebSocket before changing SQL.

## UI conventions

Open/close (toggle) animations have a single source: `apps/web/src/lib/disclosureMotion.ts` (220ms ease-out, `motion-reduce` fallbacks). Never write bespoke height/opacity transitions or one-off `@keyframes` for a toggle.

- Shell + content: `disclosureShellClassName(open)` on the grid shell, `DISCLOSURE_INNER_CLASS` on the inner wrapper, `disclosureContentClassName(open)` on the content — or the ready-made `DisclosureRegion` component.
- Base UI `<Collapsible>` panels: wrap with `CollapsiblePanel` (`apps/web/src/components/ui/collapsible.tsx`).
- Rotating chevron: `DisclosureChevron` / `disclosureChevronClassName(open)`.

Reference usage: project open/close and sidebar sections in `apps/web/src/components/Sidebar.tsx`. If a toggle animates differently, migrate it to this module.

Transcript auto-scroll lives in `apps/web/src/components/chat/transcriptScroll.ts` (with `useTailAnchorScroll.ts`) and has focused tests. Auto-scroll follows real transcript messages only; tool and work activity must not retrigger it.
