import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
const LABEL = ' New conversation ';
/**
 * A full-width labelled rule printed where a reset (/clear, mode switch,
 * rollover) starts a fresh session. The earlier output stays in scrollback, so
 * without this the new banner looks like a continuation of the old transcript.
 */
const SessionBoundary = ({ width }) => {
    const theme = useTheme();
    const columns = Math.max(LABEL.length + 4, width);
    const side = Math.max(2, Math.floor((columns - LABEL.length) / 2));
    const rule = (count) => '─'.repeat(count);
    return (React.createElement(Box, { marginTop: 2, marginBottom: 1, width: "100%" },
        React.createElement(Text, { color: theme.textSubtle, wrap: "truncate-end" },
            rule(side),
            React.createElement(Text, { color: theme.accent, bold: true }, LABEL),
            rule(Math.max(2, columns - side - LABEL.length)))));
};
export default SessionBoundary;
//# sourceMappingURL=SessionBoundary.js.map