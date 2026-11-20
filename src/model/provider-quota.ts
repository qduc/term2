import type { CodexWeeklyQuota, ProviderStatus } from './index.js';

/** The `provider_status` the Codex adapter emits; Session reads it back with `codexQuotaStatus`. */
export function codexQuotaStatus(
  quota: CodexWeeklyQuota | null,
  fiveHourQuota: CodexWeeklyQuota | null,
): ProviderStatus {
  return { type: 'provider_status', provider: 'codex', status: { quota, fiveHourQuota } };
}

/** Session's Codex quota event from a harness `provider_status`, or undefined for any other provider. */
export function codexQuotaEvent(event: ProviderStatus):
  | {
      readonly type: 'codex_quota';
      readonly quota: CodexWeeklyQuota | null;
      readonly fiveHourQuota?: CodexWeeklyQuota | null;
    }
  | undefined {
  if (event.provider !== 'codex') return undefined;
  const status = event.status as {
    readonly quota?: CodexWeeklyQuota | null;
    readonly fiveHourQuota?: CodexWeeklyQuota | null;
  };
  return {
    type: 'codex_quota',
    quota: status.quota ?? null,
    ...('fiveHourQuota' in status ? { fiveHourQuota: status.fiveHourQuota ?? null } : {}),
  };
}

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
