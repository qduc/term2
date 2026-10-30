import React, { useEffect, useMemo } from 'react';
import ResumeSelectionMenu from '../menu/ResumeSelectionMenu.js';
import { applyMenuEditorEvent } from './menu-editor.js';
export function ResumeMenuSession({ frame, active, controller, interactions, services }) {
    const resume = services.resume;
    const { onResumeConversation } = services;
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
                        resume.moveUp();
                    else if (event.direction === 'down')
                        resume.moveDown();
                    else if (event.direction === 'home')
                        resume.moveHome();
                    else if (event.direction === 'end')
                        resume.moveEnd();
                    else if (event.direction === 'page-up')
                        resume.pageUp();
                    else
                        resume.pageDown();
                    return { stack: { type: 'keep' } };
                case 'command':
                    return { stack: { type: 'keep' } };
                case 'accept': {
                    const selected = resume.getSelectedItem();
                    if (!selected)
                        return 'fallthrough';
                    void onResumeConversation?.(selected.id);
                    return {
                        buffer: { type: 'clear' },
                        stack: { type: 'close-top' },
                    };
                }
                case 'escape':
                    return { buffer: { type: 'clear' }, stack: { type: 'close-top' } };
                default:
                    return;
            }
        },
    }), [controller, onResumeConversation, resume]);
    useEffect(() => {
        if (!active)
            return;
        return interactions.register(frame.id, interaction);
    }, [active, frame.id, interaction, interactions]);
    if (!active)
        return null;
    return (React.createElement(ResumeSelectionMenu, { items: resume.conversations, selectedIndex: resume.selectedIndex, scrollOffset: resume.scrollOffset, query: frame.binding.query, loading: resume.loading, error: resume.error }));
}
//# sourceMappingURL=ResumeMenuSession.js.map