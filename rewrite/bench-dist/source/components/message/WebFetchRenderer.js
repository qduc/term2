import React from 'react';
import { Box, Text } from 'ink';
import { parseWebFetchOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const WebFetchRenderer = ({ output, renderStandardHeader }) => {
    const theme = useTheme();
    const { ToolSection } = useSkin();
    const parsed = parseWebFetchOutput(output);
    if (!parsed)
        return null;
    const { title, url, toc, tempFile, notes, content } = parsed;
    const maxLines = 15;
    const contentLines = content.split('\n');
    let displayContent = content;
    let truncatedCount = 0;
    if (contentLines.length > maxLines + 1) {
        const firstPart = contentLines.slice(0, maxLines).join('\n');
        const lastLine = contentLines[contentLines.length - 1];
        truncatedCount = contentLines.length - maxLines - 1;
        displayContent = `${firstPart}\n\n... (${truncatedCount} lines of content truncated for preview) ...\n\n${lastLine}`;
    }
    return (React.createElement(Box, { flexDirection: "column" },
        renderStandardHeader(),
        React.createElement(ToolSection, { variant: "indent" },
            title && (React.createElement(Text, { color: theme.text, bold: true }, title)),
            React.createElement(Text, { color: theme.accent, underline: true }, url)),
        toc && (React.createElement(Box, { flexDirection: "column", marginY: 1, width: 50 },
            React.createElement(ToolSection, { variant: "callout", title: "Table of Contents", tone: "warning" },
                React.createElement(Text, { color: theme.textSubtle }, toc)))),
        content && (React.createElement(Box, { flexDirection: "column", marginTop: 1 },
            React.createElement(ToolSection, { variant: "panel" },
                React.createElement(Text, { color: theme.toolOutput }, displayContent)))),
        tempFile && (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.warning },
                "Full content saved to:",
                ' ',
                React.createElement(Text, { bold: true, color: theme.text }, tempFile)))),
        notes && (React.createElement(Box, { marginTop: 0.5 },
            React.createElement(Text, { color: theme.warning },
                "Warning: ",
                notes)))));
};
export default WebFetchRenderer;
//# sourceMappingURL=WebFetchRenderer.js.map