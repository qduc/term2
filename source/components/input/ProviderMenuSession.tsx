import React, { useEffect, useMemo } from 'react';
import { useInputContext } from '../../context/InputContext.js';
import { useProviderSelection, type ProviderSelectionPhase } from '../../hooks/use-provider-selection.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import ProviderSelectionMenu from '../menu/ProviderSelectionMenu.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuEvent, MenuFrame, MenuInteraction } from './menu-types.js';

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'providers' }>>;

const getProviderWizardPromptLabel = (phase: ProviderSelectionPhase): string | undefined => {
  if (phase === 'wizard_name') return 'Enter Provider Name: ';
  if (phase === 'wizard_url') return 'Enter Base API URL: ';
  if (phase === 'wizard_key') return 'Enter API Key: ';
  return undefined;
};

/**
 * Controller-mounted adapter for the existing provider workflow. The hook
 * remains the owner of provider state and service policy; this component owns
 * only its lifecycle and translation from controller events.
 */
export function ProviderMenuSession({ frame, active, interactions, services }: Props) {
  const { setMenuPromptLabel } = useInputContext();
  const settingsService = services.settingsService as SettingsService | undefined;
  const providers = useProviderSelection(settingsService!);
  if (!settingsService) {
    throw new Error('ProviderMenuSession requires settingsService');
  }

  useEffect(() => {
    if (!active) return;
    setMenuPromptLabel(getProviderWizardPromptLabel(providers.phase));
    return () => setMenuPromptLabel(undefined);
  }, [active, providers.phase, setMenuPromptLabel]);

  const interaction = useMemo<MenuInteraction>(() => {
    const keep = (): MenuEffect => ({ stack: { type: 'keep' } });
    const textFromInput = (event: Extract<MenuEvent, { type: 'accept' }>): string =>
      event.input.kind === 'none' ? '' : event.input.text;

    return {
      handle: (event) => {
        if (!('type' in event)) return;

        switch (event.type) {
          case 'move':
            if (event.direction === 'up') providers.moveUp();
            else if (event.direction === 'down') providers.moveDown();
            return keep();
          case 'command':
            if (event.command === 'delete') providers.requestDelete();
            else if (event.command === 'reorder-up') providers.moveProviderUp();
            else if (event.command === 'reorder-down') providers.moveProviderDown();
            return keep();
          case 'accept':
            if (
              providers.phase === 'wizard_name' ||
              providers.phase === 'wizard_url' ||
              providers.phase === 'wizard_key'
            ) {
              providers.handleTextInputSubmit(textFromInput(event));
            } else {
              providers.selectItem();
            }
            return keep();
          case 'escape':
            providers.goBack();
            return keep();
        }
      },
    };
  }, [providers]);

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;

  return (
    <ProviderSelectionMenu
      phase={providers.phase}
      selectedIndex={providers.selectedIndex}
      scrollOffset={providers.scrollOffset}
      activeItems={providers.getActiveItems()}
      errorMessage={providers.errorMessage}
      fieldErrors={providers.fieldErrors}
      selectedProviderName={providers.selectedProviderName}
      draft={providers.draft}
    />
  );
}
