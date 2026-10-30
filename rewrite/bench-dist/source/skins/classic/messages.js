import React from 'react';
import { Box, Text } from 'ink';
import { GLYPH_SEPARATOR, useTheme } from '../../components/theme.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
const truncateModel = (name) => name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;
const Badge = ({ mode }) => {
    const theme = useTheme();
    return (React.createElement(Text, { backgroundColor: theme.modeBadge[mode], color: theme.modeBadgeForeground, bold: true },
        ' ',
        mode,
        ' '));
};
/**
 * Two borderless lines, not a bordered block. The banner is the first thing on
 * screen every session; a full box around it competes with the conversation
 * below for attention and costs four lines to say four short facts.
 */
export const ClassicBanner = ({ version, mode, mentor, providerLabel, model, reasoningEffort, mentorModel, mentorReasoningEffort, }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column", width: "100%", paddingTop: 1, marginBottom: 1 },
        React.createElement(Box, null,
            React.createElement(Text, { color: theme.warning, bold: true }, "\u258C"),
            React.createElement(Text, { color: theme.accent, bold: true },
                ' ',
                "term\u00B2",
                ' '),
            React.createElement(Badge, { mode: mode }),
            mentor && (React.createElement(React.Fragment, null,
                React.createElement(Text, null, " "),
                React.createElement(Badge, { mode: "MENTOR" }))),
            React.createElement(Text, { color: theme.textMuted },
                " v",
                version)),
        React.createElement(Box, null,
            React.createElement(Text, { color: theme.textSubtle }, '  '),
            React.createElement(Text, { color: theme.textMuted }, providerLabel),
            React.createElement(Text, { color: theme.textSubtle }, "/"),
            React.createElement(Text, { color: theme.accent }, model ? truncateModel(model) : '—'),
            reasoningEffort !== 'none' && React.createElement(Text, { color: theme.textSubtle },
                " (",
                reasoningEffort,
                ")"),
            mentor && mentorModel && (React.createElement(React.Fragment, null,
                React.createElement(Text, { color: theme.textSubtle },
                    " ",
                    GLYPH_SEPARATOR,
                    " "),
                React.createElement(Text, { color: theme.textSubtle }, "mentor "),
                React.createElement(Text, { color: theme.accentAlt }, truncateModel(mentorModel)),
                mentorReasoningEffort !== 'none' && React.createElement(Text, { color: theme.textSubtle },
                    " (",
                    mentorReasoningEffort,
                    ")"))))));
};
/** A full-width band, so user messages read as content blocks rather than another accent-coloured header. */
export const ClassicUserMessage = ({ text }) => {
    const theme = useTheme();
    return (React.createElement(Box, { width: "100%", backgroundColor: theme.userBackground, paddingX: 1 },
        React.createElement(Text, { bold: true, color: theme.userText },
            React.createElement(Text, { color: theme.accent }, "\u276F "),
            text)));
};
/** Answers and reasoning are printed bare; the frame exists so other skins can mark or indent them. */
export const ClassicAssistantFrame = ({ children }) => React.createElement(React.Fragment, null, children);
//# sourceMappingURL=messages.js.map