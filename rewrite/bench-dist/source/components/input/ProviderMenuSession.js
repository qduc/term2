import React, { useEffect, useMemo } from 'react';
import { useInputContext } from '../../context/InputContext.js';
import { useProviderSelection } from '../../hooks/use-provider-selection.js';
import ProviderSelectionMenu from '../menu/ProviderSelectionMenu.js';
import { applyMenuEditorEvent } from './menu-editor.js';
import { hasProviderCredentials } from '../../utils/ai/provider-credentials.js';
export const getProviderWizardPromptLabel = (phase) => {
    if (phase === 'wizard_name')
        return 'Enter Provider Name: ';
    if (phase === 'wizard_url')
        return 'Enter Base API URL: ';
    if (phase === 'wizard_key')
        return 'Enter API Key: ';
    return undefined;
};
/**
 * Controller-mounted adapter for the existing provider workflow. The hook
 * remains the owner of provider state and service policy; this component owns
 * only its lifecycle and translation from controller events.
 */
export function ProviderMenuSession({ frame, active, controller, interactions, services }) {
    const { setMenuPromptLabel } = useInputContext();
    const settingsService = services.settingsService;
    if (!settingsService) {
        throw new Error('ProviderMenuSession requires settingsService');
    }
    const onProviderSelected = services.onProviderSelected;
    const codexSelectable = Boolean(onProviderSelected) || hasProviderCredentials(settingsService, 'codex');
    const providers = useProviderSelection(settingsService, {
        onProviderSelected,
        allowCodexSelection: codexSelectable,
        onSystemMessage: services.onSystemMessage,
    });
    useEffect(() => {
        if (!active)
            return;
        setMenuPromptLabel(getProviderWizardPromptLabel(providers.phase));
        return () => setMenuPromptLabel(undefined);
    }, [active, providers.phase, setMenuPromptLabel]);
    const interaction = useMemo(() => {
        const keep = () => ({ stack: { type: 'keep' } });
        const textFromInput = (event) => event.input.kind === 'none' ? '' : event.input.text;
        return {
            handle: (event) => {
                if (!('type' in event))
                    return;
                const editingWizard = providers.phase === 'wizard_name' || providers.phase === 'wizard_url' || providers.phase === 'wizard_key';
                if (event.type === 'input' ||
                    (event.type === 'command' && (event.command === 'left' || event.command === 'right'))) {
                    if (applyMenuEditorEvent(controller, event))
                        return keep();
                }
                switch (event.type) {
                    case 'move':
                        if (event.direction === 'up')
                            providers.moveUp();
                        else if (event.direction === 'down')
                            providers.moveDown();
                        return keep();
                    case 'command':
                        if (event.command === 'backspace' || event.command === 'delete') {
                            if (editingWizard || providers.phase === 'presets')
                                applyMenuEditorEvent(controller, event);
                            else
                                providers.requestDelete();
                        }
                        return keep();
                    case 'accept':
                        if (providers.phase === 'wizard_name' ||
                            providers.phase === 'wizard_url' ||
                            providers.phase === 'wizard_key') {
                            providers.handleTextInputSubmit(textFromInput(event));
                        }
                        else {
                            providers.selectItem();
                        }
                        return keep();
                    case 'escape':
                        providers.goBack();
                        return keep();
                    default:
                        return;
                }
            },
        };
    }, [controller, providers]);
    useEffect(() => {
        if (!active)
            return;
        return interactions.register(frame.id, interaction);
    }, [active, frame.id, interaction, interactions]);
    if (!active)
        return null;
    return (React.createElement(ProviderSelectionMenu, { phase: providers.phase, presetQuery: providers.presetQuery, selectedIndex: providers.selectedIndex, scrollOffset: providers.scrollOffset, activeItems: providers.getActiveItems(), errorMessage: providers.errorMessage, fieldErrors: providers.fieldErrors, selectedProviderName: providers.selectedProviderName, draft: providers.draft, allowCodexSelection: codexSelectable }));
}
//# sourceMappingURL=ProviderMenuSession.js.map