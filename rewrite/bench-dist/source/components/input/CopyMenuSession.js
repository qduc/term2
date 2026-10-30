import React, { useEffect, useMemo } from 'react';
import CopyMenu from '../menu/CopyMenu.js';
import { useSelection } from '../../hooks/use-selection.js';
export function CopyMenuSession({ frame, active, interactions, services }) {
    const selection = useSelection(frame.items);
    const { onCopySelection } = services;
    const interaction = useMemo(() => ({
        handle: (event) => {
            if (!('type' in event))
                return;
            switch (event.type) {
                case 'move':
                    if (event.direction === 'up')
                        selection.moveUp();
                    else if (event.direction === 'down')
                        selection.moveDown();
                    else if (event.direction === 'home')
                        selection.moveHome();
                    else if (event.direction === 'end')
                        selection.moveEnd();
                    else if (event.direction === 'page-up')
                        selection.pageUp();
                    else
                        selection.pageDown();
                    return { stack: { type: 'keep' } };
                case 'accept': {
                    const selected = selection.getSelectedItem();
                    if (!selected || !onCopySelection)
                        return 'fallthrough';
                    onCopySelection(selected);
                    return { stack: { type: 'close-top' } };
                }
                case 'escape':
                    return { stack: { type: 'close-top' } };
                default:
                    return { stack: { type: 'keep' } };
            }
        },
    }), [onCopySelection, selection]);
    useEffect(() => {
        if (!active)
            return;
        return interactions.register(frame.id, interaction);
    }, [active, frame.id, interaction, interactions]);
    if (!active)
        return null;
    return React.createElement(CopyMenu, { items: frame.items, selectedIndex: selection.selectedIndex });
}
//# sourceMappingURL=CopyMenuSession.js.map