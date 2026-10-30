import React from 'react';
import { Box, Text } from 'ink';
import { parseGrepOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const GrepRenderer = ({ output, renderStandardHeader }) => {
    const theme = useTheme();
    const { ToolSection } = useSkin();
    const parsed = parseGrepOutput(output);
    if (!parsed)
        return null;
    const { matchesByFile, note } = parsed;
    const filePaths = Object.keys(matchesByFile);
    const MAX_DISPLAY_MATCHES = 10;
    let displayedMatchesCount = 0;
    let truncatedMatchesCount = 0;
    let truncatedFilesCount = 0;
    const filesToRender = [];
    for (const filePath of filePaths) {
        const matches = matchesByFile[filePath] ?? [];
        if (displayedMatchesCount >= MAX_DISPLAY_MATCHES) {
            truncatedMatchesCount += matches.length;
            truncatedFilesCount++;
        }
        else {
            const remainingSlots = MAX_DISPLAY_MATCHES - displayedMatchesCount;
            if (matches.length <= remainingSlots) {
                filesToRender.push({
                    filePath,
                    matches,
                    truncatedCount: 0,
                });
                displayedMatchesCount += matches.length;
            }
            else {
                filesToRender.push({
                    filePath,
                    matches: matches.slice(0, remainingSlots),
                    truncatedCount: matches.length - remainingSlots,
                });
                displayedMatchesCount += remainingSlots;
                truncatedMatchesCount += matches.length - remainingSlots;
            }
        }
    }
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
        filesToRender.map((file, fileIdx) => {
            if (file.matches.length === 0)
                return null;
            return (React.createElement(Box, { key: fileIdx, flexDirection: "column", marginBottom: 1 },
                React.createElement(Box, null,
                    React.createElement(Text, { color: theme.accent, bold: true }, file.filePath),
                    React.createElement(Text, { color: theme.textSubtle },
                        ' ',
                        "(",
                        file.matches.length,
                        " match",
                        file.matches.length !== 1 ? 'es' : '',
                        file.truncatedCount > 0 ? `, ${file.truncatedCount} truncated` : '',
                        ")")),
                React.createElement(ToolSection, { variant: "indent" },
                    file.matches.map((match, matchIdx) => {
                        const lineNumStr = String(match.lineNum).padStart(4, ' ');
                        return (React.createElement(Text, { key: matchIdx },
                            React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                                lineNumStr,
                                ":",
                                ' '),
                            React.createElement(Text, { color: theme.toolOutput }, match.content)));
                    }),
                    file.truncatedCount > 0 && (React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                        "... (",
                        file.truncatedCount,
                        " more match",
                        file.truncatedCount !== 1 ? 'es' : '',
                        " truncated in this file) ...")))));
        }),
        truncatedMatchesCount > 0 && (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.warning },
                "... (",
                truncatedMatchesCount,
                " match",
                truncatedMatchesCount !== 1 ? 'es' : '',
                truncatedFilesCount > 0
                    ? ` in ${truncatedFilesCount} more file${truncatedFilesCount !== 1 ? 's' : ''}`
                    : '',
                ' ',
                "truncated) ..."))),
        note && (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { color: theme.warning }, note)))));
};
export default GrepRenderer;
//# sourceMappingURL=GrepRenderer.js.map