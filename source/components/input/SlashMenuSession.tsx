import React, { useEffect, useMemo } from 'react';
import SlashCommandMenu from '../menu/SlashCommandMenu.js';
import type { useSlashCommands } from '../../hooks/use-slash-commands.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuController, MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';

type SlashState = ReturnType<typeof useSlashCommands>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'slash' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'slash' }>>['services'] & {
    slash: SlashState;
  };
};

/**
 * Tab inserts the selected command into the editor (`/name `) and closes the
 * slash frame. It never executes the command: commands such as `/rewind` or
 * `/model` take a parameter after the name, so the user must be able to finish
 * typing and press Enter themselves. The successor-trigger machinery is not
 * re-run for this close, so inserting `/model ` does not open the model picker.
 */
export function createSlashMenuInteraction(controller: MenuController, slash: SlashState): MenuInteraction {
  const keep = (): MenuEffect => ({ stack: { type: 'keep' } });

  return {
    handle: (event) => {
      if (!('type' in event)) return;
      if (applyMenuEditorEvent(controller, event)) return keep();
      switch (event.type) {
        case 'move':
          if (event.direction === 'up') slash.moveUp();
          else if (event.direction === 'down') slash.moveDown();
          else if (event.direction === 'home') slash.moveHome();
          else if (event.direction === 'end') slash.moveEnd();
          else if (event.direction === 'page-up') slash.pageUp();
          else slash.pageDown();
          return keep();
        case 'command':
          if (event.command === 'tab') {
            const selected = slash.getSelectedItem();
            if (!selected) return keep();
            const nextValue = `/${selected.name} `;
            return {
              buffer: { type: 'replace', text: nextValue, cursor: nextValue.length },
              stack: { type: 'close-top' },
            };
          }
          return keep();
        case 'accept':
          slash.executeSelected();
          return { stack: { type: 'close-top' } };
        case 'escape':
          return { stack: { type: 'close-top' }, buffer: { type: 'clear' } };
        default:
          return;
      }
    },
  };
}

export function SlashMenuSession({ frame, active, controller, interactions, services }: Props) {
  const slash = services.slash;

  const interaction = useMemo<MenuInteraction>(
    () => createSlashMenuInteraction(controller, slash),
    [controller, slash],
  );

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <SlashCommandMenu
      commands={slash.filteredCommands}
      selectedIndex={slash.selectedIndex}
      filter={frame.binding.query}
      scrollOffset={slash.scrollOffset}
    />
  );
}
