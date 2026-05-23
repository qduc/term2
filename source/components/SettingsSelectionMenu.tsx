import React, { FC } from 'react';
import fs from 'node:fs';
import { Box, Text } from 'ink';
import {
  getSettingCategory,
  type SettingCompletionItem,
  type SettingsCategory,
} from '../hooks/use-settings-completion.js';
import { SETTING_KEYS } from '../services/settings-service.js';
import { getRtkBinaryPath } from '../services/rtk-service.js';
import { MenuContainer } from './Common/MenuContainer.js';
import { ScrollableTabBar } from './Common/ScrollableTabBar.js';

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
      color: value ? 'green' : 'red',
    };
  }
  if (typeof value === 'number') {
    return { text: String(value), color: 'yellow' };
  }
  return { text: truncate(value, 40), color: 'cyan' };
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

  return (
    <Box flexDirection="column">
      <ScrollableTabBar
        items={categories}
        activeItemId={activeCategoryId}
        getItemWidth={(category) => category.label.length + 2}
        renderTab={(category, isActive) => (
          <Text inverse={isActive} color={isActive ? 'cyan' : '#64748b'} bold={isActive}>
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
        borderColor={items.length === 0 ? 'red' : 'cyan'}
        title={
          <Box>
            <Text bold color="cyan">
              ⚙ Settings
            </Text>
            <Text color="gray"> · </Text>
            <Text color="#22d3ee">
              {isSearchingAll ? 'Searching all sections' : activeCategory?.label ?? 'Settings'}
            </Text>
            <Text color="gray"> · </Text>
            {query ? (
              <Text>
                Searching: "
                <Text color="white" bold>
                  {query}
                </Text>
                "
              </Text>
            ) : (
              <Text color="gray">Type to filter</Text>
            )}
          </Box>
        }
        headerRight={
          <Text color="#64748b">
            {items.length} item{items.length === 1 ? '' : 's'}
          </Text>
        }
        fallbackText={
          <Box flexDirection="column">
            <Text bold color="red">
              No settings found
            </Text>
            <Text color="gray">
              No settings match "{query}"{' '}
              {isSearchingAll ? 'in any section' : `in ${activeCategory?.label ?? 'this section'}`}
            </Text>
          </Box>
        }
        footer={
          <Text color="gray" dimColor>
            Use <Text bold>↑↓</Text> to navigate, <Text bold>Enter</Text> to edit, <Text bold>Esc</Text> to close
          </Text>
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
                  <Text color="#22d3ee" bold underline>
                    {category.label}
                  </Text>
                </Box>
              )}

              <Box flexDirection="column">
                <Box>
                  <Text color={isSelected ? 'green' : 'gray'}>{isSelected ? '▶ ' : '  '}</Text>
                  <Text color={isSelected ? 'green' : 'white'} bold={isSelected}>
                    {paddedKey}
                  </Text>
                  {valueObj && <Text color={isSelected ? 'white' : 'gray'}>{valueObj.text}</Text>}
                </Box>

                {isSelected && item.description && (
                  <Box marginLeft={2} marginTop={0}>
                    <Text color="#7dd3fc" dimColor italic>
                      └── {item.description}
                    </Text>
                  </Box>
                )}
              </Box>
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default SettingsSelectionMenu;
