import React, { useEffect, useMemo } from 'react';
import ProfileSelectionMenu from '../menu/ProfileSelectionMenu.js';
import { PROFILE_TRIGGER } from '../../hooks/use-profile-selection.js';
import { applyMenuEditorEvent } from './menu-editor.js';
export function ProfileMenuSession({ frame, active, controller, interactions, services }) {
    const profiles = services.profiles;
    const keep = () => ({ stack: { type: 'keep' } });
    const interaction = useMemo(() => ({
        handle: (event) => {
            if (!('type' in event))
                return;
            if (applyMenuEditorEvent(controller, event))
                return keep();
            switch (event.type) {
                case 'move':
                    if (event.direction === 'up')
                        profiles.moveUp();
                    else if (event.direction === 'down')
                        profiles.moveDown();
                    else if (event.direction === 'home')
                        profiles.moveHome();
                    else if (event.direction === 'end')
                        profiles.moveEnd();
                    else if (event.direction === 'page-up')
                        profiles.pageUp();
                    else
                        profiles.pageDown();
                    return { stack: { type: 'keep' } };
                case 'command':
                    return { stack: { type: 'keep' } };
                case 'accept': {
                    const selected = profiles.getSelectedItem();
                    if (!selected)
                        return 'fallthrough';
                    // Route through the normal slash dispatch so `/profile <id>`
                    // guards (e.g. the Lite history confirmation) apply unchanged.
                    const text = `${PROFILE_TRIGGER}${selected.shortId}`;
                    return {
                        buffer: { type: 'clear' },
                        stack: { type: 'close-top' },
                        intent: {
                            id: `submit:${frame.id}`,
                            sourceFrameId: frame.id,
                            intent: { type: 'submit-prompt', text },
                        },
                    };
                }
                case 'escape':
                    return { stack: { type: 'close-top' } };
                default:
                    return;
            }
        },
    }), [controller, frame.id, profiles]);
    useEffect(() => {
        if (!active)
            return;
        return interactions.register(frame.id, interaction);
    }, [active, frame.id, interaction, interactions]);
    if (!active)
        return null;
    return (React.createElement(ProfileSelectionMenu, { items: profiles.profiles, activeProfileId: profiles.activeProfileId, selectedIndex: profiles.selectedIndex, scrollOffset: profiles.scrollOffset, query: frame.binding.query }));
}
//# sourceMappingURL=ProfileMenuSession.js.map