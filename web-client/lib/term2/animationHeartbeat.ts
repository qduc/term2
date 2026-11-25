'use client';

const BEAT_SELECTOR = '.t2-shimmer, .t2-heartbeat';
const BEAT_DURATION_MS = 800;
const BEAT_INTERVAL_MS = 3_000;

/**
 * Drives a synchronized, duty-cycled smooth WAAPI breath across live status
 * elements (`.t2-shimmer` and `.t2-heartbeat`).
 *
 * Unlike `animation: ... infinite`, finite Web Animations finish and release
 * Chromium's `NeedsBeginFrames` subscription during the quiet interval between
 * beats, dropping GPU VSync wakeups by ~70% and total power by ~85% while
 * remaining smooth during every beat. Pauses and cancels cleanly whenever the
 * tab is hidden, the window loses focus, or reduced motion is preferred.
 */
export function startAnimationHeartbeat(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const active = new Set<Animation>();
  let timer: number | null = null;
  let windowFocused = document.hasFocus();

  const canAnimate = () =>
    !document.hidden && windowFocused && !(reducedMotion?.matches ?? false);

  const cancelAll = () => {
    for (const anim of active) {
      anim.cancel();
    }
    active.clear();
  };

  const stop = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    cancelAll();
  };

  const pulseOnce = () => {
    if (!canAnimate()) return;
    const viewportHeight = window.innerHeight || 0;
    const nodes = document.querySelectorAll<HTMLElement>(BEAT_SELECTOR);
    for (const el of nodes) {
      if (typeof el.animate !== 'function') continue;
      if (el.closest('[inert]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (viewportHeight > 0 && (rect.bottom <= 0 || rect.top >= viewportHeight)) continue;
      const anim = el.animate(
        [{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }],
        { duration: BEAT_DURATION_MS, easing: 'ease-in-out' },
      );
      active.add(anim);
      const cleanup = () => active.delete(anim);
      anim.addEventListener('finish', cleanup, { once: true });
      anim.addEventListener('cancel', cleanup, { once: true });
    }
  };

  const start = () => {
    if (timer !== null || !canAnimate()) return;
    pulseOnce();
    timer = window.setInterval(pulseOnce, BEAT_INTERVAL_MS);
  };

  const sync = () => {
    if (canAnimate()) start();
    else stop();
  };
  const onFocus = () => {
    windowFocused = true;
    sync();
  };
  const onBlur = () => {
    windowFocused = false;
    sync();
  };

  sync();
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  reducedMotion?.addEventListener?.('change', sync);

  return () => {
    stop();
    document.removeEventListener('visibilitychange', sync);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    reducedMotion?.removeEventListener?.('change', sync);
  };
}
