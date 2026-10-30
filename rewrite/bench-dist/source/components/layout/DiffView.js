import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
const collapseUnchangedLines = (lines) => {
    const result = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const isUnchanged = (l) => l !== undefined && !l.startsWith('+') && !l.startsWith('-') && !l.startsWith('@@');
        if (!isUnchanged(line)) {
            result.push(line);
            i++;
            continue;
        }
        // Find the end of the consecutive unchanged lines block
        let j = i;
        while (j < lines.length && isUnchanged(lines[j])) {
            j++;
        }
        const unchangedCount = j - i;
        const maxUnchangedContext = 3;
        if (unchangedCount <= maxUnchangedContext * 2 + 1) {
            for (let k = i; k < j; k++) {
                result.push(lines[k]);
            }
        }
        else {
            // Keep first 3 lines
            for (let k = i; k < i + maxUnchangedContext; k++) {
                result.push(lines[k]);
            }
            // Add placeholder line
            const skippedCount = unchangedCount - maxUnchangedContext * 2;
            result.push(` ... (${skippedCount} unchanged lines) ...`);
            // Keep last 3 lines
            for (let k = j - maxUnchangedContext; k < j; k++) {
                result.push(lines[k]);
            }
        }
        i = j;
    }
    return result;
};
const DiffView = ({ diff }) => {
    const theme = useTheme();
    const renderLine = (line, key) => {
        let color;
        if (line.startsWith('+')) {
            color = theme.success;
        }
        else if (line.startsWith('-')) {
            color = theme.danger;
        }
        else if (line.startsWith('@@')) {
            color = theme.accent;
        }
        return (React.createElement(Text, { key: key, color: color || theme.toolOutput }, line));
    };
    let displayLines = [];
    let truncated = false;
    let collapsedLines = [];
    let lastLine = null;
    const maxLines = 30;
    try {
        const trimmedDiff = diff.trimEnd();
        const rawLines = trimmedDiff.split('\n');
        collapsedLines = collapseUnchangedLines(rawLines);
        truncated = collapsedLines.length > maxLines + 1;
        displayLines = truncated ? collapsedLines.slice(0, maxLines) : collapsedLines;
        lastLine = truncated ? collapsedLines[collapsedLines.length - 1] : null;
    }
    catch {
        // Fall through to error rendering below
    }
    if (collapsedLines.length === 0) {
        return (React.createElement(Box, { flexDirection: "column", marginLeft: 2 },
            React.createElement(Text, { color: theme.danger }, "[Failed to render diff preview]")));
    }
    return (React.createElement(Box, { flexDirection: "column", marginLeft: 2 },
        displayLines.map((line, i) => renderLine(line, i)),
        truncated && React.createElement(Text, { color: theme.toolOutput },
            "... (",
            collapsedLines.length - maxLines - 1,
            " more lines)"),
        truncated && lastLine !== null && renderLine(lastLine, 'last')));
};
export default DiffView;
//# sourceMappingURL=DiffView.js.map