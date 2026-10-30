import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import { Hairline, cells } from './parts.js';
const INTERRUPT_HINT = 'esc to interrupt';
/** The spinner glyph. Its own component so only this cell re-renders on each tick. */
const WorkingGlyph = () => {
    const theme = useTheme();
    const frame = useSpinnerFrame(BRAILLE_SPINNER);
    return React.createElement(Text, { color: theme.accent }, frame);
};
/** What the agent is doing, as the text of one line: `Thinking… 12s`. */
function workingLabel(view) {
    const { phase, elapsedSeconds, tokensPerSecond, toolName, argumentChars, retry } = view;
    const rate = tokensPerSecond != null && tokensPerSecond > 0 ? formatTokensPerSecond(tokensPerSecond) : undefined;
    if (phase === 'retrying') {
        return {
            before: `Retrying in ${elapsedSeconds}s${retry ? ` (attempt ${retry.attempt}/${retry.maxRetries})` : ''}`,
            after: '',
        };
    }
    if (phase === 'tool_call') {
        const detail = [argumentChars != null ? `${argumentChars} chars` : undefined, rate].filter(Boolean).join(' · ');
        return {
            before: toolName ? 'Calling tool ' : 'Calling tool',
            strong: toolName,
            after: `… ${elapsedSeconds}s${detail ? ` (${detail})` : ''}`,
        };
    }
    if (phase === 'thinking')
        return { before: `Thinking… ${elapsedSeconds}s${rate ? ` (${rate})` : ''}`, after: '' };
    if (rate)
        return { before: `Generating… ${elapsedSeconds}s (${rate})`, after: '' };
    return { before: `Waiting for model… ${elapsedSeconds}s`, after: '' };
}
/**
 * `⠋ Thinking… 12s   esc to interrupt`. The interrupt hint is decoration: it is
 * the first thing dropped when the line would not fit.
 */
export const RailWorkingIndicator = (view) => {
    const theme = useTheme();
    const columns = useTerminalColumns();
    const { before, strong, after } = workingLabel(view);
    const width = 2 + cells(before) + cells(strong ?? '') + cells(after) + 3 + cells(INTERRUPT_HINT);
    const showHint = width <= columns;
    return (React.createElement(Box, null,
        React.createElement(Box, { width: 2, flexShrink: 0 },
            React.createElement(WorkingGlyph, null)),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { color: theme.textMuted },
                before,
                strong !== undefined && React.createElement(Text, { bold: true }, strong),
                after,
                showHint && React.createElement(Text, { color: theme.textSubtle }, `   ${INTERRUPT_HINT}`)))));
};
/** Above the live region: one hairline between printed history and the controls. */
export const RailLiveDivider = () => React.createElement(Hairline, null);
export const RailPromptMarker = ({ mode }) => {
    const theme = useTheme();
    if (mode === 'rejection') {
        return (React.createElement(Text, { color: theme.warning, bold: true },
            "Why?",
            ' '));
    }
    if (mode === 'shell') {
        return (React.createElement(Text, { color: theme.danger, bold: true },
            "!",
            ' '));
    }
    return (React.createElement(Text, { color: theme.accent, bold: true },
        "\u276F",
        ' '));
};
/** The prompt sits between two hairlines: the live divider above, this one below. */
export const RailInputFrame = ({ children }) => (React.createElement(Box, { flexDirection: "column" },
    React.createElement(Box, null, children),
    React.createElement(Hairline, null)));
/**
 * `⏎ steer · alt+⏎ queue · / commands`: dim, joined by middle dots. Keys are one
 * step brighter than the words they name, or in their own role colour when the
 * container gave one. Whole hints wrap, never the middle of one.
 */
export const RailHints = ({ hints }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexWrap: "wrap", columnGap: 1 }, hints.map(([key, action, keyColor], index) => (React.createElement(Text, { key: key, color: theme.textSubtle },
        React.createElement(Text, { color: keyColor ? theme[keyColor] : theme.textMuted }, key),
        " ",
        action,
        index < hints.length - 1 ? ' ·' : '')))));
};
//# sourceMappingURL=live-region.js.map