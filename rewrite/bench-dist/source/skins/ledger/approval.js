import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { GLYPH_SELECTED, GLYPH_WARNING, useTheme } from '../../components/theme.js';
import { Chip } from './chip.js';
/** Below this width the options stack, one per row, instead of wrapping as a chip row. */
export const APPROVAL_VERTICAL_BELOW_COLUMNS = 60;
/**
 * A bar row that names the class of request, then the container's title. A caution is
 * an `APPROVAL` chip over a plain rule; a danger is a different word, a `▲`, and a
 * heavier rule, so the two differ in shape and not only in colour. The request itself
 * (command, diff, advisory, choices) sits beneath, against a rule in the tone's colour.
 */
export const LedgerApprovalFrame = ({ tone, header, subheader, children }) => {
    const theme = useTheme();
    const danger = tone === 'danger';
    const toneRole = danger ? 'danger' : 'warning';
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, { width: "100%", backgroundColor: theme.codeBackground },
            React.createElement(Box, { flexShrink: 0 },
                React.createElement(Chip, { solid: true, tone: toneRole }, danger ? `${GLYPH_WARNING} DANGER` : 'APPROVAL')),
            React.createElement(Box, { marginLeft: 1, flexShrink: 1 },
                React.createElement(Text, { bold: true, color: danger ? theme.danger : theme.text }, header))),
        subheader,
        React.createElement(Box, { flexDirection: "column", borderStyle: danger ? 'bold' : 'single', borderTop: false, borderBottom: false, borderRight: false, borderColor: theme[toneRole], paddingLeft: 1 }, children)));
};
const OptionChip = ({ index, label, tone, selected }) => {
    const theme = useTheme();
    // Selection is a filled chip with a leading `❯`: the glyph is what survives `mono`
    // terminals that ignore reverse video, the fill is what the eye finds first.
    if (selected) {
        return (React.createElement(Chip, { solid: true, tone: tone },
            GLYPH_SELECTED,
            " ",
            index + 1,
            " ",
            label));
    }
    return (React.createElement(Chip, { tone: "textMuted" },
        React.createElement(Text, { bold: true, color: theme[tone] }, index + 1),
        ' ',
        label));
};
/**
 * The question, then the options as numbered chips on one wrapping row (a column when
 * narrow), then what the selected option does as one dim line.
 */
export const LedgerApprovalChoices = ({ question, options, selectedIndex, layout, description, }) => {
    const theme = useTheme();
    const { stdout } = useStdout();
    const vertical = (stdout.columns ?? 100) < APPROVAL_VERTICAL_BELOW_COLUMNS;
    const selectedLabel = options[selectedIndex]?.label;
    const showDescription = layout === 'two-pane' && description !== undefined;
    return (React.createElement(Box, { flexDirection: "column", marginTop: 1 },
        question !== undefined && (React.createElement(Text, { bold: true, color: theme.text }, question)),
        React.createElement(Box, { flexDirection: vertical ? 'column' : 'row', flexWrap: vertical ? 'nowrap' : 'wrap', columnGap: 1 }, options.map((option, index) => (React.createElement(Box, { key: `${index}-${option.label}`, alignSelf: "flex-start" },
            React.createElement(OptionChip, { index: index, label: option.label, tone: option.tone, selected: index === selectedIndex }))))),
        showDescription && description.text !== undefined && description.text !== '' && (React.createElement(Box, null,
            React.createElement(Box, { flexShrink: 0, marginRight: 1 },
                React.createElement(Text, { color: theme.textSubtle }, "\u21B3")),
            React.createElement(Box, { flexShrink: 1 },
                React.createElement(Text, { color: theme.textSubtle },
                    description.title !== selectedLabel ? React.createElement(Text, { bold: true },
                        description.title,
                        ": ") : null,
                    description.text))))));
};
//# sourceMappingURL=approval.js.map