'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useChatFacts, useSessionView, useShell, useShellEnv, useShellState } from './ShellContext';

type ScrollRefs = { scrollRef: RefObject<HTMLDivElement | null>; lastScrollTopRef: RefObject<number> };

/** Smart auto-scroll pinning: the transcript follows new output while the reader is at its end. */
export function useTranscriptScroll() {
  const { dispatch } = useShell();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    // A hidden transcript (settings page open) has no box; its scroll events say nothing.
    if (!el || el.clientHeight === 0) return;
    lastScrollTopRef.current = el.scrollTop;
    dispatch({ type: 'SCROLLED', pinned: el.scrollHeight - el.scrollTop - el.clientHeight < 80 });
  }, [dispatch]);
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
  const visibleLiveStatus = useChatFacts((f) => f.visibleLiveStatus);
  useEffect(() => {
    const el = scrollRef.current;
    if (pinned && el) el.scrollTop = el.scrollHeight;
  }, [turns, pendingInteraction, visibleLiveStatus, pinned, scrollRef]);
  // The transcript was display:none while settings was open, which loses its scroll offset.
  useEffect(() => {
    if (settingsOpen) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = pinned ? el.scrollHeight : lastScrollTopRef.current;
    // Only on closing settings; `pinned` is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);
  return null;
}
