'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { term2Client, Term2ApiError } from '../lib/api/term2';
import { readyForBackgroundDrain, undeliveredBackgroundNoticeIds } from '../lib/term2/queue';
import { Term2SessionStore } from '../lib/term2/session-store';
import type {
  InteractionResolveRequest,
  MessageSubmitOptions,
  QueueManageAction,
  SessionProjection,
  SessionPage,
  TaskControlAction,
  Term2CommandId,
  Term2CommandResult,
  Term2ConnectionStatus,
  Term2SessionView,
  WorkspacePage,
} from '../lib/term2/types';

const BACKGROUND_DRAIN_RETRY_MS = 2_000;
const DIAGNOSTICS_KEY = 'term2.web.diagnostics';

/** The view of no session at all. */
const NO_SESSION: Term2SessionView = {
  sessionId: '',
  turns: [],
  pendingInteraction: null,
  status: 'idle',
  lastAppliedSequence: 0,
  error: null,
  reloadRequired: false,
};
const noSubscription = () => () => undefined;

function diagnosticsOn(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(DIAGNOSTICS_KEY) === 'true';
  } catch {
    return false;
  }
}

// Messages need a live session stream to observe their accepted outcome.
export function canSubmitSessionMessage(status: Term2ConnectionStatus): boolean {
  return status === 'connected' || status === 'running' || status === 'interrupted';
}

const COMMAND_ERROR_MESSAGES: Record<string, string> = {
  session_busy: 'The session is busy; wait for the current turn to finish.',
  session_not_admitting: 'The session is not accepting commands right now.',
  command_not_allowed: 'That command is not allowed for this session.',
  compact_failed: 'Compacting the context failed.',
  compact_interrupted: 'A previous compaction was interrupted; reload the session.',
  compact_invalid_state: 'The session compaction state is inconsistent.',
  retry_failed: 'The retry failed.',
  idempotency_conflict: 'That command conflicts with an earlier request.',
};

const NOTHING_TO_RETRY_MESSAGES: Record<Term2CommandId, string> = {
  compact: 'Nothing to compact yet.',
  'retry-tool': 'No tool output is available to retry.',
  'retry-turn': 'No failed turn is available to retry.',
};

// Contract 13 §8 bounds a compaction failure to these codes; any unknown code
// still renders readably, so a new gateway code degrades to its own words.
const COMPACTION_FAILURE_REASONS: Record<string, string> = {
  busy: 'the session was busy',
  cancelled: 'the compaction was cancelled',
  native_failed: "the provider's compaction failed",
  single_turn_too_large: 'a single turn is too large to compact',
  result_still_too_large: 'the compacted context would still be too large',
  hot_tail_would_orphan_tool_result: 'the hot tail would orphan a tool result',
};

function commandNoticeFor(
  commandId: Term2CommandId,
  result: Term2CommandResult,
): { tone: 'neutral' | 'error'; message: string } {
  if (result.outcome === 'nothing_to_retry') return { tone: 'neutral', message: NOTHING_TO_RETRY_MESSAGES[commandId] };
  if (result.outcome === 'not_reduced') return { tone: 'neutral', message: "Compaction didn't reduce the context." };
  if (result.outcome === 'failed') {
    const detail = result.reason
      ? COMPACTION_FAILURE_REASONS[result.reason] ?? result.reason.replace(/_/gu, ' ')
      : 'the reason was not reported';
    return { tone: 'error', message: `Compaction failed: ${detail}.` };
  }
  const tokens =
    result.tokensBefore !== undefined && result.tokensAfter !== undefined
      ? ` (${result.tokensBefore} → ${result.tokensAfter} tokens)`
      : '';
  return { tone: 'neutral', message: `Context compacted${tokens}.` };
}

const INTERACTION_CONFLICT_MESSAGES = {
  stale_interaction: 'This interaction is stale. The latest interaction state was reloaded.',
  interaction_already_resolved: 'This interaction was already resolved.',
  interaction_not_resolvable: 'This interaction cannot be resolved safely.',
} as const;


export interface UseTerm2SessionResult {
  view: Term2SessionView;
  workspaces: WorkspacePage['workspaces'];
  sessions: SessionPage['sessions'];
  workspaceCursor: string | null;
  sessionCursor: string | null;
  selectedWorkspaceId: string | null;
  setSelectedWorkspaceId: (id: string | null) => void;
  refreshWorkspaces: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  loadNextSessions: () => Promise<void>;
  createSession: (workspaceId: string) => Promise<SessionProjection>;
  selectSession: (sessionId: string) => void;
  submit: (text: string, options?: MessageSubmitOptions) => Promise<boolean>;
  submitError: string | null;
  clearSubmitError: () => void;
  invokeCommand: (commandId: Term2CommandId) => Promise<void>;
  manageQueue: (action: QueueManageAction) => Promise<boolean>;
  controlTask: (action: TaskControlAction) => Promise<boolean>;
  /**
   * `forResend` is for Edit and Retry, which send right after: it skips the "Conversation
   * rewound." notice and resolves only once the reloaded chat accepts messages again.
   */
  rewind: (targetId: string, expectedRevision?: string, options?: { forResend?: boolean }) => Promise<boolean>;
  commandPending: boolean;
  commandNotice: { tone: 'neutral' | 'error'; message: string } | null;
  abort: () => Promise<void>;
  resolveInteraction: (request: InteractionResolveRequest) => Promise<void>;
  refresh: () => Promise<void>;
  /** With diagnostics on, the last frames the session stream sent (for the diagnostics panel only). */
  frames: readonly unknown[] | null;
}

export function useTerm2Session(sessionId: string | null): UseTerm2SessionResult {
  // One store per open session; it owns the stream, the checkpoint and the snapshot (lib/term2/session-store.ts).
  const store = useMemo(() => (sessionId ? new Term2SessionStore(sessionId, { diagnostics: diagnosticsOn() }) : null), [sessionId]);
  useEffect(() => {
    store?.start();
    return () => store?.close();
  }, [store]);
  const view = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store ? store.getView : () => NO_SESSION,
    () => NO_SESSION,
  );
  const [workspaces, setWorkspaces] = useState<WorkspacePage['workspaces']>([]);
  const [sessions, setSessions] = useState<SessionPage['sessions']>([]);
  const [workspaceCursor, setWorkspaceCursor] = useState<string | null>(null);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [submitErrorState, setSubmitErrorState] = useState<{ sessionId: string; message: string } | null>(null);
  const [commandState, setCommandState] = useState<{
    sessionId: string;
    tone: 'neutral' | 'error';
    message: string;
  } | null>(null);
  // Keyed by session like commandState, so a command still in flight for the
  // previous session cannot disable the newly selected one's menu.
  const [commandPendingSessionId, setCommandPendingSessionId] = useState<string | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  const sessionIdRef = useRef(sessionId);
  const admittingSessionIdsRef = useRef(new Set<string>());
  /** The current view of the open session, read at call time (the store is the source of truth). */
  const currentView = useCallback(() => storeRef.current?.getView() ?? NO_SESSION, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const refreshWorkspaces = useCallback(async () => {
    const result = await term2Client.listWorkspaces(20);
    setWorkspaces(result.workspaces);
    setWorkspaceCursor(result.nextCursor);
  }, []);
  const refreshSessions = useCallback(async () => {
    const result = await term2Client.listSessions(20);
    setSessions(result.sessions);
    setSessionCursor(result.nextCursor);
  }, []);
  const loadNextSessions = useCallback(async () => {
    if (!sessionCursor) return;
    const result = await term2Client.listSessions(20, sessionCursor);
    setSessions((current) => [
      ...current,
      ...result.sessions.filter((item) => !current.some((existing) => existing.id === item.id)),
    ]);
    setSessionCursor(result.nextCursor);
  }, [sessionCursor]);

  const createSession = useCallback(async (workspaceId: string) => {
    const projection = await term2Client.createSession(workspaceId);
    setSelectedWorkspaceId(workspaceId);
    setSessions((current) => [
      {
        id: projection.id,
        workspaceId: projection.workspaceId,
        status: projection.status,
        createdAt: projection.createdAt,
        updatedAt: projection.updatedAt,
        latestSequence: projection.latestSequence,
      },
      ...current.filter((item) => item.id !== projection.id),
    ]);
    return projection;
  }, []);

  const selectSession = useCallback((nextSessionId: string) => {
    const params = new URLSearchParams(window.location.search);
    params.delete('c');
    params.set('term2', '1');
    params.set('agentSession', nextSessionId);
    window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  const clearSubmitError = useCallback(() => {
    setSubmitErrorState(null);
  }, []);

  const submit = useCallback(
    async (text: string, options?: MessageSubmitOptions) => {
      const id = sessionIdRef.current;
      const hasAttachments = Boolean(options?.attachments && options.attachments.length > 0);
      if (
        !id ||
        (!text.trim() && !hasAttachments) ||
        currentView().sessionId !== id ||
        !canSubmitSessionMessage(currentView().status) ||
        currentView().pendingInteraction !== null ||
        admittingSessionIdsRef.current.has(id)
      ) {
        return false;
      }
      const owner = storeRef.current;
      const sequenceAtSubmit = currentView().lastAppliedSequence;
      const clientRequestId = crypto.randomUUID();
      admittingSessionIdsRef.current.add(id);
      setSubmitErrorState((current) => (current?.sessionId === id ? null : current));
      try {
        await term2Client.submitMessage(id, text, clientRequestId, options);
        if (owner !== storeRef.current || sessionIdRef.current !== id) return false;
        const firstLine = text.trim().split('\n')[0]?.trim().slice(0, 120);
        if (firstLine) {
          setSessions((current) =>
            current.map((item) =>
              item.id === id && !item.title
                ? { ...item, title: firstLine, updatedAt: new Date().toISOString() }
                : item,
            ),
          );
        }
        // Until the accepted turn arrives, show the chat as running (the next accepted frame clears this).
        const now = currentView();
        if (canSubmitSessionMessage(now.status) && now.lastAppliedSequence === sequenceAtSubmit)
          owner?.setOverlay({ status: 'running', error: null });
        return true;
      } catch (error) {
        if (owner !== storeRef.current || sessionIdRef.current !== id) return false;
        // Keep a healthy stream alive and the composer usable so the user can edit/retry immediately.
        setSubmitErrorState({
          sessionId: id,
          message: error instanceof Error ? error.message : 'Message was not accepted. Please try again.',
        });
        return false;
      } finally {
        admittingSessionIdsRef.current.delete(id);
      }
    },
    [currentView],
  );

  // Command results never render a turn: an accepted retry arrives through the
  // session event stream, so only outcomes and failures need local state.
  const invokeCommand = useCallback(async (commandId: Term2CommandId) => {
    const id = sessionIdRef.current;
    if (!id) return;
    setCommandPendingSessionId(id);
    setCommandState(null);
    try {
      const result = await term2Client.commands(id, commandId, crypto.randomUUID());
      if (result.outcome !== 'accepted') setCommandState({ sessionId: id, ...commandNoticeFor(commandId, result) });
    } catch (error) {
      const message =
        error instanceof Term2ApiError && error.code && error.code in COMMAND_ERROR_MESSAGES
          ? COMMAND_ERROR_MESSAGES[error.code]
          : error instanceof Error
          ? error.message
          : 'The command was not accepted';
      setCommandState({ sessionId: id, tone: 'error', message });
    } finally {
      setCommandPendingSessionId((current) => (current === id ? null : current));
    }
  }, []);

  const refresh = useCallback(async () => {
    // Tear down the prior stream; the next snapshot frame is a fresh cut (never a second one over a live stream).
    storeRef.current?.refresh();
  }, []);

  const manageQueue = useCallback(async (action: QueueManageAction) => {
    const id = sessionIdRef.current;
    if (!id) return false;
    try {
      await term2Client.manageQueue(id, action);
      return true;
    } catch (error) {
      setCommandState({
        sessionId: id,
        tone: 'error',
        message: error instanceof Error ? error.message : 'Queue action failed.',
      });
      return false;
    }
  }, []);

  // A background task that finishes while the chat is idle only records a notice; the Session
  // admits the silent turn that tells the agent once an attached client asks it to drain (the TUI
  // does the same). Ask once per accepted boundary; the Session dedupes concurrent asks from other
  // tabs. A busy answer is normally reconsidered at the next boundary, but the Session can also be
  // busy while a finished turn's completion is held, which ends without a new event, so a busy or
  // failed ask gets exactly one delayed re-ask for the same boundary.
  const drainAttemptRef = useRef<string | null>(null);
  const drainRetriedRef = useRef<string | null>(null);
  const [drainRetry, setDrainRetry] = useState<string | null>(null);
  useEffect(() => {
    const id = sessionIdRef.current;
    if (!id || view.sessionId !== id || !readyForBackgroundDrain(view)) return;
    const pending = undeliveredBackgroundNoticeIds(view);
    if (!pending.length) return;
    const boundary = `${id}:${view.lastAppliedSequence}:${pending.join(',')}`;
    const attempt = drainRetry === boundary ? `${boundary}:retry` : boundary;
    if (drainAttemptRef.current === attempt || (attempt === boundary && drainAttemptRef.current === `${boundary}:retry`))
      return;
    drainAttemptRef.current = attempt;
    const retry = () => {
      if (drainRetriedRef.current === boundary) return;
      drainRetriedRef.current = boundary;
      setTimeout(() => setDrainRetry(boundary), BACKGROUND_DRAIN_RETRY_MS);
    };
    term2Client
      .controlTask(id, { action: 'drain_notifications', clientRequestId: `drain_${crypto.randomUUID()}` })
      .then((result) => {
        if (result.drain === 'busy') retry();
      })
      .catch((error: unknown) => {
        console.warn('Background notice drain failed', error);
        retry();
      });
  }, [view, drainRetry]);

  const controlTask = useCallback(async (action: TaskControlAction) => {
    const id = sessionIdRef.current;
    if (!id) return false;
    try {
      await term2Client.controlTask(id, action);
      return true;
    } catch (error) {
      setCommandState({
        sessionId: id,
        tone: 'error',
        message: error instanceof Error ? error.message : 'Task action failed.',
      });
      return false;
    }
  }, []);

  const rewind = useCallback(
    async (targetId: string, expectedRevision?: string, options?: { forResend?: boolean }) => {
      const id = sessionIdRef.current;
      if (!id) return false;
      setCommandPendingSessionId(id);
      setCommandState(null);
      try {
        await term2Client.rewindSession(id, {
          targetId,
          clientRequestId: crypto.randomUUID(),
          ...(expectedRevision ? { expectedRevision } : {}),
        });
        if (!options?.forResend) setCommandState({ sessionId: id, tone: 'neutral', message: 'Conversation rewound.' });
        await refresh();
        if (!options?.forResend) return true;
        // The reload reconnects the event stream; a send before it is back would be refused.
        // UI wait only: on timeout the caller's send is refused and its text is kept.
        for (let waited = 0; waited < 10_000; waited += 50) {
          if (sessionIdRef.current !== id) return false;
          if (currentView().sessionId === id && canSubmitSessionMessage(currentView().status)) return true;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return true;
      } catch (error) {
        setCommandState({
          sessionId: id,
          tone: 'error',
          message: error instanceof Error ? error.message : 'Could not rewind conversation.',
        });
        return false;
      } finally {
        setCommandPendingSessionId((current) => (current === id ? null : current));
      }
    },
    [refresh, currentView],
  );

  const abort = useCallback(async () => {
    const id = sessionIdRef.current;
    const owner = storeRef.current;
    const activeTurnId = currentView().turns.find(
      (item) => item.status === 'streaming' || item.status === 'pending',
    )?.turnId;
    if (!id || !activeTurnId || !owner) return;
    owner.setOverlay({ status: 'aborting', error: null });
    try {
      await term2Client.abort(id, activeTurnId);
    } catch (error) {
      if (owner !== storeRef.current || sessionIdRef.current !== id) return;
      owner.setOverlay({ status: 'error', error: error instanceof Error ? error.message : 'Abort result unknown' });
    }
  }, [currentView]);

  const resolveInteraction = useCallback(
    async (request: InteractionResolveRequest) => {
      const id = sessionIdRef.current;
      const owner = storeRef.current;
      const pending = currentView().pendingInteraction;
      if (!id || !owner || pending?.state !== 'pending') return;
      const stillCurrent = () => {
        const current = currentView().pendingInteraction;
        return (
          owner === storeRef.current &&
          sessionIdRef.current === id &&
          current?.state === 'pending' &&
          current.interaction.interactionId === request.interactionId &&
          current.interaction.revision === request.revision
        );
      };
      try {
        const result = await term2Client.resolveInteraction(id, request.interactionId, {
          revision: request.revision,
          answer: request.answer,
          ...(request.rejectionReason === undefined ? {} : { rejectionReason: request.rejectionReason }),
          ...(request.approvalAnswer === undefined ? {} : { approvalAnswer: request.approvalAnswer }),
        });
        if (!stillCurrent()) return;
        // A multi-question request answers with its next step: the same request, a new DTO.
        if (!result.accepted) owner.replaceInteractionById(request.interactionId, { ...pending, interaction: result.interaction });
      } catch (error) {
        if (!stillCurrent()) return;
        if (error instanceof Term2ApiError && [409, 410].includes(error.status)) {
          const message =
            error.code && error.code in INTERACTION_CONFLICT_MESSAGES
              ? INTERACTION_CONFLICT_MESSAGES[error.code as keyof typeof INTERACTION_CONFLICT_MESSAGES]
              : 'The interaction changed; the latest session state was reloaded.';
          await refresh();
          if (owner === storeRef.current && sessionIdRef.current === id) owner.setOverlay({ error: message });
          return;
        }
        owner.setOverlay({ error: error instanceof Error ? error.message : 'Interaction was not accepted' });
      }
    },
    [refresh, currentView],
  );

  return {
    view,
    workspaces,
    sessions,
    workspaceCursor,
    sessionCursor,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    refreshWorkspaces,
    refreshSessions,
    loadNextSessions,
    createSession,
    selectSession,
    submit,
    submitError: submitErrorState && submitErrorState.sessionId === sessionId ? submitErrorState.message : null,
    clearSubmitError,
    invokeCommand,
    manageQueue,
    controlTask,
    rewind,
    commandPending: sessionId !== null && commandPendingSessionId === sessionId,
    commandNotice:
      commandState && commandState.sessionId === sessionId
        ? { tone: commandState.tone, message: commandState.message }
        : null,
    abort,
    resolveInteraction,
    refresh,
    frames: store?.frames ?? null,
  };
}
