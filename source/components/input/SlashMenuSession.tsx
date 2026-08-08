import React, { useEffect, useMemo } from 'react';
import SlashCommandMenu from '../menu/SlashCommandMenu.js';
import type { useSlashCommands } from '../../hooks/use-slash-commands.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'slash' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'slash' }>>['services'] & {
    slash: ReturnType<typeof useSlashCommands>;
    onSlashTabComplete?: (command: ReturnType<typeof useSlashCommands>['filteredCommands'][number]) => boolean;
  };
};

export function SlashMenuSession({ frame, active, interactions, services }: Props) {
  const slash = services.slash;

  const interaction = useMemo<MenuInteraction>(() => {
    const keep = (): MenuEffect => ({ stack: { type: 'keep' } });

    return {
      handle: (event) => {
        if (!('type' in event)) return;
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
              if (selected && services.onSlashTabComplete?.(selected)) return { stack: { type: 'close-top' } };
              slash.completeSelected();
            }
            return keep();
          case 'accept':
            slash.executeSelected();
            return { stack: { type: 'close-top' } };
          case 'escape':
            return { stack: { type: 'close-top' }, buffer: { type: 'clear' } };
        }
      },
    };
  }, [services, slash]);

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
