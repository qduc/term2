/**
 * Hosts the legacy menu stack inside the native session. The composer draft is
 * mirrored into the controller's editor as legacy's InputContext did; while a
 * frame is open `MenuSurface` replaces the composer (legacy
 * ApplicationInputSurface) and owns the keys, and when the stack empties the
 * controller's text goes back into the composer.
 */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useInput } from 'ink';
import type { TuiMenus } from '../integration.js';
import { MenuControllerImpl } from './menu-controller.js';
import { createDefaultTriggerRegistry } from './triggers.js';
import { MenuSurface } from './MenuSurface.js';
import { InputProvider } from './input-context.js';
import { MENU_RULE_IDS, useMenuServices, type MenuActions } from './menu-services.js';
import { legacySlashCommands } from './legacy-commands.js';

type Composer = {
  readonly value: string;
  readonly cursor: { readonly current: number };
  readonly replace: (text: string, cursor?: number) => void;
};

export function useMenuStack(options: {
  readonly menus: TuiMenus | undefined;
  readonly sessionId: string;
  readonly composer: Composer;
  /** The composer may hand its draft to a menu (no panel, confirmation or decision owns the keys). */
  readonly enabled: boolean;
  readonly actions: MenuActions;
}) {
  const { menus, sessionId, composer, enabled, actions } = options;
  const [controller] = useState(() => new MenuControllerImpl());
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
  );
  const commands = useMemo(() => legacySlashCommands(actions.runCommand), [actions.runCommand]);
  useEffect(() => {
    if (!menus) return;
    controller.setTriggerRegistry(createDefaultTriggerRegistry(commands, MENU_RULE_IDS, menus.schema));
  }, [controller, commands, menus]);
  const open = Boolean(menus) && snapshot.stack.length > 0;

  // The stack emptied: whatever the menu left in the editor is the composer draft again.
  useEffect(() => {
    if (open) return;
    const { text, cursor } = controller.getSnapshot().editor;
    if (text !== composer.value) composer.replace(text, cursor);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror every composer draft change, typed or set from outside (restore, rewind, a command's draft), as
  // legacy's composer wrote through the controller; a trigger may open a frame. The stack's own hand-back is
  // already in the controller, so a Tab-completed `/model ` does not reopen a picker.
  useEffect(() => {
    if (!menus || !enabled || open) return;
    const previous = controller.getSnapshot().editor;
    if (previous.text === composer.value) return;
    const atEnd = previous.cursor >= previous.text.length;
    controller.replaceText(composer.value, atEnd ? composer.value.length : composer.cursor.current);
  }, [composer.value, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Legacy keeps Escape subscribed across the editor/menu remount (ApplicationInputSurface).
  useInput(
    (_input, key) => {
      if (!open || !enabled || !key.escape) return;
      if (controller.getSnapshot().stack.length === 0) return;
      controller.escape();
    },
    { isActive: open },
  );

  return {
    open,
    /** The text the harness and composer consumers see: the controller's while a menu owns it. */
    value: open ? snapshot.editor.text : composer.value,
    cursorChanged(cursor: number) {
      if (!menus || !enabled) return;
      if (controller.getSnapshot().editor.cursor !== cursor)
        controller.applyEditorEdit({ type: 'move-cursor', cursor });
    },
    // Always mounted, as legacy's ApplicationInputSurface kept its menu hooks mounted across opens.
    view: menus ? (
      <InputProvider controller={controller} menus={menus} sessionId={sessionId}>
        <MenuStackView open={open} enabled={enabled} commands={commands} actions={actions} controller={controller} />
      </InputProvider>
    ) : null,
  };
}

function MenuStackView(props: {
  readonly open: boolean;
  readonly enabled: boolean;
  readonly commands: ReturnType<typeof legacySlashCommands>;
  readonly actions: MenuActions;
  readonly controller: MenuControllerImpl;
}): React.ReactElement | null {
  const { open, enabled, commands, actions, controller } = props;
  const services = useMenuServices({ commands, actions });
  const { stack } = controller.getSnapshot();
  if (!open) return null;
  return (
    <MenuSurface
      stack={stack}
      controller={controller}
      interactions={controller.getInteractionRegistry()}
      services={services}
      enabled={enabled}
    />
  );
}
