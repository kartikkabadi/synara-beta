// FILE: diagnosticsSessions.ts
// Purpose: Records one session_started diagnostics event per provider session
//          by watching the normalized session slice, so every dispatch path
//          (composer, kanban, sidechat, queued sends, slash commands) counts
//          once — instead of once per composer turn.
// Layer: web diagnostics observer

import type { ThreadSession } from "./types";

// A provider session stays live from "starting" through "interrupted" — a
// steer interrupt pauses a turn; it does not tear the session down. Only a
// missing session or a stopped/error status means a later live status is a
// new provider session. A ready→starting edge is the next turn reusing the
// same session, so it must not count.
const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
]);

export function isLiveProviderSession(session: ThreadSession | null | undefined): boolean {
  return session != null && LIVE_SESSION_STATUSES.has(session.orchestrationStatus);
}

/**
 * Returns a tracker that diffs successive `threadSessionById` snapshots and
 * reports each dead→live edge once per thread. `threadIds` is the set of
 * threads the store already knows: a thread is seeded on first observation
 * without reporting, so snapshot hydration never reports provider sessions
 * that started before the renderer attached.
 */
export function createProviderSessionStartTracker(
  onSessionStart: (provider: ThreadSession["provider"]) => void,
): (input: {
  threadIds: readonly string[];
  sessionById: Record<string, ThreadSession | null> | undefined;
}) => void {
  const liveByThreadId = new Map<string, boolean>();
  return ({ threadIds, sessionById }) => {
    const seen = new Set<string>(threadIds);
    for (const threadId of Object.keys(sessionById ?? {})) seen.add(threadId);
    for (const threadId of seen) {
      const session = sessionById?.[threadId] ?? null;
      const live = isLiveProviderSession(session);
      if (liveByThreadId.get(threadId) === false && live && session !== null) {
        onSessionStart(session.provider);
      }
      liveByThreadId.set(threadId, live);
    }
    for (const threadId of [...liveByThreadId.keys()]) {
      if (!seen.has(threadId)) liveByThreadId.delete(threadId);
    }
  };
}
