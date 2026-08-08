import React, { useEffect, useMemo } from 'react';
import SkillSelectionMenu from '../menu/SkillSelectionMenu.js';
import { computeSkillInsertion } from './insertions.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuFrame, MenuInteraction } from './menu-types.js';

type SkillsState = ReturnType<typeof import('../../hooks/use-skill-selection.js').useSkillSelection>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'skills' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'skills' }>>['services'] & {
    skills: SkillsState;
  };
};

export function SkillsMenuSession({ frame, active, controller, interactions, services }: Props) {
  const skills = services.skills;
  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        if (!('type' in event)) return;
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
            const editor = controller.getSnapshot().editor;
            const insertion = computeSkillInsertion({
              selection: selected,
              triggerIndex: frame.binding.replacement.start,
              value: editor.text,
              cursorOffset: editor.cursor,
              appendTrailingSpace: true,
            });
            if (!insertion) return 'fallthrough';
            return {
              buffer: { type: 'replace', text: insertion.nextValue, cursor: insertion.nextCursor },
              stack: { type: 'close-top' },
            };
          }
          case 'escape':
            return { stack: { type: 'close-top' } };
        }
      },
    }),
    [controller, frame, skills],
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
