'use client';
import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';

/** How long newly revealed text takes to fade in. Matches `.t2-fade` in globals.css. */
export const FADE_MS = 400;
/** The reveal never runs slower than this, in characters per second. */
const MIN_RATE = 45;
/** Seconds of backlog the reveal tries to clear: the rate grows with the backlog so it never lags far behind. */
const CATCH_UP_S = 0.25;
/** Re-render at most this often; the fade itself is a CSS animation and stays smooth between renders. */
const COMMIT_MS = 32;

/** A run of characters revealed together: every character before `end` (and after the previous run) appeared at `at`. */
export type RevealBatch = { end: number; at: number };
/** What a renderer needs to fade the newest text: text before `start` is settled, later runs are still fading. */
export type RevealFade = { start: number; batches: readonly RevealBatch[]; now: number };

type RevealState = { shown: number; exact: number; fadeStart: number; batches: RevealBatch[] };

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  );
}

/** Don't split a surrogate pair: an emoji cut in half renders as a replacement glyph for a frame. */
function safeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return end + 1;
  }
  return end;
}

function prune(state: RevealState, now: number): boolean {
  let changed = false;
  while (state.batches.length > 0 && now - state.batches[0]!.at >= FADE_MS) {
    state.fadeStart = state.batches.shift()!.end;
    changed = true;
  }
  return changed;
}

/**
 * Reveals streamed text at a steady pace instead of in the provider's uneven chunks, and reports
 * which characters appeared in the last `FADE_MS` so the renderer can fade them in.
 *
 * A reply that mounts while streaming reveals from its first character; settled text shows at once.
 * When streaming stops, whatever is left shows at once too (still fading), so the finished reply
 * never waits on the animation. With reduced motion there is no pacing and no fade.
 */
export function useSmoothText(text: string, streaming: boolean): { text: string; fade: RevealFade | null } {
  const reduced = usePrefersReducedMotion();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const stateRef = useRef<RevealState | null>(null);
  // A reply that mounts while streaming reveals from its start (its first chunk is often most of a short
  // reply); text that is already settled (history, reduced motion) shows at once.
  const start = streaming && !reduced ? 0 : text.length;
  stateRef.current ??= { shown: start, exact: start, fadeStart: start, batches: [] };
  const state = stateRef.current;
  const textRef = useRef(text);
  textRef.current = text;

  // The text was replaced by a shorter one (a retry or an edit): start over from it.
  if (text.length < state.shown) {
    state.shown = state.exact = state.fadeStart = text.length;
    state.batches = [];
  }
  if (reduced) {
    state.shown = state.exact = state.fadeStart = text.length;
    state.batches = [];
  } else if (!streaming && state.shown < text.length) {
    state.batches.push({ end: text.length, at: performance.now() });
    state.shown = state.exact = text.length;
  }

  useEffect(() => {
    if (!streaming || reduced) return;
    let frame = 0;
    let last = performance.now();
    let lastCommit = 0;
    const tick = (now: number) => {
      const target = textRef.current;
      const dt = Math.min(64, now - last);
      last = now;
      let changed = prune(state, now);
      const backlog = target.length - state.exact;
      if (backlog > 0) {
        const rate = Math.max(MIN_RATE, backlog / CATCH_UP_S);
        state.exact = Math.min(target.length, state.exact + (rate * dt) / 1000);
      }
      // Commit against what is revealed, not the backlog: the last step may land on a throttled frame.
      const end = safeEnd(target, Math.floor(state.exact));
      if (end > state.shown && now - lastCommit >= COMMIT_MS) {
        state.batches.push({ end, at: now });
        state.shown = end;
        changed = true;
      }
      if (changed) {
        lastCommit = now;
        rerender();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [streaming, reduced, state]);

  // After streaming, drop the fade markup once the newest run has faded in.
  const settleFrom = !streaming && state.batches.length > 0 ? state.batches[state.batches.length - 1]!.at : null;
  useEffect(() => {
    if (settleFrom === null) return;
    const timer = window.setTimeout(
      () => {
        state.fadeStart = state.shown;
        state.batches = [];
        rerender();
      },
      Math.max(0, FADE_MS - (performance.now() - settleFrom)),
    );
    return () => window.clearTimeout(timer);
  }, [settleFrom, state]);

  const shownText = text.slice(0, state.shown);
  const fade =
    state.batches.length > 0 ? { start: state.fadeStart, batches: state.batches, now: performance.now() } : null;
  return { text: shownText, fade };
}
