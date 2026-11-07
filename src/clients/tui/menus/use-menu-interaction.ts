import { useLayoutEffect } from 'react';
import type { FrameId, MenuInteraction, MenuInteractionRegistry } from './menu-types.js';

/**
 * Route keys to the active menu through the interaction built from the state on screen.
 *
 * A passive effect runs after the frame is written, so a key that arrived in between (an Enter typed as
 * soon as the resume list appeared) reached the previous interaction, whose closure still held the empty,
 * loading list, and fell through. A layout effect runs in the same commit as the render, before any input
 * can be read.
 */
export function useMenuInteraction(
  interactions: MenuInteractionRegistry,
  frameId: FrameId,
  active: boolean,
  interaction: MenuInteraction,
): void {
  useLayoutEffect(() => {
    if (!active) return;
    return interactions.register(frameId, interaction);
  }, [active, frameId, interaction, interactions]);
}
