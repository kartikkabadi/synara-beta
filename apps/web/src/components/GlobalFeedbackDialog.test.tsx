// FILE: GlobalFeedbackDialog.test.tsx

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "~/types";

const mocks = vi.hoisted(() => ({
  focusedChat: {
    activeProject: null as Project | null,
    activeProjectId: null as Project["id"] | null,
    activeThread: null as unknown,
  },
  projects: [] as Project[],
  threadsHydrated: true,
  handleNewThread: vi.fn(),
  appendComposerPromptText: vi.fn(),
  toastAdd: vi.fn(),
  submitFeedback: vi.fn(),
  dialogProps: { current: null as Record<string, unknown> | null },
}));

// The real builders stay: only the network call is stubbed, so the prompt the
// test inspects is the one the agent would actually receive.
vi.mock("../feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../feedback")>();
  return { ...actual, submitFeedback: mocks.submitFeedback };
});

vi.mock("../focusedChatContext", () => ({
  useFocusedChatContext: () => mocks.focusedChat,
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    handleNewThread: mocks.handleNewThread,
    projects: mocks.projects,
    threadsHydrated: mocks.threadsHydrated,
  }),
}));
vi.mock("../workspacePathsStore", () => ({
  useWorkspacePathsStore: (
    selector: (store: {
      homeDir: string;
      chatWorkspaceRoot: string;
      studioWorkspaceRoot: string;
    }) => unknown,
  ) =>
    selector({
      homeDir: "/home/tester",
      chatWorkspaceRoot: "/home/tester/.synara/chats",
      studioWorkspaceRoot: "/home/tester/.synara/studio",
    }),
}));
vi.mock("../lib/chatReferences", () => ({
  appendComposerPromptText: mocks.appendComposerPromptText,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
}));
vi.mock("./FeedbackDialog", () => ({
  FeedbackDialog: (props: Record<string, unknown>) => {
    mocks.dialogProps.current = props;
    return null;
  },
}));

import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { GlobalFeedbackDialog } from "./GlobalFeedbackDialog";

function project(partial: Partial<Project> & { id: Project["id"] }): Project {
  return {
    kind: "project",
    name: partial.id,
    remoteName: partial.id,
    folderName: partial.id,
    localName: null,
    cwd: `/repo/${partial.id}`,
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
    ...partial,
  } as Project;
}

const HOME_CONTAINER = project({
  id: "home" as Project["id"],
  kind: "chat",
  name: "Home",
  remoteName: "Home",
  cwd: "/home/tester",
});

function renderDialog(): Record<string, unknown> {
  renderToStaticMarkup(<GlobalFeedbackDialog />);
  const props = mocks.dialogProps.current;
  if (!props) throw new Error("FeedbackDialog was not rendered");
  return props;
}

describe("GlobalFeedbackDialog.onDraftGithubIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dialogProps.current = null;
    mocks.focusedChat.activeProject = null;
    mocks.focusedChat.activeProjectId = null;
    mocks.focusedChat.activeThread = null;
    mocks.projects = [];
    mocks.threadsHydrated = true;
    mocks.handleNewThread.mockResolvedValue("thread-1");
    mocks.submitFeedback.mockResolvedValue(undefined);
    useFeedbackDialogStore.setState({ isOpen: false, context: null, initialCategory: null });
    vi.stubGlobal("window", { innerWidth: 1_440, innerHeight: 900 });
    vi.stubGlobal("navigator", {
      userAgent: "Synara test agent",
      platform: "MacIntel",
      language: "en-US",
    });
  });

  it("mints a thread in the active ordinary project and fills the sanitized prompt", async () => {
    const ordinary = project({ id: "proj-active" as Project["id"] });
    mocks.projects = [HOME_CONTAINER, ordinary];
    mocks.focusedChat.activeProject = ordinary;
    mocks.focusedChat.activeProjectId = ordinary.id;
    useFeedbackDialogStore.getState().openDialog(undefined, "bug");

    const props = renderDialog();
    const draft = props.onDraftGithubIssue as (details: string) => Promise<void>;
    await draft("Send crashes. My key is ghp_0123456789abcdefghijklmnop");

    // preserveProjectDraft keeps the project's unsent new-thread draft: a
    // mapped fresh draft would evict and delete its text.
    expect(mocks.handleNewThread).toHaveBeenCalledWith(ordinary.id, {
      fresh: true,
      preserveProjectDraft: true,
    });
    expect(mocks.appendComposerPromptText).toHaveBeenCalledTimes(1);
    const [threadId, prompt] = mocks.appendComposerPromptText.mock.calls[0] as [string, string];
    expect(threadId).toBe("thread-1");
    expect(prompt).toContain("bug report");
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).not.toContain("ghp_0123456789abcdefghijklmnop");
    // The private copy landed, so the prompt may say so.
    expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
    expect(prompt).toContain("delivered to the maintainer's private beta endpoint");
    expect(useFeedbackDialogStore.getState().isOpen).toBe(false);
    expect(mocks.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("still drafts when the private report copy fails, and says so in the prompt", async () => {
    const ordinary = project({ id: "proj-active" as Project["id"] });
    mocks.projects = [ordinary];
    mocks.focusedChat.activeProject = ordinary;
    mocks.focusedChat.activeProjectId = ordinary.id;
    mocks.submitFeedback.mockRejectedValue(new Error("unauthorized"));
    useFeedbackDialogStore.getState().openDialog(undefined, "bug");

    const props = renderDialog();
    const draft = props.onDraftGithubIssue as (details: string) => Promise<void>;
    await draft("Send crashes on every other submit.");

    expect(mocks.handleNewThread).toHaveBeenCalledTimes(1);
    const [, prompt] = mocks.appendComposerPromptText.mock.calls[0] as [string, string];
    // The agent must not claim a private copy it does not have.
    expect(prompt).toContain("no private copy is on file");
    expect(prompt).not.toContain("delivered to the maintainer's private beta endpoint");
    expect(mocks.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Private report copy failed" }),
    );
    expect(useFeedbackDialogStore.getState().isOpen).toBe(false);
  });

  it("drafts into the first ordinary project when the active container is Home", async () => {
    const ordinary = project({ id: "proj-first" as Project["id"] });
    mocks.projects = [HOME_CONTAINER, ordinary];
    mocks.focusedChat.activeProject = HOME_CONTAINER;
    mocks.focusedChat.activeProjectId = HOME_CONTAINER.id;

    const props = renderDialog();
    const draft = props.onDraftGithubIssue as (details: string) => Promise<void>;
    await draft("Sidebar collapsed and never came back.");

    expect(mocks.handleNewThread).toHaveBeenCalledWith(ordinary.id, {
      fresh: true,
      preserveProjectDraft: true,
    });
  });

  it("hides the draft action when no ordinary project exists", () => {
    mocks.projects = [HOME_CONTAINER];
    mocks.focusedChat.activeProject = HOME_CONTAINER;
    mocks.focusedChat.activeProjectId = HOME_CONTAINER.id;

    const props = renderDialog();

    expect(props.onDraftGithubIssue).toBeUndefined();
  });

  it("hides the draft action until threads finish hydrating", () => {
    // handleNewThread returns null while the thread store is still hydrating,
    // so the action must not be offered during that window.
    mocks.projects = [project({ id: "proj-hydrating" as Project["id"] })];
    mocks.threadsHydrated = false;

    expect(renderDialog().onDraftGithubIssue).toBeUndefined();

    mocks.threadsHydrated = true;
    expect(renderDialog().onDraftGithubIssue).toBeTypeOf("function");
  });

  it("rejects without touching the composer when the thread cannot be opened", async () => {
    const ordinary = project({ id: "proj-only" as Project["id"] });
    mocks.projects = [ordinary];
    mocks.handleNewThread.mockResolvedValue(null);
    useFeedbackDialogStore.getState().openDialog(undefined, "bug");

    const props = renderDialog();
    const draft = props.onDraftGithubIssue as (details: string) => Promise<void>;

    await expect(draft("anything")).rejects.toThrow("Could not open a draft thread.");
    expect(mocks.appendComposerPromptText).not.toHaveBeenCalled();
    // The dialog stays open so the report details are not lost on failure.
    expect(useFeedbackDialogStore.getState().isOpen).toBe(true);
  });
});
