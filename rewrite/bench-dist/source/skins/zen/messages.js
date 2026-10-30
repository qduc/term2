import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';
/**
 * The answer is the page, so the banner is only a signature: the name, the
 * version beside it, and one muted line saying what it is talking to. The mode
 * only gets a word when it is not the default; its absence is the signal.
 */
export const ZenBanner = ({ version, mode, mentor, providerLabel, model, reasoningEffort, mentorModel, mentorReasoningEffort, }) => {
    const theme = useTheme();
    const { quiet, faint } = useZenStyles();
    return (React.createElement(Box, { flexDirection: "column", width: "100%", paddingTop: 1, marginBottom: 1 },
        React.createElement(Text, null,
            React.createElement(Text, { color: theme.accent, bold: true }, "term\u00B2"),
            React.createElement(Text, { ...faint },
                " v",
                version),
            mode !== 'STANDARD' && (React.createElement(Text, { color: theme.accent, bold: true },
                '  ',
                mode)),
            mentor && (React.createElement(Text, { color: theme.accentAlt, bold: true },
                '  ',
                "MENTOR"))),
        React.createElement(Text, { ...quiet },
            providerLabel,
            "/",
            model ?? '—',
            reasoningEffort !== 'none' && React.createElement(Text, { ...faint },
                " (",
                reasoningEffort,
                ")"),
            mentor && mentorModel && (React.createElement(React.Fragment, null,
                React.createElement(Text, { ...faint }, " \u00B7 mentor "),
                mentorModel,
                mentorReasoningEffort !== 'none' && React.createElement(Text, { ...faint },
                    " (",
                    mentorReasoningEffort,
                    ")"))))));
};
/**
 * A bare bold line behind an accent `›`: the same marker the prompt uses, so what
 * you typed reads as the line you sent. No band, no box. Continuation lines hang
 * under the first word. The container already puts two blank lines above a user
 * turn, which is all the breathing room it needs.
 */
export const ZenUserMessage = ({ text }) => {
    const theme = useTheme();
    return (React.createElement(Box, { width: "100%" },
        React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 },
            React.createElement(Text, { color: theme.accent, bold: true }, "\u203A")),
        React.createElement(Text, { bold: true, color: theme.text }, text)));
};
/**
 * Blank columns kept on the right of the body. Markdown list items are a bullet
 * box beside a text box, and Yoga lays that row out against the text's unwrapped
 * width: a line that only just overflows is left unwrapped, running over its
 * container by up to the width of the bullet and its margin (2). Indenting the body
 * is enough to push such a line past the terminal edge, and a skin cannot reach
 * into the renderer to fix it, so the frame leaves room instead. On a page this
 * sparse the margin is not noticeable.
 */
const RIGHT_SLACK = 2;
/** Columns the frame consumes beside the body (marker column plus right slack); declared as `assistantGutter`. */
export const ASSISTANT_GUTTER = MARKER_COLUMNS + RIGHT_SLACK;
/**
 * The answer hangs off a `◆` in the margin and its body is indented to align
 * with the first word, the way prose sits beside a bullet. Reasoning gets the
 * hollow `◇` instead, so a thought is told apart from an answer by shape and not
 * only by the dim colour the container already gives its text (which does not
 * exist in `mono`). The frame cannot recolour markdown it did not render, so the
 * marker is what carries the difference.
 */
export const ZenAssistantFrame = ({ kind, children }) => {
    const theme = useTheme();
    const { faint } = useZenStyles();
    return (React.createElement(Box, null,
        React.createElement(Box, { width: MARKER_COLUMNS, flexShrink: 0 }, kind === 'answer' ? React.createElement(Text, { color: theme.accent }, "\u25C6") : React.createElement(Text, { ...faint }, "\u25C7")),
        React.createElement(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingRight: RIGHT_SLACK }, children)));
};
//# sourceMappingURL=messages.js.map