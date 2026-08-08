import React, { useEffect, useMemo } from 'react';
import PathSelectionMenu from '../menu/PathSelectionMenu.js';
import { computePathInsertion } from './insertions.js';
import type { PathCompletionItem } from '../../hooks/use-path-completion.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';

type PathState = ReturnType<typeof import('../../hooks/use-path-completion.js').usePathCompletion>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'path' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'path' }>>['services'] & {
    path: PathState;
  };
};

const insertionEffect = (
  frame: Extract<MenuFrame, { kind: 'path' }>,
  path: PathState,
  controller: Props['controller'],
  appendTrailingSpace: boolean,
): MenuEffect | 'fallthrough' => {
  const selected = path.getSelectedItem() as PathCompletionItem | undefined;
  const editor = controller.getSnapshot().editor;
  const insertion = computePathInsertion({
    selection: selected,
    triggerIndex: frame.binding.replacement.start,
    value: editor.text,
    cursorOffset: editor.cursor,
    appendTrailingSpace,
  });
  if (!insertion) return 'fallthrough';

  return {
    buffer: { type: 'replace', text: insertion.nextValue, cursor: insertion.nextCursor },
    stack: { type: 'close-top' },
  };
};

export function PathMenuSession({ frame, active, controller, interactions, services }: Props) {
  const path = services.path;
  const keep = (): MenuEffect => ({ stack: { type: 'keep' } });
  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        if (!('type' in event)) return;
        if (applyMenuEditorEvent(controller, event)) return keep();
        switch (event.type) {
          case 'move':
            if (event.direction === 'up') path.moveUp();
            else if (event.direction === 'down') path.moveDown();
            else if (event.direction === 'home') path.moveHome();
            else if (event.direction === 'end') path.moveEnd();
            else if (event.direction === 'page-up') path.pageUp();
            else path.pageDown();
            return { stack: { type: 'keep' } };
          case 'command':
            return event.command === 'tab'
              ? insertionEffect(frame, path, controller, false)
              : { stack: { type: 'keep' } };
          case 'accept':
            return insertionEffect(frame, path, controller, true);
          case 'escape':
            return { stack: { type: 'close-top' } };
          default:
            return;
        }
      },
    }),
    [controller, frame, path],
  );

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <PathSelectionMenu
      items={path.filteredEntries}
      selectedIndex={path.selectedIndex}
      scrollOffset={path.scrollOffset}
      query={frame.binding.query}
      loading={path.loading}
      error={path.error}
      warning={path.warning}
    />
  );
}
