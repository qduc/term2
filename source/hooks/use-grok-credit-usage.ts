import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { SettingsService } from '../services/settings/settings-service.js';
import { useSetting } from './use-setting.js';
import { getGrokCreditUsageService, type GrokCreditUsageSnapshot } from '../services/grok/grok-credit-usage-service.js';
import { GrokTokenManager } from '../providers/grok-auth.js';

const EMPTY_SNAPSHOT: GrokCreditUsageSnapshot = { usage: null, fetchedAtMs: null };

let sharedTokenManager: GrokTokenManager | null = null;
const resolveAccessToken = async (): Promise<string | null> => {
  sharedTokenManager ??= new GrokTokenManager();
  try {
    return await sharedTokenManager.getOrRefreshAccessToken();
  } catch {
    // Not logged in, or the refresh failed. Either way there is nothing to
    // show and nothing worth reporting — this is a decoration.
    return null;
  }
};

const resolveAccountId = (): string | null => sharedTokenManager?.getPinnedAccountId() ?? null;

/**
 * Keeps Grok's credit meter current for the status bar.
 *
 * Refreshes when a turn finishes rather than on a timer, so an idle terminal
 * makes no requests at all and a busy one refreshes at most once per cooldown.
 * End-of-turn is also the moment the number can have changed *and* the moment
 * the user can see it.
 *
 * Only the interactive session runs this hook, so background subagents finishing
 * their own turns never trigger a fetch; the service's single-flight guard is
 * the backstop rather than the primary defence.
 */
export interface GrokCreditUsageHandle extends GrokCreditUsageSnapshot {
  /** Refreshes now, ignoring the cooldown. For an explicit user request. */
  readonly refresh: () => void;
}

export const useGrokCreditUsage = (settingsService: SettingsService, isProcessing: boolean): GrokCreditUsageHandle => {
  const provider = useSetting(settingsService, 'agent.provider');
  const isGrok = provider === 'grok';

  const service = getGrokCreditUsageService({ resolveAccessToken, resolveAccountId });

  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => service.subscribe(listener), [service]),
    useCallback(() => service.getSnapshot(), [service]),
    () => EMPTY_SNAPSHOT,
  );

  // Seeds the value on entry so the bar is not blank for the whole first turn.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!isGrok || seededRef.current) return;
    seededRef.current = true;
    void service.refreshIfStale();
  }, [isGrok, service]);

  // Fires on the busy → idle edge, which is one refresh per completed turn.
  const wasProcessingRef = useRef(isProcessing);
  useEffect(() => {
    const finishedTurn = wasProcessingRef.current && !isProcessing;
    wasProcessingRef.current = isProcessing;
    if (!isGrok || !finishedTurn) return;
    void service.refreshIfStale();
  }, [isProcessing, isGrok, service]);

  const refresh = useCallback(() => {
    if (!isGrok) return;
    void service.refreshIfStale({ force: true });
  }, [isGrok, service]);

  return { ...(isGrok ? snapshot : EMPTY_SNAPSHOT), refresh };
};
