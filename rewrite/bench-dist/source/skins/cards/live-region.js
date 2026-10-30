import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
import { Card } from './card.js';
/** The only animated piece of the live region; it exists to keep the ticking out of its parent. */
const Spinner = () => {
    const theme = useTheme();
    const frame = useSpinnerFrame(BRAILLE_SPINNER, true);
    return (React.createElement(Text, { color: theme.accent, bold: true }, frame));
};
/** Spinner, then what the agent is doing and for how long. The same facts the classic line gives. */
export const CardsWorkingIndicator = ({ phase, elapsedSeconds, tokensPerSecond, toolName, argumentChars, retry, }) => {
    const theme = useTheme();
    const hasRate = tokensPerSecond != null && tokensPerSecond > 0;
    const rate = hasRate ? formatTokensPerSecond(tokensPerSecond) : '';
    let label;
    if (phase === 'retrying') {
        label = `Retrying in ${elapsedSeconds}s${retry ? ` · attempt ${retry.attempt}/${retry.maxRetries}` : ''}`;
    }
    else if (phase === 'tool_call') {
        label = (React.createElement(React.Fragment, null,
            "Calling tool ",
            toolName ? React.createElement(Text, { bold: true }, toolName) : '',
            ' · ',
            elapsedSeconds,
            "s",
            argumentChars != null ? ` (${argumentChars} chars` : '',
            hasRate ? ` · ${rate}` : '',
            argumentChars != null ? ')' : ''));
    }
    else if (phase === 'thinking') {
        label = (React.createElement(React.Fragment, null,
            "Thinking \u00B7 ",
            elapsedSeconds,
            "s",
            hasRate ? ` (${rate})` : ''));
    }
    else {
        label = hasRate ? `Generating · ${elapsedSeconds}s (${rate})` : `Waiting for model · ${elapsedSeconds}s`;
    }
    return (React.createElement(Box, null,
        React.createElement(Box, { flexShrink: 0, marginRight: 1 },
            React.createElement(Spinner, null)),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { color: theme.textSubtle }, label))));
};
/** The input card is the structure, so there is no rule between history and the live controls. */
export const CardsLiveDivider = () => null;
export const CardsPromptMarker = ({ mode }) => {
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
/**
 * A rounded card around the marker and the editable input, drawn in the active-border
 * colour. The input sizes itself to the terminal width less four columns, which is
 * exactly what a border and a column of padding on each side take.
 */
export const CardsInputFrame = ({ children }) => {
    const theme = useTheme();
    return (React.createElement(Card, { color: theme.borderActive },
        React.createElement(Box, null, children)));
};
/** Quiet key hints, `·`-separated, with the key itself carrying the weight. */
export const CardsHints = ({ hints }) => {
    const theme = useTheme();
    return (React.createElement(Text, { color: theme.textSubtle }, hints.map(([key, action, keyColor], index) => (React.createElement(React.Fragment, { key: key },
        index > 0 ? ' · ' : '',
        React.createElement(Text, { color: keyColor ? theme[keyColor] : theme.textMuted, bold: true }, key),
        ' ',
        action)))));
};
//# sourceMappingURL=live-region.js.map