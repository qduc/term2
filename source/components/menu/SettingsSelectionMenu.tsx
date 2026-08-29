import React, { FC } from 'react';
import fs from 'node:fs';
import { Box, Text } from 'ink';
import {
  getSettingCategory,
  type SettingCompletionItem,
  type SettingsCategory,
} from '../../hooks/use-settings-completion.js';
import { SETTING_KEYS } from '../../services/settings/settings-service.js';
import { isSecretSetting } from '../../utils/value-suggestions.js';
import { getRtkBinaryPath } from '../../services/rtk-service.js';
import { MenuContainer } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_SUCCESS, COLOR_TEXT, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

type Props = {
  items: SettingCompletionItem[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
  isSearchingAll?: boolean;
  activeCategoryId: string;
  categories: SettingsCategory[];
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

function formatValue(
  value: string | number | boolean,
  key: string,
): {
  text: string;
  color?: string;
} {
  if (typeof value === 'boolean') {
    let text = value ? 'ON' : 'OFF';
    if (value && key === SETTING_KEYS.SHELL_USE_RTK_COMPRESSION && fs.existsSync(getRtkBinaryPath())) {
      text += ' (installed)';
    }
    return {
      text,
      color: value ? COLOR_SUCCESS : COLOR_DANGER,
    };
  }
  if (typeof value === 'number') {
    return { text: String(value), color: COLOR_WARNING };
  }
  // Secrets are shown masked or not at all — never as a truncated prefix.
  if (isSecretSetting(key)) {
    return { text: value ? '********' : '<empty>', color: COLOR_TEXT_SUBTLE };
  }
  return { text: truncate(value, 40), color: COLOR_ACCENT };
}

const VISIBLE_COUNT = 10;
const KEY_COL_WIDTH = 32;

const SettingsSelectionMenu: FC<Props> = ({
  items,
  selectedIndex,
  scrollOffset = 0,
  query,
  isSearchingAll = false,
  activeCategoryId,
  categories,
}) => {
  const activeCategory = categories.find((category) => category.id === activeCategoryId);
  const selectedItem = items[selectedIndex];

  return (
    <Box flexDirection="column">
      <ScrollableTabBar
        items={categories}
        activeItemId={activeCategoryId}
        getItemWidth={(category) => category.label.length + 2}
        renderTab={(category, isActive) => (
          <Text inverse={isActive} color={isActive ? COLOR_ACCENT : COLOR_TEXT_SUBTLE} bold={isActive}>
            {' '}
            {category.label}{' '}
          </Text>
        )}
        hint="Tab/←→ → switch section"
      />
      <MenuContainer
        items={items}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        maxHeight={VISIBLE_COUNT}
        borderColor={items.length === 0 ? COLOR_DANGER : COLOR_ACCENT}
        fallbackText={
          <Box flexDirection="column">
            <Text bold color={COLOR_DANGER}>
              No settings found
            </Text>
            <Text color={COLOR_TEXT_SUBTLE}>
              No settings match "{query}"{' '}
              {isSearchingAll ? 'in any section' : `in ${activeCategory?.label ?? 'this section'}`}
            </Text>
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
              Use <Text bold>↑↓</Text> to navigate, <Text bold>Enter</Text> to edit, <Text bold>Esc</Text> to close
            </Text>
          </Box>
        }
        footerOutsideBorder={false}
        renderItem={(item, actualIndex, isSelected) => {
          const category = getSettingCategory(item.key);
          const prevCategory = actualIndex > 0 ? getSettingCategory(items[actualIndex - 1]!.key) : null;
          const showHeader = actualIndex === scrollOffset || category.id !== prevCategory?.id;

          const valueObj = item.currentValue !== undefined ? formatValue(item.currentValue, item.key) : null;
          const paddedKey =
            item.key.length > KEY_COL_WIDTH
              ? truncate(item.key, KEY_COL_WIDTH).padEnd(KEY_COL_WIDTH, ' ')
              : item.key.padEnd(KEY_COL_WIDTH, ' ');

          return (
            <Box key={item.key} flexDirection="column">
              {showHeader && (
                <Box marginTop={actualIndex === scrollOffset ? 0 : 1} marginBottom={0}>
                  <Text color={COLOR_ACCENT} bold underline>
                    {category.label}
                  </Text>
                </Box>
              )}

              <Box>
                <Text color={isSelected ? COLOR_SUCCESS : COLOR_TEXT_SUBTLE}>{isSelected ? '▶ ' : '  '}</Text>
                <Text color={isSelected ? COLOR_SUCCESS : COLOR_TEXT} bold={isSelected}>
                  {paddedKey}
                </Text>
                {valueObj && <Text color={isSelected ? COLOR_TEXT : COLOR_TEXT_SUBTLE}>{valueObj.text}</Text>}
              </Box>
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default SettingsSelectionMenu;
