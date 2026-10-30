import React from 'react';
import { Box, Text } from 'ink';
import Divider from '../../components/common/Divider.js';
import { GLYPH_SEPARATOR, useTheme } from '../../components/theme.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
/** What the agent is doing right now, as a single muted line. */
export const ClassicWorkingIndicator = ({ phase, elapsedSeconds, tokensPerSecond, toolName, argumentChars, dotCount, retry, }) => {
    const theme = useTheme();
    const hasRate = tokensPerSecond != null && tokensPerSecond > 0;
    if (phase === 'retrying') {
        return (React.createElement(Text, { color: theme.textSubtle },
            "Retrying in ",
            elapsedSeconds,
            "s",
            retry ? ` · attempt ${retry.attempt}/${retry.maxRetries}` : ''));
    }
    if (phase === 'tool_call') {
        return (React.createElement(Text, { color: theme.textSubtle },
            "Calling tool ",
            toolName ? React.createElement(Text, { bold: true }, toolName) : '',
            ' · ',
            elapsedSeconds,
            "s",
            argumentChars != null ? ` (${argumentChars} chars` : '',
            hasRate ? ` · ${formatTokensPerSecond(tokensPerSecond)}` : '',
            argumentChars != null ? ')' : '',
            '.'.repeat(dotCount)));
    }
    if (phase === 'thinking') {
        return (React.createElement(Text, { color: theme.textSubtle },
            "Thinking \u00B7 ",
            elapsedSeconds,
            "s",
            hasRate ? ` (${formatTokensPerSecond(tokensPerSecond)})` : ''));
    }
    return (React.createElement(Text, { color: theme.textSubtle }, hasRate
        ? `Generating · ${elapsedSeconds}s (${formatTokensPerSecond(tokensPerSecond)})`
        : `Waiting for model · ${elapsedSeconds}s`));
};
/** The one structural split on screen: printed history above, live controls below. */
export const ClassicLiveDivider = () => React.createElement(Divider, null);
export const ClassicPromptMarker = ({ mode }) => {
    const theme = useTheme();
    if (mode === 'rejection')
        return React.createElement(Text, { color: theme.warning }, "Why? ");
    if (mode === 'shell')
        return React.createElement(Text, { color: theme.danger }, "! ");
    return React.createElement(Text, { color: theme.accent }, "\u276F ");
};
/** The input row is printed bare; the frame is the seam other skins draw a box or rule around. */
export const ClassicInputFrame = ({ children }) => React.createElement(Box, null, children);
/**
 * One footer format for every menu and for the input, so the reader learns the
 * shape once: `key action │ key action`. Menus used to each invent their own
 * wording, separator, and arrow glyph.
 */
export const ClassicHints = ({ hints }) => {
    const theme = useTheme();
    return (React.createElement(Text, { color: theme.textSubtle }, hints.map(([key, action, keyColor], index) => (React.createElement(React.Fragment, { key: key },
        index > 0 ? ` ${GLYPH_SEPARATOR} ` : '',
        keyColor ? React.createElement(Text, { color: theme[keyColor] }, key) : key,
        " ",
        action)))));
};
export const ClassicShellActivity = ({ command }) => {
    const theme = useTheme();
    return (React.createElement(Text, { color: theme.textSubtle },
        "Running shell command: ",
        React.createElement(Text, { bold: true }, command)));
};
/** A muted header over the rows, unframed. */
export const ClassicTaskPanel = ({ header, children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
        React.createElement(Text, { color: theme.textMuted }, header),
        children));
};
//# sourceMappingURL=live-region.js.map