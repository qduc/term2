import React, { FC } from 'react';
import { Box, Text } from 'ink';
import {
  getSettingCategory,
  type SettingCompletionItem,
  type SettingsCategory,
} from '../../hooks/use-settings-completion.js';
import { MenuContainer, MenuFooter, SelectionMarker, type MenuHint } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { useTheme } from '../theme.js';
import {
  cleanSettingDescription,
  formatSettingDisplayValue,
  formatSettingValueDetail,
  truncateStart,
  truncateText,
} from './settings-value-formatter.js';

type Props = {
  items: SettingCompletionItem[];
  selectedIndex: number;
  scrollOffset?: number;
  query: string;
  isSearchingAll?: boolean;
  activeCategoryId: string;
  categories: SettingsCategory[];
  visibleCount?: number;
  /** Built-in default for a key, used to say what a changed value replaced. */
  getDefaultValue?: (key: string) => unknown;
};

/** Marker, label/value gap, changed dot, restart glyph, scrollbar, and border. */
const ROW_CHROME = 12;
const TAG_WIDTH = 10;

/**
 * Secondary detail for the selected setting. The common case (default value,
 * applies immediately) needs no line at all; only a changed value, an
 * override, or a restart requirement is worth the vertical space.
 */
function describeSettingState(
  item: SettingCompletionItem,
  getDefaultValue?: (key: string) => unknown,
): string | undefined {
  const parts: string[] = [];
  const override = item.startupOverride;
  if (override) {
    const who =
      override.source === 'env'
        ? override.name
          ? `$${override.name}`
          : 'an environment variable'
        : 'a command-line flag';
    parts.push(`set by ${who} at startup — it wins over a saved value next launch`);
  } else if (item.source === 'session') {
    parts.push('changed for this session only (not saved)');
  } else if (item.isModified && getDefaultValue) {
    parts.push(`default: ${formatSettingValueDetail(item.key, getDefaultValue(item.key))}`);
  }
  if (item.requiresRestart) parts.push('takes effect after restart');
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
  visibleCount = 10,
  getDefaultValue,
}) => {
  const theme = useTheme();
  const columns = process.stdout.columns ?? 80;
  const longestLabel = items.reduce((max, item) => Math.max(max, item.label.length), 0);
  const labelColWidth = Math.max(12, Math.min(30, longestLabel, Math.floor(columns * 0.4)));
  const tagWidth = isSearchingAll ? TAG_WIDTH : 0;
  const valueColWidth = Math.max(8, columns - labelColWidth - tagWidth - ROW_CHROME);
  const activeCategory = categories.find((category) => category.id === activeCategoryId);
  const selectedItem = items[selectedIndex];
  const stateDescription = selectedItem ? describeSettingState(selectedItem, getDefaultValue) : undefined;
  const description = selectedItem?.description ? cleanSettingDescription(selectedItem.description) : '';
  // Two lines of description at most, so the list never gets pushed off screen.
  const descriptionText = truncateText(description, Math.max(20, (columns - 6) * 2));
  const isToggle = typeof selectedItem?.currentValue === 'boolean';

  // One line at 80 columns: the ↻ glyph is explained in the detail line of
  // whichever setting carries it.
  const hints: MenuHint[] = [
    ['type', 'search'],
    ['↑↓', 'move'],
    ...(isSearchingAll ? [] : [['Tab', 'section'] as MenuHint]),
    ['⏎', isToggle ? 'toggle' : 'edit'],
    ['Esc', 'close'],
    ['●', 'changed', 'warning'],
  ];

  return (
    <Box flexDirection="column">
      {isSearchingAll ? (
        <Text color={theme.textSubtle}>Searching all settings, including advanced ones</Text>
      ) : (
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
        />
      )}
      <MenuContainer
        items={items}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        maxHeight={visibleCount}
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
                <Text color={theme.textSubtle}> · {selectedItem.key}</Text>
              </Text>
            )}
            {descriptionText && (
              <Box marginTop={1}>
                <Text color={theme.accent} italic>
                  {descriptionText}
                </Text>
              </Box>
            )}
            {stateDescription && <Text color={theme.textSubtle}>{stateDescription}</Text>}
            <Box marginTop={1}>
              <MenuFooter hints={hints} />
            </Box>
          </Box>
        }
        footerOutsideBorder={false}
        renderItem={(item, _actualIndex, isSelected) => {
          const valueObj = formatSettingDisplayValue(item.key, item.currentValue);
          const paddedLabel = truncateText(item.label, labelColWidth).padEnd(labelColWidth, ' ') + '  ';
          // Paths are most meaningful at their end; everything else at its start.
          const valueText = valueObj.text.startsWith('/')
            ? truncateStart(valueObj.text, valueColWidth)
            : truncateText(valueObj.text, valueColWidth);
          const tag = isSearchingAll ? getSettingCategory(item.key)?.label ?? 'advanced' : '';

          return (
            <Box key={item.key} width="100%">
              <SelectionMarker selected={isSelected} />
              <Text color={isSelected ? theme.accent : theme.text} bold={isSelected}>
                {paddedLabel}
              </Text>
              <Text color={theme.warning}>{item.isModified ? '● ' : '  '}</Text>
              <Box flexGrow={1}>
                <Text color={theme[valueObj.tone ?? 'textSubtle']} bold={isSelected} wrap="truncate-end">
                  {valueText}
                  {item.requiresRestart && <Text color={theme.textSubtle}> ↻</Text>}
                </Text>
              </Box>
              {tag && (
                <Box width={tagWidth} justifyContent="flex-end">
                  <Text color={theme.textSubtle} wrap="truncate-end">
                    {tag}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }}
      />
    </Box>
  );
};

export default SettingsSelectionMenu;
