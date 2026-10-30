import React from 'react';
import { Box, Text } from 'ink';
import { getSettingCategory, } from '../../hooks/use-settings-completion.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { ScrollableTabBar } from '../common/ScrollableTabBar.js';
import { useTheme } from '../theme.js';
import { cleanSettingDescription, formatSettingDisplayValue, formatSettingValueDetail, truncateStart, truncateText, } from './settings-value-formatter.js';
/** Marker, label/value gap, changed dot, restart glyph, scrollbar, and border. */
const ROW_CHROME = 12;
const TAG_WIDTH = 10;
/**
 * Secondary detail for the selected setting. The common case (default value,
 * applies immediately) needs no line at all; only a changed value, an
 * override, or a restart requirement is worth the vertical space.
 */
function describeSettingState(item, getDefaultValue) {
    const parts = [];
    const override = item.startupOverride;
    if (override) {
        const who = override.source === 'env'
            ? override.name
                ? `$${override.name}`
                : 'an environment variable'
            : 'a command-line flag';
        parts.push(`set by ${who} at startup — it wins over a saved value next launch`);
    }
    else if (item.source === 'cli') {
        parts.push('set by a command-line flag for this session');
    }
    else if (item.isModified && getDefaultValue) {
        parts.push(`default: ${formatSettingValueDetail(item.key, getDefaultValue(item.key))}`);
    }
    if (item.requiresRestart)
        parts.push('takes effect after restart');
    return parts.length > 0 ? parts.join(' · ') : undefined;
}
const SettingsSelectionMenu = ({ items, selectedIndex, scrollOffset = 0, query, isSearchingAll = false, activeCategoryId, categories, visibleCount = 10, getDefaultValue, }) => {
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
    const hints = [
        ['type', 'search'],
        ['↑↓', 'move'],
        ...(isSearchingAll ? [] : [['Tab', 'section']]),
        ['⏎', isToggle ? 'toggle' : 'edit'],
        ['Esc', 'close'],
        ['●', 'changed', 'warning'],
    ];
    return (React.createElement(Box, { flexDirection: "column" },
        isSearchingAll ? (React.createElement(Text, { color: theme.textSubtle }, "Searching all settings, including advanced ones")) : (React.createElement(ScrollableTabBar, { items: categories, activeItemId: activeCategoryId, getItemWidth: (category) => category.label.length + 2, renderTab: (category, isActive) => (React.createElement(Text, { inverse: isActive, color: isActive ? theme.accent : theme.textSubtle, bold: isActive },
                ' ',
                category.label,
                ' ')) })),
        React.createElement(MenuContainer, { items: items, selectedIndex: selectedIndex, scrollOffset: scrollOffset, maxHeight: visibleCount, borderColor: theme.accent, fallbackText: React.createElement(Box, { flexDirection: "column" },
                React.createElement(Text, { color: theme.textSubtle }, "No settings found"),
                React.createElement(Text, { color: theme.textSubtle },
                    "No settings match \"",
                    query,
                    "\"",
                    ' ',
                    isSearchingAll ? 'in any section' : `in ${activeCategory?.label ?? 'this section'}`)), footer: React.createElement(Box, { flexDirection: "column" },
                selectedItem && (React.createElement(Text, null,
                    React.createElement(Text, { color: theme.text, bold: true }, selectedItem.label),
                    React.createElement(Text, { color: theme.textSubtle },
                        " \u00B7 ",
                        selectedItem.key))),
                descriptionText && (React.createElement(Box, { marginTop: 1 },
                    React.createElement(Text, { color: theme.accent, italic: true }, descriptionText))),
                stateDescription && React.createElement(Text, { color: theme.textSubtle }, stateDescription),
                React.createElement(Box, { marginTop: 1 },
                    React.createElement(MenuFooter, { hints: hints }))), footerOutsideBorder: false, renderItem: (item, _actualIndex, isSelected) => {
                const valueObj = formatSettingDisplayValue(item.key, item.currentValue);
                const paddedLabel = truncateText(item.label, labelColWidth).padEnd(labelColWidth, ' ') + '  ';
                // Paths are most meaningful at their end; everything else at its start.
                const valueText = valueObj.text.startsWith('/')
                    ? truncateStart(valueObj.text, valueColWidth)
                    : truncateText(valueObj.text, valueColWidth);
                const tag = isSearchingAll ? getSettingCategory(item.key)?.label ?? 'advanced' : '';
                return (React.createElement(Box, { key: item.key, width: "100%" },
                    React.createElement(SelectionMarker, { selected: isSelected }),
                    React.createElement(Text, { color: isSelected ? theme.accent : theme.text, bold: isSelected }, paddedLabel),
                    React.createElement(Text, { color: theme.warning }, item.isModified ? '● ' : '  '),
                    React.createElement(Box, { flexGrow: 1 },
                        React.createElement(Text, { color: theme[valueObj.tone ?? 'textSubtle'], bold: isSelected, wrap: "truncate-end" },
                            valueText,
                            item.requiresRestart && React.createElement(Text, { color: theme.textSubtle }, " \u21BB"))),
                    tag && (React.createElement(Box, { width: tagWidth, justifyContent: "flex-end" },
                        React.createElement(Text, { color: theme.textSubtle, wrap: "truncate-end" }, tag)))));
            } })));
};
export default SettingsSelectionMenu;
//# sourceMappingURL=SettingsSelectionMenu.js.map