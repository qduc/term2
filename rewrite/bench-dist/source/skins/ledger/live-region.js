import React from 'react';
import { Box, Text, useStdout } from 'ink';
import Divider from '../../components/common/Divider.js';
import { useTheme } from '../../components/theme.js';
import { formatTokensPerSecond } from '../../utils/streaming/streaming-speed-tracker.js';
import { BRAILLE_SPINNER, useSpinnerFrame } from '../shared/spinner.js';
/** The only animated piece of the working line. Mounted only while the indicator is. */
const WorkingSpinner = () => {
    const theme = useTheme();
    const frame = useSpinnerFrame(BRAILLE_SPINNER, true);
    return (React.createElement(Text, { color: theme.accent, bold: true }, frame));
};
const INTERRUPT_HINT = 'esc to interrupt';
const PHASE_LABEL = {
    thinking: 'Thinking',
    generating: 'Generating',
    processing: 'Waiting for model',
    retrying: 'Retrying',
    tool_call: 'Calling tool',
};
/** `⠋ Thinking  12s · 48.2 tok/s · esc to interrupt`: a label, then the facts, dimmed. */
export const LedgerWorkingIndicator = ({ phase, elapsedSeconds, tokensPerSecond, toolName, argumentChars, retry, }) => {
    const theme = useTheme();
    const { stdout } = useStdout();
    const columns = stdout.columns ?? 100;
    const hasRate = tokensPerSecond != null && tokensPerSecond > 0;
    const details = [phase === 'retrying' ? `in ${elapsedSeconds}s` : `${elapsedSeconds}s`];
    if (phase === 'retrying' && retry)
        details.push(`attempt ${retry.attempt}/${retry.maxRetries}`);
    if (phase === 'tool_call' && argumentChars != null)
        details.push(`${argumentChars} chars`);
    if (hasRate)
        details.push(formatTokensPerSecond(tokensPerSecond));
    // The interrupt hint is a reminder, the facts before it are not: it goes first when the
    // line would not fit (spinner and gap take 2 columns).
    const factsWidth = [PHASE_LABEL[phase], toolName ?? '', ...details].join(' · ').length + 2;
    if (factsWidth + INTERRUPT_HINT.length + 3 <= columns)
        details.push(INTERRUPT_HINT);
    return (React.createElement(Box, null,
        React.createElement(Box, { flexShrink: 0, marginRight: 1 },
            React.createElement(WorkingSpinner, null)),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { wrap: "wrap" },
                React.createElement(Text, { color: theme.accent, bold: true }, PHASE_LABEL[phase]),
                phase === 'tool_call' && toolName ? (React.createElement(Text, { color: theme.text, bold: true },
                    ' ',
                    toolName)) : null,
                React.createElement(Text, { color: theme.textSubtle },
                    " ",
                    details.join(' · '))))));
};
/** A plain rule: the one structural split between printed history and the live controls. */
export const LedgerLiveDivider = () => React.createElement(Divider, null);
/**
 * The marker is a small solid tab exactly as wide as the container budgeted for it
 * (2 columns, 5 for the rejection prompt), so the input's wrap width stays right.
 */
export const LedgerPromptMarker = ({ mode }) => {
    const theme = useTheme();
    if (mode === 'rejection') {
        return (React.createElement(Text, { inverse: true, bold: true, color: theme.warning },
            "Why?",
            ' '));
    }
    if (mode === 'shell') {
        return (React.createElement(Text, { inverse: true, bold: true, color: theme.danger },
            "!",
            ' '));
    }
    return (React.createElement(Text, { inverse: true, bold: true, color: theme.accent },
        "\u276F",
        ' '));
};
/**
 * The prompt row sits on a full-width band. The marker is flush left like a tab; a
 * one-cell gap and a one-cell right margin together use 2 of the 4 spare columns
 * the container reserves for horizontal padding, so the input never overflows.
 */
export const LedgerInputFrame = ({ children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { width: "100%", backgroundColor: theme.codeBackground, columnGap: 1, paddingRight: 1 }, children));
};
/** Dim and compact: bold keys, quiet actions, two spaces between pairs. */
export const LedgerHints = ({ hints }) => {
    const theme = useTheme();
    return (React.createElement(Text, { color: theme.textSubtle, wrap: "wrap" }, hints.map(([key, action, keyColor], index) => (React.createElement(React.Fragment, { key: `${key}-${index}` },
        index > 0 ? '  ' : '',
        React.createElement(Text, { bold: true, color: keyColor ? theme[keyColor] : theme.textMuted }, key),
        ' ',
        action)))));
};
//# sourceMappingURL=live-region.js.map