'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { term2Client, Term2ApiError } from '../lib/api/term2';
import { consumeSseResponse } from '../lib/term2/sse';
import {
  applyProjectionEvent,
  applyTerm2Event,
  emptyTerm2SessionView,
  viewFromProjection,
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
const BACKOFF_BASE = 500;

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

function coherentProjection(value: unknown): value is SessionProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(projection.latestSequence) &&
    Number.isSafeInteger(projection.earliestReplayableSequence) &&
    Number.isSafeInteger(projection.projectionSequence) &&
    (projection.latestSequence as number) >= 0 &&
    (projection.earliestReplayableSequence as number) >= 0 &&
    (projection.earliestReplayableSequence as number) <= (projection.latestSequence as number) &&
    (projection.projectionSequence as number) >= (projection.earliestReplayableSequence as number) &&
    (projection.projectionSequence as number) <= (projection.latestSequence as number)
  );
}

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
  submit: (text: string) => Promise<void>;
  invokeCommand: (commandId: Term2CommandId) => Promise<void>;
  commandPending: boolean;
  commandNotice: { tone: 'neutral' | 'error'; message: string } | null;
  abort: () => Promise<void>;
  resolveInteraction: (request: InteractionResolveRequest) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useTerm2Session(sessionId: string | null): UseTerm2SessionResult {
  const [view, setView] = useState<Term2SessionView>(() => emptyTerm2SessionView(sessionId || ''));
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

  useEffect(() => {
    viewRef.current = view;
  }, [view]);
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

  const installProjection = useCallback((projection: SessionProjection, expectedGeneration: number) => {
    if (expectedGeneration !== generationRef.current || projection.id !== sessionIdRef.current) return false;
    const next = viewFromProjection(projection);
    viewRef.current = next;
    setView(next);
    return true;
  }, []);

  const hydrateAndConnect = useCallback(
    async (id: string, generation: number, signal: AbortSignal) => {
      let projection = await term2Client.getSession(id, signal);
      if (!installProjection(projection, generation)) return;
      let delay = BACKOFF_BASE;
      let cursor = projection.projectionSequence;
      while (!signal.aborted && generation === generationRef.current && sessionIdRef.current === id) {
        setView((current) => ({
          ...current,
          status: delay === BACKOFF_BASE ? 'connecting' : 'reconnecting',
          error: null,
        }));
        try {
          let streamHadActivity = false;
          const response = await term2Client.openEvents(id, cursor, signal);
          setView((current) => ({
            ...current,
            status: current.pendingInteraction?.state === 'pending' ? 'awaiting_interaction' : 'connected',
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
              const enrichedEvent =
                event.type === 'user_message_accepted' &&
                typeof event.payload.clientRequestId === 'string' &&
                pendingTextRef.current.has(event.payload.clientRequestId)
                  ? {
                      ...event,
                      payload: {
                        ...event.payload,
                        text: pendingTextRef.current.get(event.payload.clientRequestId),
                      },
                    }
                  : event;
              if (event.type === 'user_message_accepted' && typeof event.payload.clientRequestId === 'string')
                pendingTextRef.current.delete(event.payload.clientRequestId);
              const next = applyTerm2Event(viewRef.current, enrichedEvent);
              viewRef.current = next;
              setView(next);
              cursor = next.lastAppliedSequence;
            },
          });
          if (signal.aborted) return;
          delay = streamHadActivity ? BACKOFF_BASE : Math.min(MAX_RECONNECT_DELAY, Math.max(BACKOFF_BASE, delay * 2));
          await new Promise<void>((resolve) => {
            retryTimerRef.current = setTimeout(resolve, delay);
          });
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof Term2ApiError && error.status === 410 && error.code === 'cursor_compacted') {
            const details = error.details as
              | {
                  reloadRequired?: unknown;
                  latestSequence?: unknown;
                  session?: unknown;
                }
              | undefined;
            const sessionDetails =
              details?.session && typeof details.session === 'object' && !Array.isArray(details.session)
                ? (details.session as Record<string, unknown>)
                : undefined;
            if (
              !details ||
              details.reloadRequired !== true ||
              typeof details.latestSequence !== 'number' ||
              !Number.isSafeInteger(details.latestSequence) ||
              details.latestSequence < 0 ||
              !sessionDetails
            ) {
              setView((current) => ({
                ...current,
                status: 'error',
                reloadRequired: true,
                error: 'The compacted session cursor is invalid.',
              }));
              return;
            }
            projection = details.session as SessionProjection;
            if (!coherentProjection(projection)) {
              projection = await term2Client.getSession(id, signal);
              if (!coherentProjection(projection)) {
                setView((current) => ({
                  ...current,
                  status: 'error',
                  reloadRequired: true,
                  error: 'The compacted session projection is incoherent.',
                }));
                return;
              }
            }
            if (!installProjection(projection, generation)) return;
            cursor = projection.projectionSequence;
            delay = BACKOFF_BASE;
            continue;
          }
          if (error instanceof Term2ApiError && [401, 403, 404].includes(error.status)) {
            setView((current) => ({ ...current, status: 'error', error: error.message }));
            return;
          }
          if (error instanceof Term2ProtocolError) {
            setView((current) => ({
              ...current,
              status: 'reconnecting',
              reloadRequired: true,
              error: 'The session stream needs to reload.',
            }));
            try {
              projection = await term2Client.getSession(id, signal);
              if (!installProjection(projection, generation)) return;
              cursor = projection.projectionSequence;
              delay = BACKOFF_BASE;
              continue;
            } catch (reloadError) {
              if (signal.aborted) return;
              setView((current) => ({
                ...current,
                status: 'error',
                error: reloadError instanceof Error ? reloadError.message : 'Unable to reload session',
              }));
              return;
            }
          }
          setView((current) => ({
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
    [installProjection],
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
      setView((current) => ({ ...emptyTerm2SessionView(id), status: 'hydrating' }));
      try {
        await hydrateAndConnect(id, generation, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted)
          setView((current) => ({
            ...current,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unable to load session',
          }));
      }
    };
    void run();
    return () => {
      controller.abort();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [sessionId, hydrateAndConnect]);

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
    if (!id || !text.trim() || viewRef.current.pendingInteraction?.state === 'pending') return;
    const clientRequestId = crypto.randomUUID();
    pendingTextRef.current.set(clientRequestId, text);
    try {
      await term2Client.submitMessage(id, text, clientRequestId);
      setView((current) => ({ ...current, status: 'running', error: null }));
    } catch (error) {
      pendingTextRef.current.delete(clientRequestId);
      setView((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : 'Message was not accepted',
      }));
    }
  }, []);

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
    const activeTurnId = viewRef.current.turns.find(
      (item) => item.status === 'streaming' || item.status === 'pending',
    )?.turnId;
    if (!id || !activeTurnId) return;
    setView((current) => ({ ...current, status: 'aborting', error: null }));
    try {
      await term2Client.abort(id, activeTurnId);
    } catch (error) {
      setView((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : 'Abort result unknown',
      }));
    }
  }, []);

  const refresh = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    const projection = await term2Client.getSession(id);
    installProjection(projection, generationRef.current);
  }, [installProjection]);

  const resolveInteraction = useCallback(
    async (request: InteractionResolveRequest) => {
      const id = sessionIdRef.current;
      const pending = viewRef.current.pendingInteraction;
      if (!id || pending?.state !== 'pending') return;
      try {
        const result = await term2Client.resolveInteraction(id, request.interactionId, {
          revision: request.revision,
          answer: request.answer,
          ...(request.rejectionReason === undefined ? {} : { rejectionReason: request.rejectionReason }),
          ...(request.approvalAnswer === undefined ? {} : { approvalAnswer: request.approvalAnswer }),
        });
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
        if (error instanceof Term2ApiError && [409, 410].includes(error.status)) {
          const message =
            error.code && error.code in INTERACTION_CONFLICT_MESSAGES
              ? INTERACTION_CONFLICT_MESSAGES[error.code as keyof typeof INTERACTION_CONFLICT_MESSAGES]
              : 'The interaction changed; the latest session state was reloaded.';
          try {
            await refresh();
          } finally {
            const next = { ...viewRef.current, error: message };
            viewRef.current = next;
            setView(next);
          }
          return;
        }
        setView((current) => ({
          ...current,
          error: error instanceof Error ? error.message : 'Interaction was not accepted',
        }));
      }
    },
    [refresh],
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
