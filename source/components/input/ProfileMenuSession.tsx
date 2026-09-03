import React, { useEffect, useMemo } from 'react';
import ProfileSelectionMenu from '../menu/ProfileSelectionMenu.js';
import type { ProfileOption } from '../../hooks/use-profile-selection.js';
import { PROFILE_TRIGGER } from '../../hooks/use-profile-selection.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';

type ProfileState = ReturnType<typeof import('../../hooks/use-profile-selection.js').useProfileSelection>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'profile' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'profile' }>>['services'] & {
    profiles: ProfileState;
  };
};

export function ProfileMenuSession({ frame, active, controller, interactions, services }: Props) {
  const profiles = services.profiles;
  const keep = (): MenuEffect => ({ stack: { type: 'keep' } });
  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        if (!('type' in event)) return;
        if (applyMenuEditorEvent(controller, event)) return keep();
        switch (event.type) {
          case 'move':
            if (event.direction === 'up') profiles.moveUp();
            else if (event.direction === 'down') profiles.moveDown();
            else if (event.direction === 'home') profiles.moveHome();
            else if (event.direction === 'end') profiles.moveEnd();
            else if (event.direction === 'page-up') profiles.pageUp();
            else profiles.pageDown();
            return { stack: { type: 'keep' } };
          case 'command':
            return { stack: { type: 'keep' } };
          case 'accept': {
            const selected = profiles.getSelectedItem() as ProfileOption | undefined;
            if (!selected) return 'fallthrough';

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
    }),
    [controller, frame.id, profiles],
  );

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <ProfileSelectionMenu
      items={profiles.profiles}
      activeProfileId={profiles.activeProfileId}
      selectedIndex={profiles.selectedIndex}
      scrollOffset={profiles.scrollOffset}
      query={frame.binding.query}
    />
  );
}
