import React from 'react';
import { Box, Text } from 'ink';
import { SelectionMarker } from '../../components/common/SelectionMarker.js';
import { GLYPH_FAVORITE, useTheme } from '../../components/theme.js';
import { TwoPaneApprovalLayout } from './approval.js';
/** A boxed question over a numbered list, with the selected option explained beside it. */
export const ClassicQuestionPrompt = ({ progress, question, notice, options, description, footer, }) => {
    const theme = useTheme();
    return (React.createElement(Box, { flexDirection: "column" },
        progress !== undefined && (React.createElement(Box, { marginLeft: 1 },
            React.createElement(Text, { color: theme.textSubtle }, progress))),
        React.createElement(Box, { borderStyle: "round", borderColor: theme.warning, paddingX: 1, paddingY: 0 },
            React.createElement(Text, { color: theme.warning, bold: true }, question)),
        notice !== undefined && (React.createElement(Box, { marginTop: 1, marginLeft: 1 },
            React.createElement(Text, { color: theme.accent },
                "\u276F ",
                notice))),
        React.createElement(TwoPaneApprovalLayout, { left: options.map((option, index) => {
                const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
                return (React.createElement(Box, { key: option.label, flexDirection: "row", width: "100%" },
                    React.createElement(SelectionMarker, { selected: option.selected }),
                    React.createElement(Box, { width: 2, flexShrink: 0 },
                        React.createElement(Text, { color: theme.textSubtle, dimColor: true }, option.recommended ? GLYPH_FAVORITE : ' ')),
                    React.createElement(Box, { flexDirection: "row", flexShrink: 1, flexWrap: "wrap" },
                        React.createElement(Text, { color: option.selected && option.tone ? theme[option.tone] : undefined, bold: option.selected },
                            index + 1,
                            ". ",
                            checkbox,
                            option.label))));
            }), rightTitle: description.title, rightDescription: description.text }),
        React.createElement(Box, { marginTop: 1, marginLeft: 1 }, footer)));
};
//# sourceMappingURL=question.js.map