import React, { FC } from 'react';
import { Box, Text } from 'ink';
import {
  getSettingCategory,
  type SettingCompletionItem,
  type SettingsCategory,
} from '../../hooks/use-settings-completion.js';
import { MenuContainer } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_SUCCESS, COLOR_TEXT, COLOR_TEXT_SUBTLE } from '../theme.js';
import { formatSettingDisplayValue, truncate } from './settings-value-formatter.js';

type Props = {
  items: SettingCompletionItem[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
  isSearchingAll?: boolean;
  activeCategoryId: string;
  categories: SettingsCategory[];
};

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

          const valueObj = formatSettingDisplayValue(item.key, item.currentValue);
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
                {valueObj && (
                  <Text color={isSelected ? COLOR_TEXT : valueObj.color ?? COLOR_TEXT_SUBTLE}>{valueObj.text}</Text>
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
