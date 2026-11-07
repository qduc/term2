import React, { useMemo } from 'react';
import CopyMenu from './CopyMenu.js';
import { useSelection } from './use-selection.js';
import type { CopySelection } from './menu-types.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { useMenuInteraction } from './use-menu-interaction.js';

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'copy' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'copy' }>>['services'] & {
    onCopySelection?: (selection: CopySelection) => void;
  };
};

export function CopyMenuSession({ frame, active, interactions, services }: Props) {
  const selection = useSelection(frame.items);
  const { onCopySelection } = services;
  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        if (!('type' in event)) return;

        switch (event.type) {
          case 'move':
            if (event.direction === 'up') selection.moveUp();
            else if (event.direction === 'down') selection.moveDown();
            else if (event.direction === 'home') selection.moveHome();
            else if (event.direction === 'end') selection.moveEnd();
            else if (event.direction === 'page-up') selection.pageUp();
            else selection.pageDown();
            return { stack: { type: 'keep' } } satisfies MenuEffect;
          case 'accept': {
            const selected = selection.getSelectedItem();
            if (!selected || !onCopySelection) return 'fallthrough';
            onCopySelection(selected);
            return { stack: { type: 'close-top' } } satisfies MenuEffect;
          }
          case 'escape':
            return { stack: { type: 'close-top' } } satisfies MenuEffect;
          default:
            return { stack: { type: 'keep' } } satisfies MenuEffect;
        }
      },
    }),
    [onCopySelection, selection],
  );

  useMenuInteraction(interactions, frame.id, active, interaction);

  if (!active) return null;
  return <CopyMenu items={frame.items} selectedIndex={selection.selectedIndex} />;
}
