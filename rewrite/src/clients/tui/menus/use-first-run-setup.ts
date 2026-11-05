/**
 * Port of legacy source/hooks/use-first-run-setup.ts. When the main provider has no credentials (a first run, or
 * a resumed session whose recorded provider is not configured), the providers menu and then the model menu stay
 * open until a model is chosen. Esc closes a frame, and the gate opens it again.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { MenuController } from './menu-types.js';
import { getModelSettingConfig } from './model-settings.js';

export type FirstRunSetupPhase = 'provider' | 'model';

export type FirstRunSetupGate = {
  active: boolean;
  phase: FirstRunSetupPhase | null;
  provider: string;
  onProviderSelected: (provider: string) => void;
  requestSetup: (provider: string) => void;
  completeModelSelection: () => void;
};

/** What the gate reads from the attached session's live settings. */
export type FirstRunSettings = {
  get(key: 'agent.modelSelection'): { provider?: string } | undefined;
  onChange?(listener: (key?: string) => void): () => void;
  hasProviderCredentials(providerId: string): boolean;
};

const getMainProvider = (settings: FirstRunSettings): string =>
  settings.get('agent.modelSelection')?.provider || 'openai';

// Programmatic bound menus must retain a real text trigger: reconciliation
// otherwise dismisses them on the next editor edit or registry refresh.
const modelTrigger = getModelSettingConfig('agent.modelSelection')!.trigger;
const modelFrame = {
  kind: 'model' as const,
  target: {
    type: 'setting' as const,
    config: { modelKey: 'agent.modelSelection' },
  },
  back: { type: 'close-clear-input' as const },
  binding: {
    trigger: { range: { start: 0, end: modelTrigger.length }, text: modelTrigger },
    queryStart: modelTrigger.length,
    queryEnd: 'cursor' as const,
    replacement: { start: 0, end: 'buffer-end' as const },
  },
};

export function useFirstRunSetupGate({
  settings,
  controller,
}: {
  settings: FirstRunSettings | undefined;
  controller: MenuController;
}): FirstRunSetupGate {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const topFrame = useSyncExternalStore(subscribe, getSnapshot, getSnapshot).stack.at(-1);
  // Without menus there is no picker to force, as legacy's harnesses without a settings surface.
  const hasCredentials = useCallback(
    (provider: string) => (settings ? settings.hasProviderCredentials(provider) : true),
    [settings],
  );
  const initialProvider = useMemo(() => (settings ? getMainProvider(settings) : 'openai'), [settings]);
  const [active, setActive] = useState(() => !hasCredentials(initialProvider));
  const [phase, setPhase] = useState<FirstRunSetupPhase | null>(() =>
    hasCredentials(initialProvider) ? null : 'provider',
  );
  const [provider, setProvider] = useState(initialProvider);
  const [settingsRevision, setSettingsRevision] = useState(0);

  useEffect(() => {
    const unsubscribe = settings?.onChange?.(() => setSettingsRevision((revision) => revision + 1));
    return unsubscribe;
  }, [settings]);

  const onProviderSelected = useCallback((nextProvider: string) => {
    setProvider(nextProvider);
    setSettingsRevision((revision) => revision + 1);
  }, []);

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
    if (!settings) return;
    const currentProvider = getMainProvider(settings);

    if (!active && !hasCredentials(currentProvider)) {
      setProvider(currentProvider);
      setActive(true);
      setPhase('provider');
      return;
    }

    if (!active || !phase) return;

    if (phase === 'provider') {
      if (hasCredentials(provider)) {
        setPhase('model');
        return;
      }

      if (topFrame?.kind !== 'providers') {
        controller.closeAll();
        controller.open({ kind: 'providers' });
      }
      return;
    }

    if (!hasCredentials(provider)) {
      setPhase('provider');
      return;
    }

    if (topFrame?.kind !== 'model') {
      controller.closeAll();
      controller.replace(
        { ...modelFrame, defaultProvider: provider },
        { buffer: { type: 'replace', text: modelTrigger, cursor: modelTrigger.length } },
      );
    }
  }, [active, controller, phase, provider, settingsRevision, settings, hasCredentials, topFrame]);

  const currentProvider = settings ? getMainProvider(settings) : provider;
  const currentProviderUnavailable = !hasCredentials(currentProvider);
  const visibleActive = active || currentProviderUnavailable;
  const visiblePhase = visibleActive
    ? active && phase === 'model' && !hasCredentials(provider)
      ? 'provider'
      : phase ?? 'provider'
    : null;

  return {
    active: visibleActive,
    phase: visiblePhase,
    provider: active ? provider : currentProvider,
    onProviderSelected,
    requestSetup,
    completeModelSelection,
  };
}
