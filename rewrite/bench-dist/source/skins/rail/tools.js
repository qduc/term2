import React from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import { RAIL_HEAVY, RAIL_THIN, Rail } from './parts.js';
/**
 * The status glyph. A running call shows a spinner instead of the static `◐`;
 * the hook lives here, the smallest component that draws the glyph, and only
 * ticks while the call is actually running.
 */
const ToolGlyph = ({ status }) => {
    const theme = useTheme();
    const frame = useSpinnerFrame(BRAILLE_SPINNER, status === 'running');
    return (React.createElement(Text, { color: theme.toolStatus[status], bold: true }, status === 'running' ? frame : TOOL_STATUS_GLYPH[status]));
};
/**
 * Standard display: a thin rail, coloured by status, down the whole call so the
 * output reads as belonging to its header. A failed call gets a heavier rail, so it
 * differs in shape and not only in colour.
 *
 * Concise calls are single lines and stay bare, except a failed one: its error
 * text follows the header as extra lines, and the rail is what ties them to it
 * (and makes a failure the one thing in a quiet transcript that is indented).
 */
export const RailToolFrame = ({ status, display, children }) => {
    const theme = useTheme();
    const failed = status === 'failed' || status === 'rejected';
    if (display !== 'standard' && !failed)
        return React.createElement(React.Fragment, null, children);
    return (React.createElement(Rail, { glyph: failed ? RAIL_HEAVY : RAIL_THIN, color: theme.toolStatus[status] }, children));
};
/**
 * Glyph, the tool's name in muted type, then the action. The name is shown for
 * standard calls and for shell commands, where a bare command would otherwise have
 * no label; in concise mode the other tools' actions already begin with a verb
 * ("Read", "Searched") and a second label would only cost columns.
 *
 * The text wraps under the action, not under the glyph, so a long command stays
 * a block.
 */
export const RailToolHeader = ({ status, display, toolName, nested, action, meta, trailing, textColor, }) => {
    const theme = useTheme();
    if (nested) {
        return (React.createElement(Box, null,
            React.createElement(Text, { wrap: "truncate", color: theme.textSubtle },
                React.createElement(Text, { color: theme.toolStatus[status], bold: true }, TOOL_STATUS_GLYPH[status]),
                ' ',
                action,
                meta)));
    }
    const isShell = toolName === undefined || toolName === 'shell';
    const label = display === 'standard' || isShell ? toolName ?? 'shell' : undefined;
    return (React.createElement(Box, null,
        React.createElement(Box, { width: 2, flexShrink: 0 },
            React.createElement(ToolGlyph, { status: status })),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { color: textColor },
                label && React.createElement(Text, { color: theme.textSubtle },
                    label,
                    " "),
                action,
                meta,
                trailing))));
};
const GROUP_MARKER_KIND = {
    completed: 'completed',
    partial: 'completed',
    failed: 'failed',
};
const SummaryLine = ({ kind, text }) => {
    const theme = useTheme();
    return (React.createElement(Box, null,
        React.createElement(Box, { width: 2, flexShrink: 0 },
            React.createElement(Text, { color: theme.toolStatus[kind], bold: true }, TOOL_STATUS_GLYPH[kind])),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { color: theme.textSubtle }, text))));
};
/**
 * One quiet line for a run of calls. A partly-failed run keeps its green marker,
 * because most of it succeeded; the line below carries the bad news.
 */
export const RailToolGroupSummary = ({ status, summary, failures }) => (React.createElement(Box, { flexDirection: "column" },
    React.createElement(SummaryLine, { kind: GROUP_MARKER_KIND[status], text: summary }),
    failures !== '' && status !== 'failed' && React.createElement(SummaryLine, { kind: "failed", text: failures })));
//# sourceMappingURL=tools.js.map