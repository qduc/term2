import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { DOT_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';
/** Short waits stay calm: a count only appears once the wait is long enough to wonder about. */
const SHOW_ELAPSED_AFTER_SECONDS = 10;
const labelFor = ({ phase, toolName, elapsedSeconds, }) => {
    switch (phase) {
        case 'retrying':
            return `retrying in ${elapsedSeconds}s`;
        case 'thinking':
            return 'thinking';
        case 'generating':
            return 'writing';
        case 'tool_call':
            return toolName ? `using ${toolName}` : 'calling a tool';
        default:
            return 'waiting for the model';
    }
};
/** The breathing dots. Their own component so only these three cells re-render on each tick. */
const BreathingDots = () => {
    const frame = useSpinnerFrame(DOT_SPINNER, true, 300);
    return React.createElement(Text, null, frame);
};
/**
 * `◆ thinking ···`: the answer's own marker, dimmed, with a slow breath beside
 * what is happening. The `◆` is the one thing that does not move, so the line
 * reads as "the next answer is on its way" even in a terminal that shows no colour.
 */
export const ZenWorkingIndicator = (view) => {
    const theme = useTheme();
    const { faint } = useZenStyles();
    return (React.createElement(Box, { paddingLeft: MARKER_COLUMNS },
        React.createElement(Text, { ...faint },
            React.createElement(Text, { color: theme.accent }, "\u25C6"),
            " ",
            labelFor(view),
            " ",
            React.createElement(BreathingDots, null),
            view.phase !== 'retrying' && view.elapsedSeconds >= SHOW_ELAPSED_AFTER_SECONDS
                ? ` ${view.elapsedSeconds}s`
                : '')));
};
/** Whitespace is the divider; the live controls are already set off by the blank line above them. */
export const ZenLiveDivider = () => null;
/** The marker is the whole identity of the input: `›` to talk, `!` to run, a question after a refusal. */
export const ZenPromptMarker = ({ mode }) => {
    const theme = useTheme();
    if (mode === 'rejection') {
        return (React.createElement(Text, { color: theme.warning, bold: true },
            "why?",
            ' '));
    }
    if (mode === 'shell') {
        return (React.createElement(Text, { color: theme.danger, bold: true },
            "!",
            ' '));
    }
    return (React.createElement(Text, { color: theme.accent, bold: true },
        "\u203A",
        ' '));
};
/** Borderless: the input is a line like any other, which is what keeps the page calm. */
export const ZenInputFrame = ({ children }) => React.createElement(Box, null, children);
/**
 * Every hint is kept; they are only made small. Keys sit one step above their
 * verbs so the eye can find `esc` without reading the line, and the whole line is
 * the dimmest text on screen.
 */
export const ZenHints = ({ hints }) => {
    const theme = useTheme();
    const { quiet, faint } = useZenStyles();
    return (React.createElement(Text, { ...faint }, hints.map(([key, action, keyColor], index) => (React.createElement(React.Fragment, { key: `${key}:${action}` },
        index > 0 ? ' · ' : '',
        keyColor ? React.createElement(Text, { color: theme[keyColor] }, key) : React.createElement(Text, { ...quiet }, key),
        " ",
        action)))));
};
//# sourceMappingURL=live-region.js.map