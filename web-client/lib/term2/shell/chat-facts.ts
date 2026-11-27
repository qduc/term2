/**
 * Everything the chat page derives from the machine, the open chat's view and the server data, computed in one pure
 * place (docs/plans/web-client/web-shell-decomposition.md, section 4.8), so a handler and the screen cannot disagree
 * about, say, `sendBlocked`. Each field is the expression of the same name the shell component computed while
 * rendering, moved without rewording. Objects keep their identity while their inputs do. No React here.
 */
import { folderInfo, type FolderDetail, type FolderInfo } from '../data/folder-info';
import type { FileScope } from '../data/server-data';
import type { ResourceState } from '../data/resource';
import { readyForBackgroundDrain, undeliveredBackgroundNoticeIds } from '../queue';
import type { DraftConfig, ShellState, StagedConfig } from '../shell-machine';
import type {
  ModelSummary,
  SessionApprovalMode,
  SessionConfigRecord,
  SessionListItem,
  SettingsProjection,
  Term2SessionView,
  Term2TurnView,
  WorkspaceAlias,
} from '../types';
import { canSubmitSessionMessage, type SessionFeedback } from './open-session';

export type ChatFactInputs = {
  readonly shell: ShellState;
  readonly view: Term2SessionView;
  readonly feedback: SessionFeedback;
  readonly settings: SettingsProjection | null;
  readonly models: ResourceState<ModelSummary[]>;
  readonly folders: readonly WorkspaceAlias[];
  readonly chats: readonly SessionListItem[];
  readonly folderDetails: Readonly<Record<string, FolderDetail>>;
  readonly localControlEnabled: boolean;
};

export type ChatFacts = {
  // selection and folder
  readonly sessionId: string | null;
  readonly isDraft: boolean;
  readonly startingChat: boolean;
  readonly selectedWorkspaceId: string | null;
  readonly hostWorkspaceId: string | null;
  readonly selectedWorkspaceKind: 'directory' | 'host' | 'ssh';
  readonly openChatFolder: string | null;
  readonly selectedWorkspaceInfo: FolderInfo;
  readonly fileScope: FileScope | null;
  readonly fileScopeKey: string | null;
  readonly sessionTitle: string;
  readonly firstMessages: Readonly<Record<string, string>>;
  // turn and connection
  readonly lastTurn: Term2TurnView | undefined;
  readonly runningTurnId: string | null;
  readonly hasStreamingTurn: boolean;
  readonly interactionPending: boolean;
  readonly aborting: boolean;
  readonly canAbort: boolean;
  readonly composerDisabled: boolean;
  readonly commandPending: boolean;
  readonly commandNotice: { readonly tone: 'neutral' | 'error'; readonly message: string } | null;
  readonly submitError: string | null;
  readonly commandDisabled: boolean;
  // model and config
  readonly sessionConfig: SessionConfigRecord | null;
  readonly stagedForChat: (StagedConfig & { readonly sessionId: string }) | null;
  readonly pickerConfig: SessionConfigRecord | null;
  readonly pickerDisabled: boolean;
  readonly pickerNote: string;
  readonly pickerWarning: string | undefined;
  readonly providerId: string;
  readonly hasAnyConfiguredProvider: boolean;
  readonly requiresEmptyChatModelChoice: boolean;
  readonly needsModelChoice: boolean;
  readonly missingCredential: boolean;
  readonly modelBlocked: boolean;
  readonly sendBlocked: boolean;
  readonly suggestedModel: ModelSummary | undefined;
  // feeds and status
  readonly readyToSend: boolean;
  readonly drainBoundary: string | null;
  readonly liveStatus: string | null;
  readonly hasLiveAnimation: boolean;
  readonly tasksPanelVisible: boolean;
};

/** No picks yet: a stable empty value, so a draft without picks keeps its derived objects. */
const NO_DRAFT_CONFIG: DraftConfig = {};
const COMMAND_BUSY_STATUSES = ['idle', 'hydrating', 'connecting', 'reconnecting', 'running', 'awaiting_interaction', 'aborting'];

/** One-entry memo: recomputes only when an argument changed identity. */
function memo<A extends unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { args: A; value: R } | null = null;
  return (...args: A) => {
    if (last && last.args.length === args.length && last.args.every((arg, i) => Object.is(arg, args[i]))) return last.value;
    const value = compute(...args);
    last = { args, value };
    return value;
  };
}

/** A deriver with its own memos; the shell runtime keeps one for the page's life. */
export function createChatFacts(): (inputs: ChatFactInputs) => ChatFacts {
  const workspaceInfo = memo(folderInfo);
  const scopeOf = memo((key: string | null): FileScope | null => {
    if (!key) return null;
    const [kind, ...rest] = key.split(':');
    return { kind: kind as FileScope['kind'], id: rest.join(':') };
  });
  const firstMessagesOf = memo((sessionId: string | null, turns: readonly Term2TurnView[]) => {
    const map: Record<string, string> = {};
    if (sessionId) {
      const firstUserTurn = turns.find((turn) => turn.userText && turn.userText.trim().length > 0);
      if (firstUserTurn?.userText) map[sessionId] = firstUserTurn.userText;
    }
    return map;
  });
  const stagedOf = memo((staged: StagedConfig | null, sessionId: string | null) =>
    staged && sessionId ? { sessionId, ...staged } : null,
  );
  const noticeOf = memo((command: SessionFeedback['command'], sessionId: string | null) =>
    command && command.sessionId === sessionId ? { tone: command.tone, message: command.message } : null,
  );
  // The blank-chat default model. It is never swapped for another model behind the
  // user's back: when it isn't available, the draft keeps it and says so.
  const draftModelOf = memo(
    (isDraft: boolean, settings: SettingsProjection | null, picked: DraftConfig['modelSelection']) => {
      if (!isDraft || !settings) return null;
      const savedModel = settings.settings.safeDefaults['agent.modelSelection'];
      const selection =
        picked ??
        (savedModel?.source !== 'default'
          ? (savedModel?.value as { provider: string; model: string } | undefined)
          : undefined);
      return selection?.provider && selection.model ? selection : null;
    },
  );
  // A draft's model, effort and approval picks start from the saved defaults and are
  // applied to the session when the first message creates it.
  const draftPickerConfigOf = memo(
    (
      isDraft: boolean,
      settings: SettingsProjection | null,
      draftConfig: DraftConfig,
      draftModel: { provider: string; model: string } | null,
    ): SessionConfigRecord | null => {
      if (!isDraft || !settings) return null;
      const defaults = settings.settings.safeDefaults;
      const savedEffort = defaults['agent.reasoningEffort']?.value;
      const savedApproval = defaults['shell.autoApproveMode']?.value;
      return {
        configRevision: 'draft',
        defaultsRevision: settings.defaultsRevision,
        providerId: draftModel?.provider ?? '',
        modelId: draftModel?.model ?? '',
        reasoningEffort: draftConfig.reasoningEffort ?? (typeof savedEffort === 'string' ? savedEffort : 'default'),
        mode: 'standard',
        approvalMode:
          draftConfig.approvalMode ??
          (['off', 'auto', 'unattended', 'always'].includes(String(savedApproval))
            ? (savedApproval as SessionApprovalMode)
            : 'off'),
      };
    },
  );
  const sessionPickerConfigOf = memo(
    (
      sessionConfig: SessionConfigRecord | null,
      stagedForChat: (StagedConfig & { sessionId: string }) | null,
    ): SessionConfigRecord | null =>
      sessionConfig && stagedForChat
        ? {
            ...sessionConfig,
            ...(stagedForChat.modelSelection
              ? { providerId: stagedForChat.modelSelection.provider, modelId: stagedForChat.modelSelection.model }
              : {}),
            ...(stagedForChat.reasoningEffort ? { reasoningEffort: stagedForChat.reasoningEffort } : {}),
          }
        : sessionConfig,
  );
  const blankModelOf = memo((config: SessionConfigRecord | null) =>
    config ? { ...config, modelId: '', providerId: '' } : null,
  );
  const configuredProviderIdsOf = memo((settings: SettingsProjection | null) => {
    const ids = new Set<string>();
    if (!settings) return ids;
    for (const p of settings.settings.providers) {
      if (!p.disabled && p.credential.configured) ids.add(p.id);
    }
    return ids;
  });
  const drainBoundaryOf = memo((view: Term2SessionView, sessionId: string | null) => {
    if (!sessionId || view.sessionId !== sessionId || !readyForBackgroundDrain(view)) return null;
    const pending = undeliveredBackgroundNoticeIds(view);
    return pending.length ? `${sessionId}:${view.lastAppliedSequence}:${pending.join(',')}` : null;
  });

  return (inputs) => {
    const { shell, view, feedback, settings, models: modelsState, localControlEnabled } = inputs;
    const configBusy = shell.configApply !== null;
    const models = modelsState.data;
    const loadingModels = modelsState.loading;
    const modelsChecked = modelsState.loaded;

    // selection and folder
    const sessionId = shell.openChat;
    const startingChat = shell.starting;
    const draftWorkspaceId = shell.draft?.workspaceId ?? null;
    const draftConfig = shell.draft?.config ?? NO_DRAFT_CONFIG;
    const pendingFirstSend = shell.pendingFirstSend;
    const isDraft = !sessionId && draftWorkspaceId !== null;
    // The folder in use: an open chat's own folder; otherwise the user's choice, else the first saved one.
    const openChatFolder = sessionId ? inputs.chats.find((item) => item.id === sessionId)?.workspaceId ?? null : null;
    const hostWorkspaceId = inputs.folders.find((item) => item.kind === 'host')?.workspaceId ?? null;
    const selectedWorkspaceId = sessionId
      ? openChatFolder ?? shell.chosenFolder
      : shell.chosenFolder ?? inputs.folders.find((item) => item.kind !== 'host')?.workspaceId ?? null;
    const selectedWorkspaceKind =
      inputs.folders.find((item) => item.workspaceId === selectedWorkspaceId)?.kind ?? 'directory';
    const selectedWorkspaceInfo = workspaceInfo(selectedWorkspaceId, inputs.folderDetails, inputs.folders);
    const fileScopeKey = sessionId
      ? `session:${sessionId}`
      : selectedWorkspaceId
      ? `workspace:${selectedWorkspaceId}`
      : null;
    const firstMessages = firstMessagesOf(sessionId, view.turns);
    const sessionTitle = sessionId
      ? (() => {
          const listed = inputs.chats.find((item) => item.id === sessionId)?.title;
          const first = (firstMessages[sessionId] ?? listed)?.trim().split('\n')[0];
          if (!first) return 'New chat';
          return first.length > 80 ? `${first.slice(0, 80)}…` : first;
        })()
      : isDraft
      ? 'New chat'
      : 'Welcome';

    // turn and connection
    const interactionPending = view.status === 'awaiting_interaction';
    const aborting = view.status === 'aborting';
    const composerDisabled = isDraft
      ? startingChat
      : !sessionId ||
        view.sessionId !== sessionId ||
        !canSubmitSessionMessage(view.status) ||
        interactionPending ||
        aborting;
    const commandPending = sessionId !== null && feedback.commandPendingSessionId === sessionId;
    const commandDisabled = !sessionId || commandPending || COMMAND_BUSY_STATUSES.includes(view.status);
    const canAbort = view.status === 'running' || view.status === 'connected';
    const activeStreamingTurn = view.turns.find((turn) => turn.status === 'streaming' || turn.status === 'pending');
    const hasStreamingTurn = Boolean(activeStreamingTurn);
    const lastTurn = view.turns[view.turns.length - 1];

    // model and config
    const sessionConfig = shell.config?.sessionId === sessionId ? shell.config : null;
    const draftModel = draftModelOf(isDraft, settings, draftConfig.modelSelection);
    const draftPickerConfig = draftPickerConfigOf(isDraft, settings, draftConfig, draftModel);
    // Model and effort picked in an existing chat wait until the next message is sent.
    const stagedConfig = stagedOf(shell.staged, sessionId);
    const stagedForChat = !isDraft && stagedConfig?.sessionId === sessionId ? stagedConfig : null;
    const sessionPickerConfig = sessionPickerConfigOf(sessionConfig, stagedForChat);
    const pickerNote = isDraft
      ? 'A model you pick here becomes the default for new chats.'
      : 'Changes apply when you send your next message.';
    const firstSend = isDraft || !lastTurn;
    const modelDefault = settings?.settings.safeDefaults['agent.modelSelection'];
    const implicitModel =
      modelDefault?.source === 'default'
        ? (modelDefault.value as { provider?: string; model?: string } | undefined)
        : undefined;
    // Older clients could create an empty session before the user chose a model.
    // A draft handed off by this client has already passed the explicit-choice gate.
    const requiresEmptyChatModelChoice = Boolean(
      sessionId &&
        !lastTurn &&
        sessionConfig &&
        implicitModel?.provider &&
        sessionConfig.providerId === implicitModel.provider &&
        sessionConfig.modelId === implicitModel.model &&
        pendingFirstSend?.sessionId !== sessionId,
    );
    const needsModelChoice =
      (isDraft && !draftModel) || (requiresEmptyChatModelChoice && !stagedForChat?.modelSelection);
    const pickerConfig = isDraft
      ? draftPickerConfig
      : sessionPickerConfig && needsModelChoice
      ? blankModelOf(sessionPickerConfig)
      : sessionPickerConfig;
    const pickerDisabled = isDraft ? startingChat : commandDisabled;
    const providerId = sessionConfig?.providerId ?? '';
    const configuredProviderIds = configuredProviderIdsOf(settings);
    const hasAnyConfiguredProvider = configuredProviderIds.size > 0;
    const selectedProvider = settings?.settings.providers.find((item) => item.id === pickerConfig?.providerId);
    const selectedCredential =
      selectedProvider?.credential ?? settings?.settings.credentials[pickerConfig?.providerId ?? ''];
    const missingCredential = Boolean(selectedCredential?.required && !selectedCredential.configured);
    const selectedModelListed = models.some(
      (item) => item.provider === pickerConfig?.providerId && item.id === pickerConfig?.modelId,
    );
    const modelUnavailable = Boolean(
      pickerConfig?.modelId &&
        (selectedProvider?.disabled || (firstSend && modelsChecked && !loadingModels && !selectedModelListed)),
    );
    const modelBlocked = localControlEnabled && Boolean(pickerConfig) && (missingCredential || modelUnavailable);
    const sendBlocked =
      configBusy ||
      (localControlEnabled &&
        !hasStreamingTurn &&
        (needsModelChoice ||
          modelBlocked ||
          (firstSend && (!settings || !pickerConfig || (loadingModels && !selectedModelListed)))));
    const pickerWarning = modelBlocked
      ? `${pickerConfig?.modelId} isn’t ready to reply. Choose another model or check its connection.`
      : undefined;
    const suggestedModel = models.find(
      (item) =>
        configuredProviderIds.has(item.provider) &&
        (item.provider !== pickerConfig?.providerId || item.id !== pickerConfig.modelId),
    );

    // feeds and status
    // The open chat can take a message: its config is loaded, sending is not blocked and its stream is live.
    const readyToSend = Boolean(
      sessionId && sessionConfig && !sendBlocked && view.sessionId === sessionId && canSubmitSessionMessage(view.status),
    );
    const drainBoundary = drainBoundaryOf(view, sessionId);
    // Like the TUI's working line: while a turn runs there is always one status, so the line never blinks out.
    const liveStatus = interactionPending
      ? 'Waiting for your approval'
      : lastTurn?.transientStatus
        ? lastTurn.transientStatus.charAt(0).toUpperCase() + lastTurn.transientStatus.slice(1)
        : lastTurn && (lastTurn.status === 'streaming' || lastTurn.status === 'pending')
          ? (() => {
              if (lastTurn.commands.some((c) => c.status === 'running' || c.status === 'pending'))
                return 'Running tools…';
              const lastItem = lastTurn.items?.[lastTurn.items.length - 1];
              if (lastItem?.kind === 'reasoning' && lastItem.streaming) return 'Thinking…';
              if (lastItem?.kind === 'text' && lastItem.text) return 'Writing…';
              if (lastItem?.kind === 'tool') return 'Working…';
              return lastTurn.text ? 'Writing…' : lastTurn.reasoning ? 'Thinking…' : 'Working…';
            })()
          : null;
    const hasRunningSubagent =
      view.session?.tasks.some((task) => task.kind === 'subagent' && task.status === 'running') ?? false;
    const hasLiveAnimation = hasStreamingTurn || Boolean(liveStatus) || view.status === 'running' || hasRunningSubagent;

    return {
      sessionId,
      isDraft,
      startingChat,
      selectedWorkspaceId,
      hostWorkspaceId,
      selectedWorkspaceKind,
      openChatFolder,
      selectedWorkspaceInfo,
      fileScope: scopeOf(fileScopeKey),
      fileScopeKey,
      sessionTitle,
      firstMessages,
      lastTurn,
      runningTurnId: activeStreamingTurn?.turnId ?? null,
      hasStreamingTurn,
      interactionPending,
      aborting,
      canAbort,
      composerDisabled,
      commandPending,
      commandNotice: noticeOf(feedback.command, sessionId),
      submitError: feedback.submitError && feedback.submitError.sessionId === sessionId ? feedback.submitError.message : null,
      commandDisabled,
      sessionConfig,
      stagedForChat,
      pickerConfig,
      pickerDisabled,
      pickerNote,
      pickerWarning,
      providerId,
      hasAnyConfiguredProvider,
      requiresEmptyChatModelChoice,
      needsModelChoice,
      missingCredential,
      modelBlocked,
      sendBlocked,
      suggestedModel,
      readyToSend,
      drainBoundary,
      liveStatus,
      hasLiveAnimation,
      tasksPanelVisible: Boolean(sessionId) && shell.panels.tasks,
    };
  };
}
