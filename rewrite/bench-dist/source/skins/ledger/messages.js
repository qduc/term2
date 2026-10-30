import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
import { Chip } from './chip.js';
const truncateModel = (name) => name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;
/**
 * One header bar: the product chip, then facts. The bar is a band on `codeBackground`,
 * so a chip cannot use that surface here; the mode badge keeps its own identity colour
 * and the product chip is solid. The facts are grouped, so a narrow terminal wraps
 * between groups (`term² v1.2`, `provider/model effort`, `mentor ...`) and never inside one.
 */
export const LedgerBanner = ({ version, mode, mentor, providerLabel, model, reasoningEffort, mentorModel, mentorReasoningEffort, }) => {
    const theme = useTheme();
    const showEffort = (effort) => effort !== 'none' && effort !== 'default';
    return (React.createElement(Box, { width: "100%", marginTop: 1, marginBottom: 1 },
        React.createElement(Box, { width: "100%", backgroundColor: theme.codeBackground, flexWrap: "wrap", columnGap: 2 },
            React.createElement(Box, null,
                React.createElement(Text, null,
                    React.createElement(Chip, { solid: true, tone: "accent" }, "term\u00B2"),
                    React.createElement(Text, { color: theme.textMuted },
                        " v",
                        version),
                    mode !== 'STANDARD' && (React.createElement(React.Fragment, null,
                        ' ',
                        React.createElement(Chip, { tone: "accent", bold: true, surface: theme.modeBadge[mode], surfaceText: theme.modeBadgeForeground }, mode))),
                    mentor && (React.createElement(React.Fragment, null,
                        ' ',
                        React.createElement(Chip, { tone: "accentAlt", bold: true, surface: theme.modeBadge.MENTOR, surfaceText: theme.modeBadgeForeground }, "MENTOR"))))),
            React.createElement(Box, null,
                React.createElement(Text, null,
                    React.createElement(Text, { color: theme.textMuted }, providerLabel),
                    React.createElement(Text, { color: theme.textSubtle }, "/"),
                    React.createElement(Text, { color: theme.accent, bold: true }, model ? truncateModel(model) : '—'),
                    showEffort(reasoningEffort) && React.createElement(Text, { color: theme.warning },
                        " ",
                        reasoningEffort))),
            mentor && mentorModel && (React.createElement(Box, null,
                React.createElement(Text, null,
                    React.createElement(Text, { color: theme.textMuted }, "mentor"),
                    React.createElement(Text, { color: theme.accentAlt, bold: true }, truncateModel(mentorModel)),
                    showEffort(mentorReasoningEffort) && React.createElement(Text, { color: theme.warning },
                        " ",
                        mentorReasoningEffort)))))));
};
/** The speaker is a chip; the text hangs beside it, so a wrapped message keeps its left edge. */
export const LedgerUserMessage = ({ text }) => {
    const theme = useTheme();
    return (React.createElement(Box, { width: "100%" },
        React.createElement(Box, { flexShrink: 0 },
            React.createElement(Chip, { tone: "accent", bold: true }, "YOU")),
        React.createElement(Box, { marginLeft: 1, flexShrink: 1 },
            React.createElement(Text, { bold: true, color: theme.userText }, text))));
};
/**
 * A label chip on its own line above the text, so the markdown keeps the full
 * width (`assistantGutter` is 0). Reasoning gets a quiet chip, the answer a solid one.
 */
export const LedgerAssistantFrame = ({ kind, children }) => (React.createElement(Box, { flexDirection: "column" },
    kind === 'answer' ? (React.createElement(Chip, { solid: true, tone: "accent" }, "TERM\u00B2")) : (React.createElement(Chip, { tone: "textMuted" }, "THINKING")),
    children));
//# sourceMappingURL=messages.js.map