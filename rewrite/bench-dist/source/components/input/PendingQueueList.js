import React from 'react';
import { Box, Text } from 'ink';
import { MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
// Group colors match the Enter Steer / Alt+Enter Queue hints under the input.
const GROUPS = [
    { delivery: 'steer', label: 'steer', timing: 'mid-turn', tone: 'accent' },
    { delivery: 'follow_up', label: 'queued', timing: 'after this turn', tone: 'accentAlt' },
];
const SELECTING_HINTS = [
    ['↑↓', 'navigate'],
    ['e', 'edit'],
    ['d', 'delete'],
    ['Esc', 'back'],
];
/**
 * Steers are delivered before follow-ups, so grouping them first keeps the
 * list in delivery order. InputBox indexes its selection into this order.
 */
export const orderPendingQueueMessages = (messages) => GROUPS.flatMap(({ delivery }) => messages.filter((m) => m.delivery === delivery));
/**
 * The visible half of InputBox's local queued-submission selection mode.
 * Keyboard ownership stays in InputBox so this inline surface does not need a
 * new application-wide InputOwner variant.
 */
const PendingQueueList = ({ messages, selectedIndex, editingId, notice }) => {
    const theme = useTheme();
    const selecting = selectedIndex !== null;
    return (React.createElement(Box, { flexDirection: "column", borderStyle: "single", borderTop: false, borderRight: false, borderBottom: false, borderColor: selecting ? theme.borderActive : theme.border, paddingLeft: 1 },
        GROUPS.map((group) => {
            const rows = messages
                .map((message, index) => ({ message, index }))
                .filter(({ message }) => message.delivery === group.delivery);
            if (rows.length === 0)
                return null;
            return (React.createElement(Box, { key: group.delivery, flexDirection: "column" },
                React.createElement(Text, { color: theme.textSubtle },
                    React.createElement(Text, { color: theme[group.tone] }, group.label),
                    " \u00B7 ",
                    group.timing),
                rows.map(({ message, index }) => {
                    const selected = index === selectedIndex;
                    const editing = message.id === editingId;
                    return (React.createElement(Box, { key: message.id, flexDirection: "row" },
                        React.createElement(SelectionMarker, { selected: selected }),
                        React.createElement(Text, { color: selected ? theme.text : theme.textMuted, bold: selected, dimColor: editing, wrap: selected || editing ? 'wrap' : 'truncate-end' }, message.text)));
                })));
        }),
        notice ? React.createElement(Text, { color: theme.warning }, notice) : selecting && React.createElement(MenuFooter, { hints: SELECTING_HINTS })));
};
export default PendingQueueList;
//# sourceMappingURL=PendingQueueList.js.map