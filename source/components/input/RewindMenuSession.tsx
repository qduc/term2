import React, { useEffect, useMemo, useRef, useState } from 'react';
import RewindMenu, { MAX_VISIBLE_ITEMS } from '../menu/RewindMenu.js';
import { useSelection } from '../../hooks/use-selection.js';
import { getRewindScrollOffset } from '../../hooks/use-rewind-selection.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuEvent, MenuFrame, MenuInteraction } from './menu-types.js';

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'rewind' }>>;

/**
 * Mounted controller session for the rewind picker. The picker presentation is
 * deliberately unchanged; this component only owns selection and translates
 * terminal events into controller effects.
 */
export function RewindMenuSession({ frame, active, interactions }: Props) {
  const selection = useSelection(frame.items, { initialIndex: Math.max(0, frame.items.length - 1) });
  const [disposition, setDisposition] = useState(frame.initialDisposition);
  const dispositionRef = useRef(frame.initialDisposition);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const nextOffset = getRewindScrollOffset(frame.items.length, selection.selectedIndex, scrollOffset);
    if (nextOffset !== scrollOffset) {
      setScrollOffset(nextOffset); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [frame.items.length, selection.selectedIndex, scrollOffset]);

  const interaction = useMemo<MenuInteraction>(() => {
    const effectFor = (event: MenuEvent): MenuEffect | 'fallthrough' | void => {
      switch (event.type) {
        case 'move':
          if (event.direction === 'up') selection.moveUp();
          else if (event.direction === 'down') selection.moveDown();
          else if (event.direction === 'home') selection.moveHome();
          else if (event.direction === 'end') selection.moveEnd();
          else if (event.direction === 'page-up') selection.pageUp();
          else selection.pageDown();
          return { stack: { type: 'keep' } };
        case 'command':
          if (event.command === 'tab') {
            const next = dispositionRef.current === 'edit' ? 'resend' : 'edit';
            dispositionRef.current = next;
            setDisposition(next);
          }
          return { stack: { type: 'keep' } };
        case 'accept': {
          const item = selection.getSelectedItem();
          if (!item) return 'fallthrough';
          return {
            stack: { type: 'close-top' },
            intent: {
              id: `rewind:${frame.id}`,
              sourceFrameId: frame.id,
              intent: { type: 'rewind', item, disposition: dispositionRef.current },
            },
          };
        }
        case 'escape':
          return { stack: { type: 'close-top' } };
      }
    };

    return {
      handle: (event) => {
        if (!('type' in event)) return;
        return effectFor(event);
      },
    };
  }, [frame.id, selection]);

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  return (
    <RewindMenu
      items={frame.items}
      selectedIndex={selection.selectedIndex}
      scrollOffset={scrollOffset}
      maxHeight={MAX_VISIBLE_ITEMS}
      disposition={disposition}
    />
  );
}
