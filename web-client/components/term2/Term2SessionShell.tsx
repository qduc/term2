'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  Folder,
  PanelLeft,
  Plus,
  Square,
} from 'lucide-react';
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

/** The product name set in mono with a blinking block cursor, sized by the parent's font size. */
function Wordmark() {
  return (
    <span className="inline-flex items-baseline font-mono font-semibold tracking-tight">
      <span className="mr-[0.35em] text-zinc-400 dark:text-zinc-500">~</span>
      term2
      <span aria-hidden className="t2-caret ml-[0.12em] inline-block h-[0.95em] w-[0.5em] translate-y-[0.12em] bg-teal-500" />
    </span>
  );
}

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

  const sessionTitle = sessionId
    ? (() => {
        const first = firstMessages[sessionId]?.trim().split('\n')[0];
        if (!first) return 'Agent session';
        return first.length > 80 ? `${first.slice(0, 80)}…` : first;
      })()
    : 'New agent chat';

  return (
    <main className="relative flex h-dvh max-h-dvh overflow-hidden bg-[#f7f7f8] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div
        className={`fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] md:hidden ${sidebarOpen ? '' : 'hidden'}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside
        aria-label="Agent sessions sidebar"
        inert={!sidebarOpen ? true : undefined}
        aria-hidden={!sidebarOpen ? 'true' : undefined}
        className={`fixed inset-y-0 left-0 z-50 flex w-[17rem] flex-col bg-[#f7f7f8] shadow-2xl transition-[transform,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:bg-zinc-950 md:relative md:z-auto md:shadow-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full invisible pointer-events-none md:-ml-[17rem]'
        }`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
          <h2 className="text-[15px]">
            <Wordmark />
          </h2>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
            aria-label="Close agent sessions sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        </div>
        <div className="px-3 pb-3 pt-1">
          <label className="sr-only" htmlFor="agent-workspace">
            Workspace
          </label>
          <div className="relative">
            <Folder
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
              strokeWidth={1.75}
            />
            <select
              id="agent-workspace"
              aria-label="Agent workspace"
              value={session.selectedWorkspaceId ?? ''}
              onChange={(event) => chooseWorkspace(event.target.value || '')}
              disabled={loadingWorkspaces || (session.workspaces.length === 0 && !session.selectedWorkspaceId)}
              className="w-full cursor-pointer appearance-none rounded-lg border border-black/[0.08] bg-white py-2 pl-8 pr-8 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none transition-colors hover:border-black/[0.14] focus-visible:ring-2 focus-visible:ring-teal-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-zinc-900 dark:hover:border-white/[0.14]"
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
            <ChevronsUpDown
              aria-hidden
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
            />
          </div>
          {loadingWorkspaces && <p className="mt-1.5 px-1 text-xs text-zinc-500">Loading workspaces…</p>}
          {localControlEnabled && (
            <details className="group/local mt-2">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden className="h-3 w-3 transition-transform group-open/local:rotate-90" />
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
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
          {loadingSessions && <p className="mb-2 px-2.5 text-xs text-zinc-500">Loading agent sessions…</p>}
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

      <div className={`flex min-w-0 flex-1 flex-col md:py-2 md:pr-2 ${sidebarOpen ? '' : 'md:pl-2'}`}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-900 md:rounded-2xl md:border md:border-black/[0.06] md:shadow-[0_1px_3px_rgba(0,0,0,0.04)] md:dark:border-white/[0.06]">
          <ChatHeader
            isStreaming={canAbort && hasStreamingTurn}
            onNewChat={() => void create()}
            model=""
            onModelChange={() => {}}
            showModelSelector={false}
            title={sessionTitle}
            subtitle={selectedWorkspaceInfo.displayName || 'term2'}
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
          <section
            aria-label="Agent conversation"
            role="log"
            aria-live="polite"
            className="relative flex min-h-0 flex-1 flex-col"
          >
            <Term2StatusBanner
              status={session.view.status}
              error={loadError ?? session.view.error}
              onRetry={() => {
                if (loadError) void reloadControlPlane();
                else void session.refresh();
              }}
            />
            <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 pb-48 pt-8 scrollbar-thin sm:px-6">
              <div className="mx-auto w-full max-w-[46rem] space-y-8">
                {!sessionId && (
                  <div className="t2-enter flex flex-col items-center pt-[14vh] text-center">
                    <span aria-hidden className="text-[2rem] leading-none">
                      <Wordmark />
                    </span>
                    <h2 className="mt-6 text-xl font-semibold tracking-tight">Start an agent chat</h2>
                    <p className="mt-2 max-w-sm text-[15px] text-zinc-500 dark:text-zinc-400">
                      Choose a workspace and create an agent session to begin.
                    </p>
                    <button
                      type="button"
                      disabled={!session.selectedWorkspaceId}
                      onClick={() => void create()}
                      className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                    >
                      <Plus aria-hidden className="h-4 w-4" />
                      New agent chat
                    </button>
                  </div>
                )}
                {session.view.turns.map((turn) => (
                  <article key={turn.turnId} className="t2-enter group space-y-5">
                    {turn.userText !== undefined && (
                      <div className="flex flex-col items-end gap-1">
                        <div className="max-w-[85%] rounded-3xl bg-zinc-100 px-4 py-2.5 dark:bg-white/[0.07]">
                          <p className="whitespace-pre-wrap break-words text-[15px] leading-6">{turn.userText}</p>
                        </div>
                        <button
                          type="button"
                          aria-label="Copy message"
                          className="rounded-md p-1.5 text-zinc-400 opacity-0 transition-opacity hover:bg-black/[0.05] hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 dark:hover:bg-white/[0.07] dark:hover:text-zinc-200"
                          onClick={() => copyTurn(`${turn.turnId}:user`, turn.userText ?? '')}
                        >
                          {copiedTurn === `${turn.turnId}:user` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    )}
                    <div className="min-w-0 space-y-4">
                      {turn.reasoning && (
                        <details className="group/reason text-sm">
                          <summary className="-ml-2 inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-lg px-2 py-1 text-zinc-500 transition-colors hover:bg-black/[0.035] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                            <Brain aria-hidden className="h-4 w-4" strokeWidth={1.75} />
                            <span className={turn.status === 'streaming' && !turn.text ? 't2-shimmer' : undefined}>
                              {turn.status === 'streaming' && !turn.text ? 'Thinking…' : 'Thought process'}
                            </span>
                            <ChevronRight aria-hidden className="h-3.5 w-3.5 transition-transform group-open/reason:rotate-90" />
                          </summary>
                          <div className="ml-[7px] mt-2 border-l-2 border-zinc-200 pl-4 dark:border-zinc-800">
                            <Term2Markdown text={turn.reasoning} className="!text-[13px] !leading-6 !text-zinc-500 dark:!text-zinc-400" />
                          </div>
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
                        <p className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-2.5 py-0.5 text-xs text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
                          Turn {turn.status}
                        </p>
                      )}
                      {turn.error && (
                        <p className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                          <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                          {turn.error}
                        </p>
                      )}
                      {turn.text && turn.status !== 'streaming' && (
                        <div className="-ml-1.5 flex items-center gap-1 text-zinc-400 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                          <button
                            type="button"
                            aria-label="Copy reply"
                            className="rounded-md p-1.5 hover:bg-black/[0.05] hover:text-zinc-700 dark:hover:bg-white/[0.07] dark:hover:text-zinc-200"
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
                  <p role="status" className="flex items-center gap-2.5 text-sm">
                    <span aria-hidden className="relative flex h-2 w-2">
                      <span
                        className={`absolute inset-0 animate-ping rounded-full ${interactionPending ? 'bg-amber-400/70' : 'bg-teal-400/70'}`}
                      />
                      <span className={`relative h-2 w-2 rounded-full ${interactionPending ? 'bg-amber-500' : 'bg-teal-500'}`} />
                    </span>
                    <span className="t2-shimmer truncate">{liveStatus}</span>
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

            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-white from-60% to-transparent px-3 pb-3 pt-10 dark:from-zinc-900 sm:px-6 sm:pb-4">
              {!pinned && (
                <button
                  type="button"
                  aria-label="Jump to latest"
                  className="t2-enter pointer-events-auto absolute left-1/2 top-0 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-black/[0.08] bg-white/90 text-zinc-600 shadow-md backdrop-blur transition-colors hover:text-zinc-900 dark:border-white/10 dark:bg-zinc-800/90 dark:text-zinc-300 dark:hover:text-white"
                  onClick={scrollToLatest}
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              )}
              <div className="pointer-events-auto mx-auto max-w-[46rem] rounded-[26px] border border-black/[0.08] bg-white shadow-[0_2px_6px_rgba(0,0,0,0.03),0_12px_32px_-12px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] focus-within:border-black/[0.16] focus-within:shadow-[0_2px_6px_rgba(0,0,0,0.04),0_16px_40px_-12px_rgba(0,0,0,0.18)] dark:border-white/[0.09] dark:bg-zinc-800/60 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)] dark:focus-within:border-white/[0.18]">
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
                  className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-[15px] leading-6 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed dark:placeholder:text-zinc-500"
                  placeholder={sessionId ? 'Ask term2 to build, fix or explain…' : 'Create a session to start'}
                />
                <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {sessionId && (
                    <Term2CommandMenu
                      disabled={commandDisabled}
                      pending={session.commandPending}
                      notice={session.commandNotice}
                      onCommand={(commandId) => void session.invokeCommand(commandId)}
                    />
                  )}
                  {sessionConfig && (
                    <>
                      <span
                        className="truncate rounded-full border border-black/[0.08] px-2.5 py-1 font-mono text-[11.5px] dark:border-white/10"
                        title="Model"
                      >
                        {sessionConfig.modelId}
                      </span>
                      <span className="rounded-full border border-black/[0.08] px-2.5 py-1 dark:border-white/10" title="Mode">
                        {sessionConfig.mode}
                      </span>
                    </>
                  )}
                  <span className="ml-auto hidden items-center gap-3 sm:flex">
                    {totalTokens > 0 && (
                      <span className="tabular-nums" title="Tokens used in this session">
                        {totalTokens.toLocaleString()} tokens
                      </span>
                    )}
                  </span>
                  {canAbort && hasStreamingTurn ? (
                    <button
                      type="button"
                      aria-label="Stop agent turn"
                      title="Stop"
                      className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 sm:ml-0 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                      onClick={() => void session.abort()}
                    >
                      <Square className="h-3 w-3 fill-current" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Send agent message"
                      title="Send (Enter) · new line (Shift+Enter)"
                      className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-white shadow-sm transition-all hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none sm:ml-0 dark:bg-teal-500 dark:text-zinc-950 dark:hover:bg-teal-400 dark:disabled:bg-white/10 dark:disabled:text-zinc-500"
                      disabled={composerDisabled || !input.trim()}
                      onClick={() => void submit()}
                    >
                      <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-2 hidden text-center text-[11px] text-zinc-400 sm:block dark:text-zinc-500">
                Enter to send · Shift+Enter for a new line
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
