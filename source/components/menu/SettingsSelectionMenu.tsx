import React, { FC } from 'react';
import { Box, Text } from 'ink';
import {
  getSettingCategory,
  type SettingCompletionItem,
  type SettingsCategory,
} from '../../hooks/use-settings-completion.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_TEXT, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';
import { formatSettingDisplayValue, truncateKeepingTail } from './settings-value-formatter.js';

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

const SOURCE_LABELS: Record<NonNullable<SettingCompletionItem['source']>, string> = {
  default: 'default value',
  config: 'set in settings file',
  env: 'set by environment variable',
  cli: 'set by command-line flag',
};

function describeSettingState(item: SettingCompletionItem): string {
  const parts: string[] = [];
  if (item.source) parts.push(SOURCE_LABELS[item.source]);
  parts.push(item.requiresRestart ? 'applies after restart' : 'applies immediately');
  return parts.join(' · ');
}
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
            {selectedItem && (
              <Text color={COLOR_TEXT} bold>
                {selectedItem.key}
              </Text>
            )}
            {selectedItem?.description && (
              <Box marginBottom={0}>
                <Text color={COLOR_ACCENT} italic>
                  {selectedItem.description}
                </Text>
              </Box>
            )}
            {selectedItem && <Text color={COLOR_TEXT_SUBTLE}>{describeSettingState(selectedItem)}</Text>}
            <MenuFooter
              hints={[
                ['type', 'to search all sections'],
                ['↑↓', 'navigate'],
                ['⏎', 'edit'],
                ['esc', 'close'],
                ['●', 'changed', COLOR_WARNING],
                ['↻', 'needs restart'],
              ]}
            />
          </Box>
        }
        footerOutsideBorder={false}
        renderItem={(item, actualIndex, isSelected) => {
          const category = getSettingCategory(item.key);
          const prevCategory = actualIndex > 0 ? getSettingCategory(items[actualIndex - 1]!.key) : null;
          // A filter query searches all sections and ranks by relevance, so the
          // category boundaries carry no meaning there — render a flat list.
          const showHeader = !isSearchingAll && (actualIndex === scrollOffset || category.id !== prevCategory?.id);

          const valueObj = formatSettingDisplayValue(item.key, item.currentValue);
          // Keep the tail of long keys: the leaf name is what tells siblings apart.
          const paddedKey = truncateKeepingTail(item.key, KEY_COL_WIDTH).padEnd(KEY_COL_WIDTH, ' ');
          const isChanged = item.source !== undefined && item.source !== 'default';

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
                <SelectionMarker selected={isSelected} />
                <Text color={isSelected ? COLOR_ACCENT : COLOR_TEXT} bold={isSelected}>
                  {paddedKey}
                </Text>
                <Text color={COLOR_WARNING}>{isChanged ? '● ' : '  '}</Text>
                {valueObj && (
                  <Text color={valueObj.color ?? COLOR_TEXT_SUBTLE} bold={isSelected}>
                    {valueObj.text}
                  </Text>
                )}
                {item.requiresRestart && <Text color={COLOR_TEXT_SUBTLE}> ↻</Text>}
              </Box>
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default SettingsSelectionMenu;
