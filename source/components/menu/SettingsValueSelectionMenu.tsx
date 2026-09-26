import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { isSecretSetting, isStringSetting, type SettingValueSuggestion } from '../../utils/value-suggestions.js';
import { formatSettingDisplayValue } from './settings-value-formatter.js';
import { isDurationSetting } from '../../services/settings/settings-ui-metadata.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_SUCCESS, COLOR_TEXT, COLOR_TEXT_SUBTLE } from '../theme.js';

type Props = {
  settingKey: string;
  items: SettingValueSuggestion[];
  selectedIndex: number;
  query: string;
  isNumericSettings?: boolean;
  /** Current value, already formatted for display. */
  currentText?: string;
  /** Built-in default, already formatted for display. */
  defaultText?: string;
  /** What Enter would save right now, already formatted; omitted when nothing would be saved. */
  previewText?: string;
  /** Extra input shapes the setting accepts (e.g. `5m`, `$5`). */
  unitHint?: string;
};

const SettingsValueSelectionMenu: FC<Props> = ({
  settingKey,
  items,
  selectedIndex,
  query,
  isNumericSettings,
  currentText,
  defaultText,
  previewText,
  unitHint,
}) => {
  const acceptsAnyString = isStringSetting(settingKey);
  // Strings and numbers are settable by typing, so an empty list is a
  // neutral state. Choices (enums, booleans) stay red: Enter cannot apply
  // text their schema does not accept.
  const acceptsTypedValue = acceptsAnyString || Boolean(isNumericSettings);
  const showNeutralEmpty = items.length === 0 && acceptsTypedValue;
  const selectedItem = items[selectedIndex];
  const title =
    settingKey === 'agent.reasoningEffort'
      ? 'Reasoning effort'
      : settingKey === 'shell.autoApproveMode'
      ? 'Auto-approve mode'
      : undefined;
  const canCopySuggestion = items.length > 0 && !isSecretSetting(settingKey);

  const header = (currentText !== undefined || defaultText !== undefined || unitHint) && (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={COLOR_TEXT_SUBTLE}>
        {currentText !== undefined && (
          <>
            Current: <Text color={COLOR_TEXT}>{currentText}</Text>
          </>
        )}
        {currentText !== undefined && defaultText !== undefined && ' · '}
        {defaultText !== undefined && !(settingKey === 'agent.reasoningEffort' && defaultText === 'default') && (
          <>
            Default: <Text color={COLOR_TEXT}>{defaultText}</Text>
          </>
        )}
      </Text>
      {unitHint && <Text color={COLOR_TEXT_SUBTLE}>{unitHint}</Text>}
    </Box>
  );

  const typedHint = query ? 'Enter saves what you typed' : 'Type a value, then press Enter';

  return (
    <Box flexDirection="column">
      {header}
      <MenuContainer
        items={items}
        selectedIndex={selectedIndex}
        borderColor={items.length === 0 && !showNeutralEmpty ? COLOR_DANGER : COLOR_ACCENT}
        title={title}
        fallbackText={
          showNeutralEmpty ? (
            <Box flexDirection="column">
              <Text color={COLOR_TEXT_SUBTLE}>{isNumericSettings ? 'Type a number' : 'Type a value'}</Text>
              <Text color={COLOR_TEXT_SUBTLE}>{query ? `No suggestion matches — ${typedHint}` : typedHint}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color={COLOR_DANGER} bold>
                No option matches "{query}"
              </Text>
              <Text color={COLOR_TEXT_SUBTLE}>Backspace to see all options</Text>
            </Box>
          )
        }
        footer={
          <Box flexDirection="column">
            {selectedItem?.description && (
              <Box marginBottom={0}>
                <Text color={COLOR_ACCENT} italic>
                  {selectedItem.description}
                </Text>
              </Box>
            )}
          </Box>
        }
        footerOutsideBorder={false}
        renderItem={(item, _index, isSelected) => (
          <Box key={item.value}>
            <SelectionMarker selected={isSelected} />
            <Text color={isSelected ? COLOR_ACCENT : COLOR_TEXT} bold={isSelected}>
              {isDurationSetting(settingKey)
                ? formatSettingDisplayValue(settingKey, Number(item.value)).text
                : item.value}
            </Text>
          </Box>
        )}
      />
      {/* Outside the container: MenuContainer drops its footer when the list
          is empty, which is exactly when a typed value needs the preview. */}
      {previewText !== undefined && (
        <Text color={COLOR_TEXT_SUBTLE}>
          Enter will set: <Text color={COLOR_SUCCESS}>{previewText}</Text>
        </Text>
      )}
      <MenuFooter
        hints={[
          ...(items.length > 0 ? [['↑↓', 'choose'] as const] : []),
          ['⏎', 'apply'],
          ...(canCopySuggestion ? [['Tab', 'use value'] as const] : []),
          ['Ctrl+D', `reset ${defaultText !== undefined ? `to ${defaultText}` : 'to default'}`],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
};

export default SettingsValueSelectionMenu;
