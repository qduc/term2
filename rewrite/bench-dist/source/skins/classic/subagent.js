import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
/** `$ title — status`, then the final answer's first paragraph or the latest calls, unindented. */
export const ClassicSubagentFeed = ({ title, statusSuffix, tone, summary, children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { color: theme[tone] },
            "$ ",
            title,
            statusSuffix),
        summary !== undefined ? React.createElement(Text, { color: theme.textSubtle }, summary) : children));
};
//# sourceMappingURL=subagent.js.map