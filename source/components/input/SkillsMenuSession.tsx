import React, { useEffect, useMemo } from 'react';
import SkillSelectionMenu from '../menu/SkillSelectionMenu.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';

type SkillsState = ReturnType<typeof import('../../hooks/use-skill-selection.js').useSkillSelection>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'skills' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'skills' }>>['services'] & {
    skills: SkillsState;
    onSkillSelected?: (skill: SkillInfo) => void;
    onSystemMessage?: (text: string) => void;
  };
};

export function SkillsMenuSession({ frame, active, controller, interactions, services }: Props) {
  const skills = services.skills;
  const { onSkillSelected, onSystemMessage } = services;
  const keep = (): MenuEffect => ({ stack: { type: 'keep' } });
  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        if (!('type' in event)) return;
        if (applyMenuEditorEvent(controller, event)) return keep();
        switch (event.type) {
          case 'move':
            if (event.direction === 'up') skills.moveUp();
            else if (event.direction === 'down') skills.moveDown();
            else if (event.direction === 'home') skills.moveHome();
            else if (event.direction === 'end') skills.moveEnd();
            else if (event.direction === 'page-up') skills.pageUp();
            else skills.pageDown();
            return { stack: { type: 'keep' } };
          case 'command':
            return { stack: { type: 'keep' } };
          case 'accept': {
            const selected = skills.getSelectedItem() as SkillInfo | undefined;
            if (!selected) return 'fallthrough';

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
    }),
    [controller, onSkillSelected, onSystemMessage, skills],
  );

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <SkillSelectionMenu
      items={skills.skills}
      selectedIndex={skills.selectedIndex}
      scrollOffset={skills.scrollOffset}
      query={frame.binding.query}
    />
  );
}
