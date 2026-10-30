import React from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import { Card } from './card.js';
/** Only a running call animates, and only this component ticks, so settled output costs no timers. */
const RunningGlyph = ({ color }) => {
    const frame = useSpinnerFrame(BRAILLE_SPINNER, true);
    return (React.createElement(Text, { color: color, bold: true }, frame));
};
/** The status marker: a spinner while running, otherwise the shared glyph for the status. */
const StatusGlyph = ({ status }) => {
    const theme = useTheme();
    const color = theme.toolStatus[status];
    if (status === 'running')
        return React.createElement(RunningGlyph, { color: color });
    return (React.createElement(Text, { color: color, bold: true }, TOOL_STATUS_GLYPH[status]));
};
/** A failed or refused call gets a heavier border, so it stands out without relying on red. */
const shapeFor = (status) => status === 'failed' || status === 'rejected' ? 'bold' : 'round';
/**
 * Standard display only: the header and the full output share one rounded card whose
 * border is the status colour. Concise calls stay single bare lines, so a long run of
 * calls reads as a list rather than a wall of boxes.
 */
export const CardsToolFrame = ({ status, display, children }) => {
    const theme = useTheme();
    if (display !== 'standard')
        return React.createElement(React.Fragment, null, children);
    return (React.createElement(Card, { color: theme.toolStatus[status], shape: shapeFor(status) }, children));
};
const IN_FLIGHT = new Set(['pending', 'running']);
/** The tool's own name labels a call unless the action already is the command. */
const isShellLike = (toolName) => toolName === undefined || toolName === 'shell';
/**
 * The first row of a card: status glyph, then the tool name and action, with the
 * glyph in its own column so a long command wraps underneath the action rather than
 * under the glyph. Settled concise calls colour only the glyph and keep the text quiet.
 */
export const CardsToolHeader = ({ status, display, toolName, nested, action, meta, trailing, textColor, }) => {
    const theme = useTheme();
    if (display === 'standard') {
        return (React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0, marginRight: 1 },
                React.createElement(StatusGlyph, { status: status })),
            React.createElement(Box, { flexShrink: 1, flexGrow: 1 },
                React.createElement(Text, null,
                    !isShellLike(toolName) && React.createElement(Text, { color: theme.textSubtle },
                        toolName,
                        " "),
                    action,
                    meta,
                    trailing))));
    }
    if (nested) {
        return (React.createElement(Box, null,
            React.createElement(Text, { wrap: "truncate", color: theme.textSubtle },
                React.createElement(StatusGlyph, { status: status }),
                " ",
                action,
                meta)));
    }
    if (IN_FLIGHT.has(status)) {
        return (React.createElement(Box, null,
            React.createElement(Text, null,
                React.createElement(StatusGlyph, { status: status }),
                " ",
                action,
                meta,
                trailing)));
    }
    return (React.createElement(Text, { color: textColor || theme.textMuted },
        React.createElement(StatusGlyph, { status: status }),
        " ",
        action,
        trailing));
};
const GROUP_MARKER_KIND = {
    completed: 'completed',
    partial: 'completed',
    failed: 'failed',
};
/**
 * One line for a run of calls. A partly-failed run keeps the neutral summary and the
 * green marker, because most of what it did succeeded; the failure line beneath, with
 * its own red marker, is what carries the bad news. Both lines wrap rather than clip.
 */
export const CardsToolGroupSummary = ({ status, summary, failures }) => {
    const theme = useTheme();
    const kind = GROUP_MARKER_KIND[status];
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { color: theme.textMuted },
            React.createElement(StatusGlyph, { status: kind }),
            " ",
            summary),
        failures !== '' && status !== 'failed' && (React.createElement(Text, { color: theme.textMuted },
            React.createElement(StatusGlyph, { status: "failed" }),
            " ",
            failures))));
};
//# sourceMappingURL=tools.js.map