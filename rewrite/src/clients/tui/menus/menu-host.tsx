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
import type { UnboundFrameSpec } from './menu-types.js';
import { createDefaultTriggerRegistry } from './triggers.js';
import { MenuSurface } from './MenuSurface.js';
import { InputProvider } from './input-context.js';
import { MENU_RULE_IDS, useMenuWiring, type MenuActions } from './menu-wiring.js';
import { legacySlashCommands } from './legacy-commands.js';
import { createIntentHost, settingsIntentHandlers } from './menu-intents.js';
import { installSettingsLibrary } from './settings-lib.js';
import { FirstRunSetupPrompt } from '../presentation/components/prompt/FirstRunSetupPrompt.js';
import { useFirstRunSetupGate, type FirstRunSetupGate } from './use-first-run-setup.js';

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
  // Legacy app.tsx useFirstRunSetupGate. Credentials are the providers menu's: it saves them.
  const gateSettings = useMemo(() => {
    const providers = menus?.providers;
    if (!menus || !providers) return undefined;
    const models = menus.models.settings(sessionId);
    return {
      get: models.get,
      onChange: menus.settings.service(sessionId).onChange,
      providerLabel: models.providerLabel,
      hasProviderCredentials: (id: string) => providers.hasCredentials(sessionId, id),
    };
  }, [menus, sessionId]);
  const firstRun = useFirstRunSetupGate({ settings: gateSettings, controller });
  const latestFirstRun = useRef(firstRun);
  latestFirstRun.current = firstRun;
  const open = Boolean(menus) && snapshot.stack.length > 0;
  if (menus) installSettingsLibrary(menus.settings.lib);
  // Legacy app.tsx's intent host, limited to the ported menus' intents: the controller hands committed intents
  // to the session's commands.
  const latestActions = useRef(actions);
  latestActions.current = actions;
  useEffect(() => {
    if (!menus) return;
    const settingsHandlers = settingsIntentHandlers({
      command: (text) => latestActions.current.command(text),
      notice: (text) => latestActions.current.notice(text),
      settings: () => menus.settings.service(sessionId),
    });
    controller.setIntentHost(
      createIntentHost({
        ...settingsHandlers,
        // Legacy: an applied main-model selection completes first-run setup.
        'apply-settings': async (request) => {
          const result = await settingsHandlers['apply-settings']!(request);
          if (result?.ok && request.intent.changes.some((change) => change.key === 'agent.modelSelection'))
            latestFirstRun.current.completeModelSelection();
          return result;
        },
        // A menu's composed text runs as if typed and submitted: legacy's slash dispatch and its fallback to a turn.
        'submit-prompt': ({ intent }) => latestActions.current.runCommand(intent.text),
        rewind: ({ intent }) => latestActions.current.rewind(intent.item, intent.disposition),
      }),
    );
    return () => controller.setIntentHost(undefined);
  }, [controller, menus, sessionId]);

  // Legacy app.tsx pendingSkillRef: a skill picked in the menu rides on the next message, which runs as
  // next's `/skills <name> <request>`; Esc drops it (legacy use-app-keyboard-shortcuts).
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);
  useInput(
    (_input, key) => {
      if (!key.escape || open) return;
      setPendingSkill(null);
      actions.notice('Skill activation cancelled.');
    },
    { isActive: pendingSkill !== null && enabled },
  );

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
    /**
     * Legacy input owners 'menu' and 'first-run-setup': no composer, and no harness idle, while a menu or
     * first-run setup owns input.
     */
    owns: open || firstRun.active,
    /** Legacy BottomArea's FirstRunSetupPrompt, right under the live divider. */
    firstRunPrompt:
      firstRun.active && firstRun.phase ? (
        <FirstRunSetupPrompt
          phase={firstRun.phase}
          provider={firstRun.provider}
          providerLabel={gateSettings?.providerLabel(firstRun.provider) ?? firstRun.provider}
        />
      ) : null,
    /** Open an explicitly opened frame, as a typed `/providers` does in legacy; false when it has no menu. */
    openFrame,
    /** Legacy openCopyMenu: a command's frame replaces any open menu, with the input cleared. */
    openMenu(frame: UnboundFrameSpec) {
      controller.closeAll();
      controller.open(frame, { buffer: { type: 'clear' } });
    },
    /** Legacy attachPendingSkill: only a message (not a slash command) takes the pending skill. */
    withPendingSkill(input: string): string {
      if (!pendingSkill || !input.trim() || input.startsWith('/')) return input;
      setPendingSkill(null);
      return `/skills ${pendingSkill} ${input}`;
    },
    /**
     * The text the harness sees: the controller's while a menu owns it, and while the stack mirrors the composer
     * also until the draft reached the controller. Legacy's composer was the controller's editor, so a typed
     * trigger opened its menu before the draft was acknowledged.
     */
    value: open || (menus && enabled) ? snapshot.editor.text : composer.value,
    /**
     * A frame closed with a new text that the hand-back effect has not yet written to the composer. Legacy's editor
     * shows the menu's text at once, so the remounting composer must not draw the stale draft one character per line.
     */
    handingBack: !open && Boolean(menus) && snapshot.editor.text !== synced.current,
    /** What Ctrl+C clears: the menu's text while one owns it (legacy's global handler cleared it there too). */
    typed: {
      value: open ? snapshot.editor.text : composer.value,
      replace: (text: string) => (open ? controller.replaceText(text, text.length) : composer.replace(text)),
    },
    cursorChanged(cursor: number) {
      if (!menus || !enabled) return;
      if (controller.getSnapshot().editor.cursor !== cursor)
        controller.applyEditorEdit({ type: 'move-cursor', cursor });
    },
    // Always mounted, as legacy's ApplicationInputSurface kept its menu hooks mounted across opens.
    view: menus ? (
      <InputProvider controller={controller} menus={menus} sessionId={sessionId}>
        <MenuStackView
          open={open}
          enabled={enabled}
          commands={commands}
          actions={actions}
          controller={controller}
          onSkillSelected={setPendingSkill}
          firstRun={firstRun}
        />
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
  readonly onSkillSelected: (name: string) => void;
  readonly firstRun: FirstRunSetupGate;
}): React.ReactElement | null {
  const { open, enabled, commands, actions, controller, onSkillSelected, firstRun } = props;
  const wired = useMenuWiring({ commands, actions, onSkillSelected });
  // Legacy BottomArea: provider selection reports to the gate only during setup; an unavailable model reopens it.
  const services = {
    ...wired,
    onProviderSelected: firstRun.active ? firstRun.onProviderSelected : undefined,
    onUnavailableModelSelected: firstRun.requestSetup,
  };
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
