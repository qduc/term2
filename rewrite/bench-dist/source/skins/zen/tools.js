import React from 'react';
import { Box, Text } from 'ink';
import { TOOL_STATUS_GLYPH, useTheme } from '../../components/theme.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';
/**
 * Tool calls sit under the answer's text column, indented by the width of the
 * `◆` marker, so a turn reads as one column of prose with the machinery tucked
 * into it. The frame wraps header and body together (the container composes
 * them), so the indent is all it can do; the header decides everything else.
 */
export const ZenToolFrame = ({ children }) => (React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS }, children));
const isTrouble = (status) => status === 'failed' || status === 'rejected';
/** The glyph of a call in flight. A component of its own so only this cell re-renders on each tick. */
const RunningGlyph = () => {
    const theme = useTheme();
    const frame = useSpinnerFrame(BRAILLE_SPINNER, true, 120);
    return React.createElement(Text, { color: theme.warning }, frame);
};
const StatusGlyph = ({ status }) => {
    const theme = useTheme();
    const { faint } = useZenStyles();
    if (status === 'running')
        return React.createElement(RunningGlyph, null);
    if (isTrouble(status)) {
        return (React.createElement(Text, { color: theme.toolStatus[status], bold: true }, TOOL_STATUS_GLYPH[status]));
    }
    // Settled and waiting calls are furniture: the glyph is there to be scanned, not to be coloured.
    return React.createElement(Text, { ...faint }, TOOL_STATUS_GLYPH[status]);
};
/**
 * One quiet line. Colour is spent only on trouble: a failed call is red from its
 * glyph to its last word, everything that went right recedes. A running call is
 * the one other thing allowed to stand out, with a small spinner in the warning
 * tone, because it is the one thing still happening.
 */
export const ZenToolHeader = ({ status, display, nested, action, meta, trailing, textColor }) => {
    const theme = useTheme();
    const { quiet, faint, colourless } = useZenStyles();
    const inFlight = status === 'running' || status === 'pending';
    if (nested) {
        return (React.createElement(Box, null,
            React.createElement(Text, { wrap: "truncate", ...faint },
                React.createElement(StatusGlyph, { status: status }),
                " ",
                action,
                meta)));
    }
    // Standard display prints the output underneath, so the header is the brighter
    // of the two; concise display is the whole record, so it recedes.
    const actionStyle = status === 'failed'
        ? { color: theme.danger, dimColor: false, bold: colourless }
        : display === 'standard' || inFlight
            ? { color: undefined, dimColor: false }
            : { ...quiet, color: textColor || quiet.color };
    return (React.createElement(Box, null,
        React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 },
            React.createElement(StatusGlyph, { status: status })),
        React.createElement(Text, { ...actionStyle },
            action,
            meta,
            trailing)));
};
/**
 * One quiet line for a run of calls, and, only when something failed, the failing
 * calls beneath it, in the danger tone. A partly failed run keeps a calm summary:
 * most of it worked, and the line below says exactly what did not.
 */
export const ZenToolGroupSummary = ({ status, summary, failures }) => {
    const theme = useTheme();
    const { quiet, faint, colourless } = useZenStyles();
    return (React.createElement(Box, { flexDirection: "column", paddingLeft: MARKER_COLUMNS, width: "100%" },
        React.createElement(Box, null,
            React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 }, status === 'failed' ? (React.createElement(Text, { color: theme.toolStatus.failed, bold: true }, TOOL_STATUS_GLYPH.failed)) : (React.createElement(Text, { ...faint }, TOOL_STATUS_GLYPH.completed))),
            React.createElement(Text, { ...quiet }, summary)),
        failures !== '' && (React.createElement(Box, null,
            React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 },
                React.createElement(Text, { color: theme.toolStatus.failed, bold: true }, TOOL_STATUS_GLYPH.failed)),
            React.createElement(Text, { color: theme.danger, bold: colourless }, failures)))));
};
//# sourceMappingURL=tools.js.map