import React, { useEffect, useMemo } from 'react';
import ResumeSelectionMenu from '../menu/ResumeSelectionMenu.js';
import type { ConversationListEntry } from '../../services/conversation/conversation-persistence.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';

type ResumeState = ReturnType<typeof import('../../hooks/use-resume-selection.js').useResumeSelection>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'resume' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'resume' }>>['services'] & {
    resume: ResumeState;
    onResumeConversation?: (target?: string) => void | Promise<void>;
  };
};

export function ResumeMenuSession({ frame, active, controller, interactions, services }: Props) {
  const resume = services.resume;
  const { onResumeConversation } = services;
  const keep = (): MenuEffect => ({ stack: { type: 'keep' } });

  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        if (!('type' in event)) return;
        if (applyMenuEditorEvent(controller, event)) return keep();
        switch (event.type) {
          case 'move':
            if (event.direction === 'up') resume.moveUp();
            else if (event.direction === 'down') resume.moveDown();
            else if (event.direction === 'home') resume.moveHome();
            else if (event.direction === 'end') resume.moveEnd();
            else if (event.direction === 'page-up') resume.pageUp();
            else resume.pageDown();
            return { stack: { type: 'keep' } };
          case 'command':
            return { stack: { type: 'keep' } };
          case 'accept': {
            const selected = resume.getSelectedItem() as ConversationListEntry | undefined;
            if (!selected) return 'fallthrough';

            void onResumeConversation?.(selected.id);
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
    }),
    [controller, onResumeConversation, resume],
  );

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <ResumeSelectionMenu
      items={resume.conversations}
      selectedIndex={resume.selectedIndex}
      scrollOffset={resume.scrollOffset}
      query={frame.binding.query}
    />
  );
}
