import React, { FC } from 'react';
import { Box, Text } from 'ink';
import {
  buildSettingValueSuggestions,
  isStringSetting,
  type SettingValueSuggestion,
} from '../hooks/use-settings-value-completion.js';
import { MenuContainer } from './Common/MenuContainer.js';

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
  const isFreeFormStringSetting =
    isFreeFormString ?? (isStringSetting(settingKey) && buildSettingValueSuggestions(settingKey).length === 0);

  // For free-form string settings (no predefined suggestions), show a neutral
  // message instead of a red error box — the empty state is expected.
  const showNeutralEmpty = items.length === 0 && isFreeFormStringSetting;

  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      borderColor={items.length === 0 && !showNeutralEmpty ? 'red' : 'cyan'}
      fallbackText={
        <Box flexDirection="column">
          {showNeutralEmpty ? (
            <Text color="gray">Type a value</Text>
          ) : (
            <Text color="red" bold>
              No matching values
            </Text>
          )}
          <Text color="gray">
            {settingKey} ·{' '}
            {showNeutralEmpty ? 'No predefined values — type freely' : `No values match "${query || '*'}"`}
          </Text>
          {isNumericSettings && <Text color="yellow">Note: This setting accepts numeric values.</Text>}
          {showNeutralEmpty && <Text color="yellow">Note: This setting accepts any string value.</Text>}
          <Box marginTop={1}>
            <Text color="gray">Enter → apply typed value · Esc → cancel</Text>
          </Box>
        </Box>
      }
      footer={
        <Text color="gray" dimColor>
          <Text bold>Enter</Text> confirm · <Text bold>Esc</Text> cancel · <Text bold>↑↓</Text> navigate ·{' '}
          <Text bold>Ctrl+D</Text> reset to default
        </Text>
      }
      footerOutsideBorder={false}
      renderItem={(item, _index, isSelected) => (
        <Box key={item.value}>
          <Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '▶ ' : '  '}</Text>
          <Text color={isSelected ? 'green' : 'white'} bold={isSelected}>
            {item.value}
          </Text>
          {item.description && <Text color="gray"> — {item.description}</Text>}
        </Box>
      )}
    />
  );
};

export default SettingsValueSelectionMenu;
