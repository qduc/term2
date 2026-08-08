import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import SettingsValueSelectionMenu from '../menu/SettingsValueSelectionMenu.js';
import { parseSettingValue } from '../../utils/settings-command.js';
import type { useSettingsValueCompletion } from '../../hooks/use-settings-value-completion.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';

type SettingsValueState = ReturnType<typeof useSettingsValueCompletion>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'settings_value' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'settings_value' }>>['services'] & {
    settingsValue: SettingsValueState;
    settingsService: SettingsService;
  };
};

export function SettingsValueMenuSession({ frame, active, controller, interactions, services }: Props) {
  const settingsValue = services.settingsValue;
  const settingsService = services.settingsService;
  const [applyError, setApplyError] = useState<string | null>(null);

  const interaction = useMemo<MenuInteraction>(() => {
    const keep = (): MenuEffect => ({ stack: { type: 'keep' } });

    const resolveTypedOrSelectedValue = (): unknown => {
      const suggestion = settingsValue.getSelectedItem();
      const typedValueText = frame.binding.query;
      const parsedTypedValue = typedValueText ? parseSettingValue(typedValueText) : undefined;
      const parsedSuggestionValue = suggestion ? parseSettingValue(suggestion.value) : undefined;
      const shouldPreferTypedNumericValue =
        settingsValue.isNumericSettings &&
        parsedTypedValue !== undefined &&
        String(parsedTypedValue) !== suggestion?.value;

      return shouldPreferTypedNumericValue ? parsedTypedValue : parsedSuggestionValue ?? parsedTypedValue;
    };

    return {
      handle: (event) => {
        if (!('type' in event)) {
          // Correlated IntentResult for the apply-settings/reset-setting
          // intent this frame issued. Success closes through the declared
          // BackPolicy; failure reports a field error without reopening or
          // reconstructing the frame.
          if (event.ok) {
            return { stack: { type: 'close-top' } };
          }
          setApplyError(event.fieldErrors?.[frame.settingKey] ?? event.message);
          return keep();
        }

        switch (event.type) {
          case 'move':
            setApplyError(null);
            if (event.direction === 'up') settingsValue.moveUp();
            else if (event.direction === 'down') settingsValue.moveDown();
            else if (event.direction === 'home') settingsValue.moveHome();
            else if (event.direction === 'end') settingsValue.moveEnd();
            else if (event.direction === 'page-up') settingsValue.pageUp();
            else settingsValue.pageDown();
            return keep();
          case 'command': {
            setApplyError(null);
            if (event.command === 'tab') {
              const suggestion = settingsValue.getSelectedItem();
              if (!suggestion) return keep();
              const currentEditor = controller.getSnapshot().editor;
              const nextText = currentEditor.text.slice(0, frame.binding.replacement.start) + suggestion.value;
              return { buffer: { type: 'replace', text: nextText, cursor: nextText.length }, stack: { type: 'keep' } };
            }
            if (event.command === 'reset') {
              return {
                stack: { type: 'keep' },
                intent: {
                  id: `reset-setting:${frame.id}`,
                  sourceFrameId: frame.id,
                  intent: { type: 'reset-setting', key: frame.settingKey },
                },
              };
            }
            return keep();
          }
          case 'accept': {
            setApplyError(null);
            const parsedValue = resolveTypedOrSelectedValue();
            if (parsedValue === undefined) {
              return { stack: { type: 'close-top' } };
            }
            const persistence = settingsService.isRuntimeModifiable(frame.settingKey) ? 'runtime' : 'restart';
            return {
              stack: { type: 'keep' },
              intent: {
                id: `apply-settings:${frame.id}`,
                sourceFrameId: frame.id,
                intent: {
                  type: 'apply-settings',
                  changes: [{ key: frame.settingKey, value: parsedValue, persistence }],
                },
              },
            };
          }
          case 'escape':
            return { stack: { type: 'close-top' } };
        }
      },
    };
  }, [controller, frame, settingsService, settingsValue]);

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <Box flexDirection="column">
      <SettingsValueSelectionMenu
        settingKey={frame.settingKey}
        items={settingsValue.filteredEntries}
        selectedIndex={settingsValue.selectedIndex}
        query={frame.binding.query}
        isNumericSettings={settingsValue.isNumericSettings}
        isFreeFormString={settingsValue.isFreeFormString}
      />
      {applyError && <Text color="red">{applyError}</Text>}
    </Box>
  );
}
