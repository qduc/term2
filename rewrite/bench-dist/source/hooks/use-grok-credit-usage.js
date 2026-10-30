import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useSetting } from './use-setting.js';
import { getGrokCreditUsageService } from '../services/grok/grok-credit-usage-service.js';
import { GrokTokenManager } from '../providers/grok-auth.js';
const EMPTY_SNAPSHOT = { usage: null, fetchedAtMs: null };
let sharedTokenManager = null;
const resolveAccessToken = async () => {
    sharedTokenManager ??= new GrokTokenManager();
    try {
        return await sharedTokenManager.getOrRefreshAccessToken();
    }
    catch {
        // Not logged in, or the refresh failed. Either way there is nothing to
        // show and nothing worth reporting — this is a decoration.
        return null;
    }
};
const resolveAccountId = () => sharedTokenManager?.getPinnedAccountId() ?? null;
export const useGrokCreditUsage = (settingsService, isProcessing) => {
    const provider = useSetting(settingsService, 'agent.modelSelection').provider;
    const isGrok = provider === 'grok';
    const service = getGrokCreditUsageService({ resolveAccessToken, resolveAccountId });
    const snapshot = useSyncExternalStore(useCallback((listener) => service.subscribe(listener), [service]), useCallback(() => service.getSnapshot(), [service]), () => EMPTY_SNAPSHOT);
    // Seeds the value on entry so the bar is not blank for the whole first turn.
    const seededRef = useRef(false);
    useEffect(() => {
        if (!isGrok || seededRef.current)
            return;
        seededRef.current = true;
        void service.refreshIfStale();
    }, [isGrok, service]);
    // Fires on the busy → idle edge, which is one refresh per completed turn.
    const wasProcessingRef = useRef(isProcessing);
    useEffect(() => {
        const finishedTurn = wasProcessingRef.current && !isProcessing;
        wasProcessingRef.current = isProcessing;
        if (!isGrok || !finishedTurn)
            return;
        void service.refreshIfStale();
    }, [isProcessing, isGrok, service]);
    const refresh = useCallback(() => {
        if (!isGrok)
            return;
        void service.refreshIfStale({ force: true });
    }, [isGrok, service]);
    return { ...(isGrok ? snapshot : EMPTY_SNAPSHOT), refresh };
};
//# sourceMappingURL=use-grok-credit-usage.js.map