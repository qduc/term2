import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { hasProviderCredentials } from '../utils/ai/provider-credentials.js';
import { getModelSettingConfig } from '../utils/ai/model-settings.js';
const getMainProvider = (settingsService) => settingsService.get('agent.modelSelection').provider || 'openai';
const hasInspectableCredentials = (settingsService, provider) => {
    // Lightweight App harnesses may intentionally provide only the read-only
    // settings surface. They cannot represent a real first-run credential state,
    // so preserve their existing bypass behavior.
    if (typeof settingsService.getDynamic !== 'function')
        return true;
    return hasProviderCredentials(settingsService, provider);
};
// Programmatic bound menus must retain a real text trigger: reconciliation
// otherwise dismisses them on the next editor edit or registry refresh.
const modelTrigger = getModelSettingConfig('agent.modelSelection').trigger;
const modelFrame = {
    kind: 'model',
    target: {
        type: 'setting',
        config: { modelKey: 'agent.modelSelection' },
    },
    back: { type: 'close-clear-input' },
    binding: {
        trigger: { range: { start: 0, end: modelTrigger.length }, text: modelTrigger },
        queryStart: modelTrigger.length,
        queryEnd: 'cursor',
        replacement: { start: 0, end: 'buffer-end' },
    },
};
/**
 * Owns the narrow first-run lifecycle. Provider/model sessions still own all
 * selection, editing, credential persistence, and typed-model behavior.
 */
export function useFirstRunSetupGate({ settingsService, controller }) {
    const subscribe = useCallback((listener) => controller.subscribe(listener), [controller]);
    const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
    const topFrame = useSyncExternalStore(subscribe, getSnapshot, getSnapshot).stack.at(-1);
    const initialProvider = useMemo(() => getMainProvider(settingsService), [settingsService]);
    const [active, setActive] = useState(() => !hasInspectableCredentials(settingsService, initialProvider));
    const [phase, setPhase] = useState(() => hasInspectableCredentials(settingsService, initialProvider) ? null : 'provider');
    const [provider, setProvider] = useState(initialProvider);
    const [settingsRevision, setSettingsRevision] = useState(0);
    useEffect(() => {
        const unsubscribe = settingsService.onChange?.(() => setSettingsRevision((revision) => revision + 1));
        return unsubscribe;
    }, [settingsService]);
    const onProviderSelected = useCallback((nextProvider) => {
        setProvider(nextProvider);
        setSettingsRevision((revision) => revision + 1);
    }, []);
    const requestSetup = useCallback((nextProvider) => {
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
        if (!active && !hasInspectableCredentials(settingsService, currentProvider)) {
            setProvider(currentProvider);
            setActive(true);
            setPhase('provider');
            return;
        }
        if (!active || !phase)
            return;
        if (phase === 'provider') {
            if (hasInspectableCredentials(settingsService, provider)) {
                setPhase('model');
                return;
            }
            if (topFrame?.kind !== 'providers') {
                controller.closeAll();
                controller.open({ kind: 'providers' });
            }
            return;
        }
        if (!hasInspectableCredentials(settingsService, provider)) {
            setPhase('provider');
            return;
        }
        if (topFrame?.kind !== 'model') {
            controller.closeAll();
            controller.replace({ ...modelFrame, defaultProvider: provider }, { buffer: { type: 'replace', text: modelTrigger, cursor: modelTrigger.length } });
        }
    }, [active, controller, phase, provider, settingsRevision, settingsService, topFrame]);
    const currentProvider = getMainProvider(settingsService);
    const currentProviderUnavailable = !hasInspectableCredentials(settingsService, currentProvider);
    const visibleActive = active || currentProviderUnavailable;
    const visiblePhase = visibleActive
        ? active && phase === 'model' && !hasInspectableCredentials(settingsService, provider)
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
//# sourceMappingURL=use-first-run-setup.js.map