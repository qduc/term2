import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { SelectionMarker } from '../../components/common/SelectionMarker.js';
import { useTheme } from '../../components/theme.js';
/**
 * Left: the options. Right: what the selected one does. Below 90 columns the
 * description drops underneath instead of beside the list. Exported because the
 * ask-user prompt, which skins do not yet restyle, shares it.
 */
export const TwoPaneApprovalLayout = ({ left, rightTitle, rightDescription }) => {
    const theme = useTheme();
    const { stdout } = useStdout();
    const isNarrow = (stdout.columns ?? 100) < 90;
    const description = (React.createElement(Box, { flexDirection: "column", width: isNarrow ? '100%' : '50%', paddingLeft: isNarrow ? 0 : 2, marginTop: isNarrow ? 1 : 0, borderStyle: isNarrow ? undefined : 'single', borderTop: false, borderBottom: false, borderRight: false, borderLeft: !isNarrow, borderColor: theme.border },
        React.createElement(Text, { bold: true, color: theme.warning }, rightTitle),
        React.createElement(Box, { marginTop: 1 }, rightDescription ? (React.createElement(Text, { color: theme.text }, rightDescription)) : (React.createElement(Text, { color: theme.textSubtle, italic: true }, "No description available.")))));
    return (React.createElement(Box, { flexDirection: isNarrow ? 'column' : 'row', width: "100%", marginTop: 1 },
        React.createElement(Box, { flexDirection: "column", width: isNarrow ? '100%' : '50%', flexShrink: 0, flexGrow: 0 }, left),
        description));
};
/**
 * A title line, then the request. The riskiest class gets a red left border, not
 * just red text, so it is recognisable by shape before the words are read.
 */
export const ClassicApprovalFrame = ({ tone, header, subheader, children }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { color: theme.warning }, header),
        subheader,
        tone === 'danger' ? (React.createElement(Box, { flexDirection: "column", borderStyle: "single", borderTop: false, borderBottom: false, borderRight: false, borderLeft: true, borderColor: theme.danger, paddingLeft: 1, marginTop: 1 }, children)) : (children)));
};
export const ClassicApprovalChoices = ({ question, options, selectedIndex, layout, description, }) => {
    const theme = useTheme();
    const rows = options.map((option, index) => {
        const isSelected = selectedIndex === index;
        return (React.createElement(Box, { key: option.label },
            React.createElement(SelectionMarker, { selected: isSelected }),
            React.createElement(Text, { color: isSelected ? theme[option.tone] : undefined },
                index + 1,
                ". ",
                option.label)));
    });
    if (layout === 'list') {
        return React.createElement(React.Fragment, null, rows);
    }
    return (React.createElement(React.Fragment, null,
        question !== undefined && React.createElement(Text, null, question),
        React.createElement(TwoPaneApprovalLayout, { left: rows, rightTitle: description?.title ?? 'Option', rightDescription: description?.text })));
};
//# sourceMappingURL=approval.js.map