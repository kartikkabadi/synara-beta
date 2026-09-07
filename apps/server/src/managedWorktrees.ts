import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { OrchestrationThreadPullRequest, ServerManagedWorktree } from "@synara/contracts";
import { Effect } from "effect";

import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { GitHubCliShape } from "./git/Services/GitHubCli.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const MANAGED_WORKTREE_SCAN_DEPTH = 6;
export const MANAGED_WORKTREE_RETENTION_COUNT = 15;

/**
 * The only thread state managed-worktree retention reads. Structural on purpose so
 * both the narrow projection row and a full `OrchestrationThread` satisfy it, and so
 * the prune path never pulls a whole read model into memory just to look at five
 * columns.
 */
export interface ManagedWorktreeThreadRef {
  readonly id: string;
  readonly projectId?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly associatedWorktreePath?: string | null | undefined;
  readonly associatedWorktreeBranch?: string | null | undefined;
  readonly associatedWorktreeRef?: string | null | undefined;
  readonly lastKnownPr?: OrchestrationThreadPullRequest | null | undefined;
}

export type ManagedWorktreeRemovalReason = "deleted" | "archived-retention" | "merged";

export interface MergedWorktreeInfo {
  readonly path: string;
  readonly detectedHeadSha: string | null;
  readonly mergeSource: "pr" | "ancestry";
  readonly successfulBaseRefs?: ReadonlyArray<string> | undefined;
  readonly prHeadSha?: string | null | undefined;
}

export class MergedWorktreeSet extends Set<string> {
  private readonly infoByPath = new Map<string, MergedWorktreeInfo>();

  addInfo(info: MergedWorktreeInfo): this {
    this.add(info.path);
    this.infoByPath.set(info.path, info);
    return this;
  }

  getInfo(path: string): MergedWorktreeInfo | undefined {
    return this.infoByPath.get(path);
  }
}

export interface ManagedWorktreeRemovalCandidate {
  readonly entry: ServerManagedWorktree;
  readonly thread: ManagedWorktreeThreadRef;
  readonly reason: ManagedWorktreeRemovalReason;
  readonly detectedHeadSha?: string | null | undefined;
  readonly mergeSource?: "pr" | "ancestry" | undefined;
  readonly successfulBaseRefs?: ReadonlyArray<string> | undefined;
  readonly prHeadSha?: string | null | undefined;
}

async function findLinkedWorktreeRoots(root: string, current = root, depth = 0): Promise<string[]> {
  if (depth > MANAGED_WORKTREE_SCAN_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  if (entries.some((entry) => entry.name === ".git" && entry.isFile())) {
    return [await fs.realpath(current)];
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => findLinkedWorktreeRoots(root, path.join(current, entry.name), depth + 1)),
  );
  return nested.flat();
}

function parsePrimaryWorktreePath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      const value = line.slice("worktree ".length).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function listManagedWorktrees(input: {
  readonly worktreesDir: string;
  readonly git: GitCoreShape;
}): Effect.Effect<ReadonlyArray<ServerManagedWorktree>, Error> {
  return Effect.tryPromise({
    try: () => findLinkedWorktreeRoots(input.worktreesDir),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.flatMap((worktreePaths) =>
      Effect.forEach(
        worktreePaths,
        (worktreePath) =>
          input.git
            .execute({
              operation: "ManagedWorktrees.list",
              cwd: worktreePath,
              args: ["worktree", "list", "--porcelain"],
              timeoutMs: 5_000,
            })
            .pipe(
              Effect.flatMap((result) => {
                const workspaceRoot = parsePrimaryWorktreePath(result.stdout);
                return workspaceRoot
                  ? Effect.succeed({ path: worktreePath, workspaceRoot })
                  : Effect.fail(
                      new Error(`Git did not report a primary worktree for ${worktreePath}.`),
                    );
              }),
              Effect.catch((error) =>
                Effect.logWarning("managed worktree inventory skipped an invalid entry", {
                  worktreePath,
                  error: error instanceof Error ? error.message : String(error),
                }).pipe(Effect.as(null)),
              ),
            ),
        { concurrency: 4 },
      ),
    ),
    Effect.map((entries) =>
      entries
        .filter((entry): entry is ServerManagedWorktree => entry !== null)
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );
}

function threadManagedWorktreePath(thread: ManagedWorktreeThreadRef): string | null {
  return thread.associatedWorktreePath ?? thread.worktreePath ?? null;
}

function isActiveManagedWorktreeThread(thread: ManagedWorktreeThreadRef): boolean {
  return (thread.deletedAt ?? null) === null && (thread.archivedAt ?? null) === null;
}

function isDeletedManagedWorktreeThread(thread: ManagedWorktreeThreadRef): boolean {
  return (thread.deletedAt ?? null) !== null;
}

function isArchivedOnlyManagedWorktreeThread(thread: ManagedWorktreeThreadRef): boolean {
  return !isDeletedManagedWorktreeThread(thread) && (thread.archivedAt ?? null) !== null;
}

// The scanned inventory is realpath-canonical, while recorded thread paths may
// reach the same directory through symlinks (e.g. /var -> /private/var).
// Canonicalize the thread side too, or retention silently never matches
// anything on symlinked layouts. Missing paths fall back to plain resolution.
function canonicalizeThreadWorktreePaths(
  threads: ReadonlyArray<ManagedWorktreeThreadRef>,
): Effect.Effect<ReadonlyMap<string, string>, Error> {
  return Effect.tryPromise({
    try: async () => {
      const canonicalByRecordedPath = new Map<string, string>();
      for (const thread of threads) {
        const recordedPath = threadManagedWorktreePath(thread);
        if (recordedPath === null || canonicalByRecordedPath.has(recordedPath)) continue;
        canonicalByRecordedPath.set(
          recordedPath,
          await fs.realpath(recordedPath).catch(() => path.resolve(recordedPath)),
        );
      }
      return canonicalByRecordedPath;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

function snapshotOutputPath(input: {
  readonly snapshotsDir: string;
  readonly threadId: string;
  readonly worktreePath: string;
}): string {
  const digest = createHash("sha256").update(input.worktreePath).digest("hex").slice(0, 12);
  const threadPathSegment = input.threadId
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return path.join(input.snapshotsDir, `${threadPathSegment || "thread"}-${digest}`);
}

export function detectMergedManagedWorktreePaths(input: {
  readonly inventory: ReadonlyArray<ServerManagedWorktree>;
  readonly threads: ReadonlyArray<ManagedWorktreeThreadRef>;
  readonly canonicalByRecordedPath: ReadonlyMap<string, string>;
  readonly git: GitCoreShape;
  readonly gitHubCli?: GitHubCliShape | undefined;
}): Effect.Effect<ReadonlySet<string>, never> {
  const canonicalThreadPath = (thread: ManagedWorktreeThreadRef): string | null => {
    const recordedPath = threadManagedWorktreePath(thread);
    return recordedPath === null ? null : (input.canonicalByRecordedPath.get(recordedPath) ?? null);
  };

  const threadsByCanonicalPath = new Map<string, ManagedWorktreeThreadRef[]>();
  for (const thread of input.threads) {
    const canonicalPath = canonicalThreadPath(thread);
    if (!canonicalPath) continue;
    const existing = threadsByCanonicalPath.get(canonicalPath);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByCanonicalPath.set(canonicalPath, [thread]);
    }
  }

  const checkThreadMerged = (
    entry: ServerManagedWorktree,
    thread: ManagedWorktreeThreadRef,
  ): Effect.Effect<{
    readonly isMerged: boolean;
    readonly detectedHeadSha: string | null;
    readonly mergeSource: "pr" | "ancestry";
    readonly successfulBaseRef?: string | undefined;
    readonly prHeadSha?: string | null | undefined;
  }> =>
    Effect.gen(function* () {
      let isMerged = false;
      let prStatusKnown = false;
      let mergeSource: "pr" | "ancestry" = "pr";
      let headSha: string | null = null;
      let prHeadSha: string | null = null;
      let successfulBaseRef: string | undefined = undefined;

      // Read current worktree HEAD SHA first to compare against PR head commit or use for ancestry
      const revParseResult = yield* input.git
        .execute({
          operation: "ManagedWorktrees.revParseHead",
          cwd: entry.path,
          args: ["rev-parse", "HEAD"],
          timeoutMs: 3_000,
          allowNonZeroExit: true,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (revParseResult && revParseResult.code === 0 && revParseResult.stdout.trim().length > 0) {
        headSha = revParseResult.stdout.trim();
      } else if (
        thread.associatedWorktreeRef &&
        /^[0-9a-f]{40}$/iu.test(thread.associatedWorktreeRef)
      ) {
        headSha = thread.associatedWorktreeRef;
      }

      // Signal 1: PR check via GitHub CLI or recorded lastKnownPr
      if (thread.lastKnownPr) {
        if (input.gitHubCli) {
          const prRef = thread.lastKnownPr.url || String(thread.lastKnownPr.number);
          const prSummary = yield* input.gitHubCli
            .getPullRequest({ cwd: entry.workspaceRoot, reference: prRef })
            .pipe(
              Effect.catch((error) =>
                Effect.logDebug("managed worktrees: failed to re-resolve PR via gh", {
                  threadId: thread.id,
                  reference: prRef,
                  error: error instanceof Error ? error.message : String(error),
                }).pipe(Effect.as(null)),
              ),
            );

          if (prSummary && prSummary.state !== undefined) {
            if (prSummary.state === "merged") {
              prHeadSha = prSummary.headRefOid ?? null;
              if (prHeadSha && headSha && headSha !== prHeadSha) {
                // Post-merge commits exist in the worktree that differ from the merged PR head.
                // Do not mark merged via PR; let Signal 2 (local git ancestry) verify if those
                // extra commits were integrated into base.
                isMerged = false;
                prStatusKnown = false;
              } else {
                prStatusKnown = true;
                isMerged = true;
              }
            } else {
              prStatusKnown = true;
              isMerged = false;
            }
          } else if (thread.lastKnownPr.state === "merged") {
            prStatusKnown = true;
            isMerged = true;
          }
        } else if (thread.lastKnownPr.state === "merged") {
          prStatusKnown = true;
          isMerged = true;
        }
      }

      // Signal 2: Local git ancestry fallback.
      // Crucial safeguard: ONLY run local ancestry fallback when no PR exists or the
      // GitHub lookup failed, or when post-merge commits made the PR check inconclusive.
      // When GitHub confirms a PR is closed or open, that authoritative remote
      // status must NOT be overridden by local branch ancestry.
      if (!isMerged && !prStatusKnown) {
        if (headSha) {
          const baseCandidates: string[] = [];
          if (thread.lastKnownPr?.baseBranch) {
            baseCandidates.push(
              thread.lastKnownPr.baseBranch,
              `origin/${thread.lastKnownPr.baseBranch}`,
              `upstream/${thread.lastKnownPr.baseBranch}`,
            );
          }
          baseCandidates.push(
            "origin/main",
            "upstream/main",
            "main",
            "origin/master",
            "upstream/master",
            "master",
          );

          for (const baseRef of baseCandidates) {
            const mergeBaseResult = yield* input.git
              .execute({
                operation: "ManagedWorktrees.mergeBaseIsAncestor",
                cwd: entry.workspaceRoot,
                args: ["merge-base", "--is-ancestor", headSha, baseRef],
                timeoutMs: 3_000,
                allowNonZeroExit: true,
              })
              .pipe(Effect.catch(() => Effect.succeed(null)));

            if (mergeBaseResult && mergeBaseResult.code === 0) {
              isMerged = true;
              mergeSource = "ancestry";
              successfulBaseRef = baseRef;
              break;
            }
          }
        }
      }

      return {
        isMerged,
        detectedHeadSha: headSha,
        mergeSource,
        ...(successfulBaseRef ? { successfulBaseRef } : {}),
        ...(prHeadSha ? { prHeadSha } : {}),
      };
    });

  return Effect.gen(function* () {
    const mergedResults = yield* Effect.forEach(
      input.inventory,
      (entry) =>
        Effect.gen(function* () {
          const linked = threadsByCanonicalPath.get(entry.path) ?? [];
          if (linked.length === 0 || linked.some(isActiveManagedWorktreeThread)) return null;
          if (linked.every(isDeletedManagedWorktreeThread)) return null;

          const archivedOnly = linked.filter(isArchivedOnlyManagedWorktreeThread);
          if (archivedOnly.length === 0) return null;

          let allArchivedMerged = true;
          let detectedHeadSha: string | null = null;
          let mergeSource: "pr" | "ancestry" = "pr";
          const successfulBaseRefs: string[] = [];
          let prHeadSha: string | null = null;

          for (const thread of archivedOnly) {
            const check = yield* checkThreadMerged(entry, thread);
            if (!check.isMerged) {
              allArchivedMerged = false;
              break;
            }
            if (check.detectedHeadSha) {
              detectedHeadSha = check.detectedHeadSha;
            }
            if (check.mergeSource === "ancestry") {
              mergeSource = "ancestry";
            }
            if (check.successfulBaseRef && !successfulBaseRefs.includes(check.successfulBaseRef)) {
              successfulBaseRefs.push(check.successfulBaseRef);
            }
            if (check.prHeadSha) {
              prHeadSha = check.prHeadSha;
            }
          }

          if (!allArchivedMerged) return null;
          return {
            path: entry.path,
            detectedHeadSha,
            mergeSource,
            ...(successfulBaseRefs.length > 0 ? { successfulBaseRefs } : {}),
            ...(prHeadSha ? { prHeadSha } : {}),
          };
        }),
      { concurrency: 4 },
    );

    const mergedSet = new MergedWorktreeSet();
    for (const item of mergedResults) {
      if (item) {
        mergedSet.addInfo(item);
      }
    }
    return mergedSet;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("managed worktree merge detection failed", {
        cause: String(cause),
      }).pipe(Effect.as(new MergedWorktreeSet())),
    ),
  );
}

/**
 * Classify inventory entries into immediate reclaim vs retained archived keepers.
 * Active owners are never reclaim candidates. Deleted paths bypass the archived
 * retention window; only non-deleted archived worktrees honor it. Unowned inventory
 * is deliberately preserved: a newly-created worktree exists briefly before its
 * thread association is projected, and standalone worktrees are valid user data.
 */
export function classifyManagedWorktreeRemovalCandidates(input: {
  readonly inventory: ReadonlyArray<ServerManagedWorktree>;
  readonly threads: ReadonlyArray<ManagedWorktreeThreadRef>;
  readonly canonicalByRecordedPath: ReadonlyMap<string, string>;
  readonly mergedWorktreePaths?: ReadonlySet<string> | undefined;
}): ReadonlyArray<ManagedWorktreeRemovalCandidate> {
  const canonicalThreadPath = (thread: ManagedWorktreeThreadRef): string | null => {
    const recordedPath = threadManagedWorktreePath(thread);
    return recordedPath === null ? null : (input.canonicalByRecordedPath.get(recordedPath) ?? null);
  };
  const inventoryByPath = new Map(input.inventory.map((entry) => [entry.path, entry]));

  const activePaths = new Set<string>();
  for (const thread of input.threads) {
    if (!isActiveManagedWorktreeThread(thread)) continue;
    const worktreePath = canonicalThreadPath(thread);
    if (worktreePath !== null) activePaths.add(worktreePath);
  }

  const deletedCandidates: ManagedWorktreeRemovalCandidate[] = [];
  const seenDeletedPaths = new Set<string>();
  for (const thread of input.threads) {
    if (!isDeletedManagedWorktreeThread(thread)) continue;
    const worktreePath = canonicalThreadPath(thread);
    if (
      worktreePath === null ||
      activePaths.has(worktreePath) ||
      seenDeletedPaths.has(worktreePath)
    ) {
      continue;
    }
    const entry = inventoryByPath.get(worktreePath);
    if (!entry) continue;
    seenDeletedPaths.add(worktreePath);
    deletedCandidates.push({ entry, thread, reason: "deleted" });
  }

  const mergedCandidates: ManagedWorktreeRemovalCandidate[] = [];
  const seenMergedPaths = new Set<string>();
  if (input.mergedWorktreePaths && input.mergedWorktreePaths.size > 0) {
    for (const thread of input.threads) {
      if (!isArchivedOnlyManagedWorktreeThread(thread)) continue;
      const worktreePath = canonicalThreadPath(thread);
      if (
        worktreePath === null ||
        activePaths.has(worktreePath) ||
        seenDeletedPaths.has(worktreePath) ||
        seenMergedPaths.has(worktreePath) ||
        !input.mergedWorktreePaths.has(worktreePath)
      ) {
        continue;
      }
      const entry = inventoryByPath.get(worktreePath);
      if (!entry) continue;
      seenMergedPaths.add(worktreePath);
      const mergedInfo =
        input.mergedWorktreePaths instanceof MergedWorktreeSet
          ? input.mergedWorktreePaths.getInfo(worktreePath)
          : undefined;
      mergedCandidates.push({
        entry,
        thread,
        reason: "merged",
        detectedHeadSha: mergedInfo?.detectedHeadSha,
        mergeSource: mergedInfo?.mergeSource ?? "pr",
        ...(mergedInfo?.successfulBaseRefs
          ? { successfulBaseRefs: mergedInfo.successfulBaseRefs }
          : {}),
        ...(mergedInfo?.prHeadSha ? { prHeadSha: mergedInfo.prHeadSha } : {}),
      });
    }
  }

  const seenArchivedPaths = new Set<string>();
  const archivedKeepers = input.threads
    .filter(isArchivedOnlyManagedWorktreeThread)
    .map((thread) => {
      const worktreePath = canonicalThreadPath(thread);
      return worktreePath
        ? { thread, entry: inventoryByPath.get(worktreePath) ?? null }
        : { thread, entry: null };
    })
    .filter(
      (value): value is { thread: ManagedWorktreeThreadRef; entry: ServerManagedWorktree } =>
        value.entry !== null &&
        !activePaths.has(value.entry.path) &&
        !seenDeletedPaths.has(value.entry.path) &&
        !seenMergedPaths.has(value.entry.path),
    )
    .sort((left, right) =>
      (right.thread.archivedAt ?? "").localeCompare(left.thread.archivedAt ?? ""),
    )
    .filter(({ entry }) => {
      if (seenArchivedPaths.has(entry.path)) return false;
      seenArchivedPaths.add(entry.path);
      return true;
    });

  const archivedRetentionCandidates = archivedKeepers.slice(MANAGED_WORKTREE_RETENTION_COUNT).map(
    ({ thread, entry }): ManagedWorktreeRemovalCandidate => ({
      entry,
      thread,
      reason: "archived-retention",
    }),
  );

  return [...deletedCandidates, ...mergedCandidates, ...archivedRetentionCandidates];
}

const ensureSnapshotsDir = (snapshotsDir: string) =>
  Effect.tryPromise({
    try: () => fs.mkdir(snapshotsDir, { recursive: true, mode: 0o700 }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const snapshotExists = (snapshotPath: string) =>
  Effect.tryPromise({
    try: () =>
      fs
        .stat(path.join(snapshotPath, "snapshot.json"))
        .then((entry) => entry.isFile())
        .catch((cause: unknown) => {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw cause;
        }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

function removeManagedWorktreeSafely(input: {
  readonly snapshotsDir: string;
  readonly candidate: ManagedWorktreeRemovalCandidate;
  readonly git: GitCoreShape;
}): Effect.Effect<boolean, Error> {
  const { entry, thread, reason } = input.candidate;
  const snapshotPath = snapshotOutputPath({
    snapshotsDir: input.snapshotsDir,
    threadId: thread.id,
    worktreePath: entry.path,
  });

  return input.git
    .withMutation(
      entry.workspaceRoot,
      Effect.gen(function* () {
        const alreadySnapshotted = yield* snapshotExists(snapshotPath);
        if (!alreadySnapshotted) {
          yield* input.git.snapshotWorktree({ cwd: entry.path, outputPath: snapshotPath });
        }

        const status = yield* input.git.statusDetails(entry.path).pipe(
          Effect.catch((error) =>
            Effect.logWarning("managed worktree cleanup could not read dirty state", {
              threadId: thread.id,
              worktreePath: entry.path,
              reason,
              error: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as(null)),
          ),
        );
        if (status?.hasWorkingTreeChanges) {
          yield* Effect.logWarning(
            "managed worktree cleanup skipped dirty worktree; refusing silent data loss",
            {
              threadId: thread.id,
              worktreePath: entry.path,
              reason,
              branch: status.branch,
            },
          );
          return false;
        }

        if (reason === "merged") {
          const headResult = yield* input.git
            .execute({
              operation: "ManagedWorktrees.revalidateHead",
              cwd: entry.path,
              args: ["rev-parse", "HEAD"],
              timeoutMs: 3_000,
              allowNonZeroExit: true,
            })
            .pipe(Effect.catch(() => Effect.succeed(null)));

          const currentHeadSha =
            headResult && headResult.code === 0 ? headResult.stdout.trim() : null;

          if (!currentHeadSha) {
            yield* Effect.logWarning(
              "managed worktree cleanup could not read current HEAD; skipping merge reclaim",
              {
                threadId: thread.id,
                worktreePath: entry.path,
                reason,
              },
            );
            return false;
          }

          if (
            input.candidate.detectedHeadSha &&
            currentHeadSha !== input.candidate.detectedHeadSha
          ) {
            yield* Effect.logWarning(
              "managed worktree cleanup skipped merged worktree with unmerged commits; refusing data loss",
              {
                threadId: thread.id,
                worktreePath: entry.path,
                reason,
                headSha: currentHeadSha,
                expectedHeadSha: input.candidate.detectedHeadSha,
              },
            );
            return false;
          }

          if (
            input.candidate.mergeSource === "ancestry" ||
            (input.candidate.prHeadSha && currentHeadSha !== input.candidate.prHeadSha)
          ) {
            const baseCandidates: string[] = [];
            if (input.candidate.successfulBaseRefs) {
              baseCandidates.push(...input.candidate.successfulBaseRefs);
            }
            if (thread.lastKnownPr?.baseBranch) {
              baseCandidates.push(
                thread.lastKnownPr.baseBranch,
                `origin/${thread.lastKnownPr.baseBranch}`,
                `upstream/${thread.lastKnownPr.baseBranch}`,
              );
            }
            baseCandidates.push(
              "origin/main",
              "upstream/main",
              "main",
              "origin/master",
              "upstream/master",
              "master",
            );

            let headIsContained = false;
            for (const baseRef of baseCandidates) {
              const isAncestorResult = yield* input.git
                .execute({
                  operation: "ManagedWorktrees.revalidateHeadIsAncestor",
                  cwd: entry.workspaceRoot,
                  args: ["merge-base", "--is-ancestor", currentHeadSha, baseRef],
                  timeoutMs: 3_000,
                  allowNonZeroExit: true,
                })
                .pipe(Effect.catch(() => Effect.succeed(null)));

              if (isAncestorResult && isAncestorResult.code === 0) {
                headIsContained = true;
                break;
              }
            }

            if (!headIsContained) {
              yield* Effect.logWarning(
                "managed worktree cleanup skipped ancestry-merged worktree whose HEAD is not contained in base; refusing data loss",
                {
                  threadId: thread.id,
                  worktreePath: entry.path,
                  reason,
                  headSha: currentHeadSha,
                },
              );
              return false;
            }
          }
        }

        yield* input.git.removeWorktree({
          cwd: entry.workspaceRoot,
          path: entry.path,
          force: false,
          reclaimTemporaryBranch: true,
        });
        return true;
      }),
    )
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("managed worktree retention skipped an unsafe cleanup", {
          threadId: thread.id,
          worktreePath: entry.path,
          reason,
          error: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.as(false)),
      ),
    );
}

/** Keep active worktrees and the 15 most recently archived managed worktrees (or all merged worktrees when pruneAfterMerge is enabled). */
export function pruneArchivedManagedWorktrees(input: {
  readonly worktreesDir: string;
  readonly snapshotsDir: string;
  readonly threads: ReadonlyArray<ManagedWorktreeThreadRef>;
  readonly git: GitCoreShape;
  readonly pruneAfterMerge?: boolean | undefined;
  readonly gitHubCli?: GitHubCliShape | undefined;
}): Effect.Effect<ReadonlyArray<ServerManagedWorktree>, Error> {
  return Effect.gen(function* () {
    const inventory = yield* listManagedWorktrees(input);
    const canonicalByRecordedPath = yield* canonicalizeThreadWorktreePaths(input.threads);
    const mergedWorktreePaths = input.pruneAfterMerge
      ? yield* detectMergedManagedWorktreePaths({
          inventory,
          threads: input.threads,
          canonicalByRecordedPath,
          git: input.git,
          gitHubCli: input.gitHubCli,
        })
      : undefined;
    const removalCandidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      threads: input.threads,
      canonicalByRecordedPath,
      mergedWorktreePaths,
    });
    if (removalCandidates.length === 0) return inventory;

    yield* ensureSnapshotsDir(input.snapshotsDir);
    const removedPaths = new Set<string>();
    yield* Effect.forEach(
      removalCandidates,
      (candidate) =>
        removeManagedWorktreeSafely({
          snapshotsDir: input.snapshotsDir,
          candidate,
          git: input.git,
        }).pipe(
          Effect.tap((removed) =>
            removed ? Effect.sync(() => removedPaths.add(candidate.entry.path)) : Effect.void,
          ),
        ),
      { discard: true, concurrency: 1 },
    );
    return inventory.filter((entry) => !removedPaths.has(entry.path));
  });
}

export function pruneProjectedArchivedManagedWorktrees(input: {
  readonly homeDir: string;
  readonly worktreesDir: string;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly git: GitCoreShape;
  readonly pruneAfterMerge?: boolean | undefined;
  readonly gitHubCli?: GitHubCliShape | undefined;
}): Effect.Effect<ReadonlyArray<ServerManagedWorktree>, Error> {
  return Effect.gen(function* () {
    // Deliberately not the shell snapshot: it hides soft-deleted threads, and a
    // retention-deleted thread still owns a worktree that must be reclaimed.
    const threads = yield* input.snapshotQuery.listManagedWorktreeThreads();
    return yield* pruneArchivedManagedWorktrees({
      worktreesDir: input.worktreesDir,
      snapshotsDir: path.join(input.homeDir, "worktree-snapshots"),
      threads,
      git: input.git,
      pruneAfterMerge: input.pruneAfterMerge,
      gitHubCli: input.gitHubCli,
    });
  });
}
