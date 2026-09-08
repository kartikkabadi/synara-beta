// FILE: useTransientPresentation.ts
// Purpose: Keeps a transient status surface mounted through the shared-disclosure
//   open/close animation as its owning state appears and clears.
// Layer: Chat presentation lifecycle
// Exports: TransientPresentation, useTransientPresentation, reconcileTransientPresentation
//
// Used by the transcript-tail transient rows (worktree setup) and the floating
// thread-error card: both need to stay mounted for one close animation after the
// state that created them goes away, and the floating card additionally animates
// its entrance (mount closed, flip open on the next frame).

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";

export interface TransientPresentation<T> {
  snapshot: T;
  open: boolean;
}

// Keeps a transient surface mounted through one shared-disclosure close animation
// after the owning state clears, mirroring useSettledTurnCollapseTransitions'
// rAF-flip + delayed-cleanup shape. `animateOpen` also gives the entrance the same
// motion: mount closed, then flip open on the next frame.
export function useTransientPresentation<T>(
  value: T | null,
  options?: { animateOpen?: boolean },
): TransientPresentation<T> | null {
  const animateOpen = options?.animateOpen === true;
  const [presented, setPresented] = useState<TransientPresentation<T> | null>(null);
  const openFrameRef = useRef<number | null>(null);
  const closeFrameRef = useRef<number | null>(null);
  const cleanupTimeoutRef = useRef<number | null>(null);

  const clearCloseTimers = useCallback(() => {
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
    if (closeFrameRef.current !== null) {
      window.cancelAnimationFrame(closeFrameRef.current);
      closeFrameRef.current = null;
    }
    if (cleanupTimeoutRef.current !== null) {
      window.clearTimeout(cleanupTimeoutRef.current);
      cleanupTimeoutRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    reconcileTransientPresentation({
      value,
      presented,
      animateOpen,
      clearCloseTimers,
      openFrameRef,
      closeFrameRef,
      cleanupTimeoutRef,
      setPresented,
    });
  }, [value, presented, animateOpen, clearCloseTimers]);

  useLayoutEffect(() => clearCloseTimers, [clearCloseTimers]);

  return presented;
}

// Opens on a rAF flip when `animateOpen` is set so the entrance transition runs,
// and hands the close off to a rAF-flip + delayed unmount. Isolated in a module
// helper (not compiled) so the synchronous setState stays out of the compiled
// hook while its exact ordering against the frames/timers is preserved.
export function reconcileTransientPresentation<T>(params: {
  value: T | null;
  presented: TransientPresentation<T> | null;
  animateOpen: boolean;
  clearCloseTimers: () => void;
  openFrameRef: RefObject<number | null>;
  closeFrameRef: RefObject<number | null>;
  cleanupTimeoutRef: RefObject<number | null>;
  setPresented: Dispatch<SetStateAction<TransientPresentation<T> | null>>;
}): void {
  const {
    value,
    presented,
    animateOpen,
    clearCloseTimers,
    openFrameRef,
    closeFrameRef,
    cleanupTimeoutRef,
    setPresented,
  } = params;
  if (value !== null) {
    clearCloseTimers();
    if (!animateOpen) {
      setPresented((current) =>
        current?.open && current.snapshot === value ? current : { snapshot: value, open: true },
      );
      return;
    }
    // Mount closed so the disclosure transition runs from 0fr -> 1fr on the flip.
    setPresented((current) => {
      if (current == null) return { snapshot: value, open: false };
      if (current.snapshot === value) return current;
      // A replacement value while open swaps the card content in place instead of
      // bouncing a close+open; a mid-entrance snapshot stays closed until the flip.
      return current.open
        ? { snapshot: value, open: true }
        : { snapshot: value, open: false };
    });
    if (openFrameRef.current === null) {
      openFrameRef.current = window.requestAnimationFrame(() => {
        openFrameRef.current = null;
        setPresented((current) => (current ? { ...current, open: true } : current));
      });
    }
    return;
  }
  if (!presented) {
    return;
  }
  // A pending entrance flip must not outlive the cleared value.
  if (openFrameRef.current !== null) {
    window.cancelAnimationFrame(openFrameRef.current);
    openFrameRef.current = null;
  }
  if (!presented.open) {
    // Never became visible — drop it without a close animation.
    setPresented(null);
    return;
  }
  if (closeFrameRef.current !== null) {
    return;
  }
  closeFrameRef.current = window.requestAnimationFrame(() => {
    closeFrameRef.current = null;
    setPresented((current) => (current?.open ? { ...current, open: false } : current));
    cleanupTimeoutRef.current = window.setTimeout(() => {
      cleanupTimeoutRef.current = null;
      setPresented(null);
    }, DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
  });
}
