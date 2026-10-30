import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import { MODEL_LABEL_MAX } from '../shared/limits.js';
import { cells } from './parts.js';
const truncateModel = (name) => name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;
/**
 * A small pill. Under `mono` the badge colour is undefined, so the pill is drawn
 * inverted instead: a mode must never be invisible just because there is no colour.
 */
const Badge = ({ mode }) => {
    const theme = useTheme();
    const background = theme.modeBadge[mode];
    return (React.createElement(Text, { backgroundColor: background, color: theme.modeBadgeForeground, inverse: background === undefined, bold: true }, ` ${mode} `));
};
/**
 * One line, no box: `term² v0.30.0 · Codex/gpt-5.6-luna (high)`, then a pill only
 * when the mode is not the default. On a narrow terminal the version is the first
 * thing to go, and if the rest still does not fit the model moves to its own line.
 */
export const RailBanner = ({ version, mode, mentor, providerLabel, model, reasoningEffort, mentorModel, mentorReasoningEffort, }) => {
    const theme = useTheme();
    const columns = useTerminalColumns();
    const effort = reasoningEffort !== 'none' ? ` (${reasoningEffort})` : '';
    const modelText = `${providerLabel}/${model ? truncateModel(model) : '—'}${effort}`;
    const mentorEffort = mentorReasoningEffort !== 'none' ? ` (${mentorReasoningEffort})` : '';
    const mentorText = mentor && mentorModel ? `${truncateModel(mentorModel)}${mentorEffort}` : '';
    const badges = [...(mode !== 'STANDARD' ? [mode] : []), ...(mentor ? ['MENTOR'] : [])];
    const badgeWidth = badges.reduce((total, badge) => total + cells(badge) + 3, 0);
    const versionText = `v${version}`;
    const brandWidth = cells('term²');
    const tailWidth = 3 + cells(modelText) + (mentorText ? 1 + cells(mentorText) : 0) + badgeWidth;
    const withVersion = brandWidth + 1 + cells(versionText) + tailWidth;
    const showVersion = withVersion <= columns;
    const oneLine = showVersion || brandWidth + tailWidth <= columns;
    const brand = (React.createElement(React.Fragment, null,
        React.createElement(Text, { color: theme.accent, bold: true }, "term\u00B2"),
        showVersion && React.createElement(Text, { color: theme.textMuted },
            " ",
            versionText)));
    const separator = React.createElement(Text, { color: theme.textSubtle }, " \u00B7 ");
    const modelNode = (React.createElement(React.Fragment, null,
        React.createElement(Text, { color: theme.textMuted }, providerLabel),
        React.createElement(Text, { color: theme.textSubtle }, "/"),
        React.createElement(Text, { color: theme.accent }, model ? truncateModel(model) : '—'),
        effort && React.createElement(Text, { color: theme.textSubtle }, effort)));
    const badgeNodes = badges.map((badge) => (React.createElement(Text, { key: badge },
        ' ',
        React.createElement(Badge, { mode: badge }))));
    const mentorNode = mentorText ? React.createElement(Text, { color: theme.accentAlt },
        " ",
        mentorText) : null;
    if (oneLine) {
        return (React.createElement(Box, { marginBottom: 1 },
            React.createElement(Text, null,
                brand,
                separator,
                modelNode,
                badgeNodes,
                mentorNode)));
    }
    return (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
        React.createElement(Text, null,
            brand,
            badgeNodes),
        React.createElement(Text, null,
            modelNode,
            mentorNode)));
};
/**
 * No background band: a band only works against the terminal background it was
 * tuned for, whereas bold text behind an accent prompt reads on any. A long
 * message wraps under its first word, not under the `❯`.
 */
export const RailUserMessage = ({ text }) => {
    const theme = useTheme();
    return (React.createElement(Box, null,
        React.createElement(Box, { width: 2, flexShrink: 0 },
            React.createElement(Text, { color: theme.accent, bold: true }, "\u276F")),
        React.createElement(Box, { flexShrink: 1 },
            React.createElement(Text, { bold: true, color: theme.userText }, text))));
};
/**
 * Answers and reasoning are printed bare, flush left. Reasoning is already
 * quieter (its own colour from the container), and indenting only it would need
 * a gutter that `assistantGutter` cannot declare per kind.
 */
export const RailAssistantFrame = ({ children }) => React.createElement(React.Fragment, null, children);
//# sourceMappingURL=messages.js.map