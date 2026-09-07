import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { OrchestrationThread, OrchestrationThreadPullRequest } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { GitHubCliShape } from "./git/Services/GitHubCli.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  classifyManagedWorktreeRemovalCandidates,
  detectMergedManagedWorktreePaths,
  listManagedWorktrees,
  MANAGED_WORKTREE_RETENTION_COUNT,
  pruneArchivedManagedWorktrees,
  pruneProjectedArchivedManagedWorktrees,
} from "./managedWorktrees.ts";

const temporaryRoots: string[] = [];

async function makeManagedRoot(count: number) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-"));
  temporaryRoots.push(root);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const worktreePath = path.join(root, `task-${index}`, "synara");
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(path.join(worktreePath, ".git"), "gitdir: /tmp/repo/.git/worktrees/test\n");
    paths.push(await fs.realpath(worktreePath));
  }
  return { root, paths };
}

function cleanStatusDetails() {
  return Effect.succeed({
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: false,
    upstreamRef: null,
    branch: "synara/test",
    hasWorkingTreeChanges: false,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
  });
}

function dirtyStatusDetails() {
  return Effect.succeed({
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: false,
    upstreamRef: null,
    branch: "synara/test",
    hasWorkingTreeChanges: true,
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
  });
}

function makeGit(input: {
  readonly removals: string[];
  readonly snapshots?: string[];
  readonly dirtyPaths?: ReadonlySet<string>;
  readonly headShaByCwd?: Record<string, string>;
  readonly isAncestor?: (headSha: string, baseRef: string) => boolean;
}) {
  return {
    execute: ({ cwd, args }: { cwd: string; args?: readonly string[] }) => {
      if (args && args[0] === "rev-parse" && args[1] === "HEAD") {
        const sha = input.headShaByCwd?.[cwd] ?? "1111111111111111111111111111111111111111";
        return Effect.succeed({ code: 0, stdout: `${sha}\n`, stderr: "" });
      }
      if (args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
        const headSha = args[2]!;
        const baseRef = args[3]!;
        const ancestor = input.isAncestor ? input.isAncestor(headSha, baseRef) : true;
        return Effect.succeed({ code: ancestor ? 0 : 1, stdout: "", stderr: "" });
      }
      return Effect.succeed({
        code: 0,
        stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
        stderr: "",
      });
    },
    withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    snapshotWorktree: ({ outputPath }: { outputPath: string }) =>
      Effect.sync(() => {
        input.snapshots?.push(outputPath);
      }),
    statusDetails: (cwd: string) =>
      input.dirtyPaths?.has(cwd) ? dirtyStatusDetails() : cleanStatusDetails(),
    removeWorktree: ({ path: worktreePath }: { path: string }) =>
      Effect.sync(() => input.removals.push(worktreePath)),
  } as unknown as GitCoreShape;
}

function makeGitHubCli(
  prMap?: Record<
    string,
    { state: "open" | "closed" | "merged"; headRefOid?: string | null | undefined } | null | Error
  >,
) {
  return {
    getPullRequest: ({ reference }: { cwd: string; reference: string }) => {
      const entry = prMap?.[reference];
      if (entry instanceof Error) {
        return Effect.fail(entry);
      }
      if (entry === null || entry === undefined) {
        return Effect.succeed(null);
      }
      return Effect.succeed({
        number: 100,
        title: "Test PR",
        url: reference.startsWith("http")
          ? reference
          : `https://github.com/org/repo/pull/${reference}`,
        baseRefName: "main",
        headRefName: "feature",
        state: entry.state,
        headRefOid: entry.headRefOid ?? "1111111111111111111111111111111111111111",
      });
    },
  } as unknown as GitHubCliShape;
}

function makeThreadPr(input: {
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly url?: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly title?: string;
}): OrchestrationThreadPullRequest {
  return {
    number: input.number as never,
    title: (input.title ?? `PR #${input.number}`) as never,
    url: input.url ?? `https://github.com/org/repo/pull/${input.number}`,
    baseBranch: (input.baseBranch ?? "main") as never,
    headBranch: (input.headBranch ?? `feat/branch-${input.number}`) as never,
    state: input.state,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("managed worktrees", () => {
  it("discovers linked worktrees and reports their primary checkout", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const git = {
      execute: ({ cwd }: { cwd: string }) =>
        Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        }),
    } as unknown as GitCoreShape;

    await expect(
      Effect.runPromise(listManagedWorktrees({ worktreesDir: root, git })),
    ).resolves.toEqual(
      paths.map((worktreePath) => ({ path: worktreePath, workspaceRoot: "/repo/project" })),
    );
  });

  it("snapshots and removes only archived worktrees beyond the retention limit", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const snapshots: string[] = [];
    const removals: string[] = [];
    const git = makeGit({ removals, snapshots });
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath,
          associatedWorktreePath: worktreePath,
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );
    const snapshotsDir = path.join(root, "snapshots");

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir,
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain(path.join(root, "snapshots", "thread-0-"));
    expect(remaining).toHaveLength(MANAGED_WORKTREE_RETENTION_COUNT);
  });

  it("matches threads whose recorded paths reach the worktree through a symlink", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const canonicalRoot = await fs.realpath(root);
    const linkRoot = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-link-"));
    temporaryRoots.push(linkRoot);
    const symlinkedRoot = path.join(linkRoot, "worktrees");
    await fs.symlink(canonicalRoot, symlinkedRoot);
    const removals: string[] = [];
    const git = makeGit({ removals });
    // Threads recorded their worktrees through the symlinked directory, while
    // the inventory scan reports realpath-canonical entries.
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath: path.join(symlinkedRoot, path.relative(canonicalRoot, worktreePath)),
          associatedWorktreePath: path.join(
            symlinkedRoot,
            path.relative(canonicalRoot, worktreePath),
          ),
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
  });

  it("still prunes worktrees owned by retention-deleted threads", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const removals: string[] = [];
    const git = makeGit({ removals });

    // The oldest archived thread was soft-deleted by retention. `getShellSnapshot`
    // would hide it and silently strand its worktree on disk forever, so the prune
    // path must read a projection query that keeps soft-deleted threads visible.
    const snapshotQuery = {
      listManagedWorktreeThreads: () =>
        Effect.succeed(
          paths.map((worktreePath, index) => ({
            id: `thread-${index}`,
            archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            deletedAt: index === 0 ? new Date(Date.UTC(2026, 0, index + 2)).toISOString() : null,
            worktreePath,
            associatedWorktreePath: worktreePath,
          })),
        ),
      getSnapshot: () => Effect.die(new Error("getSnapshot must not be used by worktree prune")),
    } as unknown as ProjectionSnapshotQueryShape;

    await Effect.runPromise(
      pruneProjectedArchivedManagedWorktrees({
        homeDir: root,
        worktreesDir: root,
        snapshotQuery,
        git,
      }),
    );

    // Deleted owners reclaim immediately (bypass archived retention). The
    // remaining archived set fits inside the keep window, so only the deleted
    // owner is removed here.
    expect(removals).toEqual([paths[0]]);
  });

  it("prunes projected archived merged worktrees when pruneAfterMerge is enabled", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": { state: "merged" },
      "https://github.com/org/repo/pull/2": { state: "open" },
    });

    const snapshotQuery = {
      listManagedWorktreeThreads: () =>
        Effect.succeed([
          {
            id: "thread-merged",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            worktreePath: paths[0],
            associatedWorktreePath: paths[0],
            lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
          },
          {
            id: "thread-open",
            archivedAt: "2026-01-02T00:00:00.000Z",
            deletedAt: null,
            worktreePath: paths[1],
            associatedWorktreePath: paths[1],
            lastKnownPr: makeThreadPr({ number: 2, state: "open" }),
          },
        ]),
    } as unknown as ProjectionSnapshotQueryShape;

    const remaining = await Effect.runPromise(
      pruneProjectedArchivedManagedWorktrees({
        homeDir: root,
        worktreesDir: root,
        snapshotQuery,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    expect(removals).toEqual([paths[0]]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(paths[1]);
  });

  it("removes a clean soft-deleted worktree even when it was never archived", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = [
      {
        id: "thread-active",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: "thread-deleted",
        worktreePath: paths[1],
        associatedWorktreePath: paths[1],
        archivedAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    ] as unknown as OrchestrationThread[];

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[1]]);
  });

  it("refuses to force-remove a dirty deleted worktree", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const removals: string[] = [];
    const snapshots: string[] = [];
    const git = makeGit({
      removals,
      snapshots,
      dirtyPaths: new Set([paths[0]!]),
    });
    const threads = [
      {
        id: "thread-dirty-deleted",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(remaining).toEqual([{ path: paths[0], workspaceRoot: "/repo/project" }]);
  });

  it("preserves managed worktrees with no projected thread owner", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = [
      {
        id: "thread-active",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: null,
      },
    ] as unknown as OrchestrationThread[];

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
  });

  it("never removes active worktrees", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath,
          associatedWorktreePath: worktreePath,
          archivedAt: null,
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  it("classifies deleted candidates without touching active or unowned worktrees", () => {
    const inventory = [
      { path: "/wt/active", workspaceRoot: "/repo" },
      { path: "/wt/deleted", workspaceRoot: "/repo" },
      { path: "/wt/archived-old", workspaceRoot: "/repo" },
      { path: "/wt/archived-new", workspaceRoot: "/repo" },
      { path: "/wt/orphan", workspaceRoot: "/repo" },
    ];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    // Force retention window to treat only the newest archived as kept by
    // providing MANAGED_WORKTREE_RETENTION_COUNT archived paths via the real
    // classifier against a synthetic set is awkward; assert the core buckets
    // with a small inventory instead.
    const candidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      canonicalByRecordedPath,
      threads: [
        {
          id: "active",
          worktreePath: "/wt/active",
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "deleted",
          worktreePath: "/wt/deleted",
          archivedAt: null,
          deletedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "archived-old",
          worktreePath: "/wt/archived-old",
          archivedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
        {
          id: "archived-new",
          worktreePath: "/wt/archived-new",
          archivedAt: "2026-02-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    });

    expect(candidates.map((candidate) => [candidate.entry.path, candidate.reason])).toEqual([
      ["/wt/deleted", "deleted"],
    ]);
  });

  it("classifies merged candidates for archived threads bypassing retention limit", () => {
    const inventory = [
      { path: "/wt/active", workspaceRoot: "/repo" },
      { path: "/wt/deleted", workspaceRoot: "/repo" },
      { path: "/wt/merged", workspaceRoot: "/repo" },
      { path: "/wt/archived-old", workspaceRoot: "/repo" },
      { path: "/wt/archived-new", workspaceRoot: "/repo" },
    ];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const mergedWorktreePaths = new Set(["/wt/merged", "/wt/active"]);

    const candidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      canonicalByRecordedPath,
      mergedWorktreePaths,
      threads: [
        {
          id: "active",
          worktreePath: "/wt/active",
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "deleted",
          worktreePath: "/wt/deleted",
          archivedAt: null,
          deletedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "merged",
          worktreePath: "/wt/merged",
          archivedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
        {
          id: "archived-old",
          worktreePath: "/wt/archived-old",
          archivedAt: "2026-01-02T00:00:00.000Z",
          deletedAt: null,
        },
        {
          id: "archived-new",
          worktreePath: "/wt/archived-new",
          archivedAt: "2026-02-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    });

    expect(candidates.map((candidate) => [candidate.entry.path, candidate.reason])).toEqual([
      ["/wt/deleted", "deleted"],
      ["/wt/merged", "merged"],
    ]);
  });

  it("deduplicates multiple archived threads referencing the same merged worktree", () => {
    const inventory = [{ path: "/wt/merged", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const mergedWorktreePaths = new Set(["/wt/merged"]);

    const candidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      canonicalByRecordedPath,
      mergedWorktreePaths,
      threads: [
        {
          id: "archived-1",
          worktreePath: "/wt/merged",
          archivedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
        {
          id: "archived-2",
          worktreePath: "/wt/merged",
          archivedAt: "2026-01-02T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    });

    expect(candidates.map((candidate) => [candidate.entry.path, candidate.reason])).toEqual([
      ["/wt/merged", "merged"],
    ]);
  });

  it("detects merged worktrees via GitHub CLI pull request summary", async () => {
    const inventory = [{ path: "/wt/pr-merged", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const git = makeGit({ removals: [] });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/42": { state: "merged" },
    });

    const merged = await Effect.runPromise(
      detectMergedManagedWorktreePaths({
        inventory,
        canonicalByRecordedPath,
        git,
        gitHubCli,
        threads: [
          {
            id: "thread-pr",
            worktreePath: "/wt/pr-merged",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            lastKnownPr: makeThreadPr({ number: 42, state: "open" }),
          },
        ],
      }),
    );

    expect(Array.from(merged.keys())).toEqual(["/wt/pr-merged"]);
  });

  it("does not mark merged if GitHub CLI PR is closed even if local ancestry reports ancestor", async () => {
    const inventory = [{ path: "/wt/pr-closed-ancestor", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const git = makeGit({ removals: [], isAncestor: () => true });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/42": { state: "closed" },
    });

    const merged = await Effect.runPromise(
      detectMergedManagedWorktreePaths({
        inventory,
        canonicalByRecordedPath,
        git,
        gitHubCli,
        threads: [
          {
            id: "thread-closed-ancestor",
            worktreePath: "/wt/pr-closed-ancestor",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            lastKnownPr: makeThreadPr({ number: 42, state: "closed" }),
          },
        ],
      }),
    );

    expect(Array.from(merged.keys())).toEqual([]);
  });

  it("falls back to projection lastKnownPr.state when GitHub CLI fails", async () => {
    const inventory = [{ path: "/wt/offline-merged", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const git = makeGit({ removals: [], isAncestor: () => false });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/99": new Error("network down"),
    });

    const merged = await Effect.runPromise(
      detectMergedManagedWorktreePaths({
        inventory,
        canonicalByRecordedPath,
        git,
        gitHubCli,
        threads: [
          {
            id: "thread-offline",
            worktreePath: "/wt/offline-merged",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            lastKnownPr: makeThreadPr({ number: 99, state: "merged" }),
          },
        ],
      }),
    );

    expect(Array.from(merged.keys())).toEqual(["/wt/offline-merged"]);
  });

  it("falls back to local ancestry when GitHub CLI fails and cached PR state was open", async () => {
    const inventory = [{ path: "/wt/offline-open-merged", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const git = makeGit({
      removals: [],
      headShaByCwd: { "/wt/offline-open-merged": "4444444444444444444444444444444444444444" },
      isAncestor: (sha, base) =>
        sha === "4444444444444444444444444444444444444444" && base === "origin/main",
    });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/101": new Error("network down"),
    });

    const merged = await Effect.runPromise(
      detectMergedManagedWorktreePaths({
        inventory,
        canonicalByRecordedPath,
        git,
        gitHubCli,
        threads: [
          {
            id: "thread-offline-open",
            worktreePath: "/wt/offline-open-merged",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            lastKnownPr: makeThreadPr({ number: 101, state: "open" }),
          },
        ],
      }),
    );

    expect(Array.from(merged.keys())).toEqual(["/wt/offline-open-merged"]);
  });

  it("falls back to local git merge-base when commit is merged to main without PR", async () => {
    const inventory = [{ path: "/wt/local-merged", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const git = makeGit({
      removals: [],
      headShaByCwd: { "/wt/local-merged": "2222222222222222222222222222222222222222" },
      isAncestor: (sha, base) =>
        sha === "2222222222222222222222222222222222222222" && base === "origin/main",
    });

    const merged = await Effect.runPromise(
      detectMergedManagedWorktreePaths({
        inventory,
        canonicalByRecordedPath,
        git,
        threads: [
          {
            id: "thread-no-pr",
            worktreePath: "/wt/local-merged",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        ],
      }),
    );

    expect(Array.from(merged.keys())).toEqual(["/wt/local-merged"]);
  });

  it("protects shared worktree if an archived sibling thread is unmerged", async () => {
    const inventory = [{ path: "/wt/shared", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const git = makeGit({ removals: [], isAncestor: () => false });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": { state: "merged" },
      "https://github.com/org/repo/pull/2": { state: "open" },
    });

    const merged = await Effect.runPromise(
      detectMergedManagedWorktreePaths({
        inventory,
        canonicalByRecordedPath,
        git,
        gitHubCli,
        threads: [
          {
            id: "thread-merged",
            worktreePath: "/wt/shared",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
          },
          {
            id: "thread-unmerged",
            worktreePath: "/wt/shared",
            archivedAt: "2026-01-02T00:00:00.000Z",
            deletedAt: null,
            lastKnownPr: makeThreadPr({ number: 2, state: "open" }),
          },
        ],
      }),
    );

    expect(Array.from(merged.keys())).toEqual([]);
  });

  it("protects shared worktree when any active thread points to it", async () => {
    const inventory = [{ path: "/wt/shared-active", workspaceRoot: "/repo" }];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    const git = makeGit({ removals: [] });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": { state: "merged" },
    });

    const merged = await Effect.runPromise(
      detectMergedManagedWorktreePaths({
        inventory,
        canonicalByRecordedPath,
        git,
        gitHubCli,
        threads: [
          {
            id: "thread-active",
            worktreePath: "/wt/shared-active",
            archivedAt: null,
            deletedAt: null,
          },
          {
            id: "thread-archived-merged",
            worktreePath: "/wt/shared-active",
            archivedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
          },
        ],
      }),
    );

    expect(Array.from(merged.keys())).toEqual([]);
  });

  it("prunes merged worktrees immediately when pruneAfterMerge is enabled, even within retention limit", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": { state: "merged" },
      "https://github.com/org/repo/pull/2": { state: "open" },
    });

    const threads = [
      {
        id: "thread-0",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
      },
      {
        id: "thread-1",
        worktreePath: paths[1],
        associatedWorktreePath: paths[1],
        archivedAt: "2026-01-02T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 2, state: "open" }),
      },
    ] as unknown as OrchestrationThread[];

    // With pruneAfterMerge: true -> thread-0 is pruned immediately despite being within 15 limit
    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    expect(removals).toEqual([paths[0]]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(paths[1]);

    // With pruneAfterMerge: false -> retains both within 15 limit
    const removalsDisabled: string[] = [];
    const gitDisabled = makeGit({ removals: removalsDisabled });
    const remainingDisabled = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git: gitDisabled,
        pruneAfterMerge: false,
        gitHubCli,
      }),
    );

    expect(removalsDisabled).toEqual([]);
    expect(remainingDisabled).toHaveLength(2);
  });

  it("skips removal and snapshots a dirty merged worktree when pruneAfterMerge is enabled", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const removals: string[] = [];
    const snapshots: string[] = [];
    const git = makeGit({
      removals,
      snapshots,
      dirtyPaths: new Set([paths[0]!]),
    });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": { state: "merged" },
    });

    const threads = [
      {
        id: "thread-dirty-merged",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    expect(removals).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(remaining).toHaveLength(1);
  });

  it("prunes a squash-merged PR worktree even when git ancestry check returns false", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const removals: string[] = [];
    // Git ancestry returns false (simulating a squash merge where branch commits are not in main history)
    const git = makeGit({
      removals,
      headShaByCwd: { [paths[0]!]: "1111111111111111111111111111111111111111" },
      isAncestor: () => false,
    });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": { state: "merged" },
    });

    const threads = [
      {
        id: "thread-squash-merged",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    // Pruned successfully because GitHub confirmed merged and HEAD was unchanged
    expect(removals).toEqual([paths[0]]);
    expect(remaining).toHaveLength(0);
  });

  it("skips pruning an ancestry-merged worktree if its HEAD is not contained in base", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const removals: string[] = [];
    // Detection initially sees ancestor = true, but under mutation lock ancestor = false
    let removalAttempted = false;
    const git = {
      ...makeGit({ removals }),
      execute: ({ cwd, args }: { cwd: string; args?: readonly string[] }) => {
        if (args && args[0] === "rev-parse" && args[1] === "HEAD") {
          return Effect.succeed({
            code: 0,
            stdout: "1111111111111111111111111111111111111111\n",
            stderr: "",
          });
        }
        if (args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          return Effect.succeed({ code: removalAttempted ? 1 : 0, stdout: "", stderr: "" });
        }
        return Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        });
      },
      withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => {
        removalAttempted = true;
        return effect;
      },
    } as unknown as GitCoreShape;

    // No PR: detection relies entirely on ancestry fallback
    const threads = [
      {
        id: "thread-ancestry-unmerged",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
      }),
    );

    // Refused removal to prevent data loss when ancestry check fails for ancestry-merged candidate
    expect(removals).toEqual([]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(paths[0]);
  });

  it("skips pruning if a new commit is created between detection and removal", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const removals: string[] = [];
    let removalAttempted = false;
    // On detection, HEAD is '111111...'.
    // Between detection and removal, a new commit is created (HEAD changes to '333333...').
    const git = {
      ...makeGit({ removals }),
      execute: ({ cwd, args }: { cwd: string; args?: readonly string[] }) => {
        if (args && args[0] === "rev-parse" && args[1] === "HEAD") {
          const sha = removalAttempted
            ? "3333333333333333333333333333333333333333"
            : "1111111111111111111111111111111111111111";
          return Effect.succeed({ code: 0, stdout: `${sha}\n`, stderr: "" });
        }
        if (args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        }
        return Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        });
      },
      withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => {
        removalAttempted = true;
        return effect;
      },
    } as unknown as GitCoreShape;

    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": { state: "merged" },
    });

    const threads = [
      {
        id: "thread-race-commit",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    // Revalidation under mutation lock caught the new commit and refused removal
    expect(removals).toEqual([]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(paths[0]);
  });

  it("skips pruning a merged PR worktree if clean commits were added after PR merge and are not in base", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const worktreePath = paths[0]!;
    const removals: string[] = [];
    // Worktree HEAD is '222222...', but the PR was merged at '111111...'
    const git = makeGit({
      removals,
      headShaByCwd: { [worktreePath]: "2222222222222222222222222222222222222222" },
      isAncestor: () => false,
    });

    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": {
        state: "merged",
        headRefOid: "1111111111111111111111111111111111111111",
      },
    });

    const threads = [
      {
        id: "thread-post-merge-commits",
        worktreePath,
        associatedWorktreePath: worktreePath,
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    // Post-merge clean commits were not integrated into base, so removal was refused
    expect(removals).toEqual([]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(worktreePath);
  });

  it("prunes a merged PR worktree with post-merge commits if those commits are contained in base", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const worktreePath = paths[0]!;
    const removals: string[] = [];
    const git = makeGit({
      removals,
      headShaByCwd: { [worktreePath]: "2222222222222222222222222222222222222222" },
      isAncestor: (headSha, baseRef) =>
        headSha === "2222222222222222222222222222222222222222" && baseRef.includes("main"),
    });

    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": {
        state: "merged",
        headRefOid: "1111111111111111111111111111111111111111",
      },
    });

    const threads = [
      {
        id: "thread-post-merge-integrated",
        worktreePath,
        associatedWorktreePath: worktreePath,
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    expect(removals).toEqual([worktreePath]);
    expect(remaining).toHaveLength(0);
  });

  it("prunes shared worktree when only a later thread's non-main custom base contains HEAD", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const worktreePath = paths[0]!;
    const removals: string[] = [];
    const git = makeGit({
      removals,
      headShaByCwd: { [worktreePath]: "1111111111111111111111111111111111111111" },
      isAncestor: (headSha, baseRef) =>
        headSha === "1111111111111111111111111111111111111111" && baseRef.includes("release/v1.0"),
    });

    // Thread 1 had a PR that was merged on GitHub, but its base was 'main'
    // Thread 2 has a custom base 'release/v1.0' that contains the worktree's HEAD commit
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": {
        state: "merged",
        headRefOid: "1111111111111111111111111111111111111111",
      },
      "https://github.com/org/repo/pull/2": null,
    });

    const threads = [
      {
        id: "thread-first",
        worktreePath,
        associatedWorktreePath: worktreePath,
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 1, state: "merged", baseBranch: "main" }),
      },
      {
        id: "thread-second-custom-base",
        worktreePath,
        associatedWorktreePath: worktreePath,
        archivedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        lastKnownPr: makeThreadPr({ number: 2, state: "open", baseBranch: "release/v1.0" }),
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
        pruneAfterMerge: true,
        gitHubCli,
      }),
    );

    // Thread 1 selected as candidate, but successfulBaseRefs preserved 'release/v1.0'
    // so revalidation under mutation lock succeeded
    expect(removals).toEqual([worktreePath]);
    expect(remaining).toHaveLength(0);
  });

  it("skips pruning if a thread is unarchived between merge detection and removal", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const worktreePath = paths[0]!;
    const removals: string[] = [];
    const git = makeGit({
      removals,
      headShaByCwd: { [worktreePath]: "1111111111111111111111111111111111111111" },
    });
    const gitHubCli = makeGitHubCli({
      "https://github.com/org/repo/pull/1": {
        state: "merged",
        headRefOid: "1111111111111111111111111111111111111111",
      },
    });

    const initialThread = {
      id: "thread-concurrent-unarchive",
      worktreePath,
      associatedWorktreePath: worktreePath,
      archivedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      lastKnownPr: makeThreadPr({ number: 1, state: "merged" }),
    };

    const restoredThread = {
      ...initialThread,
      archivedAt: null,
    };

    const snapshotQuery = {
      listManagedWorktreeThreads: () => Effect.succeed([restoredThread]),
    } as unknown as ProjectionSnapshotQueryShape;

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads: [initialThread as unknown as OrchestrationThread],
        git,
        pruneAfterMerge: true,
        gitHubCli,
        snapshotQuery,
      }),
    );

    expect(removals).toEqual([]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe(worktreePath);
  });
});
