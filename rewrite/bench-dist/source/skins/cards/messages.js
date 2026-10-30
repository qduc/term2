import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
import { Card } from './card.js';
/**
 * Columns the assistant frame may take on the left: the reasoning rail and its space.
 * Declared for both kinds, so an answer wraps two columns narrower than it strictly needs
 * to; that is the price of one honest number, and it keeps reasoning's code blocks inside
 * the terminal.
 */
export const ASSISTANT_GUTTER = 2;
const truncateModel = (name) => name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;
const Badge = ({ mode }) => {
    const theme = useTheme();
    return (React.createElement(Text, { backgroundColor: theme.modeBadge[mode], color: theme.modeBadgeForeground, bold: true },
        ' ',
        mode,
        ' '));
};
/**
 * A small card that shrinks to its content: name and version on the border, the
 * model on the first row, the mode (and mentor) badges beneath.
 */
export const CardsBanner = ({ version, mode, mentor, providerLabel, model, reasoningEffort, mentorModel, mentorReasoningEffort, }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column", paddingTop: 1, marginBottom: 1 },
        React.createElement(Card, { fit: true, color: theme.border, title: React.createElement(Text, { wrap: "truncate-end" },
                React.createElement(Text, { color: theme.accent, bold: true }, "term\u00B2"),
                React.createElement(Text, { color: theme.textMuted },
                    " v",
                    version)) },
            React.createElement(Text, null,
                React.createElement(Text, { color: theme.textMuted }, providerLabel),
                React.createElement(Text, { color: theme.textSubtle }, "/"),
                React.createElement(Text, { color: theme.accent, bold: true }, model ? truncateModel(model) : '—'),
                reasoningEffort !== 'none' && React.createElement(Text, { color: theme.textSubtle },
                    " (",
                    reasoningEffort,
                    ")")),
            React.createElement(Box, { flexWrap: "wrap", columnGap: 1 },
                React.createElement(Badge, { mode: mode }),
                mentor && React.createElement(Badge, { mode: "MENTOR" }),
                mentor && mentorModel && (React.createElement(Text, null,
                    React.createElement(Text, { color: theme.textSubtle }, "mentor "),
                    React.createElement(Text, { color: theme.accentAlt }, truncateModel(mentorModel)),
                    mentorReasoningEffort !== 'none' && React.createElement(Text, { color: theme.textSubtle },
                        " (",
                        mentorReasoningEffort,
                        ")")))))));
};
/** The user's turn in a card of its own, in the accent colour, titled `you`. */
export const CardsUserMessage = ({ text }) => {
    const theme = useTheme();
    return (React.createElement(Card, { color: theme.accent, title: React.createElement(Text, { color: theme.accent, bold: true, wrap: "truncate-end" }, "you") },
        React.createElement(Text, { color: theme.userText }, text)));
};
const REASONING_RAIL = {
    topLeft: '',
    top: '',
    topRight: '',
    left: '┆',
    bottomLeft: '',
    bottom: '',
    bottomRight: '',
    right: '',
};
/**
 * Answers stay completely bare, flush left, so long markdown and code blocks read
 * without a frame. Reasoning is subordinate: it sits behind a quiet dotted rail, which is
 * also what marks it apart from an answer when there is no colour.
 */
export const CardsAssistantFrame = ({ kind, children }) => {
    const theme = useTheme();
    if (kind === 'reasoning') {
        return (React.createElement(Box, { flexDirection: "column", borderStyle: REASONING_RAIL, borderTop: false, borderBottom: false, borderRight: false, borderColor: theme.textSubtle, paddingLeft: 1 }, children));
    }
    return React.createElement(React.Fragment, null, children);
};
//# sourceMappingURL=messages.js.map