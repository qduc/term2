'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { term2Client, Term2ApiError } from '../lib/api/term2';
import { viewFromHydration, type SessionHydration } from '../lib/term2/hydration';
import { consumeSseResponse } from '../lib/term2/sse';
import {
  applyTerm2Event,
  clearTerm2LiveEvidence,
  presentTerm2SessionView,
  emptyTerm2SessionView,
} from '../lib/term2/event-adapter';
import type {
  InteractionResolveRequest,
  SessionProjection,
  SessionPage,
  Term2CommandId,
  Term2CommandResult,
  Term2ConnectionStatus,
  Term2SessionView,
  WorkspacePage,
} from '../lib/term2/types';
import { Term2ProtocolError } from '../lib/term2/types';

const MAX_RECONNECT_DELAY = 10_000;
const MAX_PROTOCOL_RELOADS = 2;
const BACKOFF_BASE = 500;

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
  submit: (text: string) => Promise<boolean>;
  invokeCommand: (commandId: Term2CommandId) => Promise<void>;
  commandPending: boolean;
  commandNotice: { tone: 'neutral' | 'error'; message: string } | null;
  abort: () => Promise<void>;
  resolveInteraction: (request: InteractionResolveRequest) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useTerm2Session(sessionId: string | null): UseTerm2SessionResult {
  const [view, setView] = useState<Term2SessionView>(() => emptyTerm2SessionView(sessionId || ''));
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [workspaces, setWorkspaces] = useState<WorkspacePage['workspaces']>([]);
  const [sessions, setSessions] = useState<SessionPage['sessions']>([]);
  const [workspaceCursor, setWorkspaceCursor] = useState<string | null>(null);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [commandState, setCommandState] = useState<{
    sessionId: string;
    tone: 'neutral' | 'error';
    message: string;
  } | null>(null);
  // Keyed by session like commandState, so a command still in flight for the
  // previous session cannot disable the newly selected one's menu.
  const [commandPendingSessionId, setCommandPendingSessionId] = useState<string | null>(null);
  const generationRef = useRef(0);
  const viewRef = useRef(view);
  const sessionIdRef = useRef(sessionId);
  const selectionControllerRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTextRef = useRef(new Map<string, string>());
  const admittingSessionIdsRef = useRef(new Set<string>());

  // viewRef is the source of truth for the latest view; React state only mirrors
  // it. Every update goes through the ref first, so a render that lags behind a
  // burst of replayed events can never roll the ref back and fake a sequence gap.
  const patchView = useCallback((update: (current: Term2SessionView) => Term2SessionView) => {
    const next = update(viewRef.current);
    viewRef.current = next;
    setView(next);
  }, []);

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

  const installHydration = useCallback((hydration: SessionHydration, expectedGeneration: number) => {
    if (expectedGeneration !== generationRef.current || hydration.sessionId !== sessionIdRef.current) return false;
    const previous = viewRef.current;
    if (hydration.earliestReplayableSequence === null) throw new Term2ProtocolError('Native atomic replay cut is unavailable');
    if (previous.sessionId === hydration.sessionId && hydration.seq < previous.lastAppliedSequence)
      throw new Term2ProtocolError('Native hydration predates the accepted checkpoint');
    const projected = viewFromHydration(hydration);
    const next = previous.sessionId === hydration.sessionId ? {
      ...projected, branches: projected.branches ?? clearTerm2LiveEvidence(previous).branches, nativeChanges: previous.nativeChanges, retiredTurns: previous.retiredTurns,
    } : projected;
    viewRef.current = next;
    setView(next);
    return true;
  }, []);

  const hydrateAndConnect = useCallback(
    async (id: string, generation: number, signal: AbortSignal) => {
      let hydration = await term2Client.hydrateSession(id, signal);
      if (!installHydration(hydration, generation)) return;
      let delay = BACKOFF_BASE;
      let cursor = hydration.seq;
      // A reload that lands on the same cursor replays the same event; stop after a few instead of looping.
      let reloadCursor = -1;
      let reloadsAtCursor = 0;
      while (!signal.aborted && generation === generationRef.current && sessionIdRef.current === id) {
        patchView((current) => ({
          ...current,
          status:
            current.status === 'running' || current.status === 'awaiting_interaction'
              ? current.status
              : delay === BACKOFF_BASE
                ? 'connecting'
                : 'reconnecting',
          error: null,
        }));
        try {
          let streamHadActivity = false;
          const response = await term2Client.openEvents(id, cursor, signal);
          const replayMode = response.data.headers.get('x-term2-replay');
          if (replayMode !== 'atomic') {
            await response.data.body?.cancel();
            patchView(current => ({ ...current, status: 'error', reloadRequired: true, error: 'Atomic replay after the hydration cut is unavailable. Reload requires a new real accepted cut; no live-only fallback was used.' }));
            return;
          }
          patchView((current) => ({
            ...current,
            replayMode,
            status:
              current.pendingInteraction?.state === 'pending'
                ? 'awaiting_interaction'
                : current.turns.some((turn) => turn.status === 'streaming' || turn.status === 'pending')
                  ? 'running'
                  : 'connected',
            error: null,
          }));
          await consumeSseResponse(response.data, {
            signal,
            expectedSessionId: id,
            onHeartbeat: () => {
              streamHadActivity = true;
              delay = BACKOFF_BASE;
            },
            onFrame: (event) => {
              streamHadActivity = true;
              delay = BACKOFF_BASE;
              if (generation !== generationRef.current || sessionIdRef.current !== id) return;
              const enrichedEvent = event.kind === 'accepted' ? {
                ...event,
                changes: event.changes.map((change) => {
                  if (change.type !== 'user_message_accepted' || typeof change.payload.clientRequestId !== 'string') return change;
                  const requestId = change.payload.clientRequestId;
                  const pendingText = pendingTextRef.current.get(requestId);
                  return pendingText === undefined ? change : { ...change, payload: { ...change.payload, text: pendingText } };
                }),
              } : event;
              const next = applyTerm2Event(viewRef.current, enrichedEvent);
              for (const change of event.changes) {
                if (change.type === 'user_message_accepted' && typeof change.payload.clientRequestId === 'string')
                  pendingTextRef.current.delete(change.payload.clientRequestId);
              }
              viewRef.current = next;
              setView(next);
              cursor = next.lastAppliedSequence;
              if (next.reloadRequired) throw new Term2ProtocolError('Accepted history replacement requires projection reload');
            },
          });
          if (signal.aborted) return;
          patchView(clearTerm2LiveEvidence);
          delay = streamHadActivity ? BACKOFF_BASE : Math.min(MAX_RECONNECT_DELAY, Math.max(BACKOFF_BASE, delay * 2));
          await new Promise<void>((resolve) => {
            retryTimerRef.current = setTimeout(resolve, delay);
          });
        } catch (error) {
          if (signal.aborted) return;
          patchView(clearTerm2LiveEvidence);
          if (error instanceof Term2ApiError && (error.status === 410 || error.code === 'replay_unavailable')) {
            patchView(current => ({ ...current, status: 'error', reloadRequired: true, error: 'The native replay cut is no longer available. Reload explicitly to hydrate a new current cut; no missing history was reconstructed.' }));
            return;
          }
          if (error instanceof Term2ApiError && [401, 403, 404].includes(error.status)) {
            patchView((current) => ({ ...current, status: 'error', error: error.message }));
            return;
          }
          if (error instanceof Term2ProtocolError) {
            reloadsAtCursor = cursor === reloadCursor ? reloadsAtCursor + 1 : 1;
            reloadCursor = cursor;
            if (reloadsAtCursor > MAX_PROTOCOL_RELOADS) {
              patchView((current) => ({
                ...current,
                status: 'error',
                reloadRequired: true,
                error: 'The session stream has an event this client cannot read.',
              }));
              return;
            }
            patchView((current) => ({
              ...current,
              status: 'reconnecting',
              reloadRequired: true,
              error: 'The session stream needs to reload.',
            }));
            try {
              hydration = await term2Client.hydrateSession(id, signal);
              if (!installHydration(hydration, generation)) return;
              cursor = hydration.seq;
              delay = BACKOFF_BASE;
              continue;
            } catch (reloadError) {
              if (signal.aborted) return;
              patchView((current) => ({
                ...current,
                status: 'error',
                error: reloadError instanceof Error ? reloadError.message : 'Unable to reload session',
              }));
              return;
            }
          }
          patchView((current) => ({
            ...current,
            status: 'reconnecting',
            error: 'Connection interrupted; retrying.',
          }));
          await new Promise<void>((resolve) => {
            retryTimerRef.current = setTimeout(resolve, delay);
          });
          delay = Math.min(MAX_RECONNECT_DELAY, delay * 2);
        }
      }
    },
    [installHydration, patchView],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    selectionControllerRef.current?.abort();
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    const controller = new AbortController();
    selectionControllerRef.current = controller;
    if (!sessionId) {
      const next = emptyTerm2SessionView('');
      viewRef.current = next;
      setView(next);
      return () => controller.abort();
    }
    const id = sessionId;
    const run = async () => {
      patchView((current) => ({ ...emptyTerm2SessionView(id), status: 'hydrating' }));
      try {
        await hydrateAndConnect(id, generation, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted)
          patchView((current) => ({
            ...current,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unable to load session',
          }));
      } finally {
        // A terminal reader must release its request and be restartable by Reload.
        controller.abort();
      }
    };
    void run();
    return () => {
      controller.abort();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [sessionId, hydrateAndConnect, connectionAttempt]);

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

  const submit = useCallback(async (text: string) => {
    const id = sessionIdRef.current;
    if (
      !id ||
      !text.trim() ||
      viewRef.current.sessionId !== id ||
      !canSubmitSessionMessage(viewRef.current.status) ||
      viewRef.current.pendingInteraction?.state === 'pending' ||
      admittingSessionIdsRef.current.has(id)
    ) {
      return false;
    }
    const generation = generationRef.current;
    const sequenceAtSubmit = viewRef.current.lastAppliedSequence;
    const clientRequestId = crypto.randomUUID();
    admittingSessionIdsRef.current.add(id);
    pendingTextRef.current.set(clientRequestId, text);
    try {
      await term2Client.submitMessage(id, text, clientRequestId);
      if (generation !== generationRef.current || sessionIdRef.current !== id) {
        pendingTextRef.current.delete(clientRequestId);
        return false;
      }
      patchView((current) =>
        canSubmitSessionMessage(current.status) && current.lastAppliedSequence === sequenceAtSubmit
          ? { ...current, status: 'running', error: null }
          : current,
      );
      return true;
    } catch (error) {
      pendingTextRef.current.delete(clientRequestId);
      if (generation !== generationRef.current || sessionIdRef.current !== id) return false;
      patchView((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : 'Message was not accepted',
      }));
      return false;
    } finally {
      admittingSessionIdsRef.current.delete(id);
    }
  }, [patchView]);

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

  const abort = useCallback(async () => {
    const id = sessionIdRef.current;
    const generation = generationRef.current;
    const activeTurnId = viewRef.current.turns.find(
      (item) => item.status === 'streaming' || item.status === 'pending',
    )?.turnId;
    if (!id || !activeTurnId) return;
    patchView((current) => ({ ...current, status: 'aborting', error: null }));
    try {
      await term2Client.abort(id, activeTurnId);
    } catch (error) {
      if (generation !== generationRef.current || sessionIdRef.current !== id) return;
      patchView((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : 'Abort result unknown',
      }));
    }
  }, [patchView]);

  const refresh = useCallback(async () => {
    // Tear down the prior stream before installing a new accepted cut. Never
    // install a second snapshot over a concurrently replaying/live connection.
    selectionControllerRef.current?.abort();
    setConnectionAttempt(attempt => attempt + 1);
  }, []);

  const resolveInteraction = useCallback(
    async (request: InteractionResolveRequest) => {
      const id = sessionIdRef.current;
      const pending = viewRef.current.pendingInteraction;
      if (!id || pending?.state !== 'pending') return;
      const generation = generationRef.current;
      const stillCurrent = () => {
        const current = viewRef.current.pendingInteraction;
        return (
          generation === generationRef.current &&
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
        if (!result.accepted) {
          const next = {
            ...viewRef.current,
            pendingInteraction: {
              state: 'pending' as const,
              interaction: result.interaction,
              turnId: pending.turnId,
            },
            status: 'awaiting_interaction' as Term2ConnectionStatus,
          };
          viewRef.current = next;
          setView(next);
        }
      } catch (error) {
        if (!stillCurrent()) return;
        if (error instanceof Term2ApiError && [409, 410].includes(error.status)) {
          const message =
            error.code && error.code in INTERACTION_CONFLICT_MESSAGES
              ? INTERACTION_CONFLICT_MESSAGES[error.code as keyof typeof INTERACTION_CONFLICT_MESSAGES]
              : 'The interaction changed; the latest session state was reloaded.';
          try {
            await refresh();
          } finally {
            if (generation !== generationRef.current || sessionIdRef.current !== id) return;
            const next = { ...viewRef.current, error: message };
            viewRef.current = next;
            setView(next);
          }
          return;
        }
        patchView((current) => ({
          ...current,
          error: error instanceof Error ? error.message : 'Interaction was not accepted',
        }));
      }
    },
    [refresh],
  );

  return {
    view: presentTerm2SessionView(view),
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
    invokeCommand,
    commandPending: commandPendingSessionId === sessionId,
    commandNotice:
      commandState && commandState.sessionId === sessionId
        ? { tone: commandState.tone, message: commandState.message }
        : null,
    abort,
    resolveInteraction,
    refresh,
  };
}
