import React from 'react';
import { Box, Text } from 'ink';
import { REWIND_MENU_VISIBLE_ITEMS } from '../../hooks/use-rewind-selection.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
/**
 * Rows are two lines plus a separator, so fewer fit on screen than in a
 * single-line menu without pushing the transcript out of view.
 */
export const MAX_VISIBLE_ITEMS = REWIND_MENU_VISIBLE_ITEMS;
const TRUNCATE_LENGTH = 64;
/** Naming two files is concrete; naming ten is noise. */
const MAX_NAMED_FILES = 2;
const truncate = (text, maxLength) => {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= maxLength)
        return oneLine;
    return oneLine.slice(0, maxLength - 1) + '…';
};
const plural = (count, singular, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;
const basename = (path) => path.split('/').filter(Boolean).pop() ?? path;
/**
 * The line that makes the rewind's cost legible before it happens. Rewinding
 * discards the turn and everything after it, and file edits already on disk are
 * not reverted — so naming the touched files matters more than counting them.
 */
function describeDiscards(item) {
    if (item.discardedReplies === 0 && item.discardedFiles.length === 0) {
        return 'no reply yet';
    }
    const parts = [];
    if (item.discardedTurns > 1) {
        parts.push(plural(item.discardedTurns, 'turn'));
    }
    if (item.discardedReplies > 0) {
        parts.push(plural(item.discardedReplies, 'reply', 'replies'));
    }
    if (item.discardedFiles.length > 0) {
        const named = item.discardedFiles.slice(0, MAX_NAMED_FILES).map(basename).join(', ');
        const remaining = item.discardedFiles.length - MAX_NAMED_FILES;
        const suffix = remaining > 0 ? ` +${remaining}` : '';
        parts.push(`${plural(item.discardedFiles.length, 'file')} (${named}${suffix})`);
    }
    return `discards ${parts.join(' · ')}`;
}
const RewindMenu = ({ items, selectedIndex, disposition, scrollOffset = 0, maxHeight = MAX_VISIBLE_ITEMS, }) => {
    const theme = useTheme();
    const footer = (React.createElement(MenuFooter, { hints: [
            ['↑↓', 'navigate'],
            ['⏎', disposition === 'edit' ? 'rewind & edit' : 'rewind & resend'],
            ['⇥', disposition === 'edit' ? 'resend instead' : 'edit instead'],
            ['Esc', 'cancel'],
        ] }));
    return (React.createElement(MenuContainer, { items: items, selectedIndex: selectedIndex, scrollOffset: scrollOffset, maxHeight: maxHeight, borderColor: theme.warning, fallbackText: React.createElement(Text, { color: theme.warning }, "Nothing to rewind"), footer: footer, footerOutsideBorder: true, renderItem: (item, index, isSelected) => {
            const images = item.imageCount > 0 ? ` [${plural(item.imageCount, 'image')}]` : '';
            const isLast = index === items.length - 1;
            return (React.createElement(Box, { key: item.targetId, flexDirection: "column" },
                React.createElement(Box, null,
                    React.createElement(SelectionMarker, { selected: isSelected }),
                    React.createElement(Text, { color: isSelected ? theme.warning : undefined, bold: isSelected }, `${String(index + 1).padStart(2)}. ${truncate(item.text, TRUNCATE_LENGTH)}${images}`)),
                React.createElement(Text, { color: isSelected ? theme.warning : theme.textSubtle, dimColor: !isSelected }, `      ↳ ${describeDiscards(item)}`),
                !isLast && React.createElement(Text, null, " ")));
        } }));
};
export default RewindMenu;
//# sourceMappingURL=RewindMenu.js.map