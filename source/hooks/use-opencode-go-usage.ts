import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsService } from '../services/settings/settings-service.js';
import { useSetting } from './use-setting.js';
import { fetchOpenCodeGoUsage, type OpenCodeGoUsage } from '../providers/opencode-go-usage.js';
import { decodeStoredCustomProviderConfigs } from '../services/settings/custom-provider-normalization.js';

export interface OpenCodeGoUsageHandle {
  readonly usage: OpenCodeGoUsage | null;
  readonly refresh: () => void;
}

const findConfig = (settingsService: SettingsService, provider: string) =>
  decodeStoredCustomProviderConfigs(
    typeof (settingsService as { getDynamic?: unknown }).getDynamic === 'function'
      ? settingsService.getDynamic('providers')
      : undefined,
  ).find((entry) => entry.id === provider || entry.name === provider);

export const useOpenCodeGoUsage = (settingsService: SettingsService, isProcessing: boolean): OpenCodeGoUsageHandle => {
  const provider = useSetting(settingsService, 'agent.provider') ?? '';
  const config = findConfig(settingsService, provider);
  const isGo = config?.baseUrl?.toLowerCase().includes('/zen/go/') === true;
  const apiKey = isGo ? config?.apiKey ?? process.env.OPENCODE_API_KEY : undefined;
  const [usage, setUsage] = useState<OpenCodeGoUsage | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const load = useCallback(
    (force = false) => {
      if (!apiKey || (!force && inFlight.current)) return;
      const request = fetchOpenCodeGoUsage({ apiKey })
        .then(setUsage)
        .catch(() => undefined);
      inFlight.current = request.finally(() => {
        inFlight.current = null;
      });
    },
    [apiKey],
  );
  const seeded = useRef(false);
  useEffect(() => {
    if (!isGo) {
      seeded.current = false;
      return;
    }
    if (!seeded.current) {
      seeded.current = true;
      load();
    }
  }, [isGo, load]);
  const wasProcessing = useRef(isProcessing);
  useEffect(() => {
    const finished = wasProcessing.current && !isProcessing;
    wasProcessing.current = isProcessing;
    if (isGo && finished) load();
  }, [isGo, isProcessing, load]);
  return { usage: isGo ? usage : null, refresh: () => load(true) };
};
