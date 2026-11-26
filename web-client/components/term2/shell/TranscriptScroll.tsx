'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useChatFacts, useSessionView, useShell, useShellEnv, useShellState } from './ShellContext';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type ScrollRefs = { scrollRef: RefObject<HTMLDivElement | null>; lastScrollTopRef: RefObject<number> };

/** Smart auto-scroll pinning: the transcript follows new output while the reader is at its end. */
export function useTranscriptScroll() {
  const { dispatch, store } = useShell();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    // A hidden transcript (settings page open) has no box; its scroll events say nothing.
    if (!el || el.clientHeight === 0) return;
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Only unpin when the reader actually scrolls up; streaming growth between frames must not
    // falsely unpin and flash the "Jump to latest" button.
    if (atBottom) {
      dispatch({ type: 'SCROLLED', pinned: true });
    } else if (!store.get().pinned || el.scrollTop < prevTop) {
      dispatch({ type: 'SCROLLED', pinned: false });
    }
  }, [dispatch, store]);
  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    dispatch({ type: 'SCROLLED', pinned: true });
  }, [dispatch]);
  return { scrollRef, lastScrollTopRef, onScroll, scrollToLatest };
}

/** Renders nothing. Keeps a pinned transcript at its end, and restores the offset settings hid. */
export function TranscriptPin({ scrollRef, lastScrollTopRef }: ScrollRefs) {
  const { settingsOpen } = useShellEnv();
  const pinned = useShellState((s) => s.pinned);
  const turns = useSessionView((v) => v.turns);
  const pendingInteraction = useSessionView((v) => v.pendingInteraction);
  const liveStatus = useChatFacts((f) => f.liveStatus);
  // Pin before browser paint so streaming growth doesn't flash at the old scrollTop for one frame.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    if (pinned && el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [turns, pendingInteraction, liveStatus, pinned, scrollRef, lastScrollTopRef]);
  // The transcript was display:none while settings was open, which loses its scroll offset.
  useIsomorphicLayoutEffect(() => {
    if (settingsOpen) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = pinned ? el.scrollHeight : lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    // Only on closing settings; `pinned` is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);
  return null;
}
