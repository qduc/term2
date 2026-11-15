import type { CodexWeeklyQuota } from './index.js';

type Window = { readonly window_minutes: number; readonly used_percent: number; readonly reset_at: number };

/** Only report a real, unexpired weekly provider observation. */
export function weeklyQuota(
  info: { readonly primary?: Window; readonly secondary?: Window } | null | undefined,
): CodexWeeklyQuota | null {
  return windowQuota(info, 10080);
}

/** Only report a real, unexpired five-hour provider observation. */
export function fiveHourQuota(
  info: { readonly primary?: Window; readonly secondary?: Window } | null | undefined,
): CodexWeeklyQuota | null {
  return windowQuota(info, 300);
}

function windowQuota(
  info: { readonly primary?: Window; readonly secondary?: Window } | null | undefined,
  minutes: number,
): CodexWeeklyQuota | null {
  const quota = [info?.primary, info?.secondary].find(
    (window) =>
      window?.window_minutes === minutes &&
      Number.isFinite(window.used_percent) &&
      window.used_percent >= 0 &&
      window.used_percent <= 100 &&
      Number.isFinite(window.reset_at) &&
      window.reset_at > Date.now() / 1000 &&
      Number.isFinite(new Date(window.reset_at * 1000).getTime()),
  );
  return quota ? { usedPercent: quota.used_percent, resetAt: quota.reset_at } : null;
}
