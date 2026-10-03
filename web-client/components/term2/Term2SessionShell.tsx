'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeft, Square } from 'lucide-react';
import { useTerm2Session } from '../../hooks/useTerm2Session';
import { Term2InteractionPanel } from './Term2InteractionPanel';
import { Term2CommandCard } from './Term2CommandCard';
import { Term2SubagentCard } from './Term2SubagentCard';
import { Term2SessionList } from './Term2SessionList';
import { Term2StatusBanner } from './Term2StatusBanner';
import { ChatHeader } from '../ChatHeader';
import { Term2FolderSelector } from './Term2FolderSelector';
import { Term2SettingsPanel } from './Term2SettingsPanel';
import { Term2SessionConfig } from './Term2SessionConfig';
import { Term2CommandMenu } from './Term2CommandMenu';
import { isTerm2LocalControlEnabled } from './flags';
import { Term2ApiError, term2Client } from '../../lib/api/term2';
import type { SettingsProjection, SessionConfigRecord } from '../../lib/term2/types';

export function Term2SessionShell({
  initialSessionId,
  authUserId,
  onExit,
}: {
  initialSessionId: string | null;
  /** Current authenticated user id (or null). A change resets session selection. */
  authUserId?: string | null;
  onExit: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [prevInitialSessionId, setPrevInitialSessionId] = useState(initialSessionId);
  if (initialSessionId !== prevInitialSessionId) {
    setPrevInitialSessionId(initialSessionId);
    setSessionId(initialSessionId);
  }

  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsProjection | null>(null);
  const [workspaceMetadata, setWorkspaceMetadata] = useState<
    Record<string, { displayName: string; fullPath: string; access?: string }>
  >({});
  const localControlEnabled = isTerm2LocalControlEnabled();
  const session = useTerm2Session(sessionId);
  const { refreshWorkspaces, refreshSessions, loadNextSessions, setSelectedWorkspaceId } = session;
  const prevUserIdRef = useRef(authUserId ?? null);

  const getWorkspaceInfo = useCallback(
    (workspaceId: string | null) => {
      if (!workspaceId) return { displayName: '', fullPath: '', access: 'read' };
      const meta = workspaceMetadata[workspaceId];
      const ws = session.workspaces.find((w) => w.workspaceId === workspaceId);

      if (meta?.displayName) {
        return {
          displayName: meta.displayName,
          fullPath: meta.fullPath || meta.displayName,
          access: meta.access || ws?.access || 'read',
        };
      }
      if (ws?.label) {
        const label = ws.label;
        if (label.includes('/')) {
          const base = label.split('/').filter(Boolean).pop() || label;
          return { displayName: base, fullPath: label, access: ws.access || 'read' };
        }
        // If label is not a raw id, use it as human name
        if (!label.startsWith('ws_')) {
          return { displayName: label, fullPath: label, access: ws.access || 'read' };
        }
      }
      return {
        displayName: 'Workspace',
        fullPath: ws?.label || workspaceId,
        access: ws?.access || 'read',
      };
    },
    [workspaceMetadata, session.workspaces],
  );

  const selectedWorkspaceInfo = useMemo(
    () => getWorkspaceInfo(session.selectedWorkspaceId),
    [getWorkspaceInfo, session.selectedWorkspaceId],
  );

  const firstMessages = useMemo(() => {
    const map: Record<string, string> = {};
    if (sessionId) {
      const firstUserTurn = session.view.turns.find((turn) => turn.userText && turn.userText.trim().length > 0);
      if (firstUserTurn?.userText) {
        map[sessionId] = firstUserTurn.userText;
      }
    }
    return map;
  }, [sessionId, session.view.turns]);

  // A signed-out or different account must never keep the previous user's
  // session: drop the selection and the ?agentSession= URL parameter.
  useEffect(() => {
    const currentUserId = authUserId ?? null;
    if (prevUserIdRef.current !== currentUserId) {
      prevUserIdRef.current = currentUserId;
      setSessionId(null);
      setInput('');
      const url = new URL(window.location.href);
      if (url.searchParams.has('agentSession')) {
        url.searchParams.delete('agentSession');
        window.history.replaceState(null, '', url.toString());
      }
    }
  }, [authUserId]);

  const reloadControlPlane = useCallback(async () => {
    setLoadError(null);
    setLoadingWorkspaces(true);
    try {
      await refreshWorkspaces();
    } catch (error) {
      setLoadError(error instanceof Error && error.message ? error.message : 'Agent control plane is unavailable');
      return;
    } finally {
      setLoadingWorkspaces(false);
    }
    setLoadingSessions(true);
    try {
      await refreshSessions();
    } catch (error) {
      setLoadError(error instanceof Error && error.message ? error.message : 'Agent sessions are unavailable');
    } finally {
      setLoadingSessions(false);
    }
  }, [refreshSessions, refreshWorkspaces]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadControlPlane();
  }, [reloadControlPlane]);

  useEffect(() => {
    const selected = session.sessions.find((item) => item.id === sessionId);
    if (selected && session.selectedWorkspaceId !== selected.workspaceId) {
      setSelectedWorkspaceId(selected.workspaceId);
    }
  }, [session.sessions, session.selectedWorkspaceId, setSelectedWorkspaceId, sessionId]);

  useEffect(() => {
    if (!localControlEnabled) return;
    void term2Client
      .readSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [localControlEnabled]);

  const chooseWorkspace = (workspaceId: string) => session.setSelectedWorkspaceId(workspaceId);
  const create = async () => {
    if (!session.selectedWorkspaceId) return;
    // One active session per workspace is enforced by the gateway. Prefer the
    // existing session for this workspace instead of failing with a 409.
    const existing = session.sessions.find((item) => item.workspaceId === session.selectedWorkspaceId);
    if (existing) {
      session.selectSession(existing.id);
      return;
    }
    try {
      const projection = await session.createSession(session.selectedWorkspaceId);
      session.selectSession(projection.id);
    } catch (error) {
      // session_busy race: the existing session was not listed yet — refresh
      // and select it.
      if (error instanceof Term2ApiError && error.status === 409) {
        await session.refreshSessions();
        const listed = session.sessions.find((item) => item.workspaceId === session.selectedWorkspaceId);
        if (listed) session.selectSession(listed.id);
        return;
      }
      setLoadError(error instanceof Error ? error.message : 'Unable to create session');
    }
  };
  const selectSession = (id: string) => {
    const selected = session.sessions.find((item) => item.id === id);
    if (selected) session.setSelectedWorkspaceId(selected.workspaceId);
    setInput('');
    session.selectSession(id);
  };
  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    const accepted = await session.submit(text);
    if (accepted) setInput((current) => (current.trim() === text ? '' : current));
  };
  const interactionPending = session.view.status === 'awaiting_interaction';
  const aborting = session.view.status === 'aborting';
  const composerDisabled = !sessionId || interactionPending || aborting;
  // Session commands are refused while a turn is running or an interaction is
  // pending, and while the session has no live stream to deliver a retry turn.
  const commandDisabled =
    !sessionId ||
    session.commandPending ||
    [
      // 'idle' is the first paint of a selected session: the effect flips the
      // status to 'hydrating' in the same tick, so the menu starts disabled.
      'idle',
      'hydrating',
      'connecting',
      'reconnecting',
      'running',
      'awaiting_interaction',
      'aborting',
    ].includes(session.view.status);
  const canAbort = session.view.status === 'running' || session.view.status === 'connected';
  const hasStreamingTurn = session.view.turns.some((turn) => turn.status === 'streaming' || turn.status === 'pending');

  return (
    <main className="relative flex h-dvh max-h-dvh overflow-hidden bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <div
        className={`fixed inset-0 z-40 bg-black/40 md:hidden ${sidebarOpen ? '' : 'hidden'}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside
        aria-label="Agent sessions sidebar"
        inert={!sidebarOpen ? true : undefined}
        aria-hidden={!sidebarOpen ? 'true' : undefined}
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-zinc-200 bg-zinc-50 transition-transform dark:border-zinc-800 dark:bg-zinc-950 md:relative md:z-auto ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full invisible pointer-events-none'
        }`}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">ChatForge</p>
            <h2 className="font-semibold">Agent</h2>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            aria-label="Close agent sessions sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
          <label className="block text-xs font-medium text-zinc-500" htmlFor="agent-workspace">
            Workspace
          </label>
          <select
            id="agent-workspace"
            aria-label="Agent workspace"
            value={session.selectedWorkspaceId ?? ''}
            onChange={(event) => chooseWorkspace(event.target.value || '')}
            disabled={loadingWorkspaces || (session.workspaces.length === 0 && !session.selectedWorkspaceId)}
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Choose a workspace</option>
            {session.workspaces.map((workspace) => {
              const info = getWorkspaceInfo(workspace.workspaceId);
              return (
                <option key={workspace.workspaceId} value={workspace.workspaceId} title={info.fullPath}>
                  {info.displayName} ({info.access === 'read_write' ? 'write' : 'read'})
                </option>
              );
            })}
            {session.selectedWorkspaceId &&
              !session.workspaces.some((workspace) => workspace.workspaceId === session.selectedWorkspaceId) && (
                <option value={session.selectedWorkspaceId} title={selectedWorkspaceInfo.fullPath}>
                  {selectedWorkspaceInfo.displayName} (
                  {selectedWorkspaceInfo.access === 'read_write' ? 'write' : 'read'})
                </option>
              )}
          </select>
          {loadingWorkspaces && <p className="mt-1 text-xs text-zinc-500">Loading workspaces…</p>}
          {localControlEnabled && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Local owner controls
              </summary>
              <div className="mt-2 space-y-2">
                <Term2FolderSelector
                  onSelected={(workspace) => {
                    setWorkspaceMetadata((prev) => ({
                      ...prev,
                      [workspace.workspaceId]: {
                        displayName: workspace.displayName,
                        fullPath: workspace.fullPath || workspace.displayName,
                        access: workspace.access,
                      },
                    }));
                    session.setSelectedWorkspaceId(workspace.workspaceId);
                    void session.refreshWorkspaces();
                  }}
                />
                <Term2SettingsPanel />
              </div>
            </details>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {loadingSessions && <p className="mb-2 text-xs text-zinc-500">Loading agent sessions…</p>}
          <Term2SessionList
            sessions={session.sessions}
            selected={sessionId}
            workspaceId={session.selectedWorkspaceId}
            workspaces={session.workspaces}
            workspaceMetadata={workspaceMetadata}
            firstMessages={firstMessages}
            onSelect={selectSession}
            onCreate={() => void create()}
            nextCursor={session.sessionCursor}
            onNextPage={() => void loadNextSessions()}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          isStreaming={canAbort && hasStreamingTurn}
          onNewChat={() => void create()}
          model=""
          onModelChange={() => {}}
          showModelSelector={false}
          title="Agent"
          subtitle={
            selectedWorkspaceInfo.displayName ? `ChatForge · ${selectedWorkspaceInfo.displayName}` : 'ChatForge'
          }
          subtitleTooltip={selectedWorkspaceInfo.fullPath || undefined}
          onExit={onExit}
          exitLabel="Chat"
          showSettingsButton={false}
          newChatLabel="New agent chat"
          onToggleLeftSidebar={() => setSidebarOpen((open) => !open)}
          showLeftSidebarButton
          alwaysShowLeftSidebarButton
          leftSidebarToggleLabel="Toggle agent sessions"
          showRightSidebarButton={false}
        />
        {localControlEnabled && (
          <Term2SessionConfig
            config={(settings?.session ?? null) as SessionConfigRecord | null}
            settings={settings}
            sessionId={sessionId}
            onApplyToFutureTurns={() => void term2Client.readSettings().then(setSettings)}
            onCreateNewSession={() => void create()}
          />
        )}
        <Term2StatusBanner
          status={session.view.status}
          error={loadError ?? session.view.error}
          onRetry={() => {
            if (loadError) void reloadControlPlane();
            else void session.refresh();
          }}
        />
        <section
          aria-label="Agent conversation"
          role="log"
          aria-live="polite"
          className="relative flex min-h-0 flex-1 flex-col"
        >
          <div className="flex-1 overflow-y-auto px-3 pb-36 pt-6 sm:px-6">
            <div className="mx-auto w-full max-w-3xl space-y-5">
              {!sessionId && (
                <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
                  <h2 className="text-lg font-semibold">Start an agent chat</h2>
                  <p className="mt-2 text-sm text-zinc-500">Choose a workspace and create an agent session to begin.</p>
                </div>
              )}
              {session.view.turns.map((turn) => (
                <article key={turn.turnId} className="space-y-3">
                  {turn.userText !== undefined && (
                    <div className="ml-auto max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-3 dark:bg-zinc-800">
                      <div className="mb-1 text-xs text-zinc-500">You</div>
                      <p className="whitespace-pre-wrap text-sm">{turn.userText}</p>
                    </div>
                  )}
                  <div className="max-w-[92%] rounded-2xl px-1 py-1">
                    <div className="mb-1 text-xs font-medium text-zinc-500">
                      Agent{turn.status !== 'completed' ? ` · ${turn.status}` : ''}
                      {turn.transientStatus ? ` · ${turn.transientStatus}` : ''}
                    </div>
                    {turn.reasoning && (
                      <details className="mb-2 text-xs text-zinc-500">
                        <summary>Reasoning</summary>
                        <p className="whitespace-pre-wrap pt-1">{turn.reasoning}</p>
                      </details>
                    )}
                    {turn.text && <p className="whitespace-pre-wrap text-sm leading-6">{turn.text}</p>}
                    {turn.commands.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {turn.commands.map((command) => (
                          <Term2CommandCard key={command.callId} command={command} />
                        ))}
                      </div>
                    )}
                    {(turn.subagents ?? []).length > 0 && (
                      <div className="mt-3 space-y-2">
                        {(turn.subagents ?? []).map((card) => (
                          <Term2SubagentCard key={card.agentId} card={card} />
                        ))}
                      </div>
                    )}
                    {turn.error && <p className="mt-2 text-sm text-red-700">{turn.error}</p>}
                  </div>
                </article>
              ))}
              {session.view.pendingInteraction?.state === 'pending' && (
                <Term2InteractionPanel
                  key={`${session.view.pendingInteraction.interaction.interactionId}:${session.view.pendingInteraction.interaction.revision}:${session.view.pendingInteraction.interaction.askUser?.currentQuestionIndex ?? 0}`}
                  interaction={session.view.pendingInteraction.interaction}
                  subagent={session.view.pendingInteraction.subagent}
                  onResolve={session.resolveInteraction}
                  disabled={aborting}
                />
              )}
              {session.view.pendingInteraction?.state === 'recovered' && (
                <Term2InteractionPanel
                  key={`${session.view.pendingInteraction.interaction.interactionId}:${session.view.pendingInteraction.interaction.revision}:recovered`}
                  interaction={session.view.pendingInteraction.interaction}
                  recovered
                  onResolve={session.resolveInteraction}
                />
              )}
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-white via-white/95 to-transparent px-3 pb-3 pt-8 dark:from-zinc-900 dark:via-zinc-900/95 sm:px-6">
            {sessionId && (
              <div className="mx-auto mb-2 max-w-3xl">
                <Term2CommandMenu
                  disabled={commandDisabled}
                  pending={session.commandPending}
                  notice={session.commandNotice}
                  onCommand={(commandId) => void session.invokeCommand(commandId)}
                />
              </div>
            )}
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-700 dark:bg-zinc-950">
              <textarea
                aria-label="Agent message"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                disabled={composerDisabled}
                className="min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed"
                placeholder="Message the agent…"
              />
              {canAbort && hasStreamingTurn ? (
                <button
                  type="button"
                  aria-label="Stop agent turn"
                  className="rounded-xl border border-red-300 p-3 text-red-700 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/30"
                  onClick={() => void session.abort()}
                >
                  <Square className="h-4 w-4 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Send agent message"
                  className="rounded-xl bg-zinc-900 p-3 text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  disabled={composerDisabled || !input.trim()}
                  onClick={() => void submit()}
                >
                  Send
                </button>
              )}
            </div>
            <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-zinc-500">Agent messages are text only.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
