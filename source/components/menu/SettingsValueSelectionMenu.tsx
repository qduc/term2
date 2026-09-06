import React, { FC } from 'react';
import { Box, Text } from 'ink';
import {
  buildSettingValueSuggestions,
  isStringSetting,
  type SettingValueSuggestion,
} from '../../utils/value-suggestions.js';
import { MenuContainer } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_SUCCESS, COLOR_TEXT, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

type Props = {
  settingKey: string;
  items: SettingValueSuggestion[];
  selectedIndex: number;
  query: string;
  isNumericSettings?: boolean;
  isFreeFormString?: boolean;
};

const SettingsValueSelectionMenu: FC<Props> = ({
  settingKey,
  items,
  selectedIndex,
  query,
  isNumericSettings,
  isFreeFormString,
}) => {
  const acceptsAnyString = isStringSetting(settingKey);
  const isFreeFormStringSetting =
    isFreeFormString ?? (acceptsAnyString && buildSettingValueSuggestions(settingKey).length === 0);

  // A string value is always settable by typing, so an empty list is an
  // expected, neutral state — never a red picker error. Choices (enums,
  // booleans) keep the red "No matching values" because Enter cannot apply
  // text their schema does not accept.
  const showNeutralEmpty = items.length === 0 && acceptsAnyString;
  const selectedItem = items[selectedIndex];

  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      borderColor={items.length === 0 && !showNeutralEmpty ? COLOR_DANGER : COLOR_ACCENT}
      fallbackText={
        <Box flexDirection="column">
          {showNeutralEmpty ? (
            <Text color={COLOR_TEXT_SUBTLE}>Type a value</Text>
          ) : (
            <Text color={COLOR_DANGER} bold>
              No matching values
            </Text>
          )}
          <Text color={COLOR_TEXT_SUBTLE}>
            {settingKey} ·{' '}
            {showNeutralEmpty
              ? isFreeFormStringSetting
                ? 'No predefined values — type freely'
                : `No value matches "${query || '*'}" — Enter applies the typed value`
              : `No values match "${query || '*'}"`}
          </Text>
          {isNumericSettings && <Text color={COLOR_WARNING}>Note: This setting accepts numeric values.</Text>}
          {showNeutralEmpty && <Text color={COLOR_WARNING}>Note: This setting accepts any string value.</Text>}
          <Box marginTop={1}>
            <Text color={COLOR_TEXT_SUBTLE}>Enter → apply typed value · Esc → cancel</Text>
          </Box>
        </Box>
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
          <Text color={COLOR_TEXT_SUBTLE} dimColor>
            <Text bold>Enter</Text> confirm · <Text bold>Esc</Text> cancel · <Text bold>↑↓</Text> navigate ·{' '}
            <Text bold>Ctrl+D</Text> reset to default
          </Text>
        </Box>
      }
      footerOutsideBorder={false}
      renderItem={(item, _index, isSelected) => (
        <Box key={item.value}>
          <Text color={isSelected ? COLOR_SUCCESS : COLOR_TEXT_SUBTLE}>{isSelected ? '▶ ' : '  '}</Text>
          <Text color={isSelected ? COLOR_SUCCESS : COLOR_TEXT} bold={isSelected}>
            {item.value}
          </Text>
        </Box>
      )}
    />
  );
};

export default SettingsValueSelectionMenu;
