import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const HINTS = [
    ['↑↓', 'navigate'],
    ['⏎', 'select'],
    ['y/n', 'answer'],
    ['Esc', 'cancel'],
];
/** The single look and key contract for every binary confirmation above the input. */
const ConfirmPrompt = ({ question, warning, confirmLabel = 'Yes', declineLabel = 'No', defaultIndex = 0, onConfirm, onDecline, onCancel, }) => {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    const [selectedIndex, setSelectedIndex] = useState(defaultIndex);
    useInput((input, key) => {
        if (key.upArrow || key.downArrow) {
            setSelectedIndex((previous) => (previous === 0 ? 1 : 0));
            return;
        }
        if (key.return) {
            if (selectedIndex === 0)
                onConfirm();
            else
                onDecline();
            return;
        }
        if (input === 'y' || input === 'Y') {
            onConfirm();
            return;
        }
        if (input === 'n' || input === 'N') {
            onDecline();
            return;
        }
        if (key.escape || input === '\u001B') {
            onCancel();
        }
    });
    const options = [confirmLabel, declineLabel];
    return (React.createElement(MenuFrame, { borderColor: theme.borderActive, hasItems: false, footerPlacement: "outside" },
        warning && (React.createElement(Text, { color: theme.warning },
            GLYPH_WARNING,
            " ",
            warning)),
        React.createElement(Text, { bold: true }, question),
        React.createElement(Box, { flexDirection: "column", marginTop: 1 }, options.map((label, index) => {
            const selected = index === selectedIndex;
            return (React.createElement(Box, { key: label },
                React.createElement(SelectionMarker, { selected: selected }),
                React.createElement(Text, { color: selected ? theme.accent : theme.textMuted, bold: selected }, label)));
        })),
        React.createElement(MenuFooter, { hints: HINTS })));
};
export default ConfirmPrompt;
//# sourceMappingURL=ConfirmPrompt.js.map