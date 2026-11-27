'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useChatFacts, useSessionView, useShell, useShellEnv, useShellState } from './ShellContext';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type ScrollRefs = {
  scrollRef: RefObject<HTMLDivElement | null>;
  lastScrollTopRef: RefObject<number>;
  /** Counts the reader's own upward scrolls away from the bottom, so a live reply can tell it was left alone. */
  readerScrollsRef: RefObject<number>;
};

function isNearBottom(el: HTMLDivElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

export function useTranscriptScroll() {
  const { dispatch, store } = useShell();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const readerScrollsRef = useRef(0);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    // A hidden transcript (settings page open) has no box; its scroll events say nothing.
    if (!el || el.clientHeight === 0) return;
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    // Only unpin when the reader actually scrolls up; streaming growth between frames must not
    // falsely unpin and flash the "Jump to latest" button.
    if (isNearBottom(el)) {
      dispatch({ type: 'SCROLLED', pinned: true });
    } else if (!store.get().pinned || el.scrollTop < prevTop) {
      if (el.scrollTop < prevTop) readerScrollsRef.current += 1;
      dispatch({ type: 'SCROLLED', pinned: false });
    }
  }, [dispatch, store]);
  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);
  return { scrollRef, lastScrollTopRef, readerScrollsRef, onScroll, scrollToLatest };
}

/** Positions each live reply once and preserves the reading position as its text grows. */
export function TranscriptPin({ scrollRef, lastScrollTopRef, readerScrollsRef }: ScrollRefs) {
  const { dispatch } = useShell();
  const { settingsOpen } = useShellEnv();
  const pinned = useShellState((s) => s.pinned);
  const sessionId = useSessionView((v) => v.sessionId);
  const turns = useSessionView((v) => v.turns);
  const pendingInteraction = useSessionView((v) => v.pendingInteraction);
  const liveStatus = useChatFacts((f) => f.liveStatus);
  const replyRef = useRef<{ sessionId: string; turnId: string; positioned: boolean; readerScrolls: number } | null>(
    null,
  );
  const wasHiddenRef = useRef(false);

  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    const latestTurn = turns.at(-1);
    if (replyRef.current && (replyRef.current.sessionId !== sessionId || replyRef.current.turnId !== latestTurn?.turnId)) {
      replyRef.current = null;
    }
    if (!replyRef.current && (latestTurn?.status === 'streaming' || latestTurn?.status === 'pending')) {
      replyRef.current = { sessionId, turnId: latestTurn.turnId, positioned: false, readerScrolls: readerScrollsRef.current };
    }
    const reply = replyRef.current;
    const wasHidden = wasHiddenRef.current;
    wasHiddenRef.current = settingsOpen;
    if (!el || settingsOpen || el.clientHeight === 0) return;

    if (wasHidden) el.scrollTop = lastScrollTopRef.current;
    if (reply && !reply.positioned && latestTurn?.text) {
      // The reader scrolled away while the reply was on its way: they are reading something else, so the reply
      // starts where it is and the view stays put. Returning to the bottom first counts as leaving it alone.
      if (readerScrollsRef.current !== reply.readerScrolls && !isNearBottom(el)) reply.positioned = true;
    }
    if (reply && !reply.positioned && latestTurn?.text) {
      const start = el.querySelector(`[data-turn-id="${CSS.escape(reply.turnId)}"] [data-reply-start]`);
      if (start) {
        const inset = Number.parseFloat(getComputedStyle(el).paddingTop);
        el.scrollTop += start.getBoundingClientRect().top - el.getBoundingClientRect().top - inset;
        reply.positioned = true;
      }
    }

    if (reply?.positioned) {
      // The dock still needs to know when there is more output below the viewport.
      dispatch({ type: 'SCROLLED', pinned: isNearBottom(el) });
    } else if (pinned) {
      el.scrollTop = el.scrollHeight;
    }
    lastScrollTopRef.current = el.scrollTop;
  }, [dispatch, turns, pendingInteraction, liveStatus, pinned, sessionId, settingsOpen, scrollRef, lastScrollTopRef, readerScrollsRef]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    // Paced text can grow between session updates. Keep the jump button in sync without moving the viewport.
    const observer = new ResizeObserver(() => {
      if (replyRef.current?.positioned && el.clientHeight > 0) {
        dispatch({ type: 'SCROLLED', pinned: isNearBottom(el) });
      }
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dispatch, scrollRef]);
  return null;
}
