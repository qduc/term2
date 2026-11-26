/**
 * The chat page's runtime, one per page (docs/plans/web-client/web-shell-decomposition.md, section 4.4): the shell
 * machine and its one command runner, the open chat, the server data, browser preferences, a little local state, the
 * facts derived from all of them, and the multi-step operations. Components reach it through
 * components/term2/shell/ShellContext.tsx and read it by selector. No React here.
 */
import { createBrowserPrefs, type BrowserPrefs } from '../browser-prefs';
import { createServerData, type ServerData } from '../data/server-data';
import { initialShellState, step, type ShellAction, type ShellState } from '../shell-machine';
import { createStore, derivedStore, type ReadableStore, type Store } from '../store';
import type { ModelSummary } from '../types';
import { createChatFacts, type ChatFacts } from './chat-facts';
import { OpenSession } from './open-session';
import { createCommandRunner } from './shell-commands';
import { createShellOperations, type ShellOperations } from './shell-operations';

export type ShellLocalState = {
  readonly configBusy: boolean;
  /** The page's one error banner: a failed list load, a failed first send, a failed default save. */
  readonly pageError: string | null;
  readonly retryError: { readonly turnId: string; readonly message: string } | null;
  readonly retryDraft: { readonly sessionId: string; readonly turnId: string; readonly model: ModelSummary } | null;
};

export interface ComposerHandle {
  focus(): void;
  /** Replaces the text, puts the cursor at its end and focuses (a starter prompt). */
  setText(text: string): void;
  /** Cmd/Ctrl+K: toggles the palette, resets its highlighted row, focuses. */
  togglePalette(): void;
}

export interface ShellRuntime {
  readonly store: ReadableStore<ShellState>;
  dispatch(action: ShellAction): void;
  readonly session: OpenSession;
  readonly data: ServerData;
  readonly prefs: BrowserPrefs;
  readonly local: Store<ShellLocalState>;
  readonly facts: ReadableStore<ChatFacts>;
  readonly ops: ShellOperations;
  /** Set by `Composer` while mounted. */
  readonly composer: { current: ComposerHandle | null };
  /** Mount: opens the open chat's stream and starts the first loads. Safe to call again after `stop()`. */
  start(): void;
  stop(): void;
}

export function createShellRuntime(options: { localControlEnabled: boolean }): ShellRuntime {
  const { localControlEnabled } = options;
  // It starts with no chat open: the first URL_CHANGED opens the address bar's chat like any later change, so the
  // open chat always gets its config loaded.
  let state: ShellState = initialShellState(null);
  const listeners = new Set<() => void>();
  const store: ReadableStore<ShellState> = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const data = createServerData({ localControlEnabled });
  const session = new OpenSession({ chatTitled: data.chatTitled });
  const prefs = createBrowserPrefs();
  const local = createStore<ShellLocalState>({ configBusy: false, pageError: null, retryError: null, retryDraft: null });
  const deriveFacts = createChatFacts();
  const facts = derivedStore(
    [store, session.view, session.feedback, data.settings, data.models, data.folders, data.chats, data.folderDetails, local],
    () =>
      deriveFacts({
        shell: state,
        view: session.view.get(),
        feedback: session.feedback.get(),
        settings: data.settings.get().data,
        models: data.models.get(),
        folders: data.folders.get().data,
        chats: data.chats.get().data.sessions,
        folderDetails: data.folderDetails.get(),
        configBusy: local.get().configBusy,
        localControlEnabled,
      }),
  );
  const composer: { current: ComposerHandle | null } = { current: null };

  let runCommand: (command: Parameters<ReturnType<typeof createCommandRunner>>[0]) => void = () => undefined;
  function dispatch(action: ShellAction) {
    const previous = state;
    const { state: next, commands } = step(previous, action);
    state = next;
    // The stream follows the open chat, before anything renders, so one render never pairs the new chat with the
    // old chat's transcript. It is not a command: URL_CHANGED is still the only action that changes the open chat.
    if (next.openChat !== previous.openChat) session.open(next.openChat);
    if (next !== previous) for (const listener of [...listeners]) listener();
    for (const command of commands) runCommand(command);
  }

  const ops = createShellOperations({ store, dispatch, session, data, prefs, local, facts, composer });
  runCommand = createCommandRunner({
    getState: () => state,
    dispatch,
    session,
    data,
    prefs,
    local,
    ops: () => ops,
    sendSettled: ops.sendSettled,
    localControlEnabled,
  });

  let started = false;
  return {
    store,
    dispatch,
    session,
    data,
    prefs,
    local,
    facts,
    ops,
    composer,
    start() {
      if (!started) {
        started = true;
        void ops.reloadLists();
        if (localControlEnabled) {
          void data.settings.load();
          void data.models.load();
        }
      }
      session.start();
    },
    stop() {
      session.stop();
    },
  };
}
