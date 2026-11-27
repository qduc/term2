/**
 * The chat page's multi-step user actions (docs/plans/web-client/web-shell-decomposition.md, section 4.9): sending,
 * retrying, applying settings, new chats and folder changes. Each was a handler in the shell component; the body is
 * unchanged, and the values it read from the render that created it are read once on entry instead. A value used
 * after an `await` is that entry value, as before, unless the old code read a ref there (`runtime.store.get()`).
 * No React here.
 */
import type { ResendFromTurn } from '../../../components/term2/Term2MessageActions';
import type { SelectedTerm2Workspace } from '../../../components/term2/Term2FolderSelector';
import type { SavedFolderChange } from '../../../components/term2/Term2SavedFolderMenu';
import { term2Client } from '../../api/term2';
import type { BrowserPrefs } from '../browser-prefs';
import { fileToComposerImage } from '../composer-text';
import type { ServerData } from '../data/server-data';
import * as navigation from '../navigation';
import {
  currentTag,
  isCurrentTag,
  type ComposerImage,
  type Delivery,
  type NoticeKey,
  type ShellAction,
  type ShellState,
  type StagedConfig,
  type Tag,
} from '../shell-machine';
import type { ReadableStore } from '../store';
import type { ModelSummary, RewindTargetSummary, SessionConfigUpdate } from '../types';
import type { ChatFacts } from './chat-facts';
import type { OpenSession } from './open-session';
import type { ComposerHandle } from './shell-runtime';

type ConfigSelection = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'mode' | 'approvalMode'>;

export interface ShellOperations {
  reloadLists(): Promise<void>;
  createNewChat(workspaceOverride?: string): void;
  selectChat(id: string): void;
  folderSelected(folder: SelectedTerm2Workspace): void;
  savedFolderChanged(change: SavedFolderChange): Promise<void>;
  applySessionConfig(selection: ConfigSelection, tag?: Tag): Promise<boolean>;
  updateSessionConfig(selection: ConfigSelection): Promise<void>;
  saveBlankChatDefault(selection: StagedConfig): Promise<void>;
  toggleFavorite(favoriteKey: string): Promise<void>;
  addImages(files: FileList | File[]): Promise<void>;
  send(delivery?: Delivery, overrideText?: string, options?: { textOnly?: boolean }): Promise<boolean>;
  retryLastTurn(model?: ModelSummary): Promise<void>;
  resendFromTurn: ResendFromTurn;
  /** Retry under a reply: resendFromTurn, and its failure shown under that turn until the page shows something else. */
  retryReply: ResendFromTurn;
  rewind(target: RewindTargetSummary, restoreText: boolean): Promise<void>;
  handoff(): Promise<void>;
  toggleSkills(): void;
  openProviderSetup(): void;
  providerChosen(model: ModelSummary): void;
  dismissNotices(): void;
  /** Called by the command runner when a send's request settles. */
  sendSettled(requestId: string, accepted: boolean): void;
}

export function createShellOperations(runtime: {
  readonly store: ReadableStore<ShellState>;
  dispatch(action: ShellAction): void;
  readonly session: OpenSession;
  readonly data: ServerData;
  readonly prefs: BrowserPrefs;
  readonly facts: ReadableStore<ChatFacts>;
  readonly composer: { current: ComposerHandle | null };
}): ShellOperations {
  const { store, dispatch, session, data, facts } = runtime;
  const setPageError = (message: string | null) => dispatch({ type: 'PAGE_ERROR', message });
  const notice = (key: NoticeKey, message: string | null, tag: Tag = currentTag(store.get())) =>
    dispatch({ type: 'NOTICE', tag, key, message });
  const focusComposer = () => runtime.composer.current?.focus();
  // A delayed focus after opening a draft or rewinding must not pull focus out of an already-open popover or dialog.
  const focusComposerIfIdle = () => {
    if (
      typeof document !== 'undefined' &&
      document.querySelector('[data-slot="popover-content"], [role="dialog"], [role="alertdialog"]')
    ) {
      return;
    }
    focusComposer();
  };
  // A send's outcome for the caller that asked (an Edit keeps its box busy until then), by request id.
  const sendWaiters = new Map<string, (accepted: boolean) => void>();

  /**
   * Sends with the facts the caller read when its action started. An Edit or Retry reads them before it rewinds:
   * the rewind can empty the chat, which turns a resend into a "first send" that a fresh read would block, and the
   * text would be lost. The machine still decides; a refused resend puts its text back with the resend notice.
   */
  const sendWith = (
    entry: Pick<ChatFacts, 'sendBlocked' | 'runningTurnId' | 'isDraft'>,
    delivery?: Delivery,
    overrideText?: string,
    options?: { textOnly?: boolean },
  ): Promise<boolean> => {
    if (entry.sendBlocked) return Promise.resolve(false);
    const requestId = crypto.randomUUID();
    const action: ShellAction = {
      type: 'SEND_REQUESTED',
      requestId,
      context: { runningTurnId: entry.runningTurnId },
      ...(delivery ? { delivery } : {}),
      ...(overrideText !== undefined ? { overrideText } : {}),
      ...(options?.textOnly ? { textOnly: true } : {}),
    };
    if (entry.isDraft) {
      setPageError(null);
      dispatch(action);
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      sendWaiters.set(requestId, resolve);
      dispatch(action);
      // Nothing to send, or a message already on its way.
      if (store.get().sending?.requestId !== requestId) ops.sendSettled(requestId, false);
    });
  };

  const ops: ShellOperations = {
    async reloadLists() {
      setPageError(null);
      // Stop only on this load's own failure: a folder refresh that starts and fails meanwhile is not it.
      try {
        await data.folders.loadOrFail();
      } catch (error) {
        setPageError(error instanceof Error && error.message ? error.message : 'Agent control plane is unavailable');
        return;
      }
      try {
        await data.chats.loadOrFail();
      } catch (error) {
        setPageError(error instanceof Error && error.message ? error.message : 'Agent sessions are unavailable');
      }
    },

    /** Opens an empty draft chat in a folder; the gateway session is created on first send. */
    createNewChat(workspaceOverride) {
      const { selectedWorkspaceId, startingChat } = facts.get();
      const targetWorkspace = workspaceOverride ?? selectedWorkspaceId;
      if (!targetWorkspace || startingChat) return;
      // NEW_DRAFT also clears the page's error banner.
      dispatch({ type: 'NEW_DRAFT', workspaceId: targetWorkspace });
      if (window.innerWidth < 768) dispatch({ type: 'SIDEBAR_SET', open: false });
      window.setTimeout(focusComposerIfIdle, 50);
    },

    selectChat(id) {
      const selected = data.chats.get().data.sessions.find((item) => item.id === id);
      dispatch({ type: 'CHAT_PICKED', sessionId: id, workspaceId: selected?.workspaceId ?? null });
      if (window.innerWidth < 768) dispatch({ type: 'SIDEBAR_SET', open: false });
    },

    folderSelected(folder) {
      data.folderDetails.set((current) => ({
        ...current,
        [folder.workspaceId]: {
          displayName: folder.displayName,
          fullPath: folder.fullPath || folder.displayName,
          access: folder.access,
        },
      }));
      dispatch({ type: 'DIALOG_CLOSED' });
      // Switch to the folder just chosen: a new chat there, not the chat that was open.
      ops.createNewChat(folder.workspaceId);
      void data.folders.refresh().catch(() => setPageError('Could not refresh saved folders.'));
    },

    /**
     * After a saved folder's access changes, its chats keep working (the gateway restarts them
     * with the narrower access). After removal they no longer open, so leave an open one.
     */
    async savedFolderChanged(change) {
      const { sessionId, openChatFolder, selectedWorkspaceId } = facts.get();
      const workspaceId = change.kind === 'removed' ? change.workspaceId : change.workspace.workspaceId;
      if (change.kind === 'access') {
        data.folderDetails.set((current) =>
          current[workspaceId]
            ? { ...current, [workspaceId]: { ...current[workspaceId], access: change.workspace.access } }
            : current,
        );
      }
      const openChatWorkspace = sessionId ? openChatFolder ?? selectedWorkspaceId : null;
      // Its chats no longer open: back to the welcome screen (the machine navigates away from the open chat).
      if (change.kind === 'removed' && openChatWorkspace === workspaceId) dispatch({ type: 'DRAFT_DISCARDED' });
      try {
        await data.folders.refresh();
      } catch {
        setPageError('Could not refresh saved folders.');
      }
      // Clear only after the list no longer has the folder, or the first saved folder would be it again.
      if (change.kind === 'removed' && store.get().chosenFolder === workspaceId)
        dispatch({ type: 'FOLDER_CHOSEN', workspaceId: null });
    },

    /** Applies a change to the open chat now. Returns whether it took effect. */
    async applySessionConfig(selection, tag = currentTag(store.get())) {
      const { sessionId } = facts.get();
      const discoveredConfig = store.get().config;
      if (!sessionId || !discoveredConfig || store.get().configApply) return false;
      // Results apply only while this chat is still open (the tag); a late answer for another chat is dropped.
      const stillOpen = () => isCurrentTag(store.get(), tag);
      const configNotice = (message: string | null) => notice('config', message, tag);
      // One change at a time in this chat; the machine refuses a second, and forgets it when the chat changes.
      const requestId = crypto.randomUUID();
      dispatch({ type: 'CONFIG_APPLY_STARTED', tag, requestId });
      if (store.get().configApply?.requestId !== requestId) return false;
      configNotice(null);
      try {
        const latest = await term2Client.readSessionConfig(sessionId);
        dispatch({ type: 'CONFIG_LOADED', tag, config: latest });
        const response = await term2Client.updateSessionConfig(sessionId, {
          clientRequestId: crypto.randomUUID(),
          expectedRevision: latest.configRevision,
          admission: 'idle',
          ...selection,
        });
        if (response.result.ok && response.result.kind === 'command_finished') {
          const refreshed = await term2Client.readSessionConfig(sessionId);
          dispatch({ type: 'CONFIG_LOADED', tag, config: refreshed });
          return stillOpen();
        }
        if (!response.result.ok) {
          configNotice(response.result.message || 'Could not update session configuration.');
          return false;
        }
        configNotice('The chat settings have not taken effect yet. Try again.');
        return false;
      } catch (reason) {
        configNotice(reason instanceof Error ? reason.message : 'Could not update session configuration.');
        return false;
      } finally {
        dispatch({ type: 'CONFIG_APPLY_SETTLED', tag, requestId });
      }
    },

    async updateSessionConfig(selection) {
      const { isDraft, sessionId, sessionConfig, requiresEmptyChatModelChoice } = facts.get();
      if (isDraft) {
        dispatch({ type: 'DRAFT_CONFIG_PICKED', selection });
        void ops.saveBlankChatDefault(selection);
        return;
      }
      if (!sessionId) return;
      const { modelSelection, reasoningEffort, ...immediate } = selection;
      if (modelSelection || reasoningEffort) {
        const next: StagedConfig = { ...store.get().staged };
        if (modelSelection) {
          const unchanged =
            sessionConfig?.providerId === modelSelection.provider && sessionConfig?.modelId === modelSelection.model;
          if (unchanged && !requiresEmptyChatModelChoice) delete next.modelSelection;
          else next.modelSelection = modelSelection;
        }
        if (reasoningEffort) {
          if ((sessionConfig?.reasoningEffort || 'default') === reasoningEffort) delete next.reasoningEffort;
          else next.reasoningEffort = reasoningEffort;
        }
        dispatch({ type: 'STAGED_CHANGED', staged: next.modelSelection || next.reasoningEffort ? next : null });
      }
      // Approval and mode are safety and behaviour controls: they apply now.
      if (Object.keys(immediate).length > 0) await ops.applySessionConfig(immediate);
    },

    /** A model or effort picked in a blank chat becomes the default for blank chats. */
    async saveBlankChatDefault(selection) {
      const changes: Array<{ key: string; value: unknown }> = [];
      if (selection.modelSelection) changes.push({ key: 'agent.modelSelection', value: selection.modelSelection });
      if (selection.reasoningEffort) changes.push({ key: 'agent.reasoningEffort', value: selection.reasoningEffort });
      if (changes.length === 0 || !data.settings.get().data) return;
      try {
        await data.writeSettings(changes);
      } catch {
        setPageError('Could not save this as the default for new chats. It still applies to this chat.');
      }
    },

    async toggleFavorite(favoriteKey) {
      const settings = data.settings.get().data;
      if (!settings) return;
      const raw = settings.settings.safeDefaults['agent.favoriteModels']?.value;
      const current = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
      const next = current.includes(favoriteKey)
        ? current.filter((item) => item !== favoriteKey)
        : [...current, favoriteKey];
      try {
        await data.writeSettings([{ key: 'agent.favoriteModels', value: next }]);
      } catch {
        /* ignore transient favorite toggle error */
      }
    },

    async addImages(files) {
      const tag = currentTag(store.get());
      notice('attachment', null);
      const list = Array.from(files);
      if (store.get().composer.attachments.length + list.length > 4) {
        notice('attachment', 'You can attach up to 4 images per message.');
        return;
      }
      const added: ComposerImage[] = [];
      let error: string | null = null;
      for (const file of list) {
        try {
          added.push(await fileToComposerImage(file));
        } catch (err) {
          error = err instanceof Error ? err.message : 'Could not attach image.';
        }
      }
      // Images read for one chat never join another chat's message (the tag).
      dispatch({ type: 'ATTACHMENTS_ADDED', tag, images: added, error });
    },

    /**
     * Sends the message box (or `overrideText`). The machine fixes the message now, applies staged picks first when
     * no turn is running, and puts an Edit or Retry's text back if it is refused. In a draft it creates the chat.
     */
    send(delivery, overrideText, options) {
      return sendWith(facts.get(), delivery, overrideText, options);
    },

    sendSettled(requestId, accepted) {
      const waiter = sendWaiters.get(requestId);
      sendWaiters.delete(requestId);
      waiter?.(accepted);
    },

    async retryLastTurn(model) {
      const { sessionId, lastTurn, commandDisabled, modelBlocked, stagedForChat } = facts.get();
      const configBusy = store.get().configApply !== null;
      const tag = currentTag(store.get());
      const models = data.models.get().data;
      if (commandDisabled || configBusy || !lastTurn || !['failed', 'aborted'].includes(lastTurn.status)) return;
      if (!model && modelBlocked) return;
      const modelSelection = model ? { provider: model.provider, model: model.id } : stagedForChat?.modelSelection;
      const reasoningEffort = stagedForChat?.reasoningEffort;
      if (modelSelection || reasoningEffort) {
        if (!(await ops.applySessionConfig({ modelSelection, reasoningEffort }))) {
          const replacement =
            model ??
            models.find((item) => item.provider === modelSelection?.provider && item.id === modelSelection.model);
          if (sessionId && replacement && lastTurn.userText)
            dispatch({ type: 'RETRY_DRAFT', tag, draft: { turnId: lastTurn.turnId, model: replacement } });
          return;
        }
        dispatch({ type: 'STAGED_CHANGED', staged: null });
      }
      dispatch({ type: 'RETRY_DRAFT', tag, draft: null });
      await session.invokeCommand('retry-turn');
    },

    // Edit and Retry: rewind to just before the turn's message, then send `text` as a new turn.
    async resendFromTurn(turnId, text) {
      const entry = facts.get();
      const { sessionId, sendBlocked } = entry;
      if (!sessionId) return 'This chat is not open.';
      if (sendBlocked) return 'Choose a model that can reply before resending.';
      dispatch({ type: 'RETRY_ERROR', tag: currentTag(store.get()), error: null });
      let targets: RewindTargetSummary[];
      // Rewind targets name the user message; every presented turn carries its opening message's id.
      const messageId = session.view.get().turns.find((item) => item.turnId === turnId)?.userMessageId;
      try {
        // The same read path as the rewind dialog; it uses what its own request returned.
        targets = await data.rewindTargets.loadOrFail(sessionId);
      } catch (error) {
        return error instanceof Error ? error.message : 'Could not load this chat’s history.';
      }
      const target = messageId ? targets.find((item) => item.messageId === messageId) : undefined;
      if (!target) return 'This message can no longer be edited or retried. It may have been compacted away.';
      if ((target.imageCount ?? 0) > 0) return 'Messages with images can’t be edited or retried yet.';
      if (!(await session.rewind(target.targetId, undefined, { forResend: true }))) return 'Could not rewind the chat.';
      // If it is refused, the machine puts the text back in this chat's message box with the resend notice.
      await sendWith(entry, 'auto', text, { textOnly: true });
      return null;
    },

    async retryReply(turnId, text) {
      const tag = currentTag(store.get());
      const failure = await ops.resendFromTurn(turnId, text);
      if (failure) dispatch({ type: 'RETRY_ERROR', tag, error: { turnId, message: failure } });
      return failure;
    },

    async rewind(target, restoreText) {
      const tag = currentTag(store.get());
      const ok = await session.rewind(target.targetId);
      // The prompt goes back into the message box of the chat that was rewound, if it is still the one shown.
      if (ok && restoreText && target.text && isCurrentTag(store.get(), tag)) {
        dispatch({ type: 'TEXT_RESTORED', tag, text: target.text });
        window.setTimeout(focusComposerIfIdle, 50);
      }
    },

    async handoff() {
      const { sessionId, selectedWorkspaceId } = facts.get();
      if (!sessionId) return;
      try {
        const { sessionId: nextId } = await term2Client.handoff(sessionId);
        dispatch({ type: 'CHAT_PICKED', sessionId: nextId, workspaceId: selectedWorkspaceId ?? null });
      } catch (error) {
        notice('config', error instanceof Error ? error.message : 'Could not hand off chat.');
      }
    },

    toggleSkills() {
      const next = !store.get().panels.skills;
      dispatch({ type: 'SKILLS_SET', open: next });
      if (next) data.skills.ensure(facts.get().selectedWorkspaceId ?? '');
    },

    openProviderSetup() {
      const { hasAnyConfiguredProvider, pickerConfig } = facts.get();
      if (data.settings.get().data && !hasAnyConfiguredProvider) dispatch({ type: 'DIALOG_OPENED', dialog: 'provider' });
      else navigation.openSettings('providers', pickerConfig?.providerId ?? null);
    },

    providerChosen(model) {
      const { sessionId, isDraft } = facts.get();
      const selection = { modelSelection: { provider: model.provider, model: model.id } };
      if (sessionId || isDraft) void ops.updateSessionConfig(selection);
      else void ops.saveBlankChatDefault(selection);
      dispatch({ type: 'DIALOG_CLOSED' });
    },

    dismissNotices() {
      session.clearSubmitError();
      notice('config', null);
      notice('attachment', null);
    },
  };
  return ops;
}
