import {
  CheckpointRef,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type GitWorktreeSetupProgressEvent,
  type ModelSlug,
  type RuntimeMode,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ChatMessage, Thread } from "../types";
import type { WorkLogEntry } from "../session-logic";

import {
  appendVoiceTranscriptToPrompt,
  buildTranscriptAutoFollowSignal,
  buildTranscriptTailKey,
  commitAfterRuntimeModePersistence,
  createRuntimeModePersistenceQueue,
  persistModelSelectionBeforeRuntimeMode,
  createLocalDispatchSnapshot,
  createWorktreeSetupResolution,
  createWorktreeSetupSnapshot,
  derivePromptHistoryFromMessages,
  failWorktreeSetupSnapshot,
  filterSidechatTranscriptMessages,
  hasFileUndoSettled,
  isComposerCursorOnFirstLine,
  isComposerCursorOnLastLine,
  type LocalDispatchSnapshot,
  promptStillMatchesActiveHistoryBrowse,
  resolvePromptHistoryNavigation,
  resolveNextLocalDispatchSnapshot,
  resolveWorkingLabel,
  deriveComposerSendState,
  deriveComposerVoiceState,
  describeVoiceRecordingStartError,
  hasLiveTurnTakenOver,
  hasServerAcknowledgedLocalDispatch,
  isVoiceAuthExpiredMessage,
  LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS,
  resolveActiveThreadTitle,
  resolveDraftFallbackModelSelection,
  resolveActiveTurnLiveDiffState,
  resolveCommittedProviderModel,
  resolveComposerStripWorkLogEntries,
  resolveCycledModelSlug,
  resolveDefaultEnvironmentPanelOpen,
  resolveEnvironmentPanelOpen,
  resolveEnvironmentPanelPreferenceAfterFirstSend,
  resolveEnvironmentPanelPreferenceUpdate,
  resolveEnvironmentPanelVisible,
  resolveGitRepoUiState,
  resolveProjectScriptTerminalTarget,
  resolveQueuedSteerGateTransition,
  resolveRuntimeModeAfterApprovalDecision,
  resolveSettledThreadBranchMismatch,
  resolveThreadDetailHydration,
  resolveThreadArtifactWorkspaceRoot,
  runWorktreeCreationFlow,
  QUEUED_STEER_GATE_TIMEOUT_MS,
  sanitizeVoiceErrorMessage,
  buildExpiredTerminalContextToastCopy,
  shouldAutoDeleteTerminalThreadOnLastClose,
  shouldConsumePendingCustomBinaryConfirmation,
  shouldEnableComposerPastedTextCollapse,
  shouldHandlePromptHistoryNavigationKey,
  shouldRenderProviderHealthBanner,
  shouldShowComposerModelBootstrapSkeleton,
  shouldStartActiveTurnLayoutGrace,
  shouldRenderTerminalWorkspace,
  bumpLocalDraftErrorVersion,
  bumpThreadErrorWriteEpoch,
  MAX_THREAD_ERROR_WRITE_EPOCHS,
  evictOverflowFailedThreadSend,
  failedSendSnapshotOwnsCurrentError,
  MAX_FAILED_THREAD_SEND_SNAPSHOTS,
  MAX_LOCAL_DRAFT_ERROR_VERSIONS,
  releaseFailedSendAtSendCommit,
  releaseFailedSendSnapshotAfterSend,
  releaseRetriedFailedSend,
  releaseSupersededFailedSend,
  findTranscriptFallbackRetryTarget,
  hasThreadErrorRetryTarget,
  worktreeSetupHasError,
} from "./ChatView.logic";

describe("composer strip work-log derivation", () => {
  it("reuses the active derivation unless a subagent view needs its parent source", () => {
    const activeWorkLogEntries: WorkLogEntry[] = [];
    const deriveParentWorkLogEntries = vi.fn(() => []);

    expect(
      resolveComposerStripWorkLogEntries({
        hasDistinctParentSource: false,
        activeWorkLogEntries,
        deriveParentWorkLogEntries,
      }),
    ).toBe(activeWorkLogEntries);
    expect(deriveParentWorkLogEntries).not.toHaveBeenCalled();

    resolveComposerStripWorkLogEntries({
      hasDistinctParentSource: true,
      activeWorkLogEntries,
      deriveParentWorkLogEntries,
    });
    expect(deriveParentWorkLogEntries).toHaveBeenCalledOnce();
  });
});

describe("thread artifact workspace root", () => {
  it("uses a materialized worktree for file previews", () => {
    expect(
      resolveThreadArtifactWorkspaceRoot({
        isStudioContainer: false,
        projectCwd: "/repo/project",
        threadWorkspaceCwd: "/repo/worktrees/feature",
      }),
    ).toBe("/repo/worktrees/feature");
  });

  it("keeps the project fallback while a normal thread worktree is pending", () => {
    expect(
      resolveThreadArtifactWorkspaceRoot({
        isStudioContainer: false,
        projectCwd: "/repo/project",
        threadWorkspaceCwd: null,
      }),
    ).toBe("/repo/project");
  });

  it("does not escape a Studio thread's selected working directory", () => {
    expect(
      resolveThreadArtifactWorkspaceRoot({
        isStudioContainer: true,
        projectCwd: "/studio/root",
        threadWorkspaceCwd: null,
      }),
    ).toBeNull();
  });
});

describe("settled thread branch mismatch", () => {
  it("describes a settled local thread whose branch differs from the checkout", () => {
    expect(
      resolveSettledThreadBranchMismatch({
        isSettled: true,
        isLocalWorkspace: true,
        threadBranch: "feature/finished",
        currentBranch: "feature/current",
      }),
    ).toEqual({
      threadBranch: "feature/finished",
      currentBranch: "feature/current",
    });
  });

  it("does not warn when the branch is current or the workspace is not local", () => {
    expect(
      resolveSettledThreadBranchMismatch({
        isSettled: true,
        isLocalWorkspace: true,
        threadBranch: "main",
        currentBranch: "main",
      }),
    ).toBeNull();
    expect(
      resolveSettledThreadBranchMismatch({
        isSettled: true,
        isLocalWorkspace: false,
        threadBranch: "feature/finished",
        currentBranch: "feature/current",
      }),
    ).toBeNull();
    expect(
      resolveSettledThreadBranchMismatch({
        isSettled: false,
        isLocalWorkspace: true,
        threadBranch: "feature/finished",
        currentBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("transcript auto-follow signal", () => {
  it("stays stable when only non-message turn activity changes", () => {
    const before = buildTranscriptAutoFollowSignal({
      messageCount: 3,
      tailKey: "assistant-3:assistant:streaming:content:120",
    });
    const afterWorkRow = buildTranscriptAutoFollowSignal({
      messageCount: 3,
      tailKey: "assistant-3:assistant:streaming:content:120",
    });

    expect(afterWorkRow).toBe(before);
  });

  it("changes for a real transcript append or tail lifecycle change", () => {
    const streaming = buildTranscriptAutoFollowSignal({
      messageCount: 3,
      tailKey: "assistant-3:assistant:streaming:content:120",
    });

    expect(
      buildTranscriptAutoFollowSignal({
        messageCount: 4,
        tailKey: "user-4:user:settled:content:24",
      }),
    ).not.toBe(streaming);
    expect(
      buildTranscriptAutoFollowSignal({
        messageCount: 3,
        tailKey: "assistant-3:assistant:settled:content:120",
      }),
    ).not.toBe(streaming);
  });

  it("changes when the tail key reports a lifecycle transition", () => {
    const firstChunk = buildTranscriptAutoFollowSignal({
      messageCount: 3,
      tailKey: "assistant-3:assistant:streaming:content:",
    });
    const settled = buildTranscriptAutoFollowSignal({
      messageCount: 3,
      tailKey: "assistant-3:assistant:settled:content:2026-01-01T00:00:00Z",
    });

    expect(settled).not.toBe(firstChunk);
  });
});

describe("transcript tail key", () => {
  const streamingTail = {
    id: "assistant-3",
    role: "assistant",
    streaming: true,
    text: "hello",
    completedAt: null,
  };

  it("returns the empty key without a tail message", () => {
    expect(buildTranscriptTailKey(null)).toBe("empty");
  });

  it("stays stable while the same streaming message only grows", () => {
    const before = buildTranscriptTailKey(streamingTail);
    const after = buildTranscriptTailKey({ ...streamingTail, text: "hello world, more text" });

    expect(after).toBe(before);
  });

  it("changes when the first content lands on an empty streaming tail", () => {
    const empty = buildTranscriptTailKey({ ...streamingTail, text: "" });

    expect(buildTranscriptTailKey(streamingTail)).not.toBe(empty);
  });

  it("changes when the tail message settles or completes", () => {
    const streaming = buildTranscriptTailKey(streamingTail);

    expect(buildTranscriptTailKey({ ...streamingTail, streaming: false })).not.toBe(streaming);
    expect(
      buildTranscriptTailKey({ ...streamingTail, completedAt: "2026-01-01T00:00:00Z" }),
    ).not.toBe(streaming);
  });

  it("changes when a different message becomes the tail", () => {
    const streaming = buildTranscriptTailKey(streamingTail);

    expect(
      buildTranscriptTailKey({ id: "user-4", role: "user", text: "next", completedAt: null }),
    ).not.toBe(streaming);
  });

  it("changes when a settled tail is replaced with different text under the same id", () => {
    const settledTail = {
      ...streamingTail,
      streaming: false,
      completedAt: "2026-01-01T00:00:00Z",
    };
    const before = buildTranscriptTailKey(settledTail);

    // Projection repair can rewrite a settled message in place; the follow
    // effect must re-stick because maintainScrollAtEnd is off once settled.
    expect(buildTranscriptTailKey({ ...settledTail, text: "hello, repaired" })).not.toBe(before);
  });
});

describe("file undo completion", () => {
  const pending = {
    threadId: ThreadId.makeUnsafe("thread-file-undo"),
    turnCounts: [2],
    existingFailureActivityIds: [],
  };
  const summary = {
    turnId: TurnId.makeUnsafe("turn-2"),
    checkpointTurnCount: 2,
    checkpointTurnCounts: [2],
    checkpointRef: CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread-file-undo/turn/2"),
    status: "ready" as const,
    completedAt: "2026-07-12T17:59:00.000Z",
    files: [{ path: "src/file.ts", additions: 1, deletions: 0 }],
  };

  it("stays pending after command acceptance until the projected file diff settles", () => {
    const baseThread = {
      id: pending.threadId,
      turnDiffSummaries: [summary],
      activities: [],
    };

    expect(hasFileUndoSettled({ pending, thread: baseThread })).toBe(false);
    expect(
      hasFileUndoSettled({
        pending,
        thread: {
          ...baseThread,
          turnDiffSummaries: [{ ...summary, files: [] }],
        },
      }),
    ).toBe(true);
  });

  it("stays pending until every merged turn in the card has been reverted", () => {
    const olderSummary = {
      ...summary,
      turnId: TurnId.makeUnsafe("turn-1"),
      checkpointTurnCount: 1,
      checkpointTurnCounts: [1],
      files: [],
    };
    const multiTurnPending = { ...pending, turnCounts: [2, 1] };

    expect(
      hasFileUndoSettled({
        pending: multiTurnPending,
        thread: {
          id: pending.threadId,
          turnDiffSummaries: [olderSummary, summary],
          activities: [],
        },
      }),
    ).toBe(false);
    expect(
      hasFileUndoSettled({
        pending: multiTurnPending,
        thread: {
          id: pending.threadId,
          turnDiffSummaries: [olderSummary, { ...summary, files: [] }],
          activities: [],
        },
      }),
    ).toBe(true);
  });

  it("settles when the matching revert failure is projected", () => {
    expect(
      hasFileUndoSettled({
        pending,
        thread: {
          id: pending.threadId,
          turnDiffSummaries: [summary],
          activities: [
            {
              id: EventId.makeUnsafe("activity-file-undo-failed"),
              tone: "error",
              kind: "checkpoint.revert.failed",
              summary: "Checkpoint revert failed",
              payload: { turnCount: 2, detail: "reset failed" },
              turnId: null,
              createdAt: "2026-07-12T18:00:01.000Z",
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("ignores a matching failure activity that predates this undo request", () => {
    expect(
      hasFileUndoSettled({
        pending: { ...pending, existingFailureActivityIds: ["activity-file-undo-failed"] },
        thread: {
          id: pending.threadId,
          turnDiffSummaries: [summary],
          activities: [
            {
              id: EventId.makeUnsafe("activity-file-undo-failed"),
              tone: "error",
              kind: "checkpoint.revert.failed",
              summary: "Checkpoint revert failed",
              payload: { turnCount: 2, detail: "old failure" },
              turnId: null,
              createdAt: "2026-07-12T17:00:00.000Z",
            },
          ],
        },
      }),
    ).toBe(false);
  });
});

describe("prompt history navigation", () => {
  it("derives newest-first native user prompts and skips imported or internal-only entries", () => {
    const messages = [
      {
        id: MessageId.makeUnsafe("message-imported"),
        role: "user",
        text: "Imported prompt",
        source: "fork-import",
      },
      {
        id: MessageId.makeUnsafe("message-assistant"),
        role: "assistant",
        text: "Assistant response",
        source: "native",
      },
      {
        id: MessageId.makeUnsafe("message-first"),
        role: "user",
        text: "First prompt\n\n<terminal_context>\n# Terminal\noutput\n</terminal_context>",
        source: "native",
      },
      {
        id: MessageId.makeUnsafe("message-images"),
        role: "user",
        text: "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
        source: "native",
      },
      {
        id: MessageId.makeUnsafe("message-second"),
        role: "user",
        text: "Second prompt",
        source: "native",
      },
    ] as const;

    expect(derivePromptHistoryFromMessages(messages)).toEqual(["Second prompt", "First prompt"]);
  });

  it("limits prompt history without deduping repeated prompts", () => {
    const messages = [
      {
        id: MessageId.makeUnsafe("message-one"),
        role: "user",
        text: "one",
        source: "native",
      },
      {
        id: MessageId.makeUnsafe("message-repeat-one"),
        role: "user",
        text: "repeat",
        source: "native",
      },
      {
        id: MessageId.makeUnsafe("message-repeat-two"),
        role: "user",
        text: "repeat",
        source: "native",
      },
    ] as const;

    expect(derivePromptHistoryFromMessages(messages, 2)).toEqual(["repeat", "repeat"]);
  });

  it("keeps history browse state for cursor-only movement inside the recalled prompt", () => {
    expect(
      promptStillMatchesActiveHistoryBrowse({
        state: { index: 0, draft: "draft in progress" },
        history: ["recalled prompt"],
        nextPrompt: "recalled prompt",
        appliedPrompt: "recalled prompt",
      }),
    ).toBe(true);

    expect(
      promptStillMatchesActiveHistoryBrowse({
        state: { index: 3, draft: "draft in progress" },
        history: ["different prompt"],
        nextPrompt: "recalled prompt",
        appliedPrompt: "recalled prompt",
      }),
    ).toBe(true);
  });

  it("ends history browse state when the recalled prompt text is edited", () => {
    expect(
      promptStillMatchesActiveHistoryBrowse({
        state: { index: 0, draft: "draft in progress" },
        history: ["recalled prompt"],
        nextPrompt: "recalled prompt edited",
        appliedPrompt: "recalled prompt",
      }),
    ).toBe(false);
  });

  it("does not start prompt history navigation while a composer menu trigger is active", () => {
    expect(
      shouldHandlePromptHistoryNavigationKey({
        key: "ArrowUp",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        menuIsActive: true,
        hasActivePendingProgress: false,
        isComposerApprovalState: false,
        pendingUserInputCount: 0,
      }),
    ).toBe(false);

    expect(
      shouldHandlePromptHistoryNavigationKey({
        key: "ArrowUp",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        menuIsActive: false,
        hasActivePendingProgress: false,
        isComposerApprovalState: false,
        pendingUserInputCount: 0,
      }),
    ).toBe(true);
  });

  it("detects first and last line cursor positions", () => {
    const prompt = "first\nmiddle\nlast";

    expect(isComposerCursorOnFirstLine(prompt, 0)).toBe(true);
    expect(isComposerCursorOnFirstLine(prompt, 5)).toBe(true);
    expect(isComposerCursorOnFirstLine(prompt, 6)).toBe(false);

    expect(isComposerCursorOnLastLine(prompt, 13)).toBe(true);
    expect(isComposerCursorOnLastLine(prompt, prompt.length)).toBe(true);
    expect(isComposerCursorOnLastLine(prompt, 12)).toBe(false);
  });

  it("navigates older prompts from a non-empty draft and restores the draft at the end", () => {
    const history = ["third prompt", "second prompt", "first prompt"];
    const first = resolvePromptHistoryNavigation({
      direction: "older",
      history,
      currentPrompt: "draft in progress",
      currentExpandedCursor: 0,
      selectionCollapsed: true,
      state: null,
    });

    expect(first).toMatchObject({
      handled: true,
      prompt: "third prompt",
      expandedCursor: "third prompt".length,
      state: { index: 0, draft: "draft in progress" },
    });

    const second = resolvePromptHistoryNavigation({
      direction: "older",
      history,
      currentPrompt: first.prompt,
      currentExpandedCursor: first.expandedCursor,
      selectionCollapsed: true,
      state: first.state,
    });

    expect(second).toMatchObject({
      handled: true,
      prompt: "second prompt",
      expandedCursor: "second prompt".length,
      state: { index: 1, draft: "draft in progress" },
    });

    const newer = resolvePromptHistoryNavigation({
      direction: "newer",
      history,
      currentPrompt: second.prompt,
      currentExpandedCursor: second.prompt.length,
      selectionCollapsed: true,
      state: second.state,
    });

    expect(newer).toMatchObject({
      handled: true,
      prompt: "third prompt",
      state: { index: 0, draft: "draft in progress" },
    });

    const restored = resolvePromptHistoryNavigation({
      direction: "newer",
      history,
      currentPrompt: newer.prompt,
      currentExpandedCursor: newer.prompt.length,
      selectionCollapsed: true,
      state: newer.state,
    });

    expect(restored).toEqual({
      handled: true,
      prompt: "draft in progress",
      expandedCursor: "draft in progress".length,
      state: null,
    });
  });

  it("places recalled multiline prompts on the eligible line for repeated navigation", () => {
    const older = resolvePromptHistoryNavigation({
      direction: "older",
      history: ["first line\nsecond line"],
      currentPrompt: "",
      currentExpandedCursor: 0,
      selectionCollapsed: true,
      state: null,
    });

    expect(older.expandedCursor).toBe("first line".length);

    const newer = resolvePromptHistoryNavigation({
      direction: "newer",
      history: ["first line\nsecond line", "older"],
      currentPrompt: "older",
      currentExpandedCursor: "older".length,
      selectionCollapsed: true,
      state: { index: 1, draft: "" },
    });

    expect(newer.prompt).toBe("first line\nsecond line");
    expect(newer.expandedCursor).toBe("first line\nsecond line".length);
  });

  it("can navigate newer immediately after recalling a multiline prompt with ArrowUp", () => {
    const history = ["newer line one\nnewer line two", "older prompt"];
    const recalled = resolvePromptHistoryNavigation({
      direction: "older",
      history,
      currentPrompt: "",
      currentExpandedCursor: 0,
      selectionCollapsed: true,
      state: null,
    });

    expect(recalled.prompt).toBe("newer line one\nnewer line two");
    expect(recalled.expandedCursor).toBe("newer line one".length);

    const restoredDraft = resolvePromptHistoryNavigation({
      direction: "newer",
      history,
      currentPrompt: recalled.prompt,
      currentExpandedCursor: recalled.expandedCursor,
      selectionCollapsed: true,
      state: recalled.state,
    });

    expect(restoredDraft).toEqual({
      handled: true,
      prompt: "",
      expandedCursor: 0,
      state: null,
    });
  });

  it("does not navigate when cursor position or selection should belong to text editing", () => {
    expect(
      resolvePromptHistoryNavigation({
        direction: "older",
        history: ["previous"],
        currentPrompt: "first\nsecond",
        currentExpandedCursor: "first\ns".length,
        selectionCollapsed: true,
        state: null,
      }).handled,
    ).toBe(false);

    expect(
      resolvePromptHistoryNavigation({
        direction: "older",
        history: ["previous"],
        currentPrompt: "draft",
        currentExpandedCursor: 0,
        selectionCollapsed: false,
        state: null,
      }).handled,
    ).toBe(false);
  });

  it("does not navigate from lower lines even when the first line is long", () => {
    // Cursor offsets are expanded (raw string indices). A collapsed cursor —
    // where an inline chip like "@apps/web/src/components/ChatView.tsx" counts
    // as one unit — would sit below the first line's raw end and wrongly hijack
    // ArrowUp from the second line; expanded offsets must be used instead.
    const prompt = "@apps/web/src/components/ChatView.tsx fix this\nplease keep the draft";
    const secondLineCursor = prompt.indexOf("please") + "plea".length;

    expect(
      resolvePromptHistoryNavigation({
        direction: "older",
        history: ["previous"],
        currentPrompt: prompt,
        currentExpandedCursor: secondLineCursor,
        selectionCollapsed: true,
        state: null,
      }).handled,
    ).toBe(false);
  });

  it("restarts from the newest entry when older navigation loses its place", () => {
    const older = resolvePromptHistoryNavigation({
      direction: "older",
      history: ["new prompt"],
      currentPrompt: "old prompt",
      currentExpandedCursor: 0,
      selectionCollapsed: true,
      state: { index: 0, draft: "draft" },
    });

    expect(older).toEqual({
      handled: true,
      prompt: "new prompt",
      expandedCursor: "new prompt".length,
      state: { index: 0, draft: "draft" },
    });
  });

  it("restarts from the newest entry when the stored index falls outside history", () => {
    const older = resolvePromptHistoryNavigation({
      direction: "older",
      history: ["only prompt"],
      currentPrompt: "recalled from longer history",
      currentExpandedCursor: 0,
      selectionCollapsed: true,
      state: { index: 5, draft: "draft" },
    });

    expect(older).toEqual({
      handled: true,
      prompt: "only prompt",
      expandedCursor: "only prompt".length,
      state: { index: 0, draft: "draft" },
    });
  });

  it("restores the draft when newer navigation loses its place", () => {
    const newer = resolvePromptHistoryNavigation({
      direction: "newer",
      history: ["new prompt"],
      currentPrompt: "old prompt",
      currentExpandedCursor: "old prompt".length,
      selectionCollapsed: true,
      state: { index: 0, draft: "draft" },
    });

    expect(newer).toEqual({
      handled: true,
      prompt: "draft",
      expandedCursor: "draft".length,
      state: null,
    });
  });
});

describe("composer pasted text collapse", () => {
  it("is enabled only for regular chat sends", () => {
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: false,
        hasPendingUserInput: false,
        showPlanFollowUpPrompt: false,
      }),
    ).toBe(true);
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: false,
        hasPendingUserInput: true,
        showPlanFollowUpPrompt: false,
      }),
    ).toBe(false);
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: false,
        hasPendingUserInput: false,
        showPlanFollowUpPrompt: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: true,
        hasPendingUserInput: false,
        showPlanFollowUpPrompt: false,
      }),
    ).toBe(false);
  });
});

describe("voice helpers", () => {
  it("keeps manual titles visible for empty home chats", () => {
    expect(
      resolveActiveThreadTitle({
        title: "Roadmap scratchpad",
        subagentTitle: null,
        isHomeChat: true,
        isEmpty: true,
      }),
    ).toBe("Roadmap scratchpad");
  });

  it("maps untouched empty home chats to the friendly header label", () => {
    expect(
      resolveActiveThreadTitle({
        title: "New thread",
        subagentTitle: null,
        isHomeChat: true,
        isEmpty: true,
      }),
    ).toBe("New Chat");
  });

  it("prefers the resolved subagent label when present", () => {
    expect(
      resolveActiveThreadTitle({
        title: "Ignored raw title",
        subagentTitle: "Reviewer / Fix follow-up",
        isHomeChat: false,
        isEmpty: false,
      }),
    ).toBe("Reviewer / Fix follow-up");
  });

  it("hides fork-imported transcript rows only for sidechats", () => {
    const messages = [
      {
        id: "message-imported" as never,
        role: "assistant",
        text: "Previous context",
        turnId: null,
        streaming: false,
        source: "fork-import",
        createdAt: "2026-05-02T10:00:00.000Z",
        completedAt: "2026-05-02T10:00:00.000Z",
      },
      {
        id: "message-native" as never,
        role: "user",
        text: "Fresh side question",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-05-02T10:01:00.000Z",
        completedAt: "2026-05-02T10:01:00.000Z",
      },
    ] as const;

    expect(filterSidechatTranscriptMessages(messages, true).map((message) => message.id)).toEqual([
      "message-native",
    ]);
    expect(filterSidechatTranscriptMessages(messages, false).map((message) => message.id)).toEqual([
      "message-imported",
      "message-native",
    ]);
  });

  it("appends a transcript to the existing prompt without disturbing spacing", () => {
    expect(appendVoiceTranscriptToPrompt("Hello there   ", "  next line  ")).toBe(
      "Hello there\nnext line",
    );
  });

  it("returns null when the transcript is empty", () => {
    expect(appendVoiceTranscriptToPrompt("Hello", "   ")).toBeNull();
  });

  it("sanitizes inline stack traces from voice errors", () => {
    expect(
      sanitizeVoiceErrorMessage(
        "Your ChatGPT login has expired. Sign in again. at file:///Users/test/app.mjs:12:3",
      ),
    ).toBe("Your ChatGPT login has expired. Sign in again.");
  });

  it("strips desktop bridge wrappers from voice errors", () => {
    expect(
      sanitizeVoiceErrorMessage(
        "Error invoking remote method 'desktop:server-transcribe-voice': Error: The transcription response did not include any text.",
      ),
    ).toBe("The transcription response did not include any text.");
  });

  it("detects auth-expired copy in sanitized voice errors", () => {
    expect(isVoiceAuthExpiredMessage("Sign in again to ChatGPT")).toBe(true);
    expect(isVoiceAuthExpiredMessage("The microphone could not be opened.")).toBe(false);
  });

  it("maps microphone permission errors to clearer copy", () => {
    const error = new Error("Permission denied");
    error.name = "NotAllowedError";

    expect(describeVoiceRecordingStartError(error)).toContain("Microphone access was denied");
  });

  it("derives voice-note availability from provider auth and runtime state", () => {
    expect(
      deriveComposerVoiceState({
        authStatus: "authenticated",
        voiceTranscriptionAvailable: true,
        isRecording: false,
        isTranscribing: false,
      }),
    ).toEqual({
      canRenderVoiceNotes: true,
      canStartVoiceNotes: true,
      showVoiceNotesControl: true,
    });

    expect(
      deriveComposerVoiceState({
        authStatus: "unauthenticated",
        voiceTranscriptionAvailable: true,
        isRecording: true,
        isTranscribing: false,
      }),
    ).toEqual({
      canRenderVoiceNotes: false,
      canStartVoiceNotes: false,
      showVoiceNotesControl: true,
    });
  });
});

describe("environment panel visibility", () => {
  it("keeps normal chat threads closed by default unless the setting opts in", () => {
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: false,
      }),
    ).toBe(false);
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: false,
        settingsDefaultOpen: false,
      }),
    ).toBe(false);
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: false,
        settingsDefaultOpen: true,
      }),
    ).toBe(true);
  });

  it("keeps empty landing, terminal-primary, and constrained layouts closed even when setting is open", () => {
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: true,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: false,
        settingsDefaultOpen: true,
      }),
    ).toBe(false);
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: true,
        isConstrainedChatLayout: false,
        settingsDefaultOpen: true,
      }),
    ).toBe(false);
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: true,
        settingsDefaultOpen: true,
      }),
    ).toBe(false);
  });

  it("lets a manual preference override the default while switching chats", () => {
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: true,
        userPreferenceOpen: null,
      }),
    ).toBe(true);
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: true,
        userPreferenceOpen: false,
      }),
    ).toBe(false);
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: false,
        userPreferenceOpen: true,
      }),
    ).toBe(true);
  });

  it("persists explicit toggles but keeps action-driven closes session-only", () => {
    expect(resolveEnvironmentPanelPreferenceUpdate({ open: true, persist: true })).toEqual({
      userPreferenceOpen: true,
      settingsDefaultOpen: true,
    });
    expect(resolveEnvironmentPanelPreferenceUpdate({ open: false, persist: true })).toEqual({
      userPreferenceOpen: false,
      settingsDefaultOpen: false,
    });
    expect(resolveEnvironmentPanelPreferenceUpdate({ open: false, persist: false })).toEqual({
      userPreferenceOpen: false,
      settingsDefaultOpen: null,
    });
  });

  it("resolves landing preferences on first send without changing non-landing state", () => {
    expect(
      resolveEnvironmentPanelPreferenceAfterFirstSend({
        isCenteredEmptyLanding: true,
        settingsDefaultOpen: false,
        currentPreferenceOpen: true,
      }),
    ).toBe(false);
    expect(
      resolveEnvironmentPanelPreferenceAfterFirstSend({
        isCenteredEmptyLanding: true,
        settingsDefaultOpen: true,
        currentPreferenceOpen: false,
      }),
    ).toBeNull();
    expect(
      resolveEnvironmentPanelPreferenceAfterFirstSend({
        isCenteredEmptyLanding: false,
        settingsDefaultOpen: false,
        currentPreferenceOpen: true,
      }),
    ).toBe(true);
  });

  it("clears an action-close override so default-open applies after first send", () => {
    const actionClose = resolveEnvironmentPanelPreferenceUpdate({ open: false, persist: false });
    const afterFirstSend = resolveEnvironmentPanelPreferenceAfterFirstSend({
      isCenteredEmptyLanding: true,
      settingsDefaultOpen: true,
      currentPreferenceOpen: actionClose.userPreferenceOpen,
    });

    expect(actionClose.settingsDefaultOpen).toBeNull();
    expect(afterFirstSend).toBeNull();
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: true,
        userPreferenceOpen: afterFirstSend,
      }),
    ).toBe(true);
  });

  it("renders the panel when the user toggles it open on empty landing", () => {
    expect(
      resolveEnvironmentPanelVisible({
        environmentEnabled: true,
        environmentPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("keeps the panel hidden when environment controls are disabled or closed", () => {
    expect(
      resolveEnvironmentPanelVisible({
        environmentEnabled: false,
        environmentPanelOpen: true,
      }),
    ).toBe(false);
    expect(
      resolveEnvironmentPanelVisible({
        environmentEnabled: true,
        environmentPanelOpen: false,
      }),
    ).toBe(false);
  });
});

describe("git repository UI state", () => {
  it("waits for positive repository detection in Studio", () => {
    expect(
      resolveGitRepoUiState({
        isStudioContainer: true,
        queriedIsRepo: undefined,
      }),
    ).toBe(false);
    expect(
      resolveGitRepoUiState({
        isStudioContainer: true,
        queriedIsRepo: true,
      }),
    ).toBe(true);
    expect(
      resolveGitRepoUiState({
        isStudioContainer: true,
        queriedIsRepo: false,
      }),
    ).toBe(false);
  });

  it("keeps normal project Git UI stable while discovery is pending", () => {
    expect(
      resolveGitRepoUiState({
        isStudioContainer: false,
        queriedIsRepo: undefined,
      }),
    ).toBe(true);
  });
});

describe("resolveCycledModelSlug", () => {
  const options = [{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }];

  it("returns null when fewer than two models are available", () => {
    expect(
      resolveCycledModelSlug({
        currentModel: "a",
        options: [{ slug: "a" }],
        direction: "next",
      }),
    ).toBeNull();
  });

  it("cycles next/previous through the full list", () => {
    expect(
      resolveCycledModelSlug({
        currentModel: "a",
        options,
        direction: "next",
      }),
    ).toBe("b");
    expect(
      resolveCycledModelSlug({
        currentModel: "a",
        options,
        direction: "previous",
      }),
    ).toBe("d");
  });

  it("puts favorites first and cycles within that ordered list", () => {
    // Ordered: d, b, a, c — from c next wraps to d; from d next is b
    expect(
      resolveCycledModelSlug({
        currentModel: "c",
        options,
        favoriteSlugs: ["d", "b"],
        direction: "next",
      }),
    ).toBe("d");
    expect(
      resolveCycledModelSlug({
        currentModel: "d",
        options,
        favoriteSlugs: ["d", "b"],
        direction: "next",
      }),
    ).toBe("b");
  });

  it("starts at the ordered boundary when the current model is unavailable", () => {
    expect(
      resolveCycledModelSlug({
        currentModel: "removed-model",
        options,
        favoriteSlugs: ["d", "b"],
        direction: "next",
      }),
    ).toBe("d");
    expect(
      resolveCycledModelSlug({
        currentModel: "removed-model",
        options,
        favoriteSlugs: ["d", "b"],
        direction: "previous",
      }),
    ).toBe("c");
  });

  it("normalizes whitespace and ignores duplicate or unavailable favorites", () => {
    expect(
      resolveCycledModelSlug({
        currentModel: " d ",
        options: [{ slug: " a " }, { slug: "b" }, { slug: "b" }, { slug: "d" }],
        favoriteSlugs: [" missing ", " d ", "d"],
        direction: "next",
      }),
    ).toBe("a");
  });
});

describe("resolveActiveTurnLiveDiffState", () => {
  it("uses only the diff summary for the active turn", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-previous"),
            completedAt: "2026-06-13T10:00:00.000Z",
            files: [{ path: "old.ts", additions: 100, deletions: 50 }],
          },
          {
            turnId: activeTurnId,
            completedAt: "2026-06-13T10:01:00.000Z",
            files: [
              { path: "src/a.ts", additions: 2, deletions: 1 },
              { path: "src/b.ts", additions: 3, deletions: 0 },
            ],
          },
        ],
      }),
    ).toEqual({
      turnId: activeTurnId,
      fileCount: 2,
      additions: 5,
      deletions: 1,
      hasChanges: true,
    });
  });

  it("returns zero totals before the active turn has a diff summary or file-edit work", () => {
    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: TurnId.makeUnsafe("turn-active"),
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-previous"),
            completedAt: "2026-06-13T10:00:00.000Z",
            files: [{ path: "old.ts", additions: 100, deletions: 50 }],
          },
        ],
      }),
    ).toEqual({
      turnId: null,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      hasChanges: false,
    });
  });

  it("treats an empty active turn diff summary as authoritative over tool-log file hints", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [
          {
            turnId: activeTurnId,
            completedAt: "2026-06-13T10:01:00.000Z",
            files: [],
          },
        ],
        workLogEntries: [
          {
            turnId: activeTurnId,
            itemType: "file_change",
            changedFiles: ["src/a.ts"],
          },
        ],
      }),
    ).toEqual({
      turnId: null,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      hasChanges: false,
    });
  });

  it("falls back to in-turn file-edit work before the diff summary lands", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [],
        workLogEntries: [
          // Other turn / non-edit work is ignored.
          { turnId: TurnId.makeUnsafe("turn-previous"), itemType: "file_change" },
          { turnId: activeTurnId, requestKind: "command" },
          {
            turnId: activeTurnId,
            itemType: "file_change",
            changedFiles: ["src/a.ts", "src/b.ts"],
          },
          { turnId: activeTurnId, itemType: "file_change", changedFiles: ["src/a.ts"] },
        ],
      }),
    ).toEqual({
      turnId: null,
      fileCount: 2,
      additions: 0,
      deletions: 0,
      hasChanges: true,
    });
  });

  it("surfaces a stat-less strip when file-edit work has no changed paths yet", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [],
        workLogEntries: [{ turnId: activeTurnId, itemType: "file_change" }],
      }),
    ).toEqual({
      turnId: null,
      fileCount: null,
      additions: 0,
      deletions: 0,
      hasChanges: true,
    });
  });
});

describe("shouldShowComposerModelBootstrapSkeleton", () => {
  it("shows a skeleton while a provider requires runtime-discovered models", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "cursor",
        selectedModel: "auto",
        persistedModelSelection: null,
        draftModelSelection: null,
        providerModelsLoading: true,
        requiresDiscoveredModels: true,
      }),
    ).toBe(true);
  });

  it("hides the skeleton for a provider requiring discovered models after loading completes", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "cursor",
        selectedModel: "auto",
        persistedModelSelection: null,
        draftModelSelection: null,
        providerModelsLoading: false,
        requiresDiscoveredModels: true,
      }),
    ).toBe(false);
  });

  it("shows a skeleton while provider discovery is still resolving a persisted thread model", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "opencode",
        selectedModel: "openai/gpt-5-codex",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: null,
        providerModelsLoading: true,
      }),
    ).toBe(true);
  });

  it("hides the skeleton once the persisted thread model is already selected", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "opencode",
        selectedModel: "openai/gpt-5.4",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: null,
        providerModelsLoading: true,
      }),
    ).toBe(false);
  });

  // #103: Cursor CLI missing must not leave the whole model control in a permanent loading state.
  it("does not keep the Cursor bootstrap skeleton after discovery is no longer loading", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "cursor",
        selectedModel: "auto",
        persistedModelSelection: {
          provider: "cursor",
          model: "auto",
        },
        draftModelSelection: null,
        providerModelsLoading: false,
        requiresDiscoveredModels: true,
      }),
    ).toBe(false);
  });

  it("prefers an explicit draft selection over persisted thread state", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "opencode",
        selectedModel: "opencode/minimax-m2.5-free",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: {
          provider: "opencode",
          model: "opencode/minimax-m2.5-free",
        },
        providerModelsLoading: true,
      }),
    ).toBe(false);
  });

  it("shows a skeleton when the provisional provider does not match the persisted thread provider", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: null,
        providerModelsLoading: false,
      }),
    ).toBe(true);
  });
});

describe("resolveCommittedProviderModel", () => {
  it("preserves the exact runtime-discovered slug when the picker selected it", () => {
    expect(
      resolveCommittedProviderModel({
        selectedModel: "grok-code-fast-1-0825" as ModelSlug,
        availableOptions: [
          {
            slug: "grok-code-fast-1-0825" as ModelSlug,
            name: "Grok Code Fast 1 0825",
          },
        ],
        fallback: () => "grok-build-0.1",
      }),
    ).toBe("grok-code-fast-1-0825");
  });

  it("falls back to static alias resolution when the selected slug is not in the options", () => {
    expect(
      resolveCommittedProviderModel({
        selectedModel: "code-fast" as ModelSlug,
        availableOptions: [],
        fallback: () => "grok-build-0.1",
      }),
    ).toBe("grok-build-0.1");
  });
});

describe("shouldConsumePendingCustomBinaryConfirmation", () => {
  it("still processes a pending path for a session that was already checked", () => {
    expect(
      shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: true,
        pendingCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toBe(true);
  });

  it("skips already checked sessions when there is no pending path to confirm", () => {
    expect(
      shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: true,
        pendingCustomBinaryPath: null,
      }),
    ).toBe(false);
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 0,
      browserAnnotationCount: 0,
      fileCommentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
      pastedTexts: [],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 0,
      browserAnnotationCount: 0,
      fileCommentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
      pastedTexts: [],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats assistant selections as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 1,
      browserAnnotationCount: 0,
      fileCommentCount: 0,
      terminalContexts: [],
      pastedTexts: [],
    });

    expect(state.hasSendableContent).toBe(true);
  });

  it("treats file comments as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 0,
      browserAnnotationCount: 0,
      fileCommentCount: 1,
      terminalContexts: [],
      pastedTexts: [],
    });

    expect(state.hasSendableContent).toBe(true);
  });

  it("treats file attachments as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      fileCount: 1,
      assistantSelectionCount: 0,
      browserAnnotationCount: 0,
      fileCommentCount: 0,
      terminalContexts: [],
      pastedTexts: [],
    });

    expect(state.hasSendableContent).toBe(true);
  });

  it("treats browser annotations as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 0,
      browserAnnotationCount: 1,
      fileCommentCount: 0,
      terminalContexts: [],
      pastedTexts: [],
    });

    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("shouldRenderTerminalWorkspace", () => {
  it("renders the workspace shell before the active project has hydrated", () => {
    expect(
      shouldRenderTerminalWorkspace({
        presentationMode: "workspace",
        terminalOpen: true,
      }),
    ).toBe(true);
  });

  it("renders only for an open workspace terminal", () => {
    expect(
      shouldRenderTerminalWorkspace({
        presentationMode: "workspace",
        terminalOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldRenderTerminalWorkspace({
        presentationMode: "drawer",
        terminalOpen: true,
      }),
    ).toBe(false);
  });
});

describe("resolveProjectScriptTerminalTarget", () => {
  it("reuses the base terminal only when no terminal is open or running", () => {
    const target = resolveProjectScriptTerminalTarget({
      baseTerminalId: "default",
      createTerminalId: () => "new-terminal",
      hasRunningTerminal: false,
      terminalOpen: false,
    });

    expect(target).toEqual({
      shouldCreateNewTerminal: false,
      terminalId: "default",
    });
  });

  it("creates a fresh terminal when a live terminal could keep stale cwd or env", () => {
    expect(
      resolveProjectScriptTerminalTarget({
        baseTerminalId: "default",
        createTerminalId: () => "visible-script-terminal",
        hasRunningTerminal: false,
        terminalOpen: true,
      }),
    ).toEqual({
      shouldCreateNewTerminal: true,
      terminalId: "visible-script-terminal",
    });

    expect(
      resolveProjectScriptTerminalTarget({
        baseTerminalId: "default",
        createTerminalId: () => "running-script-terminal",
        hasRunningTerminal: true,
        terminalOpen: false,
      }),
    ).toEqual({
      shouldCreateNewTerminal: true,
      terminalId: "running-script-terminal",
    });
  });

  it("honors explicit requests for a new terminal", () => {
    const target = resolveProjectScriptTerminalTarget({
      baseTerminalId: "default",
      createTerminalId: () => "forced-script-terminal",
      hasRunningTerminal: false,
      preferNewTerminal: true,
      terminalOpen: false,
    });

    expect(target).toEqual({
      shouldCreateNewTerminal: true,
      terminalId: "forced-script-terminal",
    });
  });
});

describe("shouldRenderProviderHealthBanner", () => {
  it("does not show chat provider health while a terminal thread is active", () => {
    expect(
      shouldRenderProviderHealthBanner({
        threadEntryPoint: "terminal",
        terminalWorkspaceTerminalTabActive: false,
      }),
    ).toBe(false);
  });

  it("does not show chat provider health while the terminal workspace tab is active", () => {
    expect(
      shouldRenderProviderHealthBanner({
        threadEntryPoint: "chat",
        terminalWorkspaceTerminalTabActive: true,
      }),
    ).toBe(false);
  });

  it("shows chat provider health only on the chat surface", () => {
    expect(
      shouldRenderProviderHealthBanner({
        threadEntryPoint: "chat",
        terminalWorkspaceTerminalTabActive: false,
      }),
    ).toBe(true);
  });
});

describe("shouldStartActiveTurnLayoutGrace", () => {
  it("starts the grace window when a live turn just became settled", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: true,
        currentTurnLayoutLive: false,
        latestTurnStartedAt: "2026-04-13T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("does not start the grace window for already-idle threads", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: false,
        currentTurnLayoutLive: false,
        latestTurnStartedAt: "2026-04-13T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not start the grace window while work is still live", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: true,
        currentTurnLayoutLive: true,
        latestTurnStartedAt: "2026-04-13T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not start the grace window when the turn never started", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: true,
        currentTurnLayoutLive: false,
        latestTurnStartedAt: null,
      }),
    ).toBe(false);
  });
});

describe("worktree setup snapshots", () => {
  it("marks earlier steps done, the active step active, and later steps pending", () => {
    expect(createWorktreeSetupSnapshot("prepare-thread").steps).toEqual([
      { id: "create-branch", label: "Creating branch", status: "done" },
      { id: "create-worktree", label: "Creating worktree", status: "done" },
      { id: "prepare-thread", label: "Linking thread workspace", status: "active" },
      { id: "start-session", label: "Starting session", status: "pending" },
    ]);
  });

  it("starts with every step pending except the first when setup begins", () => {
    expect(createWorktreeSetupSnapshot("create-branch").steps.map((step) => step.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("ends with every step done except the last when the session starts", () => {
    expect(createWorktreeSetupSnapshot("start-session").steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
      "active",
    ]);
  });

  it("inserts the copy step when the worktree copies local changes", () => {
    expect(createWorktreeSetupSnapshot("copy-changes").steps).toEqual([
      { id: "create-branch", label: "Creating branch", status: "done" },
      { id: "create-worktree", label: "Creating worktree", status: "done" },
      { id: "copy-changes", label: "Copying local changes", status: "active" },
      { id: "prepare-thread", label: "Linking thread workspace", status: "pending" },
      { id: "start-session", label: "Starting session", status: "pending" },
    ]);
    expect(
      createWorktreeSetupSnapshot("create-branch", { copyLocalChanges: true }).steps.map(
        (step) => step.id,
      ),
    ).toEqual([
      "create-branch",
      "create-worktree",
      "copy-changes",
      "prepare-thread",
      "start-session",
    ]);
  });

  it("inserts the setup action step when a worktree setup script is present", () => {
    expect(
      createWorktreeSetupSnapshot("run-setup-action", { setupScriptName: "Setup" }).steps,
    ).toEqual([
      { id: "create-branch", label: "Creating branch", status: "done" },
      { id: "create-worktree", label: "Creating worktree", status: "done" },
      { id: "prepare-thread", label: "Linking thread workspace", status: "done" },
      { id: "run-setup-action", label: "Running setup action: Setup", status: "active" },
      { id: "start-session", label: "Starting session", status: "pending" },
    ]);
  });

  it("keeps the setup action step done when the session starts afterward", () => {
    expect(
      createWorktreeSetupSnapshot("start-session", { setupScriptName: "Setup" }).steps.map(
        (step) => step.status,
      ),
    ).toEqual(["done", "done", "done", "done", "active"]);
  });

  it("preserves setup action metadata while advancing local worktree setup", () => {
    const current = createLocalDispatchSnapshot(undefined, {
      worktreeSetupStepId: "create-worktree",
      setupScriptName: "Setup",
    });

    const next = resolveNextLocalDispatchSnapshot({
      current,
      activeThread: undefined,
      options: { worktreeSetupStepId: "run-setup-action", setupScriptName: "Setup" },
    });

    expect(next.worktreeSetup?.steps).toEqual([
      { id: "create-branch", label: "Creating branch", status: "done" },
      { id: "create-worktree", label: "Creating worktree", status: "done" },
      { id: "prepare-thread", label: "Linking thread workspace", status: "done" },
      { id: "run-setup-action", label: "Running setup action: Setup", status: "active" },
      { id: "start-session", label: "Starting session", status: "pending" },
    ]);
  });

  it("fails only the active step and leaves the rest untouched", () => {
    const failed = failWorktreeSetupSnapshot(createWorktreeSetupSnapshot("prepare-thread"));
    expect(failed.steps.map((step) => step.status)).toEqual(["done", "done", "error", "pending"]);
    expect(worktreeSetupHasError(failed)).toBe(true);
  });

  it("returns the same snapshot when no step is active", () => {
    const failed = failWorktreeSetupSnapshot(createWorktreeSetupSnapshot("prepare-thread"));
    expect(failWorktreeSetupSnapshot(failed)).toBe(failed);
  });

  it("reports no error for null or healthy snapshots", () => {
    expect(worktreeSetupHasError(null)).toBe(false);
    expect(worktreeSetupHasError(createWorktreeSetupSnapshot("create-worktree"))).toBe(false);
  });

  it("resolves a worktree setup resolution once and ignores later attempts", async () => {
    const resolution = createWorktreeSetupResolution();
    expect(resolution.action).toBeNull();

    resolution.resolve("work-locally");
    resolution.resolve("cancel");

    expect(resolution.action).toBe("work-locally");
    await expect(resolution.promise).resolves.toBe("work-locally");
  });

  it("exposes a cancel resolution through both the getter and the promise", async () => {
    const resolution = createWorktreeSetupResolution();
    const settled = resolution.promise;

    resolution.resolve("cancel");

    expect(resolution.action).toBe("cancel");
    await expect(settled).resolves.toBe("cancel");
  });

  it("replaces a held failed setup when a fresh local dispatch starts", () => {
    const current: LocalDispatchSnapshot = {
      startedAt: "2026-04-13T00:00:00.000Z",
      worktreeSetup: failWorktreeSetupSnapshot(createWorktreeSetupSnapshot("create-worktree")),
      expectedUserMessageId: null,
      latestTurnTurnId: null,
      latestTurnRequestedAt: null,
      latestTurnStartedAt: null,
      latestTurnCompletedAt: null,
      sessionOrchestrationStatus: null,
      sessionUpdatedAt: null,
    };

    const next = resolveNextLocalDispatchSnapshot({
      current,
      activeThread: undefined,
    });

    expect(next).not.toBe(current);
    expect(next.worktreeSetup).toBeNull();
  });

  it("starts a fresh dispatch marker when a new expected user message id arrives", () => {
    const current: LocalDispatchSnapshot = {
      startedAt: "2026-04-13T00:00:00.000Z",
      worktreeSetup: null,
      expectedUserMessageId: "message-first" as never,
      latestTurnTurnId: null,
      latestTurnRequestedAt: null,
      latestTurnStartedAt: null,
      latestTurnCompletedAt: null,
      sessionOrchestrationStatus: "ready",
      sessionUpdatedAt: "2026-04-13T00:00:00.000Z",
    };

    const next = resolveNextLocalDispatchSnapshot({
      current,
      activeThread: undefined,
      options: { expectedUserMessageId: "message-second" as never },
    });

    expect(next).not.toBe(current);
    expect(next.expectedUserMessageId).toBe("message-second");
  });

  it("replaces a held failed setup when retrying worktree setup", () => {
    const current: LocalDispatchSnapshot = {
      startedAt: "2026-04-13T00:00:00.000Z",
      worktreeSetup: failWorktreeSetupSnapshot(createWorktreeSetupSnapshot("create-worktree")),
      expectedUserMessageId: null,
      latestTurnTurnId: null,
      latestTurnRequestedAt: null,
      latestTurnStartedAt: null,
      latestTurnCompletedAt: null,
      sessionOrchestrationStatus: null,
      sessionUpdatedAt: null,
    };

    const next = resolveNextLocalDispatchSnapshot({
      current,
      activeThread: undefined,
      options: { worktreeSetupStepId: "create-worktree" },
    });

    expect(next).not.toBe(current);
    expect(next.worktreeSetup?.steps.map((step) => step.status)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });
});

describe("runWorktreeCreationFlow", () => {
  interface FlowHarness {
    emit: (event: GitWorktreeSetupProgressEvent) => void;
    resolution: ReturnType<typeof createWorktreeSetupResolution>;
    steps: string[];
    removedPaths: string[];
    unsubscribeCount: () => number;
    settleCreation: (worktreePath: string) => void;
    rejectCreation: (error: unknown) => void;
    flow: ReturnType<typeof runWorktreeCreationFlow<{ worktree: { path: string } }>>;
  }

  function startFlowHarness(): FlowHarness {
    const listeners: Array<(event: GitWorktreeSetupProgressEvent) => void> = [];
    let unsubscribes = 0;
    let settle!: (result: { worktree: { path: string } }) => void;
    let reject!: (error: unknown) => void;
    const resolution = createWorktreeSetupResolution();
    const steps: string[] = [];
    const removedPaths: string[] = [];
    const flow = runWorktreeCreationFlow({
      progressId: "progress-1",
      subscribeToProgress: (listener) => {
        listeners.push(listener);
        return () => {
          unsubscribes += 1;
        };
      },
      startCreation: () =>
        new Promise<{ worktree: { path: string } }>((resolveCreation, rejectCreation) => {
          settle = resolveCreation;
          reject = rejectCreation;
        }),
      resolution,
      onCreationStep: (stepId) => steps.push(stepId),
      removeWorktree: (worktreePath) => {
        removedPaths.push(worktreePath);
        return Promise.resolve();
      },
    });
    return {
      emit: (event) => {
        for (const listener of listeners) {
          listener(event);
        }
      },
      resolution,
      steps,
      removedPaths,
      unsubscribeCount: () => unsubscribes,
      settleCreation: (worktreePath) => settle({ worktree: { path: worktreePath } }),
      rejectCreation: (error) => reject(error),
      flow,
    };
  }

  it("advances steps only for this creation's phase-started events", async () => {
    const harness = startFlowHarness();

    harness.emit({ progressId: "progress-1", kind: "phase_started", phase: "branch" });
    harness.emit({ progressId: "progress-other", kind: "phase_started", phase: "worktree" });
    harness.emit({
      progressId: "progress-1",
      kind: "completed",
      result: { worktree: { path: "/wt", ref: "abc123", branch: "synara/x" } },
    });
    harness.emit({ progressId: "progress-1", kind: "phase_started", phase: "copy-changes" });

    expect(harness.steps).toEqual(["create-branch", "copy-changes"]);

    harness.settleCreation("/wt");
    await expect(harness.flow).resolves.toEqual({
      outcome: "created",
      result: { worktree: { path: "/wt" } },
    });
    expect(harness.removedPaths).toEqual([]);
    expect(harness.unsubscribeCount()).toBe(1);
  });

  it("stops advancing steps once the setup card is resolved", async () => {
    const harness = startFlowHarness();

    harness.emit({ progressId: "progress-1", kind: "phase_started", phase: "branch" });
    harness.resolution.resolve("cancel");
    harness.emit({ progressId: "progress-1", kind: "phase_started", phase: "worktree" });

    expect(harness.steps).toEqual(["create-branch"]);
    await expect(harness.flow).resolves.toEqual({ outcome: "resolved" });
  });

  it("tears down the worktree once creation lands after a resolution won the race", async () => {
    const harness = startFlowHarness();

    harness.resolution.resolve("work-locally");
    await expect(harness.flow).resolves.toEqual({ outcome: "resolved" });
    expect(harness.unsubscribeCount()).toBe(1);
    expect(harness.removedPaths).toEqual([]);

    harness.settleCreation("/late-worktree");
    await Promise.resolve();
    expect(harness.removedPaths).toEqual(["/late-worktree"]);
  });

  it("unsubscribes and rethrows when creation fails", async () => {
    const harness = startFlowHarness();

    harness.rejectCreation(new Error("worktree add failed"));

    await expect(harness.flow).rejects.toThrow("worktree add failed");
    expect(harness.unsubscribeCount()).toBe(1);
    expect(harness.removedPaths).toEqual([]);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const localDispatch: LocalDispatchSnapshot = {
    startedAt: "2026-04-13T00:00:00.000Z",
    worktreeSetup: null,
    expectedUserMessageId: "message-for-dispatch" as never,
    latestTurnTurnId: null,
    latestTurnRequestedAt: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    sessionOrchestrationStatus: "ready",
    sessionUpdatedAt: "2026-04-13T00:00:00.000Z",
  };
  const firstTurnLocalDispatch: LocalDispatchSnapshot = {
    startedAt: "2026-04-13T00:00:00.000Z",
    worktreeSetup: null,
    expectedUserMessageId: "message-first-send" as never,
    latestTurnTurnId: null,
    latestTurnRequestedAt: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    sessionOrchestrationStatus: null,
    sessionUpdatedAt: null,
  };

  it("stays pending until the server-side thread/session snapshot changes", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        messages: [
          {
            id: "message-before-dispatch" as never,
            role: "user",
            text: "an unrelated message",
            createdAt: "2026-04-13T00:00:00.000Z",
            streaming: false,
          },
        ],
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges the local send once the latest turn snapshot changes", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: "2026-04-13T00:00:01.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
        messages: [],
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("keeps the first-turn optimistic timer alive through a null-to-ready session bootstrap", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: firstTurnLocalDispatch,
        phase: "ready",
        latestTurn: null,
        messages: [],
        session: {
          provider: "claudeAgent",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a first send when its user message becomes durable", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: firstTurnLocalDispatch,
        phase: "ready",
        latestTurn: null,
        messages: [
          {
            id: "message-first-send" as never,
            role: "user",
            text: "the submitted message",
            createdAt: "2026-04-13T00:00:01.000Z",
            streaming: false,
          },
        ],
        session: {
          provider: "claudeAgent",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("still acknowledges non-ready session transitions without a latest turn snapshot", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: firstTurnLocalDispatch,
        phase: "disconnected",
        latestTurn: null,
        messages: [],
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: "provider failed",
      }),
    ).toBe(true);
  });
});

describe("hasLiveTurnTakenOver", () => {
  const localDispatch: LocalDispatchSnapshot = {
    startedAt: "2026-04-13T00:00:00.000Z",
    worktreeSetup: null,
    expectedUserMessageId: "message-for-dispatch" as never,
    latestTurnTurnId: null,
    latestTurnRequestedAt: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    sessionOrchestrationStatus: "ready",
    sessionUpdatedAt: "2026-04-13T00:00:00.000Z",
  };

  it("stays false for a message echo and requestedAt-only turn bump", () => {
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: "2026-04-13T00:00:01.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        now: Date.parse("2026-04-13T00:00:02.000Z"),
      }),
    ).toBe(false);
  });

  it("takes over once the session phase is running or connecting", () => {
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "running",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "connecting",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("takes over when an active turn id appears", () => {
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: "turn-1" as never,
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("takes over when latestTurn startedAt or completedAt changes", () => {
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: "2026-04-13T00:00:01.000Z",
          startedAt: "2026-04-13T00:00:02.000Z",
          completedAt: null,
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: "2026-04-13T00:00:01.000Z",
          startedAt: null,
          completedAt: "2026-04-13T00:00:03.000Z",
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("takes over on pending approval, user input, or thread error", () => {
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        session: null,
        hasPendingApproval: true,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: true,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: "provider failed",
      }),
    ).toBe(true);
  });

  it("fails open after the awaiting-turn timeout unless worktree setup is active", () => {
    const now = Date.parse(localDispatch.startedAt) + LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS;
    expect(
      hasLiveTurnTakenOver({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        now,
      }),
    ).toBe(true);
    expect(
      hasLiveTurnTakenOver({
        localDispatch: {
          ...localDispatch,
          worktreeSetup: createWorktreeSetupSnapshot("create-worktree"),
        },
        phase: "ready",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        now,
      }),
    ).toBe(false);
  });
});

describe("resolveWorkingLabel", () => {
  it("shows Loading only while an unacknowledged send is still local", () => {
    expect(resolveWorkingLabel({ isSendBusy: true, turnTakenOver: false })).toBe("Loading");
    expect(resolveWorkingLabel({ isSendBusy: true, turnTakenOver: true })).toBe("Thinking");
    expect(resolveWorkingLabel({ isSendBusy: false, turnTakenOver: false })).toBe("Thinking");
  });

  it("shows Starting provider… during the connecting phase", () => {
    expect(
      resolveWorkingLabel({
        isSendBusy: false,
        turnTakenOver: false,
        isConnecting: true,
        providerName: "Pi",
      }),
    ).toBe("Starting Pi…");

    expect(
      resolveWorkingLabel({
        isSendBusy: true,
        turnTakenOver: false,
        isConnecting: true,
        providerName: "Pi",
      }),
    ).toBe("Loading");

    expect(
      resolveWorkingLabel({
        isSendBusy: true,
        turnTakenOver: true,
        isConnecting: true,
        providerName: "Pi",
      }),
    ).toBe("Starting Pi…");

    expect(
      resolveWorkingLabel({ isSendBusy: false, turnTakenOver: false, isConnecting: true }),
    ).toBe("Thinking");
  });
});

describe("shouldAutoDeleteTerminalThreadOnLastClose", () => {
  it("deletes untouched terminal-first placeholder threads when the last terminal closes", () => {
    expect(
      shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: true,
        isServerThread: true,
        terminalEntryPoint: "terminal",
        thread: {
          title: "New terminal",
          messages: [],
          latestTurn: null,
          session: null,
          activities: [],
          proposedPlans: [],
        },
      }),
    ).toBe(true);
  });

  it("keeps non-placeholder or already-used threads", () => {
    expect(
      shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: true,
        isServerThread: true,
        terminalEntryPoint: "terminal",
        thread: {
          title: "Manual rename",
          messages: [],
          latestTurn: null,
          session: null,
          activities: [],
          proposedPlans: [],
        },
      }),
    ).toBe(false);

    expect(
      shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: true,
        isServerThread: true,
        terminalEntryPoint: "terminal",
        thread: {
          title: "New terminal",
          messages: [
            {
              id: "msg-1" as never,
              role: "user",
              text: "hello",
              createdAt: "2026-04-06T12:00:00.000Z",
              streaming: false,
            },
          ],
          latestTurn: null,
          session: null,
          activities: [],
          proposedPlans: [],
        },
      }),
    ).toBe(false);
  });
});

describe("resolveRuntimeModeAfterApprovalDecision", () => {
  it("switches approval-required threads to full-access on acceptForSession", () => {
    expect(resolveRuntimeModeAfterApprovalDecision("approval-required", "acceptForSession")).toBe(
      "full-access",
    );
  });

  it("does not change a thread already in full-access", () => {
    expect(resolveRuntimeModeAfterApprovalDecision("full-access", "acceptForSession")).toBeNull();
  });

  it("keeps Auto as the durable policy after a session-scoped approval", () => {
    expect(resolveRuntimeModeAfterApprovalDecision("auto", "acceptForSession")).toBeNull();
  });

  it("leaves runtime mode untouched for one-off accept and decline decisions", () => {
    expect(resolveRuntimeModeAfterApprovalDecision("approval-required", "accept")).toBeNull();
    expect(resolveRuntimeModeAfterApprovalDecision("approval-required", "decline")).toBeNull();
  });

  it("does not widen a permission-profile grant to full access", () => {
    expect(
      resolveRuntimeModeAfterApprovalDecision("auto", "acceptForSession", "permissions"),
    ).toBeNull();
  });
});

describe("commitAfterRuntimeModePersistence", () => {
  it("does not commit an incompatible model when the canonical downgrade fails", async () => {
    const calls: Array<string> = [];

    const committed = await commitAfterRuntimeModePersistence({
      currentRuntimeMode: "auto",
      nextRuntimeMode: "approval-required",
      persistRuntimeMode: async () => {
        calls.push("persist");
        return false;
      },
      commit: () => calls.push("commit"),
    });

    expect(committed).toBe(false);
    expect(calls).toEqual(["persist"]);
  });

  it("commits the model only after the canonical downgrade succeeds", async () => {
    const calls: Array<string> = [];

    const committed = await commitAfterRuntimeModePersistence({
      currentRuntimeMode: "auto",
      nextRuntimeMode: "approval-required",
      persistRuntimeMode: async () => {
        calls.push("persist");
        return true;
      },
      commit: () => calls.push("commit"),
    });

    expect(committed).toBe(true);
    expect(calls).toEqual(["persist", "commit"]);
  });
});

describe("createRuntimeModePersistenceQueue", () => {
  it("persists the final rapid selection after an opposite update is already in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: Array<[RuntimeMode, RuntimeMode]> = [];
    const queue = createRuntimeModePersistenceQueue("auto");
    const persist = async (currentMode: RuntimeMode, nextMode: RuntimeMode) => {
      calls.push([currentMode, nextMode]);
      if (calls.length === 1) {
        await firstBlocked;
      }
      return true;
    };

    const fullAccess = queue.persist("full-access", persist);
    await Promise.resolve();
    const auto = queue.persist("auto", persist);
    expect(calls).toEqual([["auto", "full-access"]]);

    releaseFirst?.();
    await expect(Promise.all([fullAccess, auto])).resolves.toEqual([true, true]);
    expect(calls).toEqual([
      ["auto", "full-access"],
      ["full-access", "auto"],
    ]);
  });

  it("keeps the acknowledged mode when an earlier queued write fails", async () => {
    const calls: Array<[RuntimeMode, RuntimeMode]> = [];
    const queue = createRuntimeModePersistenceQueue("auto");
    const failed = queue.persist("full-access", async (currentMode, nextMode) => {
      calls.push([currentMode, nextMode]);
      return false;
    });
    const finalAuto = queue.persist("auto", async (currentMode, nextMode) => {
      calls.push([currentMode, nextMode]);
      return true;
    });

    await expect(Promise.all([failed, finalAuto])).resolves.toEqual([false, true]);
    expect(calls).toEqual([["auto", "full-access"]]);
  });
});

describe("persistModelSelectionBeforeRuntimeMode", () => {
  const previousModel = {
    provider: "droid",
    model: "claude-opus-4-8",
  } as const;
  const autoCapableModel = {
    provider: "codex",
    model: "gpt-5.6-sol",
  } as const;

  it("persists a newly selected model before enabling Auto", async () => {
    const calls: Array<string> = [];

    await persistModelSelectionBeforeRuntimeMode({
      currentModelSelection: previousModel,
      nextModelSelection: autoCapableModel,
      currentRuntimeMode: "approval-required",
      nextRuntimeMode: "auto",
      persistModelSelection: async () => {
        calls.push("model");
      },
      persistRuntimeMode: async () => {
        calls.push("runtime");
      },
    });

    expect(calls).toEqual(["model", "runtime"]);
  });

  it("does not enable Auto when persisting the selected model fails", async () => {
    const calls: Array<string> = [];

    await expect(
      persistModelSelectionBeforeRuntimeMode({
        currentModelSelection: previousModel,
        nextModelSelection: autoCapableModel,
        currentRuntimeMode: "approval-required",
        nextRuntimeMode: "auto",
        persistModelSelection: async () => {
          calls.push("model");
          throw new Error("model persistence failed");
        },
        persistRuntimeMode: async () => {
          calls.push("runtime");
        },
      }),
    ).rejects.toThrow("model persistence failed");

    expect(calls).toEqual(["model"]);
  });

  it("downgrades from Auto before persisting an incompatible model", async () => {
    const calls: Array<string> = [];

    await persistModelSelectionBeforeRuntimeMode({
      currentModelSelection: autoCapableModel,
      nextModelSelection: previousModel,
      currentRuntimeMode: "auto",
      nextRuntimeMode: "approval-required",
      persistModelSelection: async () => {
        calls.push("model");
      },
      persistRuntimeMode: async () => {
        calls.push("runtime");
      },
    });

    expect(calls).toEqual(["runtime", "model"]);
  });
});

describe("resolveQueuedSteerGateTransition", () => {
  const armedGate = {
    sawInterruptGap: false,
    gapStartedAt: null,
    armedActiveTurnId: "turn-original",
  };
  const now = 1_000_000;

  it("holds without expiry while the original turn is still running", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: armedGate,
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-original",
      now,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: armedGate,
      expiresInMs: null,
    });
  });

  it("adopts the live turn id when the gate was armed before the projection caught up", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { sawInterruptGap: false, gapStartedAt: null, armedActiveTurnId: null },
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-original",
      now,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: armedGate,
      expiresInMs: null,
    });
  });

  it("clears when the active turn id flips without an observed idle gap", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: armedGate,
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-steered",
      now,
    });
    expect(transition).toEqual({ kind: "clear" });
  });

  it("starts the gap timer when the interrupt lands and the phase leaves running", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: armedGate,
      phase: "ready",
      sessionErrored: false,
      activeTurnId: null,
      now,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      expiresInMs: QUEUED_STEER_GATE_TIMEOUT_MS,
    });
  });

  it("keeps counting down from the original gap start on re-evaluation", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      phase: "ready",
      sessionErrored: false,
      activeTurnId: null,
      now: now + 5_000,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      expiresInMs: QUEUED_STEER_GATE_TIMEOUT_MS - 5_000,
    });
  });

  it("clears once the steered turn starts running after the gap", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-steered",
      now: now + 1_000,
    });
    expect(transition).toEqual({ kind: "clear" });
  });

  it("fails open when the steered turn never starts within the timeout", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      phase: "ready",
      sessionErrored: false,
      activeTurnId: null,
      now: now + QUEUED_STEER_GATE_TIMEOUT_MS,
    });
    expect(transition).toEqual({ kind: "clear" });
  });

  it("clears on session error or disconnect so the queue cannot stall", () => {
    expect(
      resolveQueuedSteerGateTransition({
        gate: armedGate,
        phase: "ready",
        sessionErrored: true,
        activeTurnId: null,
        now,
      }),
    ).toEqual({ kind: "clear" });
    expect(
      resolveQueuedSteerGateTransition({
        gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
        phase: "disconnected",
        sessionErrored: false,
        activeTurnId: null,
        now,
      }),
    ).toEqual({ kind: "clear" });
  });
});

describe("thread detail hydration", () => {
  it("keeps local drafts on the empty landing even if a stale failure flag lingers", () => {
    expect(
      resolveThreadDetailHydration({
        isServerThread: false,
        hasTimelineEntries: false,
        detailSyncState: null,
      }),
    ).toBe("ready");
    expect(
      resolveThreadDetailHydration({
        isServerThread: false,
        hasTimelineEntries: false,
        detailSyncState: "failed",
      }),
    ).toBe("ready");
  });

  it("renders existing timeline entries without waiting for a snapshot", () => {
    expect(
      resolveThreadDetailHydration({
        isServerThread: true,
        hasTimelineEntries: true,
        detailSyncState: null,
      }),
    ).toBe("ready");
  });

  it("treats a synced empty thread as genuinely empty", () => {
    expect(
      resolveThreadDetailHydration({
        isServerThread: true,
        hasTimelineEntries: false,
        detailSyncState: "synced",
      }),
    ).toBe("ready");
  });

  it("shows loading for a server thread whose detail has not synced yet", () => {
    expect(
      resolveThreadDetailHydration({
        isServerThread: true,
        hasTimelineEntries: false,
        detailSyncState: null,
      }),
    ).toBe("loading");
  });

  it("surfaces a failed state when the detail stream died without data", () => {
    expect(
      resolveThreadDetailHydration({
        isServerThread: true,
        hasTimelineEntries: false,
        detailSyncState: "failed",
      }),
    ).toBe("failed");
  });
});

describe("resolveDraftFallbackModelSelection", () => {
  it("prefers an explicit project default over the settings default provider", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: { provider: "codex", model: "gpt-5.5" },
        settingsDefaultProvider: "devin",
      }),
    ).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("uses the settings default provider when the project has no default", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: null,
        settingsDefaultProvider: "devin",
      }),
    ).toEqual({ provider: "devin", model: "adaptive" });
  });

  it("keeps the project default model when it matches the settings provider", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: { provider: "devin", model: "swe-1-7" },
        settingsDefaultProvider: "devin",
      }),
    ).toEqual({ provider: "devin", model: "swe-1-7" });
  });

  it("uses the project default provider when the settings default is pi", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: { provider: "claudeAgent", model: "claude-sonnet-5" },
        settingsDefaultProvider: "pi",
      }),
    ).toEqual({ provider: "claudeAgent", model: "claude-sonnet-5" });
  });

  it("falls back to codex when the settings default is pi and no project default exists", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: null,
        settingsDefaultProvider: "pi",
      }),
    ).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("uses the settings provider default model when no project default exists", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: undefined,
        settingsDefaultProvider: "grok",
      }),
    ).toEqual({ provider: "grok", model: "grok-4.6" });
  });
});

describe("failed thread send snapshot identity", () => {
  it("owns the card only while the current error is the generation the snapshot raised", () => {
    const snapshot = { errorMessage: "rate limited", errorVersion: 2 };
    expect(
      failedSendSnapshotOwnsCurrentError(snapshot, {
        error: "rate limited",
        errorVersion: 2,
      }),
    ).toBe(true);
    // E→F→E: identical text after an intervening error is a newer generation,
    // so the snapshot is stale and must not clear the card or drive retry.
    expect(
      failedSendSnapshotOwnsCurrentError(snapshot, {
        error: "rate limited",
        errorVersion: 3,
      }),
    ).toBe(false);
    expect(failedSendSnapshotOwnsCurrentError(snapshot, { error: null, errorVersion: 3 })).toBe(
      false,
    );
  });
});

describe("evictOverflowFailedThreadSend", () => {
  const snapshotFor = (errorMessage: string, errorVersion: number) => ({
    errorMessage,
    errorVersion,
    prompt: "failed payload",
  });
  // Fills the map to the bound so the next call must evict its oldest entry.
  const fill = (sends: Map<ThreadId, ReturnType<typeof snapshotFor>>) => {
    for (let index = 0; sends.size < MAX_FAILED_THREAD_SEND_SNAPSHOTS; index += 1) {
      sends.set(ThreadId.makeUnsafe(`thread-fill-${index}`), snapshotFor("other", 1));
    }
  };

  it("leaves the map alone below the bound", () => {
    const sends = new Map([[ThreadId.makeUnsafe("thread-1"), snapshotFor("e", 1)]]);
    expect(
      evictOverflowFailedThreadSend(sends, () => ({ error: "e", errorVersion: 1 })),
    ).toBeNull();
    expect(sends.size).toBe(1);
  });

  it("returns the evicted thread only while its snapshot still owns the current error", () => {
    const oldest = ThreadId.makeUnsafe("thread-oldest");
    const sends = new Map<ThreadId, ReturnType<typeof snapshotFor>>([
      [oldest, snapshotFor("send failed", 1)],
    ]);
    fill(sends);
    expect(
      evictOverflowFailedThreadSend(sends, () => ({
        error: "send failed",
        errorVersion: 1,
      })),
    ).toBe(oldest);
    expect(sends.has(oldest)).toBe(false);
    expect(sends.size).toBe(MAX_FAILED_THREAD_SEND_SNAPSHOTS - 1);
  });

  it("evicts the stale snapshot without clearing the newer identical error (E→F→E)", () => {
    const oldest = ThreadId.makeUnsafe("thread-oldest");
    const sends = new Map<ThreadId, ReturnType<typeof snapshotFor>>([
      [oldest, snapshotFor("rate limited", 1)],
    ]);
    fill(sends);
    // The same message was re-raised at a newer generation — the card belongs
    // to a different failure, so eviction must not clear it.
    expect(
      evictOverflowFailedThreadSend(sends, () => ({
        error: "rate limited",
        errorVersion: 3,
      })),
    ).toBeNull();
    expect(sends.has(oldest)).toBe(false);
  });
});

describe("bumpLocalDraftErrorVersion", () => {
  const noPins = () => false;

  it("bumps monotonically per thread", () => {
    const versions = new Map<ThreadId, number>();
    const threadId = ThreadId.makeUnsafe("thread-1");
    expect(bumpLocalDraftErrorVersion(versions, noPins, threadId)).toBe(1);
    expect(bumpLocalDraftErrorVersion(versions, noPins, threadId)).toBe(2);
    expect(bumpLocalDraftErrorVersion(versions, noPins, ThreadId.makeUnsafe("other"))).toBe(1);
  });

  it("bounds the map by evicting the oldest entry no live snapshot references", () => {
    const versions = new Map<ThreadId, number>();
    // A pinned entry — the one a failed-send snapshot still references — must
    // survive pressure so the snapshot's identity check can never go blind.
    const pinnedId = ThreadId.makeUnsafe("thread-pinned");
    bumpLocalDraftErrorVersion(versions, noPins, pinnedId);
    const isPinned = (id: ThreadId) => id === pinnedId;
    for (let index = 0; index < MAX_LOCAL_DRAFT_ERROR_VERSIONS + 10; index += 1) {
      bumpLocalDraftErrorVersion(versions, isPinned, ThreadId.makeUnsafe(`thread-${index}`));
    }
    expect(versions.size).toBeLessThanOrEqual(MAX_LOCAL_DRAFT_ERROR_VERSIONS);
    expect(versions.has(pinnedId)).toBe(true);
    // The oldest unpinned entries were evicted first.
    expect(versions.has(ThreadId.makeUnsafe("thread-0"))).toBe(false);
    expect(versions.has(ThreadId.makeUnsafe(`thread-${MAX_LOCAL_DRAFT_ERROR_VERSIONS + 9}`))).toBe(
      true,
    );
  });
});

describe("releaseFailedSendSnapshotAfterSend", () => {
  const snapshot = { errorMessage: "rate limited", errorVersion: 1 };

  it("deletes the exact snapshot when the resend is accepted and the error was cleared", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const accepted = await releaseFailedSendSnapshotAfterSend(
      Promise.resolve(true),
      failedSends,
      threadId,
      snapshot,
      () => ({ error: null, errorVersion: 2 }),
    );
    expect(accepted).toBe(true);
    expect(failedSends.has(threadId)).toBe(false);
  });

  it("retains the snapshot when the resend is rejected", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const accepted = await releaseFailedSendSnapshotAfterSend(
      Promise.resolve(false),
      failedSends,
      threadId,
      snapshot,
      () => ({ error: null, errorVersion: 2 }),
    );
    expect(accepted).toBe(false);
    expect(failedSends.get(threadId)).toBe(snapshot);
  });

  it("does not delete the snapshot when accepted but the send did not actually dispatch", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const accepted = await releaseFailedSendSnapshotAfterSend(
      Promise.resolve(true),
      failedSends,
      threadId,
      snapshot,
      () => ({ error: snapshot.errorMessage, errorVersion: snapshot.errorVersion }),
    );
    expect(accepted).toBe(true);
    expect(failedSends.get(threadId)).toBe(snapshot);
  });

  it("does not delete a newer snapshot created by an overlapping send", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const newer = { errorMessage: "network error", errorVersion: 2 };
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, newer]]);
    const accepted = await releaseFailedSendSnapshotAfterSend(
      Promise.resolve(true),
      failedSends,
      threadId,
      snapshot,
      () => ({ error: newer.errorMessage, errorVersion: newer.errorVersion }),
    );
    expect(accepted).toBe(true);
    expect(failedSends.get(threadId)).toBe(newer);
  });
});

describe("releaseSupersededFailedSend", () => {
  const snapshot = { errorMessage: "rate limited", errorVersion: 1 };

  it("releases the superseded snapshot and clears the error together", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const cleared: ThreadId[] = [];
    releaseSupersededFailedSend(failedSends, threadId, (id) => {
      cleared.push(id);
    });
    expect(failedSends.has(threadId)).toBe(false);
    expect(cleared).toEqual([threadId]);
  });

  it("still clears the error when no failed-send snapshot exists", () => {
    // An accepted send supersedes whatever card is showing, including a fresh
    // error that has no captured payload — it must not survive the commit.
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>();
    const cleared: ThreadId[] = [];
    releaseSupersededFailedSend(failedSends, threadId, (id) => {
      cleared.push(id);
    });
    expect(cleared).toEqual([threadId]);
  });

  it("releases a snapshot recorded while the send was still preparing, so its payload cannot outlive the superseded card", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const newer = { errorMessage: "network error", errorVersion: 2 };
    const failedSends = new Map<ThreadId, typeof newer>([[threadId, newer]]);
    const cleared: ThreadId[] = [];
    releaseSupersededFailedSend(failedSends, threadId, (id) => {
      cleared.push(id);
    });
    expect(failedSends.has(threadId)).toBe(false);
    expect(cleared).toEqual([threadId]);
  });

  it("leaves another thread's failed send untouched", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const otherThreadId = ThreadId.makeUnsafe("thread-2");
    const failedSends = new Map<ThreadId, typeof snapshot>([[otherThreadId, snapshot]]);
    releaseSupersededFailedSend(failedSends, threadId, () => {});
    expect(failedSends.get(otherThreadId)).toBe(snapshot);
  });
});

describe("releaseRetriedFailedSend", () => {
  const snapshot = { errorMessage: "rate limited", errorVersion: 1 };
  const retriedError = { error: "rate limited", errorVersion: 1 };

  it("releases the captured snapshot and clears its card when the state is unchanged", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const cleared: ThreadId[] = [];
    releaseRetriedFailedSend(
      failedSends,
      threadId,
      snapshot,
      retriedError,
      () => retriedError,
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.has(threadId)).toBe(false);
    expect(cleared).toEqual([threadId]);
  });

  it("leaves a newer snapshot and its card intact when a failure lands during the retry's attachment rebuild", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const newer = { errorMessage: "network error", errorVersion: 2 };
    const newerError = { error: newer.errorMessage, errorVersion: newer.errorVersion };
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, newer]]);
    const cleared: ThreadId[] = [];
    releaseRetriedFailedSend(
      failedSends,
      threadId,
      snapshot,
      retriedError,
      () => newerError,
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.get(threadId)).toBe(newer);
    expect(cleared).toEqual([]);
  });

  it("clears a card with no captured payload (transcript retry) only while the same error is still showing", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>();
    const cleared: ThreadId[] = [];
    const getCurrentError = () => retriedError;
    releaseRetriedFailedSend(failedSends, threadId, null, retriedError, getCurrentError, (id) => {
      cleared.push(id);
    });
    expect(cleared).toEqual([threadId]);
    // A newer error that replaced the retried one survives the commit.
    cleared.length = 0;
    releaseRetriedFailedSend(
      failedSends,
      threadId,
      null,
      retriedError,
      () => ({ error: "different failure", errorVersion: 2 }),
      (id) => {
        cleared.push(id);
      },
    );
    expect(cleared).toEqual([]);
  });

  it("releases the retried snapshot even when a newer card without a payload is showing — its payload is already queued", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const cleared: ThreadId[] = [];
    releaseRetriedFailedSend(
      failedSends,
      threadId,
      snapshot,
      retriedError,
      () => ({ error: "different failure", errorVersion: 2 }),
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.has(threadId)).toBe(false);
    expect(cleared).toEqual([]);
  });

  it("keeps the card when a newer failed send re-recorded the same error text — its snapshot must not be stranded", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    // Recording a snapshot does not bump the error version when the message is
    // unchanged (setError no-ops on identical text), so the newer snapshot
    // owning the card is the only signal that this is a different failure.
    const newer = { errorMessage: "rate limited", errorVersion: 1 };
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, newer]]);
    const cleared: ThreadId[] = [];
    releaseRetriedFailedSend(
      failedSends,
      threadId,
      null,
      retriedError,
      () => retriedError,
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.get(threadId)).toBe(newer);
    expect(cleared).toEqual([]);
  });

  it("keeps a replaced snapshot and its card when a newer failure owns the current error", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const newer = { errorMessage: "rate limited", errorVersion: 1 };
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, newer]]);
    const cleared: ThreadId[] = [];
    releaseRetriedFailedSend(
      failedSends,
      threadId,
      snapshot,
      retriedError,
      () => retriedError,
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.get(threadId)).toBe(newer);
    expect(cleared).toEqual([]);
  });
});

// `onSend` has several commit points — the restored-draft queue enqueue, the
// plan-follow-up enqueue, the direct dispatch, and `onSubmitPlanFollowUp` — and
// every one of them funnels through `releaseFailedSendAtSendCommit`. A retry
// passes the identity it captured before its awaits; a fresh send passes
// nothing and supersedes. These tests pin the overlap contract each path
// relies on: a newer failure that lands mid-retry keeps its snapshot and card.
describe("releaseFailedSendAtSendCommit", () => {
  const snapshot = { errorMessage: "rate limited", errorVersion: 1 };
  const retriedError = { error: "rate limited", errorVersion: 1 };

  it("supersedes the failed-send pair for a fresh send, including the plan-follow-up queue commit", () => {
    // A queued plan follow-up must not leave the stale card and pinned payload
    // behind — it commits like any other send.
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const cleared: ThreadId[] = [];
    releaseFailedSendAtSendCommit(
      failedSends,
      threadId,
      undefined,
      () => retriedError,
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.has(threadId)).toBe(false);
    expect(cleared).toEqual([threadId]);
  });

  it("keeps a newer snapshot and card when a direct-dispatch retry commits over an overlapping failure", () => {
    // The snapshot leg dispatches `send(undefined, "queue", retryTurn)`, which
    // skips the queue branch and commits at the direct dispatch point — after
    // awaits during which a newer send can fail.
    const threadId = ThreadId.makeUnsafe("thread-1");
    const newer = { errorMessage: "network error", errorVersion: 2 };
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, newer]]);
    const cleared: ThreadId[] = [];
    releaseFailedSendAtSendCommit(
      failedSends,
      threadId,
      { expectedSnapshot: snapshot, retriedError },
      () => ({ error: newer.errorMessage, errorVersion: newer.errorVersion }),
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.get(threadId)).toBe(newer);
    expect(cleared).toEqual([]);
  });

  it("keeps a newer snapshot and card when a restored-draft retry commits to the queue", () => {
    // The restored-draft leg calls `send(undefined, "queue")` and commits at
    // the queue-enqueue point after the attachment-persistence await. The
    // overlapping failure re-raised identical text, so only the snapshot it
    // recorded proves the card belongs to it.
    const threadId = ThreadId.makeUnsafe("thread-1");
    const newer = { errorMessage: "rate limited", errorVersion: 1 };
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, newer]]);
    const cleared: ThreadId[] = [];
    releaseFailedSendAtSendCommit(
      failedSends,
      threadId,
      { expectedSnapshot: snapshot, retriedError },
      () => retriedError,
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.get(threadId)).toBe(newer);
    expect(cleared).toEqual([]);
  });

  it("keeps a newer snapshot and card when a plan follow-up retry commits over an overlapping failure", () => {
    // The transcript fallback has no captured payload, so the retry carries
    // only the error identity it was initiated for; a newer failure recorded
    // in between keeps both halves of its pair.
    const threadId = ThreadId.makeUnsafe("thread-1");
    const newer = { errorMessage: "network error", errorVersion: 2 };
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, newer]]);
    const cleared: ThreadId[] = [];
    releaseFailedSendAtSendCommit(
      failedSends,
      threadId,
      { expectedSnapshot: null, retriedError },
      () => ({ error: newer.errorMessage, errorVersion: newer.errorVersion }),
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.get(threadId)).toBe(newer);
    expect(cleared).toEqual([]);
  });

  it("releases the retry's own pair when nothing newer landed before the commit", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const failedSends = new Map<ThreadId, typeof snapshot>([[threadId, snapshot]]);
    const cleared: ThreadId[] = [];
    releaseFailedSendAtSendCommit(
      failedSends,
      threadId,
      { expectedSnapshot: snapshot, retriedError },
      () => retriedError,
      (id) => {
        cleared.push(id);
      },
    );
    expect(failedSends.has(threadId)).toBe(false);
    expect(cleared).toEqual([threadId]);
  });
});

// The transcript fallback replays the errored turn's own input, so it must only
// fire when the card's failure IS that turn's failure. Every other error source
// (approval and user-input responses, unblocks, plan follow-ups, dispatches
// that never produced a turn) has no safe payload, and resending the last
// transcript message would launch an unrelated earlier request. The returned
// turn is also the retry's plan-linkage source: buildRetryTurn copies its
// sourceProposedPlan so the retried thread.turn.start keeps implementation
// tracking attached to the original plan.
describe("findTranscriptFallbackRetryTarget", () => {
  const erroredTurnId = TurnId.makeUnsafe("turn-errored");
  const planReference = {
    threadId: ThreadId.makeUnsafe("thread-1"),
    planId: "plan-1",
  };
  const erroredPlanTurn: NonNullable<Thread["latestTurn"]> = {
    turnId: erroredTurnId,
    state: "error",
    requestedAt: "2026-09-09T00:00:02.000Z",
    startedAt: "2026-09-09T00:00:02.500Z",
    completedAt: "2026-09-09T00:00:03.000Z",
    assistantMessageId: null,
    sourceProposedPlan: planReference,
  };
  const currentError = { error: "boom", errorVersion: 3 };
  const ownership = {
    threadId: ThreadId.makeUnsafe("thread-1"),
    turnId: erroredTurnId,
    errorVersion: currentError.errorVersion,
    writeEpoch: 7,
  };
  const userMessage = (turnId: TurnId | null, text = "Implement the plan"): ChatMessage => ({
    id: MessageId.makeUnsafe(text.toLowerCase().replace(/\s+/g, "-")),
    role: "user",
    text,
    turnId,
    createdAt: "2026-09-09T00:00:01.000Z",
    streaming: false,
  });

  it("targets the errored turn's own last user message and carries its plan linkage", () => {
    const failedUserMessage = userMessage(erroredTurnId, "Implement the plan");
    const ownership = {
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: erroredTurnId,
      errorVersion: currentError.errorVersion,
      writeEpoch: 7,
    };
    const target = findTranscriptFallbackRetryTarget(
      [userMessage(TurnId.makeUnsafe("turn-older"), "Propose a plan"), failedUserMessage],
      erroredPlanTurn,
      currentError,
      ownership,
      7,
    );
    expect(target?.message).toBe(failedUserMessage);
    // Identity, not a copy: the retry reads sourceProposedPlan off this exact
    // turn record, so the retried thread.turn.start keeps the linkage.
    expect(target?.turn).toBe(erroredPlanTurn);
    expect(target?.turn.sourceProposedPlan).toEqual(planReference);
  });

  it("rejects a live turn so a retry cannot interrupt or duplicate it", () => {
    expect(
      findTranscriptFallbackRetryTarget(
        [userMessage(erroredTurnId)],
        { ...erroredPlanTurn, state: "running", completedAt: null },
        currentError,
        ownership,
        7,
      ),
    ).toBeNull();
  });

  it("rejects when the last user message belongs to an older turn", () => {
    // An approval or user-input response failure lands while an errored turn is
    // still the latest but its own dispatch never produced a transcript message
    // — the fallback must not resend the older turn's input.
    expect(
      findTranscriptFallbackRetryTarget(
        [userMessage(TurnId.makeUnsafe("turn-older"))],
        { ...erroredPlanTurn, turnId: TurnId.makeUnsafe("turn-newer") },
        currentError,
        ownership,
        7,
      ),
    ).toBeNull();
  });

  it("rejects a transcript whose last user message never joined a turn", () => {
    expect(
      findTranscriptFallbackRetryTarget(
        [userMessage(null)],
        erroredPlanTurn,
        currentError,
        ownership,
        7,
      ),
    ).toBeNull();
  });

  it("rejects a transcript with no user message at all", () => {
    expect(
      findTranscriptFallbackRetryTarget([], erroredPlanTurn, currentError, ownership, 7),
    ).toBeNull();
  });

  it("rejects a completed latest turn — its failure is not the card's error", () => {
    expect(
      findTranscriptFallbackRetryTarget(
        [userMessage(erroredTurnId)],
        { ...erroredPlanTurn, state: "completed" },
        currentError,
        ownership,
        7,
      ),
    ).toBeNull();
  });
});

// "Try again" must reflect a concrete replay target, not just a retryable
// error string: approval and user-input response failures can raise
// connection-classified errors with nothing to replay. A target exists when a
// failed-send snapshot still owns the current error, or the transcript
// fallback has a safe target.
describe("hasThreadErrorRetryTarget", () => {
  const erroredTurnId = TurnId.makeUnsafe("turn-errored");
  const erroredPlanTurn: NonNullable<Thread["latestTurn"]> = {
    turnId: erroredTurnId,
    state: "error",
    requestedAt: "2026-09-09T00:00:02.000Z",
    startedAt: "2026-09-09T00:00:02.500Z",
    completedAt: "2026-09-09T00:00:03.000Z",
    assistantMessageId: null,
  };
  const userMessage = (turnId: TurnId | null): ChatMessage => ({
    id: MessageId.makeUnsafe("message-errored"),
    role: "user",
    text: "Implement the plan",
    turnId,
    createdAt: "2026-09-09T00:00:01.000Z",
    streaming: false,
  });
  const snapshot = { errorMessage: "boom", errorVersion: 1 };

  it("accepts a snapshot that still owns the current error", () => {
    expect(
      hasThreadErrorRetryTarget(snapshot, { error: "boom", errorVersion: 1 }, [], null, null, 4),
    ).toBe(true);
  });

  it("rejects a stale snapshot with no transcript fallback target", () => {
    // An approval or user-input response failure replaced the card: the
    // snapshot no longer owns it and no errored turn exists to replay.
    expect(
      hasThreadErrorRetryTarget(snapshot, { error: "boom", errorVersion: 2 }, [], null, null, 4),
    ).toBe(false);
  });

  it("accepts the transcript fallback while the session attribution is current", () => {
    expect(
      hasThreadErrorRetryTarget(
        undefined,
        { error: "boom", errorVersion: 1 },
        [userMessage(erroredTurnId)],
        erroredPlanTurn,
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: erroredTurnId,
          errorVersion: 1,
          writeEpoch: 4,
        },
        4,
      ),
    ).toBe(true);
  });

  it("closes the transcript fallback once a newer client-side failure overwrites the error", () => {
    // An attachment, script, approval, or user-input failure overwrites
    // thread.error without touching the session's lastError: the card now
    // belongs to that newer failure, and the old turn's input must not resend.
    expect(
      hasThreadErrorRetryTarget(
        undefined,
        { error: "You can attach up to 8 references per message.", errorVersion: 4 },
        [userMessage(erroredTurnId)],
        erroredPlanTurn,
        null,
        4,
      ),
    ).toBe(false);
  });

  it("closes the transcript fallback when a client write reuses the session text", () => {
    // The client write bumps the write epoch without changing the generation,
    // so the attribution recorded for the session failure no longer matches.
    expect(
      hasThreadErrorRetryTarget(
        undefined,
        { error: "boom", errorVersion: 3 },
        [userMessage(erroredTurnId)],
        erroredPlanTurn,
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: erroredTurnId,
          errorVersion: 3,
          writeEpoch: 9,
        },
        10,
      ),
    ).toBe(false);
  });

  it("rejects when neither a snapshot nor a fallback target exists", () => {
    expect(
      hasThreadErrorRetryTarget(undefined, { error: "boom", errorVersion: 1 }, [], null, null, 4),
    ).toBe(false);
  });

  it("keeps the fallback closed when the session error is null", () => {
    // A client-side clear or a non-session error source: nothing ties the
    // card to the errored turn.
    expect(
      hasThreadErrorRetryTarget(
        undefined,
        { error: "boom", errorVersion: 1 },
        [userMessage(erroredTurnId)],
        erroredPlanTurn,
        null,
        4,
      ),
    ).toBe(false);
  });
});

describe("bumpThreadErrorWriteEpoch", () => {
  it("keeps a recently written thread's entry alive across writes to other threads", () => {
    const epochs = new Map<ThreadId, number>();
    const counter = { current: 0 };
    const touched = ThreadId.makeUnsafe("thread-touched");
    bumpThreadErrorWriteEpoch(epochs, touched, counter);
    for (let i = 0; i < MAX_THREAD_ERROR_WRITE_EPOCHS - 1; i += 1) {
      bumpThreadErrorWriteEpoch(epochs, ThreadId.makeUnsafe(`thread-other-${i}`), counter);
    }
    // The touched entry is still the least recently written here, but the
    // re-touch moves it to the tail before the bound applies, so it survives
    // with the next globally monotonic value.
    expect(bumpThreadErrorWriteEpoch(epochs, touched, counter)).toBe(65);
    expect(epochs.has(touched)).toBe(true);
    expect(epochs.size).toBeLessThanOrEqual(MAX_THREAD_ERROR_WRITE_EPOCHS);
  });

  it("keeps epochs globally monotonic past eviction, so old claims never re-match", () => {
    const epochs = new Map<ThreadId, number>();
    const counter = { current: 0 };
    const evicted = ThreadId.makeUnsafe("thread-evicted");
    bumpThreadErrorWriteEpoch(epochs, evicted, counter);
    for (let i = 0; i < MAX_THREAD_ERROR_WRITE_EPOCHS; i += 1) {
      bumpThreadErrorWriteEpoch(epochs, ThreadId.makeUnsafe(`thread-other-${i}`), counter);
    }
    expect(epochs.has(evicted)).toBe(false);
    // The next write takes the next global value, not a restarted 1: an old
    // claim with epoch 1 can never match a later same-text write.
    const nextEpoch = bumpThreadErrorWriteEpoch(epochs, evicted, counter);
    expect(nextEpoch).toBeGreaterThan(MAX_THREAD_ERROR_WRITE_EPOCHS);
  });
});
