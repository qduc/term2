import React from 'react';
import { Text, useInput } from 'ink';
import { MenuFooter } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const QueuePausedPrompt = ({ queueLength, pauseReason, onResume, onDiscard, onCommand, }) => {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    useInput((input, key) => {
        if (input.startsWith('/')) {
            onCommand(input);
            return;
        }
        if (input === 'r' || input === 'R') {
            onResume();
            return;
        }
        if (input === 'x' || input === 'X') {
            onDiscard();
            return;
        }
        // Esc must never implicitly discard queued messages.
        if (key.escape)
            return;
    });
    return (React.createElement(MenuFrame, { borderColor: theme.borderActive, hasItems: false, footerPlacement: "outside" },
        React.createElement(Text, { color: theme.warning },
            GLYPH_WARNING,
            " Queue paused: ",
            queueLength,
            " ",
            queueLength === 1 ? 'item' : 'items',
            " pending.",
            pauseReason === 'failure' ? ' Last turn failed.' : ''),
        React.createElement(MenuFooter, { hints: [
                ['r', 'resume'],
                ['x', 'discard'],
                ['/', 'commands (keep paused)'],
            ] })));
};
export default QueuePausedPrompt;
//# sourceMappingURL=QueuePausedPrompt.js.map