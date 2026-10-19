import React, { FC } from 'react';
import { Box, Text } from 'ink';
import {
  getSettingCategory,
  type SettingCompletionItem,
  type SettingsCategory,
} from '../../hooks/use-settings-completion.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { useTheme } from '../theme.js';
import { formatSettingDisplayValue, truncateText } from './settings-value-formatter.js';

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

/**
 * Secondary detail for the selected setting. The common case (default value,
 * applies immediately) needs no line at all; only a changed source or a
 * restart requirement is worth the vertical space.
 */
function describeSettingState(item: SettingCompletionItem): string | undefined {
  const parts: string[] = [];
  if (item.source && item.source !== 'default') parts.push(SOURCE_LABELS[item.source]);
  if (item.requiresRestart) parts.push('needs restart');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
const SettingsSelectionMenu: FC<Props> = ({
  items,
  selectedIndex,
  scrollOffset = 0,
  query,
  isSearchingAll = false,
  activeCategoryId,
  categories,
}) => {
  const theme = useTheme();
  const labelColWidth = Math.max(12, Math.min(32, (process.stdout.columns ?? 80) - 48));
  const activeCategory = categories.find((category) => category.id === activeCategoryId);
  const selectedItem = items[selectedIndex];
  const stateDescription = selectedItem ? describeSettingState(selectedItem) : undefined;

  return (
    <Box flexDirection="column">
      <ScrollableTabBar
        items={categories}
        activeItemId={activeCategoryId}
        getItemWidth={(category) => category.label.length + 2}
        renderTab={(category, isActive) => (
          <Text inverse={isActive} color={isActive ? theme.accent : theme.textSubtle} bold={isActive}>
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
        borderColor={theme.accent}
        fallbackText={
          <Box flexDirection="column">
            <Text color={theme.textSubtle}>No settings found</Text>
            <Text color={theme.textSubtle}>
              No settings match "{query}"{' '}
              {isSearchingAll ? 'in any section' : `in ${activeCategory?.label ?? 'this section'}`}
            </Text>
          </Box>
        }
        footer={
          <Box flexDirection="column">
            {selectedItem && (
              <Text>
                <Text color={theme.text} bold>
                  {selectedItem.label}
                </Text>
                <Text color={theme.textSubtle}> {selectedItem.key}</Text>
              </Text>
            )}
            {selectedItem?.description && (
              <Text color={theme.accent} italic wrap="truncate-end">
                {selectedItem.description}
              </Text>
            )}
            {stateDescription && <Text color={theme.textSubtle}>{stateDescription}</Text>}
            <MenuFooter
              hints={[
                ['type', 'search all'],
                ['↑↓', 'move'],
                ['⏎', 'edit'],
                ['Esc', 'close'],
                ['●', 'changed', 'warning'],
                ['↻', 'restart'],
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
          const paddedLabel = truncateText(item.label, labelColWidth).padEnd(labelColWidth, ' ') + ' ';
          const isChanged = item.source !== undefined && item.source !== 'default';

          return (
            <Box key={item.key} flexDirection="column">
              {showHeader && (
                <Box marginTop={actualIndex === scrollOffset ? 0 : 1} marginBottom={0}>
                  <Text color={theme.accent} bold underline>
                    {category.label}
                  </Text>
                </Box>
              )}

              <Box>
                <SelectionMarker selected={isSelected} />
                <Text color={isSelected ? theme.accent : theme.text} bold={isSelected}>
                  {paddedLabel}
                </Text>
                <Text color={theme.warning}>{isChanged ? '● ' : '  '}</Text>
                {valueObj && (
                  <Text color={theme[valueObj.tone ?? 'textSubtle']} bold={isSelected}>
                    {valueObj.text}
                  </Text>
                )}
                {item.requiresRestart && <Text color={theme.textSubtle}> ↻</Text>}
              </Box>
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default SettingsSelectionMenu;
