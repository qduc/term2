import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import { truncateTerminalText } from '../../components/layout/terminal-text-budget.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
/**
 * Width of the tool-name column for a terminal of this width. It depends only on
 * the terminal, never on the call, which is what makes the action column start in
 * the same place on every row of a run. Below `NAME_COLUMN_MIN_COLUMNS` the column
 * goes: the action already names its verb, and the columns are worth more to it.
 */
const NAME_COLUMN_MIN_COLUMNS = 50;
export function nameColumnWidth(columns) {
    if (columns < NAME_COLUMN_MIN_COLUMNS)
        return 0;
    if (columns < 80)
        return 10;
    return 12;
}
/** The only animated piece: a spinner while the call runs. Everything settled is static text. */
const RunningGlyph = () => {
    const theme = useTheme();
    const frame = useSpinnerFrame(BRAILLE_SPINNER, true);
    return (React.createElement(Text, { color: theme.toolStatus.running, bold: true }, frame));
};
const StatusGlyph = ({ status }) => {
    const theme = useTheme();
    if (status === 'running')
        return React.createElement(RunningGlyph, null);
    return (React.createElement(Text, { color: theme.toolStatus[status], bold: true }, TOOL_STATUS_GLYPH[status]));
};
/**
 * Concise calls are bare rows: a run of them is a table. Standard calls get a left
 * gutter so a header and the output beneath it read as one unit; the gutter turns
 * danger-coloured (and stays a rule, not only a colour) when the call did not succeed.
 */
export const LedgerToolFrame = ({ status, display, children }) => {
    const theme = useTheme();
    if (display === 'concise')
        return React.createElement(React.Fragment, null, children);
    const failed = status === 'failed' || status === 'rejected';
    return (React.createElement(Box, { flexDirection: "column", borderStyle: failed ? 'bold' : 'single', borderTop: false, borderBottom: false, borderRight: false, borderColor: failed ? theme.danger : theme.border, paddingLeft: 1 }, children));
};
/**
 * `glyph  tool-name  action  meta trailing`. The glyph and the name are fixed
 * columns; the action takes the rest and wraps under itself, never under the glyph.
 */
export const LedgerToolHeader = ({ status, display, toolName, nested, action, meta, trailing, textColor, }) => {
    const theme = useTheme();
    const { stdout } = useStdout();
    const columns = stdout.columns ?? 100;
    if (nested) {
        return (React.createElement(Box, null,
            React.createElement(Text, { wrap: "truncate", color: theme.textSubtle },
                React.createElement(StatusGlyph, { status: status }),
                " ",
                action,
                meta)));
    }
    const nameWidth = nameColumnWidth(columns);
    const settled = status !== 'pending' && status !== 'running';
    const name = truncateTerminalText(toolName ?? 'shell', nameWidth);
    // Settled rows stay quiet and a concise failure is already loud in its glyph; only a
    // call still in flight, or a failure whose full output follows, colours its text.
    const actionColor = settled && (status === 'completed' || display === 'concise') ? textColor || theme.text : theme.toolStatus[status];
    return (React.createElement(Box, null,
        React.createElement(Box, { flexShrink: 0, marginRight: 1 },
            React.createElement(StatusGlyph, { status: status })),
        nameWidth > 0 && (React.createElement(Box, { width: nameWidth, flexShrink: 0, marginRight: 1 },
            React.createElement(Text, { color: theme.textMuted, wrap: "truncate" }, name))),
        React.createElement(Box, { flexShrink: 1, flexGrow: 1 },
            React.createElement(Text, { color: actionColor },
                action,
                meta,
                trailing))));
};
const GROUP_MARKER_KIND = {
    completed: 'completed',
    partial: 'completed',
    failed: 'failed',
};
/**
 * One compact row for a run of calls; failures sit beneath it, indented under the
 * summary text, in the danger tone with the failure glyph so they read without colour.
 */
export const LedgerToolGroupSummary = ({ status, summary, failures }) => {
    const theme = useTheme();
    const kind = GROUP_MARKER_KIND[status];
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0, marginRight: 1 },
                React.createElement(Text, { color: theme.toolStatus[kind], bold: true }, TOOL_STATUS_GLYPH[kind])),
            React.createElement(Box, { flexShrink: 1 },
                React.createElement(Text, { color: status === 'failed' ? theme.danger : theme.textMuted }, summary))),
        failures !== '' && status !== 'failed' && (React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0, marginRight: 1 },
                React.createElement(Text, { color: theme.toolStatus.failed, bold: true }, TOOL_STATUS_GLYPH.failed)),
            React.createElement(Box, { flexShrink: 1 },
                React.createElement(Text, { color: theme.danger }, failures))))));
};
//# sourceMappingURL=tools.js.map