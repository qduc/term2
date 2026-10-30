import React, { useEffect, useMemo } from 'react';
import SkillSelectionMenu from '../menu/SkillSelectionMenu.js';
import { applyMenuEditorEvent } from './menu-editor.js';
export function SkillsMenuSession({ frame, active, controller, interactions, services }) {
    const skills = services.skills;
    const { onSkillSelected, onSystemMessage } = services;
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
                        skills.moveUp();
                    else if (event.direction === 'down')
                        skills.moveDown();
                    else if (event.direction === 'home')
                        skills.moveHome();
                    else if (event.direction === 'end')
                        skills.moveEnd();
                    else if (event.direction === 'page-up')
                        skills.pageUp();
                    else
                        skills.pageDown();
                    return { stack: { type: 'keep' } };
                case 'command':
                    return { stack: { type: 'keep' } };
                case 'accept': {
                    const selected = skills.getSelectedItem();
                    if (!selected)
                        return 'fallthrough';
                    onSkillSelected?.(selected);
                    onSystemMessage?.(`Skill "${selected.name}" activated. Type your request (or press Esc to cancel).`);
                    return {
                        buffer: { type: 'clear' },
                        stack: { type: 'close-top' },
                    };
                }
                case 'escape':
                    return { stack: { type: 'close-top' } };
                default:
                    return;
            }
        },
    }), [controller, onSkillSelected, onSystemMessage, skills]);
    useEffect(() => {
        if (!active)
            return;
        return interactions.register(frame.id, interaction);
    }, [active, frame.id, interaction, interactions]);
    if (!active)
        return null;
    return (React.createElement(SkillSelectionMenu, { items: skills.skills, selectedIndex: skills.selectedIndex, scrollOffset: skills.scrollOffset, query: frame.binding.query }));
}
//# sourceMappingURL=SkillsMenuSession.js.map