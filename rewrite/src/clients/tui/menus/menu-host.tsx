/**
 * Hosts the legacy menu stack inside the native session. The composer draft is
 * mirrored into the controller's editor as legacy's InputContext did; while a
 * frame is open `MenuSurface` replaces the composer (legacy
 * ApplicationInputSurface) and owns the keys, and when the stack empties the
 * controller's text goes back into the composer.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useInput } from 'ink';
import type { TuiMenus } from '../integration.js';
import { MenuControllerImpl } from './menu-controller.js';
import { createDefaultTriggerRegistry } from './triggers.js';
import { MenuSurface } from './MenuSurface.js';
import { InputProvider } from './input-context.js';
import { MENU_RULE_IDS, useMenuServices, type MenuActions } from './menu-services.js';
import { legacySlashCommands } from './legacy-commands.js';
import { menuIntentHost } from './menu-intent-host.js';

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
  // Legacy openProvidersMenu: close whatever is open and open the frame; only when the app serves its data.
  const openFrame = useCallback(
    (frame: 'providers'): boolean => {
      if (!menus?.[frame]) return false;
      controller.closeAll();
      controller.open({ kind: frame });
      return true;
    },
    [controller, menus],
  );
  const commands = useMemo(() => legacySlashCommands(actions.runCommand, openFrame), [actions.runCommand, openFrame]);
  useEffect(() => {
    if (!menus) return;
    controller.setTriggerRegistry(createDefaultTriggerRegistry(commands, MENU_RULE_IDS, menus.schema));
  }, [controller, commands, menus]);
  // The session passes fresh callbacks each render; the host reads the latest.
  const latestActions = useRef(actions);
  latestActions.current = actions;
  useEffect(() => {
    controller.setIntentHost(menuIntentHost(() => latestActions.current));
    return () => controller.setIntentHost(undefined);
  }, [controller]);
  const open = Boolean(menus) && snapshot.stack.length > 0;

  // The text both sides last agreed on. Cursor-only controller revisions and composer keystrokes not yet
  // mirrored must not be mistaken for a menu's edit, or the hand-back would revert the keystroke.
  const synced = useRef('');
  // With no frame open, an editor change the composer did not make (a menu's close, or legacy's deferred
  // command action writing `/model ` after the slash frame closed) becomes the composer draft.
  useEffect(() => {
    if (open) return;
    const { text, cursor } = snapshot.editor;
    if (text === synced.current) return;
    synced.current = text;
    if (text !== composer.value) composer.replace(text, cursor);
  }, [open, snapshot.editor.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror every composer draft change, typed or set from outside (restore, rewind, a command's draft), as
  // legacy's composer wrote through the controller; a trigger may open a frame.
  useEffect(() => {
    if (!menus || !enabled || open || composer.value === synced.current) return;
    synced.current = composer.value;
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
    /** Open an explicitly opened frame, as a typed `/providers` does in legacy; false when it has no menu. */
    openFrame,
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
