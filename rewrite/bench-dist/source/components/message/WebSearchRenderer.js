import React from 'react';
import { Box, Text } from 'ink';
import { parseWebSearchOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const WebSearchRenderer = ({ output, renderStandardHeader }) => {
    const theme = useTheme();
    const { ToolSection } = useSkin();
    const parsed = parseWebSearchOutput(output);
    if (!parsed)
        return null;
    const { answer, results } = parsed;
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
        answer && (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
            React.createElement(ToolSection, { variant: "callout", title: "Answer Summary", tone: "warning" },
                React.createElement(Text, { color: theme.toolOutput }, answer)))),
        results && results.length > 0 && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, { color: theme.accent, bold: true }, "Search Results:"),
            results.map((res, idx) => (React.createElement(Box, { key: idx, flexDirection: "column", marginTop: 1 },
                React.createElement(ToolSection, { variant: "indent" },
                    React.createElement(Text, { bold: true, color: theme.text },
                        idx + 1,
                        ". ",
                        res.title),
                    React.createElement(Text, { color: theme.accent, underline: true }, res.url),
                    res.published && (React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                        "Published: ",
                        res.published)),
                    React.createElement(Box, { marginTop: 1 },
                        React.createElement(Text, { color: theme.toolOutput }, res.content))))))))));
};
export default WebSearchRenderer;
//# sourceMappingURL=WebSearchRenderer.js.map