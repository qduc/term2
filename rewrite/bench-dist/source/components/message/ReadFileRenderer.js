import React from 'react';
import { Box, Text } from 'ink';
import { parseReadFileOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const ReadFileRenderer = ({ output, renderStandardHeader }) => {
    const theme = useTheme();
    const { ToolSection } = useSkin();
    const parsed = parseReadFileOutput(output);
    if (!parsed)
        return null;
    const { filePath: _filePath, totalLines: _totalLines, startLine, endLine: _endLine, contentLines } = parsed;
    const maxContentLines = 10;
    const displayLines = [];
    let truncatedCount = 0;
    if (contentLines.length > maxContentLines + 1) {
        const topCount = maxContentLines - 1;
        for (let i = 0; i < topCount; i++) {
            displayLines.push({ lineNum: startLine + i, content: contentLines[i] ?? '' });
        }
        truncatedCount = contentLines.length - topCount - 1;
        displayLines.push({ lineNum: -1, content: `... (${truncatedCount} lines truncated) ...` });
        displayLines.push({
            lineNum: startLine + contentLines.length - 1,
            content: contentLines[contentLines.length - 1] ?? '',
        });
    }
    else {
        contentLines.forEach((content, i) => {
            displayLines.push({ lineNum: startLine + i, content });
        });
    }
    return (React.createElement(Box, { flexDirection: "column" },
        renderStandardHeader(),
        React.createElement(Box, { flexDirection: "column", marginTop: 1 },
            React.createElement(ToolSection, { variant: "panel" }, displayLines.map((line, idx) => {
                if (line.lineNum === -1) {
                    return (React.createElement(Box, { key: idx, flexDirection: "row" },
                        React.createElement(Box, { width: 8, flexShrink: 0 },
                            React.createElement(Text, { color: theme.textSubtle, dimColor: true }, '      │ ')),
                        React.createElement(Box, { flexGrow: 1 },
                            React.createElement(Text, { color: theme.textSubtle, dimColor: true }, line.content))));
                }
                const lineNumStr = String(line.lineNum).padStart(5, ' ');
                return (React.createElement(Box, { key: idx, flexDirection: "row" },
                    React.createElement(Box, { width: 8, flexShrink: 0 },
                        React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                            lineNumStr,
                            " \u2502",
                            ' ')),
                    React.createElement(Box, { flexGrow: 1 },
                        React.createElement(Text, { color: theme.toolOutput }, line.content))));
            })))));
};
export default ReadFileRenderer;
//# sourceMappingURL=ReadFileRenderer.js.map