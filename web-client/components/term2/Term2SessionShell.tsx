'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  CircleAlert,
  CircleHelp,
  Copy,
  Folder,
  History,
  PanelLeft,
  Plus,
  RotateCcw,
  Settings,
  SquarePen,
  Square,
  Target,
  Wand2,
  X,
} from 'lucide-react';
import { canSubmitSessionMessage, useTerm2Session } from '../../hooks/useTerm2Session';
import { shellSandboxMachineFact } from '../../lib/term2/shell-sandbox-notice';
import { Term2InteractionPanel } from './Term2InteractionPanel';
import { Term2TurnTimeline, type Term2DisplayMode } from './Term2TurnTimeline';
import { describeCommand } from './Term2CommandCard';
import { Term2SubagentCard } from './Term2SubagentCard';
import { Term2SessionList } from './Term2SessionList';
import { Term2StatusBanner } from './Term2StatusBanner';
import { ChatHeader } from '../ChatHeader';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Term2FolderSelector, type SelectedTerm2Workspace } from './Term2FolderSelector';
import type { SavedFolderChange } from './Term2SavedFolderMenu';
import { Term2SetupDialog } from './Term2SetupDialog';
import { Term2SettingsPage } from './settings/Term2SettingsPage';
import { parseSettingsSection, type SettingsSectionId } from './settings/settings-catalog';
import { Term2NativeEvidence } from './Term2NativeEvidence';
import { Term2SessionConfig } from './Term2SessionConfig';
import { Term2CommandMenu } from './Term2CommandMenu';
import { Term2ModelPicker } from './Term2ModelPicker';
import { Term2ApprovalPicker } from './Term2ApprovalPicker';
import { Term2UsagePopover } from './Term2UsagePopover';
import { Term2QueueBar } from './Term2QueueBar';
import { Term2RewindDialog } from './Term2RewindDialog';
import { Term2RetryReply, Term2UserMessage, type ResendFromTurn } from './Term2MessageActions';
import { Term2RunningTasksPanel, useRunningTasks } from './Term2RunningTasksPanel';
import {
  Term2PathPopover,
  Term2QuickPalette,
  Term2SkillsPopover,
  type QuickActionItem,
} from './Term2ComposerPopovers';
import { Term2HelpDialog } from './Term2HelpDialog';
import { isTerm2LocalControlEnabled } from './flags';
import { Term2ApiError, term2Client } from '../../lib/api/term2';
import type {
  ImageAttachmentPayload,
  ModelSummary,
  RewindTargetSummary,
  SessionApprovalMode,
  SessionConfigRecord,
  SessionConfigUpdate,
  SettingsProjection,
  SkillSummary,
  WorkspaceFileEntry,
} from '../../lib/term2/types';

const PROMPT_HISTORY_KEY = 'term2.web.promptHistory';
/** Radix Select reserves the empty string, so the "no folder" option uses a sentinel. */
const NO_WORKSPACE = '__none__';
const DISPLAY_MODE_KEY = 'term2.web.displayMode';
const NOTIFICATIONS_KEY = 'term2.web.notifications';
const DIAGNOSTICS_KEY = 'term2.web.diagnostics';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const STARTER_PROMPTS = [
  'What files are in this folder?',
  'Summarize how this project is organized',
  'Find any TODOs or potential issues here',
];

interface DraftImage extends ImageAttachmentPayload {
  id: string;
  name: string;
  previewUrl: string;
}

function Wordmark() {
  return (
    <span className="inline-flex items-baseline font-mono font-semibold tracking-tight">
      <span className="mr-[0.35em] text-zinc-400 dark:text-zinc-500">~</span>
      term2
    </span>
  );
}

/** The current URL with the settings page's parameters set (or removed when `section` is null). */
function settingsUrl(section: SettingsSectionId | null, provider?: string | null): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('settings');
  url.searchParams.delete('provider');
  if (section) {
    url.searchParams.set('settings', section);
    if (provider) url.searchParams.set('provider', provider);
  }
  return url.toString();
}

function readLocalString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readPromptHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(PROMPT_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(-50) : [];
  } catch {
    return [];
  }
}

function fileToDraftImage(file: File): Promise<DraftImage> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      reject(new Error(`Unsupported image type (${file.type || 'unknown'}). Use PNG, JPEG, WebP, or GIF.`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`Image “${file.name || 'clipboard'}” is larger than 5 MB.`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error('Invalid image encoding.'));
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name || 'image',
        type: 'image',
        mediaType: file.type as ImageAttachmentPayload['mediaType'],
        data: dataUrl.slice(comma + 1),
        previewUrl: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

function extractAtMention(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match) return null;
  const query = match[1] ?? '';
  const start = cursor - query.length - 1;
  return { start, query };
}

export function Term2SessionShell({
  initialSessionId,
  authUserId,
  homeFolder,
  allowWrite = false,
  settingsSection = null,
  settingsProvider = null,
}: {
  initialSessionId: string | null;
  /** Current authenticated user id (or null). A change resets session selection. */
  authUserId?: string | null;
  homeFolder?: string;
  allowWrite?: boolean;
  /** `?settings=` URL value; when set, the settings page replaces the chat view. */
  settingsSection?: string | null;
  /** `?provider=` URL value: the provider shown on the settings page's Providers section. */
  settingsProvider?: string | null;
}) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [prevInitialSessionId, setPrevInitialSessionId] = useState(initialSessionId);
  if (initialSessionId !== prevInitialSessionId) {
    setPrevInitialSessionId(initialSessionId);
    setSessionId(initialSessionId);
  }

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<DraftImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  const [armedSkill, setArmedSkill] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dialog, setDialog] = useState<'folder' | 'help' | 'rewind' | null>(null);
  const [rewindInitialTurnId, setRewindInitialTurnId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ turnId: string; message: string } | null>(null);
  // The running tasks panel: which chat it is open for, and chats where the user closed it.
  const [tasksPanelFor, setTasksPanelFor] = useState<string | null>(null);
  const [tasksPanelDismissed, setTasksPanelDismissed] = useState<Record<string, true>>({});
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [startingChat, setStartingChat] = useState(false);
  // "New chat" opens a draft: a folder and a composer, but no gateway session
  // until the first message is sent, so clicking around leaves no empty chats.
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null);
  const [draftConfig, setDraftConfig] = useState<
    Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'approvalMode'>
  >({});
  const [pendingFirstSend, setPendingFirstSend] = useState<{
    sessionId: string;
    delivery?: 'auto' | 'steer' | 'follow_up';
    overrideText?: string;
  } | null>(null);
  const isDraft = !sessionId && draftWorkspaceId !== null;
  // Model and effort picked in an existing chat wait here until the next message is sent;
  // leaving the chat discards them, so browsing never changes a conversation's model.
  const [stagedConfig, setStagedConfig] = useState<{
    sessionId: string;
    modelSelection?: { provider: string; model: string };
    reasoningEffort?: SessionConfigUpdate['reasoningEffort'];
  } | null>(null);
  const pendingFirstSendIdRef = useRef<string | null>(null);
  pendingFirstSendIdRef.current = pendingFirstSend?.sessionId ?? null;
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [discoveredConfig, setDiscoveredConfig] = useState<SessionConfigRecord | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsProjection | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<WorkspaceFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesLoadedFor, setFilesLoadedFor] = useState<string | null>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [popoverIndex, setPopoverIndex] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [displayMode, setDisplayMode] = useState<Term2DisplayMode>('concise');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const savedDraftRef = useRef<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillPickedRef = useRef(false);

  const [workspaceMetadata, setWorkspaceMetadata] = useState<
    Record<string, { displayName: string; fullPath: string; access?: string }>
  >({});
  const localControlEnabled = isTerm2LocalControlEnabled();
  const activeSettingsSection = localControlEnabled ? parseSettingsSection(settingsSection) : null;
  const settingsOpen = activeSettingsSection !== null;

  /** Opens the settings page as a new history entry, so browser Back returns to the chat. */
  const openSettings = useCallback((section: SettingsSectionId = 'providers', provider?: string | null) => {
    window.history.pushState({ term2Settings: true }, '', settingsUrl(section, provider));
  }, []);
  /** Moves within settings without adding history entries. */
  const navigateSettings = useCallback((section: SettingsSectionId, provider?: string | null) => {
    window.history.replaceState(
      { term2Settings: Boolean((window.history.state as { term2Settings?: boolean } | null)?.term2Settings) },
      '',
      settingsUrl(section, provider),
    );
  }, []);
  const closeSettings = useCallback(() => {
    // Opened from the chat: go back to that entry. Opened from a link or a refresh: drop the parameters.
    if ((window.history.state as { term2Settings?: boolean } | null)?.term2Settings) {
      window.history.back();
      return;
    }
    window.history.replaceState({}, '', settingsUrl(null));
  }, []);
  const session = useTerm2Session(sessionId);
  const { refreshWorkspaces, refreshSessions, loadNextSessions, setSelectedWorkspaceId } = session;
  const prevUserIdRef = useRef(authUserId ?? null);
  const draftSessionIdRef = useRef(sessionId);

  // Open sidebar by default on desktop screens and load saved UI preferences.
  useEffect(() => {
    if (window.innerWidth >= 768) setSidebarOpen(true);
    const savedDisplay = readLocalString(DISPLAY_MODE_KEY);
    // 'detailed' is the earlier name for standard.
    if (savedDisplay === 'standard' || savedDisplay === 'detailed') setDisplayMode('standard');
    else if (savedDisplay === 'concise') setDisplayMode('concise');
    if (readLocalString(NOTIFICATIONS_KEY) === 'true') setNotificationsEnabled(true);
    if (readLocalString(DIAGNOSTICS_KEY) === 'true') setShowDiagnostics(true);
    setPromptHistory(readPromptHistory());
  }, []);

  const updateDisplayMode = (mode: Term2DisplayMode) => {
    setDisplayMode(mode);
    try {
      window.localStorage.setItem(DISPLAY_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  };

  const updateDiagnostics = (enabled: boolean) => {
    setShowDiagnostics(enabled);
    try {
      window.localStorage.setItem(DIAGNOSTICS_KEY, String(enabled));
    } catch {
      /* ignore */
    }
  };

  const updateNotifications = (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    try {
      window.localStorage.setItem(NOTIFICATIONS_KEY, String(enabled));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (draftSessionIdRef.current === sessionId) return;
    draftSessionIdRef.current = sessionId;
    // A draft that just became this session keeps its composer text, images and skill for the first send.
    if (sessionId && pendingFirstSendIdRef.current === sessionId) return;
    setInput('');
    setAttachments([]);
    setAttachmentError(null);
    setArmedSkill(null);
    setConfigError(null);
    setHistoryIndex(null);
    setPaletteOpen(false);
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

  const reloadModels = useCallback(async () => {
    if (!localControlEnabled) return;
    setLoadingModels(true);
    try {
      const res = await term2Client.listModels();
      setModels(res.models);
    } catch {
      /* model catalog may be empty before any provider is configured */
    } finally {
      setLoadingModels(false);
    }
  }, [localControlEnabled]);

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
    void reloadControlPlane();
  }, [reloadControlPlane]);

  // Auto-select the first saved workspace if none is selected yet (less friction for returning users).
  useEffect(() => {
    if (!session.selectedWorkspaceId && session.workspaces.length > 0 && !sessionId) {
      setSelectedWorkspaceId(session.workspaces[0].workspaceId);
    }
  }, [session.selectedWorkspaceId, session.workspaces, sessionId, setSelectedWorkspaceId]);

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
    void reloadModels();
  }, [localControlEnabled, reloadModels]);

  useEffect(() => {
    setDiscoveredConfig(null);
    if (!localControlEnabled || !sessionId) return;
    const controller = new AbortController();
    void term2Client
      .readSessionConfig(sessionId, controller.signal)
      .then((config) => {
        if (!controller.signal.aborted) setDiscoveredConfig(config);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [localControlEnabled, sessionId]);

  const ensureSessionFiles = useCallback(() => {
    if (!sessionId || loadingFiles || filesLoadedFor === sessionId) return;
    setLoadingFiles(true);
    void term2Client
      .listSessionFiles(sessionId)
      .then((res) => {
        setSessionFiles(res.entries);
        setFilesLoadedFor(sessionId);
      })
      .catch(() => undefined)
      .finally(() => setLoadingFiles(false));
  }, [sessionId, loadingFiles, filesLoadedFor]);

  const openSkillsMenu = () => {
    setSkillsOpen((open) => {
      const next = !open;
      if (next && skills.length === 0 && !loadingSkills) {
        setLoadingSkills(true);
        void term2Client
          .listSkills()
          .then((res) => setSkills(res.skills))
          .catch(() => undefined)
          .finally(() => setLoadingSkills(false));
      }
      return next;
    });
  };

  const effectiveAllowWrite = allowWrite || settings?.settings.safety.workspaceAccess === 'read_write';

  const chooseWorkspace = (workspaceId: string) => session.setSelectedWorkspaceId(workspaceId || null);

  const leaveSession = useCallback(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('agentSession')) return;
    url.searchParams.delete('agentSession');
    window.history.pushState({}, '', url.toString());
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  /** Opens an empty draft chat in a folder; the gateway session is created on first send. */
  const createNewChat = useCallback(
    async (workspaceOverride?: string) => {
      const targetWorkspace = workspaceOverride ?? session.selectedWorkspaceId;
      if (!targetWorkspace || startingChat) return;
      setLoadError(null);
      session.setSelectedWorkspaceId(targetWorkspace);
      setDraftWorkspaceId(targetWorkspace);
      setDraftConfig({});
      setInput('');
      leaveSession();
      if (window.innerWidth < 768) setSidebarOpen(false);
      window.setTimeout(() => composerRef.current?.focus(), 50);
    },
    [leaveSession, session, startingChat],
  );

  /** Creates the gateway session for a draft, applies draft picks, then hands the first send to it. */
  const startDraftChat = async (delivery?: 'auto' | 'steer' | 'follow_up', overrideText?: string) => {
    if (!draftWorkspaceId || startingChat) return;
    setStartingChat(true);
    setLoadError(null);
    try {
      const projection = await session.createSession(draftWorkspaceId);
      const toApply = draftConfig;
      if (Object.keys(toApply).length > 0) {
        const latest = await term2Client.readSessionConfig(projection.id);
        await term2Client.updateSessionConfig(projection.id, {
          clientRequestId: crypto.randomUUID(),
          expectedRevision: latest.configRevision,
          admission: 'idle',
          ...toApply,
        });
      }
      setPendingFirstSend({ sessionId: projection.id, delivery, overrideText });
      setDraftWorkspaceId(null);
      setDraftConfig({});
      session.selectSession(projection.id);
    } catch (error) {
      if (error instanceof Term2ApiError && error.status === 409) {
        await session.refreshSessions().catch(() => undefined);
      }
      setLoadError(
        error instanceof Error && error.message
          ? error.message
          : 'Could not start a new chat. Try again or choose a different folder.',
      );
    } finally {
      setStartingChat(false);
    }
  };

  const onFolderSelected = (folder: SelectedTerm2Workspace) => {
    setWorkspaceMetadata((current) => ({
      ...current,
      [folder.workspaceId]: {
        displayName: folder.displayName,
        fullPath: folder.fullPath || folder.displayName,
        access: folder.access,
      },
    }));
    setDialog(null);
    // Switch to the folder just chosen: a new chat there, not the chat that was open.
    void createNewChat(folder.workspaceId);
    void refreshWorkspaces().catch(() => setLoadError('Could not refresh saved folders.'));
  };

  /**
   * After a saved folder's access changes, its chats keep working (the gateway restarts them
   * with the narrower access). After removal they no longer open, so leave an open one.
   */
  const onSavedFolderChanged = async (change: SavedFolderChange) => {
    const workspaceId = change.kind === 'removed' ? change.workspaceId : change.workspace.workspaceId;
    if (change.kind === 'access') {
      setWorkspaceMetadata((current) =>
        current[workspaceId]
          ? { ...current, [workspaceId]: { ...current[workspaceId], access: change.workspace.access } }
          : current,
      );
    }
    const openChatWorkspace = sessionId
      ? (session.sessions.find((item) => item.id === sessionId)?.workspaceId ?? session.selectedWorkspaceId)
      : null;
    if (change.kind === 'removed' && openChatWorkspace === workspaceId) {
      const params = new URLSearchParams(window.location.search);
      params.delete('agentSession');
      window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    void refreshSessions().catch(() => undefined);
    try {
      await refreshWorkspaces();
    } catch {
      setLoadError('Could not refresh saved folders.');
    }
    // Clear only after the list no longer has the folder, or the auto-select would pick it again.
    if (change.kind === 'removed' && session.selectedWorkspaceId === workspaceId) setSelectedWorkspaceId(null);
  };

  const selectSession = (id: string) => {
    const selected = session.sessions.find((item) => item.id === id);
    if (selected) session.setSelectedWorkspaceId(selected.workspaceId);
    setInput('');
    session.selectSession(id);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  /** Applies a change to the open chat now. Returns whether it took effect. */
  const applySessionConfig = async (
    selection: Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'mode' | 'approvalMode'>,
  ): Promise<boolean> => {
    if (!sessionId || !discoveredConfig || configBusy) return false;
    setConfigBusy(true);
    setConfigError(null);
    try {
      const latest = await term2Client.readSessionConfig(sessionId);
      setDiscoveredConfig(latest);
      const response = await term2Client.updateSessionConfig(sessionId, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: latest.configRevision,
        admission: 'idle',
        ...selection,
      });
      if (response.result.ok && response.result.kind === 'command_finished') {
        const refreshed = await term2Client.readSessionConfig(sessionId);
        setDiscoveredConfig(refreshed);
        return true;
      }
      if (!response.result.ok) {
        setConfigError(response.result.message || 'Could not update session configuration.');
        return false;
      }
      return true;
    } catch (reason) {
      setConfigError(reason instanceof Error ? reason.message : 'Could not update session configuration.');
      return false;
    } finally {
      setConfigBusy(false);
    }
  };

  /** A model or effort picked in a blank chat becomes the default for blank chats. */
  const saveBlankChatDefault = async (
    selection: Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort'>,
  ) => {
    const changes: Array<{ key: string; value: unknown }> = [];
    if (selection.modelSelection) changes.push({ key: 'agent.modelSelection', value: selection.modelSelection });
    if (selection.reasoningEffort) changes.push({ key: 'agent.reasoningEffort', value: selection.reasoningEffort });
    if (changes.length === 0 || !settings) return;
    try {
      const res = await term2Client.writeSettings({ expectedRevision: settings.revision, changes });
      setSettings(res.projection);
    } catch {
      setLoadError('Could not save this as the default for new chats. It still applies to this chat.');
    }
  };

  const handleUpdateSessionConfig = async (
    selection: Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'mode' | 'approvalMode'>,
  ) => {
    if (isDraft) {
      setDraftConfig((current) => ({ ...current, ...selection }));
      void saveBlankChatDefault(selection);
      return;
    }
    if (!sessionId) return;
    const { modelSelection, reasoningEffort, ...immediate } = selection;
    if (modelSelection || reasoningEffort) {
      setStagedConfig((current) => {
        const next: NonNullable<typeof current> =
          current?.sessionId === sessionId ? { ...current } : { sessionId };
        if (modelSelection) {
          const unchanged =
            sessionConfig?.providerId === modelSelection.provider && sessionConfig?.modelId === modelSelection.model;
          if (unchanged) delete next.modelSelection;
          else next.modelSelection = modelSelection;
        }
        if (reasoningEffort) {
          if ((sessionConfig?.reasoningEffort || 'default') === reasoningEffort) delete next.reasoningEffort;
          else next.reasoningEffort = reasoningEffort;
        }
        return next.modelSelection || next.reasoningEffort ? next : null;
      });
    }
    // Approval and mode are safety and behaviour controls: they apply now.
    if (Object.keys(immediate).length > 0) await applySessionConfig(immediate);
  };

  const handleToggleFavorite = async (favoriteKey: string) => {
    if (!settings) return;
    const raw = settings.settings.safeDefaults['agent.favoriteModels']?.value;
    const current = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    const next = current.includes(favoriteKey)
      ? current.filter((item) => item !== favoriteKey)
      : [...current, favoriteKey];
    try {
      const res = await term2Client.writeSettings({
        expectedRevision: settings.revision,
        changes: [{ key: 'agent.favoriteModels', value: next }],
      });
      setSettings(res.projection);
    } catch {
      /* ignore transient favorite toggle error */
    }
  };

  const addImageFiles = async (files: FileList | File[]) => {
    setAttachmentError(null);
    const list = Array.from(files);
    if (attachments.length + list.length > 4) {
      setAttachmentError('You can attach up to 4 images per message.');
      return;
    }
    const added: DraftImage[] = [];
    for (const file of list) {
      try {
        added.push(await fileToDraftImage(file));
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : 'Could not attach image.');
      }
    }
    if (added.length > 0) {
      setAttachments((current) => [...current, ...added].slice(0, 4));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      void addImageFiles(imageFiles);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFile(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void addImageFiles(files);
    }
  };

  const interactionPending = session.view.status === 'awaiting_interaction';
  const aborting = session.view.status === 'aborting';
  const composerDisabled = isDraft
    ? startingChat
    : !sessionId ||
    session.view.sessionId !== sessionId ||
    !canSubmitSessionMessage(session.view.status) ||
    interactionPending ||
    aborting;
  const commandDisabled =
    !sessionId ||
    session.commandPending ||
    ['idle', 'hydrating', 'connecting', 'reconnecting', 'running', 'awaiting_interaction', 'aborting'].includes(
      session.view.status,
    );
  const canAbort = session.view.status === 'running' || session.view.status === 'connected';
  const activeStreamingTurn = session.view.turns.find(
    (turn) => turn.status === 'streaming' || turn.status === 'pending',
  );
  const hasStreamingTurn = Boolean(activeStreamingTurn);

  const submitMessage = async (
    delivery?: 'auto' | 'steer' | 'follow_up',
    overrideText?: string,
    // Edit and Retry resend one message's text without the composer's attachments or skill.
    options?: { textOnly?: boolean },
  ) => {
    const text = (overrideText ?? input).trim();
    if (!text && attachments.length === 0) return;
    if (isDraft) {
      await startDraftChat(delivery, overrideText);
      return;
    }
    // A staged model or effort applies to the next turn this message starts; a steer or
    // queued message during a running turn leaves it staged.
    if (!hasStreamingTurn && stagedConfig && stagedConfig.sessionId === sessionId) {
      const { sessionId: _staged, ...changes } = stagedConfig;
      if (!(await applySessionConfig(changes))) return;
      setStagedConfig(null);
    }
    const effectiveDelivery = delivery ?? (hasStreamingTurn ? 'steer' : 'auto');
    const accepted = await session.submit(text, {
      delivery: effectiveDelivery,
      ...(effectiveDelivery === 'steer' && activeStreamingTurn ? { expectedSteerTurnId: activeStreamingTurn.turnId } : {}),
      ...(armedSkill && !options?.textOnly ? { skill: armedSkill } : {}),
      ...(attachments.length > 0 && !options?.textOnly
        ? {
            attachments: attachments.map(({ type, mediaType, data }) => ({ type, mediaType, data })),
          }
        : {}),
    });
    if (accepted) {
      if (overrideText === undefined) {
        setInput((current) => (current.trim() === text ? '' : current));
        setAttachments([]);
        setAttachmentError(null);
        setArmedSkill(null);
        setHistoryIndex(null);
        if (text) {
          setPromptHistory((prev) => {
            const next = prev[prev.length - 1] === text ? prev : [...prev.slice(-49), text];
            try {
              window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));
            } catch {
              /* ignore */
            }
            return next;
          });
        }
      }
    }
    return accepted;
  };

  const sessionConfig = discoveredConfig?.sessionId === sessionId ? discoveredConfig : null;

  // Opening any real chat ends the draft.
  useEffect(() => {
    if (sessionId) setDraftWorkspaceId(null);
    setStagedConfig((current) => (current && current.sessionId === sessionId ? current : null));
  }, [sessionId]);

  // The blank-chat default model. It is never swapped for another model behind the
  // user's back: when it isn't available, the draft keeps it and says so.
  const draftModel = useMemo((): {
    selection: { provider: string; model: string };
    unavailable?: boolean;
  } | null => {
    if (!isDraft || !settings) return null;
    const selection =
      draftConfig.modelSelection ??
      (settings.settings.safeDefaults['agent.modelSelection']?.value as
        | { provider: string; model: string }
        | undefined);
    if (!selection?.provider || !selection.model) return null;
    const providerOff = Boolean(settings.settings.providers.find((item) => item.id === selection.provider)?.disabled);
    const notListed =
      models.length > 0 && !models.some((m) => m.provider === selection.provider && m.id === selection.model);
    return { selection, unavailable: providerOff || notListed };
  }, [isDraft, settings, draftConfig.modelSelection, models]);

  // A draft's model, effort and approval picks start from the saved defaults and are
  // applied to the session when the first message creates it.
  const draftPickerConfig = useMemo((): SessionConfigRecord | null => {
    if (!isDraft || !settings || !draftModel) return null;
    const defaults = settings.settings.safeDefaults;
    const savedEffort = defaults['agent.reasoningEffort']?.value;
    const savedApproval = defaults['shell.autoApproveMode']?.value;
    return {
      configRevision: 'draft',
      defaultsRevision: settings.defaultsRevision,
      providerId: draftModel.selection.provider,
      modelId: draftModel.selection.model,
      reasoningEffort: draftConfig.reasoningEffort ?? (typeof savedEffort === 'string' ? savedEffort : 'default'),
      mode: 'standard',
      approvalMode:
        draftConfig.approvalMode ??
        (['off', 'auto', 'unattended', 'always'].includes(String(savedApproval))
          ? (savedApproval as SessionApprovalMode)
          : 'off'),
    };
  }, [isDraft, settings, draftConfig, draftModel]);
  const stagedForChat = !isDraft && stagedConfig?.sessionId === sessionId ? stagedConfig : null;
  const sessionPickerConfig = useMemo(
    (): SessionConfigRecord | null =>
      sessionConfig && stagedForChat
        ? {
            ...sessionConfig,
            ...(stagedForChat.modelSelection
              ? { providerId: stagedForChat.modelSelection.provider, modelId: stagedForChat.modelSelection.model }
              : {}),
            ...(stagedForChat.reasoningEffort ? { reasoningEffort: stagedForChat.reasoningEffort } : {}),
          }
        : sessionConfig,
    [sessionConfig, stagedForChat],
  );
  const pickerNote = isDraft
    ? 'A model you pick here becomes the default for new chats.'
    : 'Changes apply when you send your next message.';
  const pickerWarning =
    isDraft && draftModel?.unavailable
      ? `${draftModel.selection.model} isn't available right now (its provider is off or didn't list it). Pick another model, or send anyway to try it.`
      : undefined;
  const pickerConfig = isDraft ? draftPickerConfig : sessionPickerConfig;
  const pickerDisabled = isDraft ? startingChat : commandDisabled;
  const providerId = sessionConfig?.providerId ?? '';
  const chatProvider = settings?.settings.providers.find((provider) => provider.id === providerId);
  const providerLabel = chatProvider?.label ?? (providerId === 'openai' ? 'OpenAI' : providerId);
  const credential = chatProvider?.credential ?? settings?.settings.credentials[providerId];
  const needsProviderSetup = Boolean(credential?.required && !credential.configured && credential.writable);

  const configuredProviderIds = useMemo(() => {
    const ids = new Set<string>();
    if (!settings) return ids;
    for (const p of settings.settings.providers) {
      if (!p.disabled && p.credential.configured) ids.add(p.id);
    }
    for (const [provider, accounts] of Object.entries(settings.settings.oauthAccounts)) {
      if (accounts.length > 0) ids.add(provider);
    }
    return ids;
  }, [settings]);

  const hasAnyConfiguredProvider = useMemo(() => {
    if (!settings) return true; // Avoid flashing warning before settings finish loading.
    return configuredProviderIds.size > 0 || models.length > 0;
  }, [settings, configuredProviderIds.size, models.length]);

  const fallbackConfiguredModel = useMemo(
    () => models.find((m) => configuredProviderIds.has(m.provider)) ?? null,
    [models, configuredProviderIds],
  );

  // If a brand-new empty chat inherits an unconfigured default provider (e.g. OpenAI before any key is added)
  // while the user already configured another provider (Anthropic, Ollama, OpenRouter, custom), switch automatically.
  const autoAlignedSessionRef = useRef<string | null>(null);
  const willAutoAlign = Boolean(
    sessionId &&
      sessionConfig &&
      needsProviderSetup &&
      fallbackConfiguredModel &&
      session.view.turns.length === 0 &&
      autoAlignedSessionRef.current !== sessionId,
  );
  useEffect(() => {
    if (!willAutoAlign || !sessionId || !sessionConfig || !fallbackConfiguredModel || configBusy) {
      return;
    }
    autoAlignedSessionRef.current = sessionId;
    setConfigBusy(true);
    void term2Client
      .updateSessionConfig(sessionId, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: sessionConfig.configRevision,
        admission: 'idle',
        modelSelection: { provider: fallbackConfiguredModel.provider, model: fallbackConfiguredModel.id },
      })
      .then(async (response) => {
        if (response.result.ok && response.result.kind === 'command_finished') {
          const refreshed = await term2Client.readSessionConfig(sessionId);
          setDiscoveredConfig(refreshed);
        }
      })
      .catch(() => undefined)
      .finally(() => setConfigBusy(false));
  }, [willAutoAlign, sessionId, sessionConfig, fallbackConfiguredModel, configBusy]);

  // Send a draft's first message once its new session is loaded and any automatic
  // provider alignment has finished.
  useEffect(() => {
    if (!pendingFirstSend || sessionId !== pendingFirstSend.sessionId) return;
    if (!sessionConfig || willAutoAlign || configBusy) return;
    if (session.view.sessionId !== sessionId || !canSubmitSessionMessage(session.view.status)) return;
    const pending = pendingFirstSend;
    setPendingFirstSend(null);
    void submitMessage(pending.delivery, pending.overrideText);
    // submitMessage reads the current composer state; it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFirstSend, sessionId, sessionConfig, willAutoAlign, configBusy, session.view.sessionId, session.view.status]);

  const lastTurn = session.view.turns[session.view.turns.length - 1];
  const liveStatus = interactionPending
    ? 'Waiting for your approval'
    : lastTurn?.transientStatus
      ? lastTurn.transientStatus
      : lastTurn && (lastTurn.status === 'streaming' || lastTurn.status === 'pending')
        ? (() => {
            const active = [...lastTurn.commands]
              .reverse()
              .find((c) => c.status === 'running' || c.status === 'pending');
            if (active) {
              const { verb, target } = describeCommand(active);
              return `${verb}${target ? ` ${target}` : ''}…`;
            }
            const lastItem = lastTurn.items?.[lastTurn.items.length - 1];
            if (lastItem?.kind === 'reasoning' && lastItem.streaming) return 'Thinking…';
            if (lastItem?.kind === 'text' && lastItem.text) return null;
            return lastTurn.text ? null : lastTurn.reasoning ? 'Thinking…' : 'Working…';
          })()
        : null;

  // Browser tab title badge & optional background notifications.
  const prevStatusRef = useRef(session.view.status);
  useEffect(() => {
    if (interactionPending) {
      document.title = 'Approval needed · term2';
    } else if (hasStreamingTurn) {
      document.title = 'Working… · term2';
    } else {
      document.title = 'term2';
    }
    const prev = prevStatusRef.current;
    prevStatusRef.current = session.view.status;
    if (
      notificationsEnabled &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      document.hidden
    ) {
      if (interactionPending && prev !== 'awaiting_interaction') {
        new Notification('Term2 needs your approval', { body: 'A tool action is waiting for your decision.' });
      } else if (prev === 'running' && session.view.status === 'connected') {
        new Notification('Term2 finished replying', { body: 'Your answer is ready.' });
      }
    }
  }, [interactionPending, hasStreamingTurn, session.view.status, notificationsEnabled]);

  // Global Cmd/Ctrl+K quick palette shortcut. The settings page uses it for its search box.
  useEffect(() => {
    if (settingsOpen) return;
    const onGlobalKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (sessionId) {
          setPaletteOpen((open) => !open);
          setPopoverIndex(0);
          composerRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, [sessionId, settingsOpen]);

  // Smart auto-scroll pinning.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const lastScrollTopRef = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    // A hidden transcript (settings page open) has no box; its scroll events say nothing.
    if (!el || el.clientHeight === 0) return;
    lastScrollTopRef.current = el.scrollTop;
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
    setPinned(true);
  }, [sessionId]);
  // The transcript was display:none while settings was open, which loses its scroll offset.
  useEffect(() => {
    if (settingsOpen) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = pinned ? el.scrollHeight : lastScrollTopRef.current;
    // Only on closing settings; `pinned` is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

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

  // @ file mention detection
  const atMention = useMemo(() => extractAtMention(input, cursorPos), [input, cursorPos]);
  useEffect(() => {
    if (atMention) ensureSessionFiles();
  }, [atMention, ensureSessionFiles]);

  const matchingFiles = useMemo(() => {
    if (!atMention) return [];
    const q = atMention.query.toLowerCase();
    return sessionFiles
      .filter((entry) => !q || entry.path.toLowerCase().includes(q))
      .slice(0, 14);
  }, [atMention, sessionFiles]);

  const insertFileMention = (entry: WorkspaceFileEntry) => {
    if (!atMention) return;
    const suffix = entry.type === 'directory' ? '/' : ' ';
    const inserted = `@${entry.path}${suffix}`;
    const before = input.slice(0, atMention.start);
    const after = input.slice(cursorPos);
    const next = `${before}${inserted}${after}`;
    setInput(next);
    const nextCursor = before.length + inserted.length;
    setCursorPos(nextCursor);
    setPopoverIndex(0);
    window.setTimeout(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  };

  // Slash / Cmd+K Quick Actions Palette
  const slashQuery = !atMention && input.startsWith('/') && !input.includes('\n') && !input.includes(' ')
    ? input.slice(1)
    : null;
  const showQuickPalette = paletteOpen || slashQuery !== null;
  const quickActions: QuickActionItem[] = useMemo(() => {
    const clearPalette = () => {
      setPaletteOpen(false);
      if (slashQuery !== null) setInput('');
    };
    const items: QuickActionItem[] = [
      {
        id: 'new-chat',
        label: 'New chat',
        hint: 'Start a fresh conversation in the selected folder',
        icon: Plus,
        disabled: !session.selectedWorkspaceId || startingChat,
        run: () => {
          clearPalette();
          void createNewChat();
        },
      },
      {
        id: 'compact',
        label: 'Compact context',
        hint: 'Summarize older turns to free up context window',
        icon: Archive,
        disabled: commandDisabled,
        run: () => {
          clearPalette();
          void session.invokeCommand('compact');
        },
      },
      {
        id: 'rewind',
        label: 'Rewind conversation',
        hint: 'Undo back to an earlier message and edit your prompt',
        icon: History,
        disabled: commandDisabled || session.view.turns.length === 0,
        run: () => {
          clearPalette();
          setRewindInitialTurnId(null);
          setDialog('rewind');
        },
      },
      {
        id: 'retry-turn',
        label: 'Retry failed turn',
        hint: 'Regenerate the last failed reply',
        icon: RotateCcw,
        disabled: commandDisabled,
        run: () => {
          clearPalette();
          void session.invokeCommand('retry-turn');
        },
      },
      {
        id: 'settings',
        label: 'Open settings',
        hint: 'Manage AI providers, API keys, models, and preferences',
        icon: Settings,
        disabled: !localControlEnabled,
        run: () => {
          clearPalette();
          openSettings();
        },
      },
      {
        id: 'folder',
        label: 'Choose a folder',
        hint: 'Grant access to a different local project folder',
        icon: Folder,
        disabled: !localControlEnabled,
        run: () => {
          clearPalette();
          setDialog('folder');
        },
      },
      {
        id: 'help',
        label: 'Help & keyboard shortcuts',
        hint: 'Learn how to mention files, paste images, and manage chats',
        icon: CircleHelp,
        run: () => {
          clearPalette();
          setDialog('help');
        },
      },
    ];
    const needle = (slashQuery ?? '').toLowerCase();
    return needle ? items.filter((item) => item.label.toLowerCase().includes(needle) || item.id.includes(needle)) : items;
  }, [commandDisabled, createNewChat, localControlEnabled, session, slashQuery, startingChat]);

  const activeGoal = session.view.nativeState?.goal;
  const activeVerification = session.view.nativeState?.verification;

  const sessionTitle = sessionId
    ? (() => {
        const listed = session.sessions.find((item) => item.id === sessionId)?.title;
        const first = (firstMessages[sessionId] ?? listed)?.trim().split('\n')[0];
        if (!first) return 'New chat';
        return first.length > 80 ? `${first.slice(0, 80)}…` : first;
      })()
    : isDraft
      ? 'New chat'
      : 'Welcome';

  // Edit and Retry: rewind to just before the turn's message, then send `text` as a new turn.
  const resendFromTurn: ResendFromTurn = async (turnId, text) => {
    if (!sessionId) return 'This chat is not open.';
    setRetryError(null);
    let targets: RewindTargetSummary[];
    let messageId = session.view.turns.find((item) => item.turnId === turnId)?.userMessageId;
    try {
      ({ targets } = await term2Client.listRewindTargets(sessionId));
      // Rewind targets name the user message; a turn sent from this page only knows its turn
      // id, so look the message up in the saved history.
      if (!messageId) {
        const { snapshot } = await term2Client.hydrateSession(sessionId);
        const message = snapshot.messages.find((item) => item.role === 'user' && item.turnId === turnId);
        messageId = typeof message?.id === 'string' ? message.id : undefined;
      }
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not load this chat’s history.';
    }
    const target = messageId ? targets.find((item) => item.messageId === messageId) : undefined;
    if (!target) return 'This message can no longer be edited or retried. It may have been compacted away.';
    if ((target.imageCount ?? 0) > 0) return 'Messages with images can’t be edited or retried yet.';
    if (!(await session.rewind(target.targetId, undefined, { forResend: true }))) return 'Could not rewind the chat.';
    if (await submitMessage('auto', text, { textOnly: true })) return null;
    // The chat is already rewound and this turn is gone, so say so at the message box,
    // where the text is kept.
    setInput(text);
    if (!session.submitError) setResendNotice('The chat was rewound, but the message wasn’t sent. Send it again from here.');
    return null;
  };

  const runningTasks = useRunningTasks(session.view);
  const tasksPanelVisible = Boolean(sessionId) && tasksPanelFor === sessionId && runningTasks.shown.length > 0;
  const closeTasksPanel = () => {
    if (sessionId) setTasksPanelDismissed((current) => ({ ...current, [sessionId]: true }));
    setTasksPanelFor(null);
  };
  // Open on its own when a task starts, unless the user closed it in this chat. Not on small
  // screens, where it would cover the chat; the header pill opens it there.
  const hasRunning = runningTasks.runningCount > 0;
  useEffect(() => {
    if (!sessionId || !hasRunning || tasksPanelDismissed[sessionId]) return;
    if (window.innerWidth < 768) return;
    setTasksPanelFor(sessionId);
  }, [sessionId, hasRunning, tasksPanelDismissed]);
  // Once the last card leaves, the panel is closed, not just empty: a later task must not
  // bring it back on a small screen, where only the header pill opens it.
  const anyShown = runningTasks.shown.length > 0;
  useEffect(() => {
    if (!anyShown) setTasksPanelFor(null);
  }, [anyShown]);

  const handleRewind = async (target: RewindTargetSummary, restoreText: boolean) => {
    const ok = await session.rewind(target.targetId);
    if (ok && restoreText && target.text) {
      setInput(target.text);
      window.setTimeout(() => composerRef.current?.focus(), 50);
    }
  };

  return (
    <main className="relative flex h-dvh max-h-dvh overflow-hidden bg-[#f7f7f8] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside
        aria-label="Chat history and folders"
        inert={!sidebarOpen ? true : undefined}
        aria-hidden={!sidebarOpen ? 'true' : undefined}
        className={`${settingsOpen ? 'hidden! ' : ''}fixed inset-y-0 left-0 z-[70] flex w-[17.5rem] flex-col bg-[#f7f7f8] shadow-2xl transition-[transform,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:bg-zinc-950 md:relative md:z-auto md:shadow-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full invisible pointer-events-none md:-ml-[17.5rem]'
        }`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
          <button
            type="button"
            onClick={() => {
              setDraftWorkspaceId(null);
              const url = new URL(window.location.href);
              url.searchParams.delete('agentSession');
              window.history.pushState({}, '', url.toString());
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
            className="text-[15px] hover:opacity-80"
            title="Go to welcome screen"
          >
            <Wordmark />
          </button>
          <div className="flex items-center gap-0.5">
            {session.selectedWorkspaceId && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`New chat in ${selectedWorkspaceInfo.displayName || 'this folder'}`}
                title={`New chat in ${selectedWorkspaceInfo.displayName || 'this folder'}`}
                disabled={startingChat}
                onClick={() => void createNewChat()}
                className="text-muted-foreground"
              >
                <SquarePen strokeWidth={1.75} />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close chat history"
              onClick={() => setSidebarOpen(false)}
              className="text-muted-foreground"
            >
              <PanelLeft strokeWidth={1.75} />
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-1">
          {(loadingSessions || loadingWorkspaces) && (
            <p className="mb-2 px-2.5 text-xs text-muted-foreground">Loading chats…</p>
          )}
          <Term2SessionList
            sessions={session.sessions}
            selected={sessionId}
            selectedWorkspaceId={session.selectedWorkspaceId}
            workspaces={session.workspaces}
            workspaceMetadata={workspaceMetadata}
            firstMessages={firstMessages}
            onSelect={selectSession}
            onCreate={(workspaceId) => {
              session.setSelectedWorkspaceId(workspaceId);
              void createNewChat(workspaceId);
            }}
            onAddFolder={localControlEnabled ? () => setDialog('folder') : undefined}
            onSavedFolderChanged={localControlEnabled ? (change) => void onSavedFolderChanged(change) : undefined}
            allowWrite={effectiveAllowWrite}
            nextCursor={session.sessionCursor}
            onNextPage={() => void loadNextSessions()}
          />
        </div>
      </aside>

      {settingsOpen && activeSettingsSection && (
        <Term2SettingsPage
          section={activeSettingsSection}
          provider={settingsProvider}
          onNavigate={navigateSettings}
          onClose={closeSettings}
          onLoaded={setSettings}
          models={models}
          modelsLoading={loadingModels}
          onModelsChanged={reloadModels}
          displayMode={displayMode}
          onDisplayModeChange={updateDisplayMode}
          notificationsEnabled={notificationsEnabled}
          onNotificationsChange={updateNotifications}
          showDiagnostics={showDiagnostics}
          onShowDiagnosticsChange={updateDiagnostics}
          approvalWaiting={interactionPending}
        />
      )}
      {/* Hidden, not unmounted, while settings is open so the chat keeps its draft and running stream. */}
      <div
        className={`flex min-w-0 flex-1 flex-col md:py-2 md:pr-2 ${sidebarOpen ? '' : 'md:pl-2'} ${settingsOpen ? 'hidden!' : ''}`}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-900 md:rounded-2xl md:border md:border-black/[0.06] md:shadow-[0_1px_3px_rgba(0,0,0,0.04)] md:dark:border-white/[0.06]">
          <ChatHeader
            isStreaming={canAbort && hasStreamingTurn}
            model=""
            onModelChange={() => {}}
            showModelSelector={false}
            title={sessionTitle}
            subtitle={selectedWorkspaceInfo.displayName || undefined}
            subtitleTooltip={selectedWorkspaceInfo.fullPath || undefined}
            onOpenFolder={localControlEnabled ? () => setDialog('folder') : undefined}
            onNewChat={!sidebarOpen && session.selectedWorkspaceId ? () => void createNewChat() : undefined}
            newChatLabel="New chat"
            onOpenHelp={() => setDialog('help')}
            onOpenSettings={() => openSettings()}
            showSettingsButton={localControlEnabled}
            onToggleLeftSidebar={() => setSidebarOpen((open) => !open)}
            showLeftSidebarButton={!sidebarOpen}
            alwaysShowLeftSidebarButton
            leftSidebarToggleLabel="Open chat history"
            showRightSidebarButton={false}
            runningTasks={
              sessionId
                ? {
                    count: runningTasks.runningCount,
                    needsYou: runningTasks.needsYouCount,
                    open: tasksPanelVisible,
                    onClick: () => {
                      if (tasksPanelVisible) closeTasksPanel();
                      else {
                        setTasksPanelDismissed(({ [sessionId]: _removed, ...rest }) => rest);
                        setTasksPanelFor(sessionId);
                      }
                    },
                  }
                : undefined
            }
          />
          <section
            aria-label={sessionId ? 'Conversation' : 'Chat setup'}
            role={sessionId ? 'log' : undefined}
            aria-live={sessionId ? 'polite' : undefined}
            className="relative flex min-h-0 flex-1 flex-col"
          >
            {(sessionId || loadError) && (
              <Term2StatusBanner
                status={session.view.status}
                error={loadError ?? session.view.error}
                onRetry={() => {
                  if (loadError) void reloadControlPlane();
                  else void session.refresh();
                }}
              />
            )}
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className={`flex-1 overflow-y-auto px-4 pt-6 scrollbar-thin sm:px-6 ${sessionId || isDraft ? 'pb-60' : 'pb-12'}`}
            >
              <div className="mx-auto w-full max-w-[46rem] space-y-6">
                {!sessionId && !isDraft && (
                  <div className="t2-enter mx-auto flex max-w-lg flex-col items-center pt-[7vh] text-center">
                    <span aria-hidden className="text-[2rem] leading-none">
                      <Wordmark />
                    </span>
                    <h2 className="mt-5 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                      Work with your files using AI
                    </h2>
                    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                      Ask questions, inspect code, and review every action before it runs.
                    </p>

                    <div className="mt-7 w-full space-y-3 text-left">
                      {localControlEnabled && (
                        <div className="flex items-start justify-between gap-3 rounded-2xl border border-black/[0.08] bg-zinc-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]">
                          <div className="flex items-start gap-3">
                            <span
                              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                                hasAnyConfiguredProvider
                                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                              }`}
                            >
                              {hasAnyConfiguredProvider ? <CheckCircle2 className="h-4 w-4" /> : '1'}
                            </span>
                            <div>
                              <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                {hasAnyConfiguredProvider ? 'AI provider connected' : 'Connect an AI provider'}
                              </h3>
                              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                {hasAnyConfiguredProvider
                                  ? 'You can switch models or add more providers anytime in Settings.'
                                  : 'Add an API key (OpenAI, Anthropic, Gemini, OpenRouter), sign in with OAuth, or connect a local server.'}
                              </p>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant={hasAnyConfiguredProvider ? 'outline' : 'default'}
                            onClick={() => openSettings()}
                          >
                            {hasAnyConfiguredProvider ? 'Manage' : 'Connect'}
                          </Button>
                        </div>
                      )}

                      <div className="rounded-2xl border border-black/[0.08] bg-zinc-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <span
                              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                                session.selectedWorkspaceId
                                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                              }`}
                            >
                              {session.selectedWorkspaceId ? <CheckCircle2 className="h-4 w-4" /> : '2'}
                            </span>
                            <div>
                              <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                {session.selectedWorkspaceId
                                  ? `Folder ready: ${selectedWorkspaceInfo.displayName}`
                                  : 'Choose a folder to work in'}
                              </h3>
                              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                {session.selectedWorkspaceId
                                  ? `${selectedWorkspaceInfo.access === 'read_write' ? 'Read & write access' : 'Read-only access'} · only files inside this folder are visible to Term2.`
                                  : 'Pick a local folder so Term2 can read and answer questions about your files.'}
                              </p>
                            </div>
                          </div>
                          {localControlEnabled && (
                            <Button
                              type="button"
                              size="sm"
                              variant={!session.selectedWorkspaceId && hasAnyConfiguredProvider ? 'default' : 'outline'}
                              onClick={() => setDialog('folder')}
                            >
                              {session.selectedWorkspaceId ? 'Change' : 'Browse'}
                            </Button>
                          )}
                        </div>

                        {session.workspaces.length > 0 && (
                          <div className="mt-3 pl-9">
                            <label className="sr-only" htmlFor="landing-workspace">
                              Saved folders
                            </label>
                            <Select
                              value={session.selectedWorkspaceId ?? NO_WORKSPACE}
                              onValueChange={(value) => chooseWorkspace(value === NO_WORKSPACE ? '' : value)}
                            >
                              <SelectTrigger id="landing-workspace" size="sm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent position="popper">
                                <SelectItem value={NO_WORKSPACE}>Choose a saved folder…</SelectItem>
                                {session.workspaces.map((workspace) => (
                                  <SelectItem value={workspace.workspaceId} key={workspace.workspaceId}>
                                    {workspace.label} ({workspace.access === 'read_write' ? 'read & write' : 'read only'})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                    </div>

                    {loadingWorkspaces ? (
                      <p role="status" className="mt-5 text-sm text-zinc-500">
                        Loading folders…
                      </p>
                    ) : (
                      session.selectedWorkspaceId && (
                        <Button
                          type="button"
                          size="lg"
                          disabled={startingChat}
                          onClick={() => void createNewChat()}
                          className="mt-6"
                        >
                          <Plus aria-hidden />
                          {startingChat ? 'Starting chat…' : 'Start a new chat'}
                        </Button>
                      )
                    )}
                    {!loadingWorkspaces && !localControlEnabled && session.workspaces.length === 0 && !loadError && (
                      <p className="mt-4 text-sm text-zinc-500">
                        No folders are available yet. Ask the person who set up Term2 to add one.
                      </p>
                    )}
                  </div>
                )}

                {sessionId && activeGoal && (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-teal-500/25 bg-teal-500/[0.06] px-4 py-3 text-xs dark:border-teal-400/20 dark:bg-teal-500/10">
                    <Target className="mt-0.5 h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-teal-950 dark:text-teal-100">
                        Active goal{typeof activeGoal.status === 'string' ? ` · ${activeGoal.status}` : ''}
                      </p>
                      <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">
                        {typeof activeGoal.outcome === 'string'
                          ? activeGoal.outcome
                          : typeof activeGoal.text === 'string'
                            ? activeGoal.text
                            : JSON.stringify(activeGoal)}
                      </p>
                      {activeVerification && (
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          Verification: {String(activeVerification.status ?? 'recorded')}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {sessionId && needsProviderSetup && !willAutoAlign && !configBusy && (
                  <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-100">
                    <h2 className="font-semibold">Connect {providerLabel} to get replies</h2>
                    <p className="mt-1 text-sm">
                      This chat is using {providerLabel}. Paste an API key in Settings, or switch to another configured
                      model using the model picker below.
                    </p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {fallbackConfiguredModel && (
                        <Button
                          type="button"
                          onClick={() =>
                            void handleUpdateSessionConfig({
                              modelSelection: {
                                provider: fallbackConfiguredModel.provider,
                                model: fallbackConfiguredModel.id,
                              },
                            })
                          }
                          size="sm"
                        >
                          Switch to {fallbackConfiguredModel.name ?? fallbackConfiguredModel.id}
                        </Button>
                      )}
                      <Button
                        type="button"
                        onClick={() => openSettings('providers', providerId || null)}
                        variant="outline" size="sm"
                      >
                        Open provider settings
                      </Button>
                    </div>
                  </div>
                )}

                {((sessionId && session.view.turns.length === 0 && (!needsProviderSetup || willAutoAlign || configBusy)) ||
                  isDraft) && (
                  <div className="rounded-2xl border border-black/[0.06] bg-zinc-50/70 p-5 dark:border-white/[0.07] dark:bg-white/[0.02]">
                    <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                      What would you like help with in {selectedWorkspaceInfo.displayName || 'this folder'}?
                    </h2>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Click a suggestion to try it, type <code className="font-mono">@</code> to mention a file, or
                      paste an image.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {STARTER_PROMPTS.map((prompt) => (
                        <Button
                          key={prompt}
                          type="button"
                          disabled={composerDisabled}
                          onClick={() => void submitMessage('auto', prompt)}
                          variant="outline" size="sm" className="rounded-full"
                        >
                          {prompt}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {session.view.turns.map((turn, turnIndex) => (
                  <article key={turn.turnId} className="t2-enter group space-y-5">
                    {turn.userText !== undefined && (
                      <Term2UserMessage
                        turnId={turn.turnId}
                        text={turn.userText}
                        copied={copiedTurn === `${turn.turnId}:user`}
                        onCopy={() => copyTurn(`${turn.turnId}:user`, turn.userText ?? '')}
                        disabled={commandDisabled}
                        laterTurns={session.view.turns.length - 1 - turnIndex}
                        onResend={resendFromTurn}
                      />
                    )}
                    <div className="min-w-0 space-y-4">
                      <Term2TurnTimeline turn={turn} displayMode={displayMode} />
                      {(turn.subagents ?? []).length > 0 && (
                        <div className="space-y-2">
                          {(turn.subagents ?? [])
                            .filter(
                              (card) =>
                                !session.view.nativeState?.tasks?.some(
                                  (task) => task.id === card.agentId || task.agentId === card.agentId,
                                ),
                            )
                            .map((card) => (
                              <Term2SubagentCard key={card.agentId} card={card} />
                            ))}
                        </div>
                      )}
                      {turn.status !== 'completed' && turn.status !== 'streaming' && turn.status !== 'pending' && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-2.5 py-0.5 text-xs text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
                            {turn.transientFailure
                              ? 'Live connection error (reload to check saved state)'
                              : turn.status === 'aborted'
                                ? 'Stopped'
                                : `Turn ${turn.status}`}
                          </span>
                          {(turn.status === 'failed' || turn.status === 'aborted') && !turn.error && !commandDisabled && (
                            <Button
                              type="button"
                              onClick={() => void session.invokeCommand('retry-turn')}
                              variant="outline" size="xs" className="rounded-full"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Retry turn
                            </Button>
                          )}
                        </div>
                      )}
                      {turn.error && (
                        <div className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                          <p className="flex min-w-0 flex-1 items-start gap-2">
                            <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>
                              {turn.error === 'provider_error' || turn.error === 'runtime_error'
                                ? 'The AI service could not reply. Check your provider settings or click Retry to try again.'
                                : turn.error}
                            </span>
                          </p>
                          <div className="flex shrink-0 items-center gap-2">
                            {!commandDisabled && (
                              <Button
                                type="button"
                                onClick={() => void session.invokeCommand('retry-turn')}
                                variant="destructive" size="xs"
                              >
                                Retry
                              </Button>
                            )}
                            {localControlEnabled && (
                              <Button
                                type="button"
                                onClick={() => openSettings('providers', providerId || null)}
                                variant="outline" size="xs"
                              >
                                Settings
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                      {turn.text && turn.status !== 'streaming' && (
                        <div className="-ml-1.5 flex items-center gap-1 text-zinc-400 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                          <Button
                            type="button"
                            aria-label="Copy reply"
                            title="Copy reply"
                            variant="ghost" size="icon-xs" className="text-muted-foreground"
                            onClick={() => copyTurn(turn.turnId, turn.text)}
                          >
                            {copiedTurn === turn.turnId ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          {turn.userText ? (
                            <Term2RetryReply
                              turnId={turn.turnId}
                              userText={turn.userText}
                              disabled={commandDisabled}
                              laterTurns={session.view.turns.length - 1 - turnIndex}
                              onResend={resendFromTurn}
                              onError={(message) => setRetryError({ turnId: turn.turnId, message })}
                            />
                          ) : null}
                          {turn.usage?.totalTokens ? (
                            <span className="text-xs tabular-nums">
                              {turn.usage.totalTokens.toLocaleString()} tokens
                            </span>
                          ) : null}
                        </div>
                      )}
                      {retryError?.turnId === turn.turnId && (
                        <p role="alert" className="text-xs text-destructive">
                          {retryError.message}
                        </p>
                      )}
                    </div>
                  </article>
                ))}

                {liveStatus && (
                  <p role="status" className="flex items-center gap-2.5 text-sm">
                    <span aria-hidden className="relative flex h-2 w-2">
                      <span
                        className={`absolute inset-0 animate-ping rounded-full ${
                          interactionPending ? 'bg-amber-400/70' : 'bg-teal-400/70'
                        }`}
                      />
                      <span
                        className={`relative h-2 w-2 rounded-full ${
                          interactionPending ? 'bg-amber-500' : 'bg-teal-500'
                        }`}
                      />
                    </span>
                    <span className="t2-shimmer truncate">{liveStatus}</span>
                  </p>
                )}

                {session.view.pendingInteraction?.state === 'pending' && (
                  <div id="term2-pending-interaction" className="scroll-mt-4">
                  <Term2InteractionPanel
                    key={`${session.view.pendingInteraction.interaction.interactionId}:${
                      session.view.pendingInteraction.interaction.revision
                    }:${session.view.pendingInteraction.interaction.askUser?.currentQuestionIndex ?? 0}`}
                    interaction={session.view.pendingInteraction.interaction}
                    subagent={session.view.pendingInteraction.subagent}
                    shellSandboxNotice={shellSandboxMachineFact(settings?.shellSandboxNotice) ?? undefined}
                    onResolve={session.resolveInteraction}
                    disabled={aborting}
                  />
                  </div>
                )}
                {session.view.pendingInteraction?.state === 'recovered' && (
                  <Term2InteractionPanel
                    key={`${session.view.pendingInteraction.interaction.interactionId}:${session.view.pendingInteraction.interaction.revision}:recovered`}
                    interaction={session.view.pendingInteraction.interaction}
                    recovered
                    onResolve={session.resolveInteraction}
                  />
                )}


                {showDiagnostics && sessionId && (session.view.turns.length > 0 || Boolean(session.view.error)) && (
                  <details className="pt-2 text-xs text-zinc-400 dark:text-zinc-500">
                    <summary className="cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300">
                      Diagnostics &amp; raw session state
                    </summary>
                    <div className="mt-2 space-y-2 text-zinc-600 dark:text-zinc-400">
                      {localControlEnabled && (
                        <Term2SessionConfig
                          key={sessionId}
                          config={sessionConfig}
                          onDiscovered={setDiscoveredConfig}
                          settings={settings}
                          sessionId={sessionId}
                          onCreateNewSession={() => void createNewChat()}
                        />
                      )}
                      <Term2NativeEvidence view={session.view} />
                    </div>
                  </details>
                )}
              </div>
            </div>

            {(sessionId || isDraft) && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 overflow-visible bg-gradient-to-t from-white from-65% to-transparent px-3 pb-3 pt-10 dark:from-zinc-900 sm:px-6 sm:pb-4">
                {!pinned && (
                  <div className="mb-2 flex justify-center">
                    <Button
                      type="button"
                      aria-label="Jump to latest"
                      variant="outline" size="icon" className="t2-enter pointer-events-auto rounded-full shadow-md"
                      onClick={scrollToLatest}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                <Term2QueueBar view={session.view} onManageQueue={session.manageQueue} />

                {(session.submitError || configError || attachmentError || resendNotice) && (
                  <div
                    role="alert"
                    className="pointer-events-auto mx-auto mb-2 flex max-w-[46rem] items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/60 dark:text-red-300"
                  >
                    <span className="flex items-center gap-1.5">
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                      {session.submitError ?? configError ?? attachmentError ?? resendNotice}
                    </span>
                    <button
                      type="button"
                      aria-label="Dismiss error"
                      onClick={() => {
                        session.clearSubmitError();
                        setConfigError(null);
                        setAttachmentError(null);
                      }}
                      className="rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                <div
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDraggingFile(true);
                  }}
                  onDragLeave={() => setDraggingFile(false)}
                  onDrop={handleDrop}
                  className={`pointer-events-auto relative mx-auto max-w-[46rem] overflow-visible rounded-3xl border bg-white shadow-[0_2px_6px_rgba(0,0,0,0.03),0_12px_32px_-12px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] focus-within:border-black/[0.16] focus-within:shadow-[0_2px_6px_rgba(0,0,0,0.04),0_16px_40px_-12px_rgba(0,0,0,0.18)] dark:bg-zinc-800/80 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)] dark:focus-within:border-white/[0.18] ${
                    draggingFile
                      ? 'border-teal-500 ring-2 ring-teal-500/20'
                      : 'border-black/[0.08] dark:border-white/[0.09]'
                  }`}
                >
                  {atMention && (
                    <Term2PathPopover
                      entries={matchingFiles}
                      query={atMention.query}
                      loading={loadingFiles}
                      activeIndex={Math.min(popoverIndex, Math.max(0, matchingFiles.length - 1))}
                      onSelect={insertFileMention}
                    />
                  )}
                  {!atMention && showQuickPalette && (
                    <Term2QuickPalette
                      actions={quickActions}
                      activeIndex={Math.min(popoverIndex, Math.max(0, quickActions.length - 1))}
                      query={slashQuery ?? ''}
                    />
                  )}

                  {(armedSkill || attachments.length > 0) && (
                    <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                      {armedSkill && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-500/12 px-2.5 py-1 text-xs font-medium text-teal-800 dark:bg-teal-500/20 dark:text-teal-200">
                          <Wand2 className="h-3 w-3" />
                          Skill: {armedSkill}
                          <button
                            type="button"
                            aria-label="Remove skill"
                            onClick={() => setArmedSkill(null)}
                            className="rounded-full p-0.5 hover:bg-teal-500/20"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      )}
                      {attachments.map((img) => (
                        <div
                          key={img.id}
                          className="relative flex items-center gap-1.5 rounded-xl border border-black/[0.08] bg-zinc-50 p-1 pr-2 dark:border-white/10 dark:bg-zinc-900"
                        >
                          <img
                            src={img.previewUrl}
                            alt={img.name}
                            className="h-9 w-9 rounded-lg object-cover"
                          />
                          <span className="max-w-[7rem] truncate text-xs text-zinc-600 dark:text-zinc-300">
                            {img.name}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${img.name}`}
                            onClick={() => setAttachments((cur) => cur.filter((a) => a.id !== img.id))}
                            className="rounded-full p-0.5 text-zinc-400 hover:bg-black/[0.06] hover:text-zinc-800 dark:hover:bg-white/10"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <textarea
                    ref={composerRef}
                    rows={1}
                    aria-label="Message"
                    value={input}
                    onPaste={handlePaste}
                    onChange={(event) => {
                      setInput(event.target.value);
                      setCursorPos(event.target.selectionStart ?? event.target.value.length);
                      setPopoverIndex(0);
                      setHistoryIndex(null);
                      if (session.submitError) session.clearSubmitError();
                      setResendNotice(null);
                    }}
                    onClick={(event) => setCursorPos(event.currentTarget.selectionStart ?? input.length)}
                    onKeyUp={(event) => setCursorPos(event.currentTarget.selectionStart ?? input.length)}
                    onKeyDown={(event) => {
                      if (atMention && matchingFiles.length > 0) {
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setPopoverIndex((i) => (i + 1) % matchingFiles.length);
                          return;
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setPopoverIndex((i) => (i - 1 + matchingFiles.length) % matchingFiles.length);
                          return;
                        }
                        if (event.key === 'Enter' || event.key === 'Tab') {
                          event.preventDefault();
                          insertFileMention(matchingFiles[Math.min(popoverIndex, matchingFiles.length - 1)]);
                          return;
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setInput((cur) => `${cur.slice(0, atMention.start)}${cur.slice(cursorPos)}`);
                          return;
                        }
                      }
                      if (showQuickPalette) {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setPaletteOpen(false);
                          if (slashQuery !== null) setInput('');
                          return;
                        }
                        if (quickActions.length > 0) {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setPopoverIndex((i) => (i + 1) % quickActions.length);
                            return;
                          }
                          if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setPopoverIndex((i) => (i - 1 + quickActions.length) % quickActions.length);
                            return;
                          }
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            const chosen = quickActions[Math.min(popoverIndex, quickActions.length - 1)];
                            if (chosen && !chosen.disabled) chosen.run();
                            return;
                          }
                        }
                      }
                      if (
                        event.key === 'ArrowUp' &&
                        !event.shiftKey &&
                        !input.includes('\n') &&
                        (event.currentTarget.selectionStart ?? 0) === 0 &&
                        promptHistory.length > 0
                      ) {
                        event.preventDefault();
                        const nextIdx =
                          historyIndex === null ? promptHistory.length - 1 : Math.max(0, historyIndex - 1);
                        if (historyIndex === null) savedDraftRef.current = input;
                        setHistoryIndex(nextIdx);
                        setInput(promptHistory[nextIdx]);
                        return;
                      }
                      if (event.key === 'ArrowDown' && historyIndex !== null && !input.includes('\n')) {
                        event.preventDefault();
                        if (historyIndex >= promptHistory.length - 1) {
                          setHistoryIndex(null);
                          setInput(savedDraftRef.current);
                        } else {
                          const nextIdx = historyIndex + 1;
                          setHistoryIndex(nextIdx);
                          setInput(promptHistory[nextIdx]);
                        }
                        return;
                      }
                      if (event.key === 'Enter' && event.altKey && !event.nativeEvent.isComposing && hasStreamingTurn) {
                        event.preventDefault();
                        void submitMessage('follow_up');
                        return;
                      }
                      // Enter confirms an IME candidate; it must not send.
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void submitMessage();
                      }
                    }}
                    disabled={composerDisabled}
                    className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-base leading-6 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed dark:placeholder:text-zinc-500"
                    placeholder={
                      interactionPending
                        ? 'Respond to the approval prompt above to continue…'
                        : hasStreamingTurn
                          ? 'Steer (Enter) or queue follow-up (Alt+Enter)…'
                          : 'Ask about your files… (@ files, / actions)'
                    }
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      if (event.target.files) void addImageFiles(event.target.files);
                      event.target.value = '';
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <Popover
                      open={skillsOpen}
                      onOpenChange={(open) => {
                        if (open) openSkillsMenu();
                        else setSkillsOpen(false);
                      }}
                    >
                      <PopoverAnchor asChild>
                        <div className="min-w-0">
                          <Term2CommandMenu
                            composerDisabled={composerDisabled}
                            commandsDisabled={commandDisabled}
                            pending={session.commandPending}
                            notice={session.commandNotice}
                            onAttachImage={() => fileInputRef.current?.click()}
                            onMentionFile={() => {
                              const prefix = input && !input.endsWith(' ') ? `${input} @` : `${input}@`;
                              setInput(prefix);
                              setCursorPos(prefix.length);
                              ensureSessionFiles();
                              composerRef.current?.focus();
                            }}
                            onUseSkill={openSkillsMenu}
                            onCommand={(commandId) => void session.invokeCommand(commandId)}
                          />
                        </div>
                      </PopoverAnchor>
                      <PopoverContent
                        side="top"
                        align="start"
                        aria-label="Choose a skill"
                        className="max-h-72 w-[min(22rem,calc(100vw-2rem))] gap-0 overflow-y-auto p-1 scrollbar-thin"
                        onCloseAutoFocus={(event) => {
                          // Picking a skill hands focus to the composer rather than back to the trigger.
                          if (!skillPickedRef.current) return;
                          skillPickedRef.current = false;
                          event.preventDefault();
                          composerRef.current?.focus();
                        }}
                      >
                        <Term2SkillsPopover
                          skills={skills}
                          loading={loadingSkills}
                          selectedSkill={armedSkill}
                          onSelect={(skill) => {
                            setArmedSkill(skill ? skill.name : null);
                            skillPickedRef.current = true;
                            setSkillsOpen(false);
                            composerRef.current?.focus();
                          }}
                        />
                      </PopoverContent>
                    </Popover>

                    {pickerConfig && (
                      <>
                        <Term2ModelPicker
                          config={pickerConfig}
                          models={models}
                          loadingModels={loadingModels}
                          settings={settings}
                          disabled={pickerDisabled}
                          busy={configBusy}
                          onSelectModel={(provider, model) =>
                            void handleUpdateSessionConfig({ modelSelection: { provider, model } })
                          }
                          onSelectEffort={(reasoningEffort) => void handleUpdateSessionConfig({ reasoningEffort })}
                          onToggleFavorite={settings ? (key) => void handleToggleFavorite(key) : undefined}
                          onRefreshModels={() => void reloadModels()}
                          onOpenSettings={() => openSettings()}
                          pending={Boolean(stagedForChat)}
                          note={pickerNote}
                          warning={pickerWarning}
                        />
                        <Term2ApprovalPicker
                          mode={pickerConfig.approvalMode ?? 'off'}
                          disabled={pickerDisabled}
                          busy={configBusy}
                          onSelect={(approvalMode) => void handleUpdateSessionConfig({ approvalMode })}
                        />
                      </>
                    )}

                    <div className="ml-auto flex items-center gap-1.5">
                      <Term2UsagePopover
                        view={session.view}
                        config={sessionConfig}
                        models={models}
                        canCompact={!commandDisabled}
                        onCompact={() => void session.invokeCommand('compact')}
                      />

                      {canAbort && hasStreamingTurn && (input.trim() || attachments.length > 0) && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => void submitMessage('follow_up')}
                            title="Queue message for after this turn (Alt+Enter)"
                            className="rounded-full"
                          >
                            Queue
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            onClick={() => void submitMessage('steer')}
                            title="Steer the active turn immediately (Enter)"
                            className="rounded-full"
                          >
                            Steer
                          </Button>
                        </>
                      )}

                      {canAbort && hasStreamingTurn ? (
                        <Button
                          type="button"
                          size="icon"
                          aria-label="Stop agent turn"
                          title="Stop"
                          className="rounded-full"
                          onClick={() => void session.abort()}
                        >
                          <Square className="size-3 fill-current" />
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="icon"
                          aria-label="Send message"
                          title="Send (Enter) · new line (Shift+Enter)"
                          className="rounded-full"
                          disabled={composerDisabled || (!input.trim() && attachments.length === 0)}
                          onClick={() => void submitMessage()}
                        >
                          <ArrowUp strokeWidth={2.25} />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {tasksPanelVisible && !settingsOpen && (
        <>
          <button
            type="button"
            aria-label="Close running tasks"
            className="fixed inset-0 z-[60] bg-black/30 md:hidden"
            onClick={closeTasksPanel}
          />
          <aside
            aria-label="Running tasks"
            className="fixed inset-y-0 right-0 z-[70] w-[19rem] max-w-[85vw] bg-[#f7f7f8] shadow-2xl dark:bg-zinc-950 md:relative md:z-auto md:shadow-none"
          >
            <Term2RunningTasksPanel
              view={session.view}
              shown={runningTasks.shown}
              onControlTask={session.controlTask}
              onClose={closeTasksPanel}
              onGoToQuestion={() =>
                document.getElementById('term2-pending-interaction')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            />
          </aside>
        </>
      )}
      {dialog === 'folder' && (
        <Term2SetupDialog title="Choose a folder" wide onClose={() => setDialog(null)}>
          <Term2FolderSelector
            homeFolder={homeFolder}
            allowWrite={effectiveAllowWrite}
            savedWorkspaces={session.workspaces}
            selectedWorkspaceId={session.selectedWorkspaceId}
            onSelectExisting={(workspaceId) => {
              setDialog(null);
              void createNewChat(workspaceId);
            }}
            onSelected={onFolderSelected}
            onSavedFolderChanged={(change) => void onSavedFolderChanged(change)}
          />
        </Term2SetupDialog>
      )}
      {sidebarOpen && !settingsOpen && (
        <button
          type="button"
          aria-label="Dismiss chat history"
          className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-[2px] md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {dialog === 'help' && (
        <Term2SetupDialog title="Help & shortcuts" onClose={() => setDialog(null)}>
          <Term2HelpDialog allowWrite={effectiveAllowWrite} />
        </Term2SetupDialog>
      )}
      {dialog === 'rewind' && sessionId && (
        <Term2SetupDialog title="Rewind conversation" onClose={() => setDialog(null)}>
          <Term2RewindDialog
            sessionId={sessionId}
            initialTurnId={rewindInitialTurnId}
            onRewind={handleRewind}
            onClose={() => setDialog(null)}
          />
        </Term2SetupDialog>
      )}
    </main>
  );
}
