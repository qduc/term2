import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MenuController } from '../components/input/menu-types.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { getProviderLabel } from '../providers/provider-service.js';
import { hasProviderCredentials } from '../utils/ai/provider-credentials.js';

export type FirstRunSetupPhase = 'provider' | 'model';

export type FirstRunSetupGate = {
  active: boolean;
  phase: FirstRunSetupPhase | null;
  provider: string;
  onProviderSelected: (provider: string) => void;
  requestSetup: (provider: string) => void;
  completeModelSelection: () => void;
};

type Dependencies = {
  settingsService: SettingsService;
  controller: MenuController;
  applyProvider?: (provider: string) => void;
};

const getMainProvider = (settingsService: SettingsService): string => settingsService.get('agent.provider') || 'openai';

const hasInspectableCredentials = (settingsService: SettingsService, provider: string): boolean => {
  // Lightweight App harnesses may intentionally provide only the read-only
  // settings surface. They cannot represent a real first-run credential state,
  // so preserve their existing bypass behavior.
  if (typeof (settingsService as unknown as { getDynamic?: unknown }).getDynamic !== 'function') return true;
  return hasProviderCredentials(settingsService, provider);
};

const modelFrame = {
  kind: 'model' as const,
  target: {
    type: 'setting' as const,
    config: { modelKey: 'agent.model', providerKey: 'agent.provider' },
  },
  back: { type: 'close-clear-input' as const },
  binding: {
    trigger: { range: { start: 0, end: 0 }, text: '' },
    queryStart: 0,
    queryEnd: 'cursor' as const,
    replacement: { start: 0, end: 'buffer-end' as const },
  },
};

/**
 * Owns the narrow first-run lifecycle. Provider/model sessions still own all
 * selection, editing, credential persistence, and typed-model behavior.
 */
export function useFirstRunSetupGate({ settingsService, controller, applyProvider }: Dependencies): FirstRunSetupGate {
  const initialProvider = useMemo(() => getMainProvider(settingsService), [settingsService]);
  const [active, setActive] = useState(() => !hasInspectableCredentials(settingsService, initialProvider));
  const [phase, setPhase] = useState<FirstRunSetupPhase | null>(() =>
    hasInspectableCredentials(settingsService, initialProvider) ? null : 'provider',
  );
  const [provider, setProvider] = useState(initialProvider);
  const [settingsRevision, setSettingsRevision] = useState(0);

  useEffect(() => {
    const unsubscribe = settingsService.onChange?.(() => setSettingsRevision((revision) => revision + 1));
    return unsubscribe;
  }, [settingsService]);

  const onProviderSelected = useCallback(
    (nextProvider: string) => {
      setProvider(nextProvider);
      setSettingsRevision((revision) => revision + 1);
      if (nextProvider !== getMainProvider(settingsService)) {
        applyProvider?.(nextProvider);
      }
    },
    [applyProvider, settingsService],
  );

  const requestSetup = useCallback((nextProvider: string) => {
    setProvider(nextProvider);
    setActive(true);
    setPhase('provider');
  }, []);

  const completeModelSelection = useCallback(() => {
    setActive(false);
    setPhase(null);
  }, []);

  useEffect(() => {
    const currentProvider = getMainProvider(settingsService);
    if (active && currentProvider !== provider) {
      setProvider(currentProvider);
      if (phase === 'model' && !hasInspectableCredentials(settingsService, currentProvider)) {
        setPhase('provider');
      }
      return;
    }

    if (!active && !hasInspectableCredentials(settingsService, currentProvider)) {
      setProvider(currentProvider);
      setActive(true);
      setPhase('provider');
      return;
    }

    if (!active || !phase) return;

    if (phase === 'provider') {
      if (hasInspectableCredentials(settingsService, provider)) {
        setPhase('model');
        return;
      }

      const top = controller.getSnapshot().stack.at(-1);
      if (top?.kind !== 'providers') {
        controller.closeAll();
        controller.open({ kind: 'providers' });
      }
      return;
    }

    if (!hasInspectableCredentials(settingsService, currentProvider)) {
      setPhase('provider');
      return;
    }

    const top = controller.getSnapshot().stack.at(-1);
    if (top?.kind !== 'model') {
      controller.closeAll();
      controller.replace(modelFrame, { buffer: { type: 'replace', text: '', cursor: 0 } });
    }
  }, [active, controller, phase, provider, settingsRevision, settingsService]);

  const currentProvider = getMainProvider(settingsService);
  const currentProviderUnavailable = !hasInspectableCredentials(settingsService, currentProvider);
  const visibleActive = active || currentProviderUnavailable;
  const visiblePhase = visibleActive
    ? active && phase === 'model' && currentProviderUnavailable
      ? 'provider'
      : phase ?? 'provider'
    : null;

  return {
    active: visibleActive,
    phase: visiblePhase,
    provider: currentProviderUnavailable ? currentProvider : provider,
    onProviderSelected,
    requestSetup,
    completeModelSelection,
  };
}

export const describeFirstRunProvider = (provider: string): string => getProviderLabel(provider) ?? provider;
