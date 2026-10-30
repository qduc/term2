import React from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
/** Tool output is printed bare in the classic skin; the frame is the seam other skins draw around it. */
export const ClassicToolFrame = ({ children }) => React.createElement(React.Fragment, null, children);
const IN_FLIGHT = new Set(['pending', 'running']);
/**
 * One header line. Standard mode and in-flight calls colour the whole line by
 * status; settled concise calls colour only the marker and leave the text muted,
 * so a transcript of finished calls stays quiet and a failure stands out.
 */
export const ClassicToolHeader = ({ status, display, nested, action, meta, trailing, textColor, }) => {
    const theme = useTheme();
    const color = theme.toolStatus[status];
    const glyph = TOOL_STATUS_GLYPH[status];
    if (display === 'standard') {
        return (React.createElement(Box, null,
            React.createElement(Text, { color: color },
                glyph,
                " ",
                action,
                meta)));
    }
    if (nested) {
        return (React.createElement(Box, null,
            React.createElement(Text, { wrap: "truncate", color: theme.textSubtle },
                React.createElement(Text, { color: color }, glyph),
                " ",
                action,
                meta)));
    }
    if (IN_FLIGHT.has(status)) {
        return (React.createElement(Box, null,
            React.createElement(Text, { color: color },
                React.createElement(Text, { bold: true }, glyph),
                " ",
                action,
                meta,
                trailing)));
    }
    return (React.createElement(Text, { color: textColor || theme.textMuted },
        React.createElement(Text, { color: color, bold: true }, glyph),
        ' ',
        action,
        trailing));
};
const GROUP_MARKER_KIND = {
    completed: 'completed',
    partial: 'completed',
    failed: 'failed',
};
/**
 * Concise-mode line(s) for a run of tool calls. A partly-failed run keeps a green
 * marker and neutral summary: most of what it did succeeded, and painting the whole
 * line red would claim otherwise. The red marker underneath carries the bad news and
 * names the calls that failed, so the count is actionable without painting the whole
 * line red.
 */
export const ClassicToolGroupSummary = ({ status, summary, failures }) => {
    const theme = useTheme();
    const kind = GROUP_MARKER_KIND[status];
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { color: theme.textMuted, wrap: "truncate" },
            React.createElement(Text, { color: theme.toolStatus[kind], bold: true }, TOOL_STATUS_GLYPH[kind]),
            ' ',
            summary),
        failures !== '' && status !== 'failed' && (React.createElement(Text, { color: theme.textMuted, wrap: "truncate" },
            React.createElement(Text, { color: theme.toolStatus.failed, bold: true }, TOOL_STATUS_GLYPH.failed),
            ' ',
            failures))));
};
//# sourceMappingURL=tools.js.map