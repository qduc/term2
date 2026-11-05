/**
 * Legacy source/hooks/use-first-run-setup.ts. While the main provider has no
 * credentials, keep the providers menu open, then the model picker for the
 * provider chosen, until a model selection is applied. The menus own selection,
 * editing and credential persistence; this owns only the lifecycle.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { MenuController } from './menu-types.js';
import { getModelSettingConfig } from './model-settings.js';

export type FirstRunSetupPhase = 'provider' | 'model';

/** The live session settings the gate reads: legacy's SettingsService surface. */
export type FirstRunSettings = {
  get(key: 'agent.modelSelection'): { provider?: string | null };
  hasProviderCredentials(providerId: string): boolean;
  onChange?(listener: () => void): () => void;
};

export type FirstRunSetupGate = {
  active: boolean;
  phase: FirstRunSetupPhase | null;
  provider: string;
  onProviderSelected: (provider: string) => void;
  requestSetup: (provider: string) => void;
  completeModelSelection: () => void;
};

const getMainProvider = (settings: FirstRunSettings): string =>
  settings.get('agent.modelSelection').provider || 'openai';
// No menus (a test harness or a surface without them) is never a first-run state.
const hasCredentials = (settings: FirstRunSettings | undefined, provider: string): boolean =>
  !settings || settings.hasProviderCredentials(provider);

// Programmatic bound menus must retain a real text trigger: reconciliation
// otherwise dismisses them on the next editor edit or registry refresh.
const modelTrigger = getModelSettingConfig('agent.modelSelection')!.trigger;
const modelFrame = {
  kind: 'model' as const,
  target: { type: 'setting' as const, config: getModelSettingConfig('agent.modelSelection')! },
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
  readonly settings: FirstRunSettings | undefined;
  readonly controller: MenuController;
}): FirstRunSetupGate {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const topFrame = useSyncExternalStore(subscribe, getSnapshot, getSnapshot).stack.at(-1);
  const [initialProvider] = useState(() => (settings ? getMainProvider(settings) : 'openai'));
  const [active, setActive] = useState(() => !hasCredentials(settings, initialProvider));
  const [phase, setPhase] = useState<FirstRunSetupPhase | null>(() =>
    hasCredentials(settings, initialProvider) ? null : 'provider',
  );
  const [provider, setProvider] = useState(initialProvider);
  const [settingsRevision, setSettingsRevision] = useState(0);

  useEffect(() => settings?.onChange?.(() => setSettingsRevision((revision) => revision + 1)), [settings]);

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
    if (!active && !hasCredentials(settings, currentProvider)) {
      setProvider(currentProvider);
      setActive(true);
      setPhase('provider');
      return;
    }
    if (!active || !phase) return;
    if (phase === 'provider') {
      if (hasCredentials(settings, provider)) {
        setPhase('model');
        return;
      }
      if (topFrame?.kind !== 'providers') {
        controller.closeAll();
        controller.open({ kind: 'providers' });
      }
      return;
    }
    if (!hasCredentials(settings, provider)) {
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
  }, [active, controller, phase, provider, settingsRevision, settings, topFrame]);

  const currentProvider = settings ? getMainProvider(settings) : 'openai';
  const currentProviderUnavailable = !hasCredentials(settings, currentProvider);
  const visibleActive = active || currentProviderUnavailable;
  const visiblePhase = visibleActive
    ? active && phase === 'model' && !hasCredentials(settings, provider)
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
