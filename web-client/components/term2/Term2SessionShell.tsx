'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Copy, PanelLeft, Square } from 'lucide-react';
import { useTerm2Session } from '../../hooks/useTerm2Session';
import { Term2InteractionPanel } from './Term2InteractionPanel';
import { Term2ToolGroup } from './Term2ToolGroup';
import { Term2Markdown } from './Term2Markdown';
import { describeCommand } from './Term2CommandCard';
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
  const draftSessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (draftSessionIdRef.current === sessionId) return;
    draftSessionIdRef.current = sessionId;
    // A draft belongs to the session where it was typed, including navigation
    // driven by create, browser history, or a URL prop change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInput('');
  }, [sessionId]);

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

  // Align the workspace selector to the open session once per session. Re-running
  // on every selector change would undo the user's own pick of another workspace.
  // The ref follows the open session id itself, so returning to a session after
  // visiting one that is not in the loaded list aligns again.
  const alignmentRef = useRef<{ sessionId: string | null; aligned: boolean }>({ sessionId: null, aligned: false });
  useEffect(() => {
    if (alignmentRef.current.sessionId !== sessionId) {
      alignmentRef.current = { sessionId, aligned: false };
    }
    if (!sessionId || alignmentRef.current.aligned) return;
    const selected = session.sessions.find((item) => item.id === sessionId);
    if (!selected) return;
    alignmentRef.current.aligned = true;
    setSelectedWorkspaceId(selected.workspaceId);
  }, [session.sessions, setSelectedWorkspaceId, sessionId]);

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

  const sessionConfig = (settings?.session ?? null) as SessionConfigRecord | null;
  const totalTokens = session.view.turns.reduce((sum, turn) => sum + (turn.usage?.totalTokens ?? 0), 0);
  const lastTurn = session.view.turns[session.view.turns.length - 1];
  const liveStatus = interactionPending
    ? 'Waiting for your approval'
    : lastTurn?.transientStatus
      ? lastTurn.transientStatus
      : lastTurn && (lastTurn.status === 'streaming' || lastTurn.status === 'pending')
        ? (() => {
            const active = [...lastTurn.commands].reverse().find((c) => c.status === 'running' || c.status === 'pending');
            if (active) {
              const { verb, target } = describeCommand(active);
              return `${verb}${target ? ` ${target}` : ''}…`;
            }
            return lastTurn.text ? null : lastTurn.reasoning ? 'Thinking…' : 'Working…';
          })()
        : null;

  // Follow the stream only while the reader is at the bottom; scrolling up
  // releases it and shows a jump-to-latest control.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };
  const scrollToLatest = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (pinned && el) el.scrollTop = el.scrollHeight;
  }, [session.view.turns, session.view.pendingInteraction, liveStatus, pinned]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinned(true);
  }, [sessionId]);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  const [copiedTurn, setCopiedTurn] = useState<string | null>(null);
  const copyTurn = (turnId: string, text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedTurn(turnId);
        window.setTimeout(() => setCopiedTurn((id) => (id === turnId ? null : id)), 1500);
      })
      .catch(() => undefined);
  };

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
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">term2</p>
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
            selectedWorkspaceInfo.displayName ? `term2 · ${selectedWorkspaceInfo.displayName}` : 'term2'
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
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 pb-44 pt-6 sm:px-6">
            <div className="mx-auto w-full max-w-3xl space-y-5">
              {!sessionId && (
                <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
                  <h2 className="text-lg font-semibold">Start an agent chat</h2>
                  <p className="mt-2 text-sm text-zinc-500">Choose a workspace and create an agent session to begin.</p>
                </div>
              )}
              {session.view.turns.map((turn) => (
                <article key={turn.turnId} className="group space-y-4">
                  {turn.userText !== undefined && (
                    <div className="flex flex-col items-end gap-1">
                      <div className="max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2.5 dark:bg-zinc-800">
                        <p className="whitespace-pre-wrap break-words text-[15px] leading-6">{turn.userText}</p>
                      </div>
                      <button
                        type="button"
                        aria-label="Copy message"
                        className="rounded p-1 text-zinc-400 opacity-0 transition-opacity hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 dark:hover:text-zinc-200"
                        onClick={() => copyTurn(`${turn.turnId}:user`, turn.userText ?? '')}
                      >
                        {copiedTurn === `${turn.turnId}:user` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  )}
                  <div className="min-w-0 space-y-3">
                    {turn.reasoning && (
                      <details className="text-xs text-zinc-500">
                        <summary className="cursor-pointer select-none">
                          {turn.status === 'streaming' && !turn.text ? 'Thinking…' : 'Thought process'}
                        </summary>
                        <Term2Markdown text={turn.reasoning} className="!text-xs !leading-5 pt-1 text-zinc-500" />
                      </details>
                    )}
                    {turn.commands.length > 0 && <Term2ToolGroup commands={turn.commands} />}
                    {(turn.subagents ?? []).length > 0 && (
                      <div className="space-y-2">
                        {(turn.subagents ?? []).map((card) => (
                          <Term2SubagentCard key={card.agentId} card={card} />
                        ))}
                      </div>
                    )}
                    {turn.text && <Term2Markdown text={turn.text} />}
                    {turn.status !== 'completed' && turn.status !== 'streaming' && turn.status !== 'pending' && (
                      <p className="text-xs text-zinc-500">Turn {turn.status}</p>
                    )}
                    {turn.error && <p className="text-sm text-red-700 dark:text-red-400">{turn.error}</p>}
                    {turn.text && turn.status !== 'streaming' && (
                      <div className="flex items-center gap-2 text-zinc-400 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        <button
                          type="button"
                          aria-label="Copy reply"
                          className="rounded p-1 hover:text-zinc-700 dark:hover:text-zinc-200"
                          onClick={() => copyTurn(turn.turnId, turn.text)}
                        >
                          {copiedTurn === turn.turnId ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                        {turn.usage?.totalTokens ? (
                          <span className="text-xs tabular-nums">{turn.usage.totalTokens.toLocaleString()} tokens</span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {liveStatus && (
                <p role="status" className="animate-pulse text-sm text-zinc-500">
                  {liveStatus}
                </p>
              )}
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
            {!pinned && (
              <button
                type="button"
                aria-label="Jump to latest"
                className="absolute -top-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                onClick={scrollToLatest}
              >
                <ArrowDown className="h-3 w-3" /> Jump to latest
              </button>
            )}
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
            <div className="mx-auto max-w-3xl rounded-2xl border border-zinc-200 bg-white shadow-sm focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-950">
              <textarea
                ref={composerRef}
                rows={1}
                aria-label="Agent message"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  // Enter confirms an IME candidate; it must not send.
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                disabled={composerDisabled}
                className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[15px] outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed"
                placeholder={sessionId ? 'Message term2…' : 'Create a session to start'}
              />
              <div className="flex items-center gap-2 px-3 pb-2 text-xs text-zinc-500">
                {sessionConfig && (
                  <>
                    <span className="truncate rounded-md bg-zinc-100 px-2 py-0.5 font-mono dark:bg-zinc-800" title="Model">
                      {sessionConfig.modelId}
                    </span>
                    <span className="rounded-md bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800" title="Mode">
                      {sessionConfig.mode}
                    </span>
                  </>
                )}
                {totalTokens > 0 && (
                  <span className="tabular-nums" title="Tokens used in this session">
                    {totalTokens.toLocaleString()} tokens
                  </span>
                )}
                <span className="ml-auto hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
                {canAbort && hasStreamingTurn ? (
                  <button
                    type="button"
                    aria-label="Stop agent turn"
                    className="ml-auto rounded-lg border border-red-300 p-2 text-red-700 hover:bg-red-50 sm:ml-0 dark:border-red-800 dark:hover:bg-red-950/30"
                    onClick={() => void session.abort()}
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label="Send agent message"
                    className="ml-auto rounded-lg bg-teal-600 p-2 text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40 sm:ml-0 dark:bg-teal-500 dark:text-zinc-950 dark:hover:bg-teal-400"
                    disabled={composerDisabled || !input.trim()}
                    onClick={() => void submit()}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
