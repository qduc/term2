'use client';

import {
  currentTag,
  initialShellState,
  isCurrentTag,
  step,
  type Composer,
  type ComposerImage,
  type DraftConfig,
  type NoticeKey,
  type ShellAction,
  type ShellCommand,
  type ShellState,
  type StagedConfig,
  type Tag,
} from '../../lib/term2/shell-machine';
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
import { startAnimationHeartbeat } from '../../lib/term2/animationHeartbeat';
import { readyForBackgroundDrain, undeliveredBackgroundNoticeIds } from '../../lib/term2/queue';
import { shellSandboxMachineFact } from '../../lib/term2/shell-sandbox-notice';
import { Term2InteractionPanel } from './Term2InteractionPanel';
import { Term2TurnTimeline, type Term2DisplayMode } from './Term2TurnTimeline';
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
import { Term2ProviderSetup } from './Term2ProviderSetup';
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
import { Term2PathPopover, Term2QuickPalette, Term2SkillsPopover, type QuickActionItem } from './Term2ComposerPopovers';
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
/** Wait briefly before re-showing "Working…" after a tool call finishes so rapid tool-to-tool transitions don't flash. */

const STARTER_PROMPTS = [
  'What files are in this folder?',
  'Summarize how this project is organized',
  'Find any TODOs or potential issues here',
];

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

function fileToDraftImage(file: File): Promise<ComposerImage> {
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

/** No picks yet: a stable empty value, so a draft without picks does not re-render on every pass. */
const NO_DRAFT_CONFIG: DraftConfig = {};

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
  // Selection, draft and first-send policy (lib/term2/shell-machine.ts). The address bar owns the open chat.
  // It starts with no chat open: the first URL_CHANGED below opens the address bar's chat like any later change,
  // so the open chat always gets its config loaded.
  const [shell, setShell] = useState<ShellState>(() => initialShellState(null));
  const shellRef = useRef(shell);
  const runShellCommandRef = useRef<(command: ShellCommand) => void>(() => undefined);
  const dispatchShell = useCallback((action: ShellAction) => {
    const { state, commands } = step(shellRef.current, action);
    shellRef.current = state;
    setShell(state);
    for (const command of commands) runShellCommandRef.current(command);
  }, []);
  useEffect(() => {
    dispatchShell({ type: 'URL_CHANGED', sessionId: initialSessionId });
  }, [initialSessionId, dispatchShell]);
  const sessionId = shell.openChat;

  // The message box and its notices live in the machine: a chat change resets them in one transition, and a late
  // result (a send's outcome, a restored prompt, an image read) carries a tag and is dropped once stale.
  const { input, attachments, armedSkill, historyIndex, paletteOpen } = shell.composer;
  const editComposer = useCallback(
    (patch: Partial<Composer>) => dispatchShell({ type: 'COMPOSER_EDITED', patch }),
    [dispatchShell],
  );
  const setInput = useCallback(
    (next: string | ((current: string) => string)) =>
      editComposer({ input: typeof next === 'function' ? next(shellRef.current.composer.input) : next }),
    [editComposer],
  );
  const setArmedSkill = (armed: string | null) => editComposer({ armedSkill: armed });
  const setHistoryIndex = (index: number | null) => editComposer({ historyIndex: index });
  const setPaletteOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) =>
      editComposer({ paletteOpen: typeof next === 'function' ? next(shellRef.current.composer.paletteOpen) : next }),
    [editComposer],
  );
  /** Sets a notice for what the page shows now; `tag` names an earlier screen for a result that arrives late. */
  const setNotice = (key: NoticeKey, message: string | null, tag: Tag = currentTag(shellRef.current)) =>
    dispatchShell({ type: 'NOTICE', tag, key, message });
  const { attachment: attachmentError, config: configError, resend: resendNotice } = shell.notices;
  const setAttachmentError = (message: string | null) => setNotice('attachment', message);
  const setConfigError = (message: string | null) => setNotice('config', message);
  const [draggingFile, setDraggingFile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dialog, setDialog] = useState<'folder' | 'help' | 'rewind' | 'provider' | null>(null);
  const [rewindInitialTurnId, setRewindInitialTurnId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ turnId: string; message: string } | null>(null);
  const [retryDraft, setRetryDraft] = useState<{ sessionId: string; turnId: string; model: ModelSummary } | null>(null);
  // The running tasks panel: which chat it is open for, and chats where the user closed it.
  /** Only the user opens or closes the running tasks panel; nothing toggles it on its own. */
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  const startingChat = shell.starting;
  // "New chat" opens a draft: a folder and a composer, but no gateway session
  // until the first message is sent, so clicking around leaves no empty chats.
  const draftWorkspaceId = shell.draft?.workspaceId ?? null;
  const draftConfig = shell.draft?.config ?? NO_DRAFT_CONFIG;
  const pendingFirstSend = shell.pendingFirstSend;
  const isDraft = !sessionId && draftWorkspaceId !== null;
  // Model and effort picked in an existing chat wait here until the next message is sent;
  // leaving the chat discards them, so browsing never changes a conversation's model.
  const stagedConfig = shell.staged && sessionId ? { sessionId, ...shell.staged } : null;
  const setStagedConfig = (staged: StagedConfig | null) => dispatchShell({ type: 'STAGED_CHANGED', staged });
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const discoveredConfig = shell.config;
  /** A config read for the chat that is open now; dropped if the user has moved on (it carries its tag). */
  const configLoaded = useCallback(
    (tag: Tag, config: SessionConfigRecord) => dispatchShell({ type: 'CONFIG_LOADED', tag, config }),
    [dispatchShell],
  );
  const [configBusy, setConfigBusy] = useState(false);
  const [settings, setSettings] = useState<SettingsProjection | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsChecked, setModelsChecked] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<WorkspaceFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesLoadedFor, setFilesLoadedFor] = useState<string | null>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [popoverIndex, setPopoverIndex] = useState(0);
  const [displayMode, setDisplayMode] = useState<Term2DisplayMode>('concise');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
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
  const { refreshWorkspaces, refreshSessions, loadNextSessions } = session;
  // The folder in use, derived: an open chat's own folder; otherwise the user's choice, else the first saved one.
  const openChatFolder = sessionId ? session.sessions.find((item) => item.id === sessionId)?.workspaceId ?? null : null;
  const selectedWorkspaceId = sessionId
    ? openChatFolder ?? shell.chosenFolder
    : shell.chosenFolder ?? session.workspaces[0]?.workspaceId ?? null;
  const setSelectedWorkspaceId = useCallback(
    (workspaceId: string | null) => dispatchShell({ type: 'FOLDER_CHOSEN', workspaceId }),
    [dispatchShell],
  );
  const currentFileScope = sessionId
    ? `session:${sessionId}`
    : selectedWorkspaceId
    ? `workspace:${selectedWorkspaceId}`
    : null;
  const fileScopeRef = useRef(currentFileScope);
  fileScopeRef.current = currentFileScope;
  const fileLoadRequestRef = useRef(0);
  const prevUserIdRef = useRef(authUserId ?? null);

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
    () => getWorkspaceInfo(selectedWorkspaceId),
    [getWorkspaceInfo, selectedWorkspaceId],
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
      const url = new URL(window.location.href);
      if (url.searchParams.has('agentSession')) {
        url.searchParams.delete('agentSession');
        window.history.replaceState(null, '', url.toString());
      }
      dispatchShell({ type: 'URL_CHANGED', sessionId: null });
      // Another user: no draft and an empty message box either.
      dispatchShell({ type: 'DRAFT_DISCARDED' });
    }
  }, [authUserId, dispatchShell]);

  const reloadModels = useCallback(async () => {
    if (!localControlEnabled) return;
    setLoadingModels(true);
    try {
      const res = await term2Client.listModels();
      setModels(res.models);
      setModelsChecked(true);
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

  const reloadSetupSettings = useCallback(async () => {
    try {
      const projection = await term2Client.readSettings();
      setSettings(projection);
      return projection;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!localControlEnabled) return;
    void reloadSetupSettings();
    void reloadModels();
  }, [localControlEnabled, reloadSetupSettings, reloadModels]);


  const ensureSessionFiles = useCallback(() => {
    const workspaceId = selectedWorkspaceId;
    const fileScope = currentFileScope;
    if (!fileScope || loadingFiles || filesLoadedFor === fileScope) return;
    const requestId = ++fileLoadRequestRef.current;
    setLoadingFiles(true);
    const request = sessionId
      ? term2Client.listSessionFiles(sessionId)
      : term2Client.listWorkspaceFiles(workspaceId!);
    void request
      .then((res) => {
        if (fileScopeRef.current !== fileScope || fileLoadRequestRef.current !== requestId) return;
        setSessionFiles(res.entries);
        setFilesLoadedFor(fileScope);
      })
      .catch(() => undefined)
      .finally(() => {
        if (fileLoadRequestRef.current === requestId) setLoadingFiles(false);
      });
  }, [currentFileScope, sessionId, selectedWorkspaceId, loadingFiles, filesLoadedFor]);

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

  const chooseWorkspace = (workspaceId: string) => setSelectedWorkspaceId(workspaceId || null);

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
      const targetWorkspace = workspaceOverride ?? selectedWorkspaceId;
      if (!targetWorkspace || startingChat) return;
      setLoadError(null);
      dispatchShell({ type: 'NEW_DRAFT', workspaceId: targetWorkspace });
      if (window.innerWidth < 768) setSidebarOpen(false);
      window.setTimeout(() => composerRef.current?.focus(), 50);
    },
    [dispatchShell, selectedWorkspaceId, startingChat],
  );

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
      ? openChatFolder ?? selectedWorkspaceId
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
    if (change.kind === 'removed' && shellRef.current.chosenFolder === workspaceId) setSelectedWorkspaceId(null);
  };

  const selectSession = (id: string) => {
    const selected = session.sessions.find((item) => item.id === id);
    if (selected) setSelectedWorkspaceId(selected.workspaceId);
    session.selectSession(id);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  /** Applies a change to the open chat now. Returns whether it took effect. */
  const applySessionConfig = async (
    selection: Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'mode' | 'approvalMode'>,
    tag: Tag = currentTag(shellRef.current),
  ): Promise<boolean> => {
    if (!sessionId || !discoveredConfig || configBusy) return false;
    // Results apply only while this chat is still open (the tag); a late answer for another chat is dropped.
    const stillOpen = () => isCurrentTag(shellRef.current, tag);
    const configNotice = (message: string | null) => setNotice('config', message, tag);
    setConfigBusy(true);
    configNotice(null);
    try {
      const latest = await term2Client.readSessionConfig(sessionId);
      configLoaded(tag, latest);
      const response = await term2Client.updateSessionConfig(sessionId, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: latest.configRevision,
        admission: 'idle',
        ...selection,
      });
      if (response.result.ok && response.result.kind === 'command_finished') {
        const refreshed = await term2Client.readSessionConfig(sessionId);
        configLoaded(tag, refreshed);
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
      setConfigBusy(false);
    }
  };

  /** A model or effort picked in a blank chat becomes the default for blank chats. */
  const saveBlankChatDefault = async (selection: Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort'>) => {
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
      dispatchShell({ type: 'DRAFT_CONFIG_PICKED', selection });
      void saveBlankChatDefault(selection);
      return;
    }
    if (!sessionId) return;
    const { modelSelection, reasoningEffort, ...immediate } = selection;
    if (modelSelection || reasoningEffort) {
      {
        const current = shellRef.current.staged;
        const next: StagedConfig = { ...current };
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
        setStagedConfig(next.modelSelection || next.reasoningEffort ? next : null);
      }
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
    const tag = currentTag(shellRef.current);
    setAttachmentError(null);
    const list = Array.from(files);
    if (attachments.length + list.length > 4) {
      setAttachmentError('You can attach up to 4 images per message.');
      return;
    }
    const added: ComposerImage[] = [];
    let error: string | null = null;
    for (const file of list) {
      try {
        added.push(await fileToDraftImage(file));
      } catch (err) {
        error = err instanceof Error ? err.message : 'Could not attach image.';
      }
    }
    // Images read for one chat never join another chat's message (the tag).
    dispatchShell({ type: 'ATTACHMENTS_ADDED', tag, images: added, error });
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

  // A send's outcome for the caller that asked (an Edit keeps its box busy until then), by request id.
  const sendWaitersRef = useRef(new Map<string, (accepted: boolean) => void>());
  const sendSettled = (requestId: string, accepted: boolean) => {
    const waiter = sendWaitersRef.current.get(requestId);
    sendWaitersRef.current.delete(requestId);
    waiter?.(accepted);
  };
  /**
   * Sends the message box (or `overrideText`). The machine fixes the message now, applies staged picks first when
   * no turn is running, and puts an Edit or Retry's text back if it is refused. In a draft it creates the chat.
   */
  const submitMessage = (
    delivery?: 'auto' | 'steer' | 'follow_up',
    overrideText?: string,
    // Edit and Retry resend one message's text without the composer's attachments or skill.
    options?: { textOnly?: boolean },
  ): Promise<boolean> => {
    if (sendBlocked) return Promise.resolve(false);
    const requestId = crypto.randomUUID();
    const action: ShellAction = {
      type: 'SEND_REQUESTED',
      requestId,
      context: { runningTurnId: activeStreamingTurn?.turnId ?? null },
      ...(delivery ? { delivery } : {}),
      ...(overrideText !== undefined ? { overrideText } : {}),
      ...(options?.textOnly ? { textOnly: true } : {}),
    };
    if (isDraft) {
      setLoadError(null);
      dispatchShell(action);
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      sendWaitersRef.current.set(requestId, resolve);
      dispatchShell(action);
      // Nothing to send, or a message already on its way.
      if (shellRef.current.sending?.requestId !== requestId) sendSettled(requestId, false);
    });
  };

  /** A draft's first send failed; the machine keeps any chat it already created for the retry. */
  const failDraftStart = (tag: Tag, error: unknown) => {
    if (error instanceof Term2ApiError && error.status === 409) void session.refreshSessions().catch(() => undefined);
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'Could not start a new chat. Try again or choose a different folder.';
    if (isCurrentTag(shellRef.current, tag)) setLoadError(message);
    dispatchShell({ type: 'DRAFT_START_FAILED', tag, message });
  };
  // The one place the machine's commands run. Every result goes back as an action carrying its command's tag.
  runShellCommandRef.current = (command: ShellCommand) => {
    switch (command.type) {
      case 'navigate':
        if (command.sessionId) session.selectSession(command.sessionId);
        else leaveSession();
        return;
      case 'loadConfig': {
        const id = command.tag.sessionId;
        if (!localControlEnabled || !id) return;
        void term2Client
          .readSessionConfig(id)
          .then((config) => configLoaded(command.tag, config))
          .catch(() => undefined);
        return;
      }
      case 'createSession':
        void session.createSession(command.workspaceId).then(
          (projection) => dispatchShell({ type: 'SESSION_CREATED', tag: command.tag, sessionId: projection.id }),
          (error: unknown) => failDraftStart(command.tag, error),
        );
        return;
      case 'applyDraftConfig': {
        const { tag, sessionId: id, config } = command;
        void (async () => {
          if (Object.keys(config).length > 0) {
            const latest = await term2Client.readSessionConfig(id);
            const { result } = await term2Client.updateSessionConfig(id, {
              clientRequestId: crypto.randomUUID(),
              expectedRevision: latest.configRevision,
              admission: 'idle',
              ...config,
            });
            if (!result.ok || result.kind !== 'command_finished')
              throw new Error(!result.ok ? result.message : 'The chat settings have not taken effect.');
          }
          dispatchShell({ type: 'DRAFT_CONFIG_APPLIED', tag, sessionId: id });
        })().catch((error: unknown) => failDraftStart(tag, error));
        return;
      }
      case 'applyStaged': {
        const { tag, requestId, changes } = command;
        void applySessionConfig(changes, tag).then((ok) => {
          dispatchShell({ type: 'STAGED_APPLIED', tag, requestId, ok });
          if (shellRef.current.sending?.requestId !== requestId) sendSettled(requestId, false);
        });
        return;
      }
      case 'submit': {
        const { tag, message } = command;
        void session
          .submit(message.text, {
            delivery: message.delivery,
            ...(message.expectedSteerTurnId ? { expectedSteerTurnId: message.expectedSteerTurnId } : {}),
            ...(message.skill ? { skill: message.skill } : {}),
            ...(message.attachments
              ? { attachments: message.attachments.map(({ type, mediaType, data }) => ({ type, mediaType, data })) }
              : {}),
          })
          .then((accepted) => {
            dispatchShell({ type: 'SUBMIT_SETTLED', tag, requestId: message.requestId, accepted });
            sendSettled(message.requestId, accepted);
          });
        return;
      }
      case 'rememberPrompt':
        setPromptHistory((prev) => {
          const next = prev[prev.length - 1] === command.text ? prev : [...prev.slice(-49), command.text];
          try {
            window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));
          } catch {
            /* ignore */
          }
          return next;
        });
        return;
      case 'drainNotifications': {
        const { tag, boundary } = command;
        if (!tag.sessionId) return;
        term2Client
          .controlTask(tag.sessionId, {
            action: 'drain_notifications',
            clientRequestId: `drain_${crypto.randomUUID()}`,
          })
          .then((answer) => dispatchShell({ type: 'DRAIN_ANSWERED', tag, boundary, retry: answer.drain === 'busy' }))
          .catch((error: unknown) => {
            console.warn('Background notice drain failed', error);
            dispatchShell({ type: 'DRAIN_ANSWERED', tag, boundary, retry: true });
          });
        return;
      }
      case 'later':
        window.setTimeout(() => dispatchShell(command.action), command.ms);
        return;
    }
  };

  const sessionConfig = discoveredConfig?.sessionId === sessionId ? discoveredConfig : null;


  // The blank-chat default model. It is never swapped for another model behind the
  // user's back: when it isn't available, the draft keeps it and says so.
  const draftModel = useMemo(() => {
    if (!isDraft || !settings) return null;
    const savedModel = settings.settings.safeDefaults['agent.modelSelection'];
    const selection =
      draftConfig.modelSelection ??
      (savedModel?.source !== 'default'
        ? (savedModel?.value as { provider: string; model: string } | undefined)
        : undefined);
    return selection?.provider && selection.model ? selection : null;
  }, [isDraft, settings, draftConfig.modelSelection]);

  // A draft's model, effort and approval picks start from the saved defaults and are
  // applied to the session when the first message creates it.
  const draftPickerConfig = useMemo((): SessionConfigRecord | null => {
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
  const lastTurn = session.view.turns[session.view.turns.length - 1];
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
  const needsModelChoice = (isDraft && !draftModel) || (requiresEmptyChatModelChoice && !stagedForChat?.modelSelection);
  const pickerConfig = isDraft
    ? draftPickerConfig
    : sessionPickerConfig && needsModelChoice
    ? { ...sessionPickerConfig, modelId: '', providerId: '' }
    : sessionPickerConfig;
  const pickerDisabled = isDraft ? startingChat : commandDisabled;
  const providerId = sessionConfig?.providerId ?? '';
  const configuredProviderIds = useMemo(() => {
    const ids = new Set<string>();
    if (!settings) return ids;
    for (const p of settings.settings.providers) {
      if (!p.disabled && p.credential.configured) ids.add(p.id);
    }
    return ids;
  }, [settings]);

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

  const openProviderSetup = () => {
    if (settings && !hasAnyConfiguredProvider) setDialog('provider');
    else openSettings('providers', pickerConfig?.providerId ?? null);
  };

  const retryLastTurn = async (model?: ModelSummary) => {
    if (commandDisabled || configBusy || !lastTurn || !['failed', 'aborted'].includes(lastTurn.status)) return;
    if (!model && modelBlocked) return;
    const modelSelection = model ? { provider: model.provider, model: model.id } : stagedForChat?.modelSelection;
    const reasoningEffort = stagedForChat?.reasoningEffort;
    if (modelSelection || reasoningEffort) {
      if (!(await applySessionConfig({ modelSelection, reasoningEffort }))) {
        const replacement =
          model ??
          models.find((item) => item.provider === modelSelection?.provider && item.id === modelSelection.model);
        if (sessionId && replacement && lastTurn.userText)
          setRetryDraft({ sessionId, turnId: lastTurn.turnId, model: replacement });
        return;
      }
      setStagedConfig(null);
    }
    setRetryDraft(null);
    await session.invokeCommand('retry-turn');
  };

  // Tell the machine when the open chat can take a message: its config is loaded, sending is not blocked and its
  // stream is live. It sends a draft's first message then, exactly once.
  const readyToSend = Boolean(
    sessionId &&
      sessionConfig &&
      !sendBlocked &&
      session.view.sessionId === sessionId &&
      canSubmitSessionMessage(session.view.status),
  );
  const runningTurnId = activeStreamingTurn?.turnId ?? null;
  useEffect(() => {
    if (readyToSend && sessionId && pendingFirstSend?.sessionId === sessionId)
      dispatchShell({
        type: 'READY_TO_SEND',
        sessionId,
        requestId: crypto.randomUUID(),
        context: { runningTurnId },
      });
  }, [readyToSend, sessionId, pendingFirstSend, runningTurnId, dispatchShell]);

  // A background task that finishes while the chat is idle only records a notice; the Session admits the silent
  // turn that tells the agent once an attached client asks it to drain (the TUI does the same). The machine asks
  // once per accepted boundary, with one delayed re-ask after a busy or failed answer.
  const drainBoundary = useMemo(() => {
    const view = session.view;
    if (!sessionId || view.sessionId !== sessionId || !readyForBackgroundDrain(view)) return null;
    const pending = undeliveredBackgroundNoticeIds(view);
    return pending.length ? `${sessionId}:${view.lastAppliedSequence}:${pending.join(',')}` : null;
  }, [session.view, sessionId]);
  useEffect(() => {
    if (drainBoundary && sessionId) dispatchShell({ type: 'BOUNDARY', sessionId, boundary: drainBoundary });
  }, [drainBoundary, sessionId, dispatchShell]);

  const liveStatus = interactionPending
    ? 'Waiting for your approval'
    : lastTurn?.transientStatus
      ? lastTurn.transientStatus
      : lastTurn && (lastTurn.status === 'streaming' || lastTurn.status === 'pending')
        ? (() => {
            // A running or waiting tool already says so on its own row, with its spinner;
            // repeating it here showed the same words twice.
            if (lastTurn.commands.some((c) => c.status === 'running' || c.status === 'pending')) return null;
            const lastItem = lastTurn.items?.[lastTurn.items.length - 1];
            if (lastItem?.kind === 'reasoning' && lastItem.streaming) return 'Thinking…';
            if (lastItem?.kind === 'text' && lastItem.text) return null;
            return lastTurn.text ? null : lastTurn.reasoning ? 'Thinking…' : 'Working…';
          })()
        : null;
  const deferLiveStatus = Boolean(
    liveStatus &&
      !interactionPending &&
      !lastTurn?.transientStatus &&
      (lastTurn?.commands.length ?? 0) > 0,
  );
  // A status that follows a tool row waits POST_TOOL_STATUS_DELAY_MS (the machine's timer) so a quick next step
  // does not flash it. Until the machine has seen this status, a deferred one stays hidden.
  useEffect(() => {
    dispatchShell({ type: 'LIVE_STATUS', text: liveStatus, defer: deferLiveStatus });
  }, [liveStatus, deferLiveStatus, dispatchShell]);
  const visibleLiveStatus = !deferLiveStatus
    ? liveStatus
    : shell.liveStatus.text === liveStatus && shell.liveStatus.defer
    ? shell.liveStatus.shown
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

  // Pause CSS animations when the tab is hidden or the window loses focus so
  // backgrounded and unfocused visible windows avoid compositor/GPU wakeups.
  useEffect(() => {
    const syncVisibilityAndFocus = () => {
      document.documentElement.dataset.pageHidden = document.hidden ? 'true' : 'false';
      document.documentElement.dataset.windowBlurred = document.hasFocus() ? 'false' : 'true';
    };
    const onBlur = () => {
      document.documentElement.dataset.windowBlurred = 'true';
    };
    const onFocus = () => {
      document.documentElement.dataset.windowBlurred = 'false';
    };
    syncVisibilityAndFocus();
    document.addEventListener('visibilitychange', syncVisibilityAndFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibilityAndFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      delete document.documentElement.dataset.pageHidden;
      delete document.documentElement.dataset.windowBlurred;
    };
  }, []);

  // Drive duty-cycled smooth WAAPI breathing only while live indicators exist.
  const hasRunningSubagent =
    session.view.session?.tasks.some((task) => task.kind === 'subagent' && task.status === 'running') ?? false;
  const hasLiveAnimation =
    hasStreamingTurn ||
    Boolean(visibleLiveStatus) ||
    session.view.status === 'running' ||
    hasRunningSubagent;
  useEffect(() => {
    if (!hasLiveAnimation) return;
    return startAnimationHeartbeat();
  }, [hasLiveAnimation]);

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
  const pinned = shell.pinned;
  const setPinned = (next: boolean) => dispatchShell({ type: 'SCROLLED', pinned: next });
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
  }, [session.view.turns, session.view.pendingInteraction, visibleLiveStatus, pinned]);
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
    if (!atMention || filesLoadedFor !== currentFileScope) return [];
    const q = atMention.query.toLowerCase();
    return sessionFiles.filter((entry) => !q || entry.path.toLowerCase().includes(q)).slice(0, 14);
  }, [atMention, currentFileScope, filesLoadedFor, sessionFiles]);

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
  const slashQuery =
    !atMention && input.startsWith('/') && !input.includes('\n') && !input.includes(' ') ? input.slice(1) : null;
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
        disabled: !selectedWorkspaceId || startingChat,
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
        disabled: commandDisabled || sendBlocked || !lastTurn || !['failed', 'aborted'].includes(lastTurn.status),
        run: () => {
          clearPalette();
          void retryLastTurn();
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
    return needle
      ? items.filter((item) => item.label.toLowerCase().includes(needle) || item.id.includes(needle))
      : items;
  }, [
    commandDisabled,
    createNewChat,
    lastTurn,
    localControlEnabled,
    retryLastTurn,
    sendBlocked,
    session,
    slashQuery,
    startingChat,
  ]);

  const activeGoal = session.view.session?.goal;
  const activeVerification = session.view.session?.verification;

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
    if (sendBlocked) return 'Choose a model that can reply before resending.';
    setRetryError(null);
    let targets: RewindTargetSummary[];
    // Rewind targets name the user message; every presented turn carries its opening message's id.
    const messageId = session.view.turns.find((item) => item.turnId === turnId)?.userMessageId;
    try {
      ({ targets } = await term2Client.listRewindTargets(sessionId));
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not load this chat’s history.';
    }
    const target = messageId ? targets.find((item) => item.messageId === messageId) : undefined;
    if (!target) return 'This message can no longer be edited or retried. It may have been compacted away.';
    if ((target.imageCount ?? 0) > 0) return 'Messages with images can’t be edited or retried yet.';
    if (!(await session.rewind(target.targetId, undefined, { forResend: true }))) return 'Could not rewind the chat.';
    // If it is refused, the machine puts the text back in this chat's message box with the resend notice.
    await submitMessage('auto', text, { textOnly: true });
    return null;
  };

  const runningTasks = useRunningTasks(session.view);
  const tasksPanelVisible = Boolean(sessionId) && tasksPanelOpen;
  const closeTasksPanel = () => setTasksPanelOpen(false);

  const handleRewind = async (target: RewindTargetSummary, restoreText: boolean) => {
    const tag = currentTag(shellRef.current);
    const ok = await session.rewind(target.targetId);
    // The prompt goes back into the message box of the chat that was rewound, if it is still the one shown.
    if (ok && restoreText && target.text && isCurrentTag(shellRef.current, tag)) {
      dispatchShell({ type: 'TEXT_RESTORED', tag, text: target.text });
      window.setTimeout(() => composerRef.current?.focus(), 50);
    }
  };

  return (
    <main className="relative flex h-dvh max-h-dvh overflow-hidden bg-[#f7f7f8] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside
        aria-label="Chat history and folders"
        inert={!sidebarOpen ? true : undefined}
        aria-hidden={!sidebarOpen ? 'true' : undefined}
        className={`${
          settingsOpen ? 'hidden! ' : ''
        }fixed inset-y-0 left-0 z-[70] flex w-[17.5rem] flex-col bg-[#f7f7f8] shadow-2xl transition-[transform,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:bg-zinc-950 md:relative md:z-auto md:shadow-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full invisible pointer-events-none md:-ml-[17.5rem]'
        }`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
          <button
            type="button"
            onClick={() => {
              dispatchShell({ type: 'DRAFT_DISCARDED' });
            }}
            className="text-[15px] hover:opacity-80"
            title="Go to welcome screen"
          >
            <Wordmark />
          </button>
          <div className="flex items-center gap-0.5">
            {selectedWorkspaceId && (
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
            selectedWorkspaceId={selectedWorkspaceId}
            workspaces={session.workspaces}
            workspaceMetadata={workspaceMetadata}
            firstMessages={firstMessages}
            onSelect={selectSession}
            onCreate={(workspaceId) => void createNewChat(workspaceId)}
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
        className={`flex min-w-0 flex-1 flex-col md:py-2 md:pr-2 ${sidebarOpen ? '' : 'md:pl-2'} ${
          settingsOpen ? 'hidden!' : ''
        }`}
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
            onNewChat={!sidebarOpen && selectedWorkspaceId ? () => void createNewChat() : undefined}
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
                    onClick: () => setTasksPanelOpen((open) => !open),
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
              className={`flex-1 overflow-y-auto px-4 pt-6 scrollbar-thin sm:px-6 ${
                sessionId || isDraft ? 'pb-60' : 'pb-12'
              }`}
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
                                {!settings
                                  ? 'AI connection'
                                  : hasAnyConfiguredProvider
                                  ? 'AI provider connected'
                                  : 'Connect an AI service'}
                              </h3>
                              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                {!settings
                                  ? 'Checking for saved connections…'
                                  : hasAnyConfiguredProvider
                                  ? 'You can switch models or add more providers anytime in Settings.'
                                  : 'Sign in with ChatGPT, use an API key, or connect your own server.'}
                              </p>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant={hasAnyConfiguredProvider ? 'outline' : 'default'}
                            onClick={openProviderSetup}
                            disabled={!settings}
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
                                selectedWorkspaceId
                                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                              }`}
                            >
                              {selectedWorkspaceId ? <CheckCircle2 className="h-4 w-4" /> : '2'}
                            </span>
                            <div>
                              <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                {selectedWorkspaceId
                                  ? `Folder ready: ${selectedWorkspaceInfo.displayName}`
                                  : 'Choose a folder to work in'}
                              </h3>
                              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                {selectedWorkspaceId
                                  ? `${
                                      selectedWorkspaceInfo.access === 'read_write'
                                        ? 'Read & write access'
                                        : 'Read-only access'
                                    } · only files inside this folder are visible to Term2.`
                                  : 'Pick a local folder so Term2 can read and answer questions about your files.'}
                              </p>
                            </div>
                          </div>
                          {localControlEnabled && (
                            <Button
                              type="button"
                              size="sm"
                              variant={!selectedWorkspaceId && hasAnyConfiguredProvider ? 'default' : 'outline'}
                              onClick={() => setDialog('folder')}
                            >
                              {selectedWorkspaceId ? 'Change' : 'Browse'}
                            </Button>
                          )}
                        </div>

                        {session.workspaces.length > 0 && (
                          <div className="mt-3 pl-9">
                            <label className="sr-only" htmlFor="landing-workspace">
                              Saved folders
                            </label>
                            <Select
                              value={selectedWorkspaceId ?? NO_WORKSPACE}
                              onValueChange={(value) => chooseWorkspace(value === NO_WORKSPACE ? '' : value)}
                            >
                              <SelectTrigger id="landing-workspace" size="sm" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent position="popper">
                                <SelectItem value={NO_WORKSPACE}>Choose a saved folder…</SelectItem>
                                {session.workspaces.map((workspace) => (
                                  <SelectItem value={workspace.workspaceId} key={workspace.workspaceId}>
                                    {workspace.label} (
                                    {workspace.access === 'read_write' ? 'read & write' : 'read only'})
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
                      selectedWorkspaceId && (
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
                        {activeGoal.text}
                      </p>
                      {activeVerification && (
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          Verification: {String(activeVerification.status ?? 'recorded')}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {(modelBlocked || (needsModelChoice && settings)) && (
                  <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-100">
                    <h2 className="font-semibold">
                      {needsModelChoice
                        ? hasAnyConfiguredProvider
                          ? 'Choose a model to send'
                          : 'Connect an AI service to send'
                        : missingCredential
                        ? 'Connect an AI service to send'
                        : 'This model isn’t ready to reply'}
                    </h2>
                    <p className="mt-1">{pickerWarning} You can keep drafting your message.</p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {!needsModelChoice && suggestedModel && (
                        <Button
                          type="button"
                          disabled={pickerDisabled || configBusy}
                          onClick={() => {
                            if (lastTurn?.status === 'failed') void retryLastTurn(suggestedModel);
                            else
                              void handleUpdateSessionConfig({
                                modelSelection: { provider: suggestedModel.provider, model: suggestedModel.id },
                              });
                          }}
                          size="sm"
                        >
                          {lastTurn?.status === 'failed' ? 'Switch and retry with' : 'Use'}{' '}
                          {suggestedModel.name ?? suggestedModel.id}
                        </Button>
                      )}
                      <Button type="button" onClick={openProviderSetup} variant="outline" size="sm">
                        {hasAnyConfiguredProvider ? 'Open provider settings' : 'Connect an AI service'}
                      </Button>
                    </div>
                  </div>
                )}

                {((sessionId && session.view.turns.length === 0) || isDraft) && (
                  <div className="rounded-2xl border border-black/[0.06] bg-zinc-50/70 p-5 dark:border-white/[0.07] dark:bg-white/[0.02]">
                    <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                      What would you like help with in {selectedWorkspaceInfo.displayName || 'this folder'}?
                    </h2>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Click a suggestion to add it to your message, type <code className="font-mono">@</code> to mention
                      a file, or paste an image.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {STARTER_PROMPTS.map((prompt) => (
                        <Button
                          key={prompt}
                          type="button"
                          disabled={composerDisabled || Boolean(input.trim())}
                          onClick={() => {
                            setInput(prompt);
                            setCursorPos(prompt.length);
                            composerRef.current?.focus();
                          }}
                          variant="outline"
                          size="sm"
                          className="rounded-full"
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
                        content={turn.userContent}
                        copied={copiedTurn === `${turn.turnId}:user`}
                        onCopy={() => copyTurn(`${turn.turnId}:user`, turn.userText ?? '')}
                        disabled={commandDisabled}
                        laterTurns={session.view.turns.length - 1 - turnIndex}
                        onResend={resendFromTurn}
                      />
                    )}
                    <div className="min-w-0 space-y-4">
                      <Term2TurnTimeline turn={turn} displayMode={displayMode} />
                      {turn.status !== 'completed' && turn.status !== 'streaming' && turn.status !== 'pending' && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-2.5 py-0.5 text-xs text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
                            {turn.interruptedByFault
                              ? 'Interrupted by an error (reload to check saved state)'
                              : turn.status === 'aborted'
                              ? 'Stopped'
                              : `Turn ${turn.status}`}
                          </span>
                          {turn === lastTurn &&
                            (turn.status === 'failed' || turn.status === 'aborted') &&
                            !turn.error &&
                            !commandDisabled &&
                            !sendBlocked && (
                              <Button
                                type="button"
                                onClick={() => void retryLastTurn()}
                                variant="outline"
                                size="xs"
                                className="rounded-full"
                              >
                                <RotateCcw className="h-3 w-3" />
                                Retry turn
                              </Button>
                            )}
                          {turn === lastTurn &&
                            turn.status === 'failed' &&
                            !turn.error &&
                            suggestedModel &&
                            !modelBlocked &&
                            !commandDisabled &&
                            !configBusy &&
                            retryDraft?.turnId !== turn.turnId && (
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                onClick={() => void retryLastTurn(suggestedModel)}
                              >
                                Switch and retry with {suggestedModel.name ?? suggestedModel.id}
                              </Button>
                            )}
                        </div>
                      )}
                      {(turn.error || turn.errorMessage) && (
                        <div className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                          <p className="flex min-w-0 flex-1 items-start gap-2">
                            <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>
                              {turn.errorMessage
                                ? turn.errorMessage
                                : turn.error === 'provider_error' || turn.error === 'runtime_error'
                                  ? 'The AI service could not reply. Check your provider settings or click Retry to try again.'
                                  : turn.error}
                            </span>
                          </p>
                          <div className="flex shrink-0 items-center gap-2">
                            {turn === lastTurn &&
                              turn.status === 'failed' &&
                              suggestedModel &&
                              !modelBlocked &&
                              retryDraft?.turnId !== turn.turnId &&
                              !commandDisabled &&
                              !configBusy &&
                              (turn.error === 'provider_error' || turn.error === 'runtime_error') && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  onClick={() => void retryLastTurn(suggestedModel)}
                                >
                                  Switch and retry with {suggestedModel.name ?? suggestedModel.id}
                                </Button>
                              )}
                            {turn === lastTurn && !commandDisabled && !sendBlocked && (
                              <Button
                                type="button"
                                onClick={() => void retryLastTurn()}
                                variant="destructive"
                                size="xs"
                              >
                                Retry
                              </Button>
                            )}
                            {localControlEnabled && (
                              <Button
                                type="button"
                                onClick={() => openSettings('providers', providerId || null)}
                                variant="outline"
                                size="xs"
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
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
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
                      {retryDraft?.sessionId === sessionId && retryDraft.turnId === turn.turnId && turn.userText && (
                        <div className="space-y-2 text-sm text-muted-foreground">
                          <p>
                            This chat couldn’t switch models. You can copy the last prompt into a new draft without
                            changing this chat.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const { provider, id: model } = retryDraft.model;
                              void createNewChat();
                              dispatchShell({ type: 'DRAFT_CONFIG_PICKED', selection: { modelSelection: { provider, model } } });
                              setInput(turn.userText ?? '');
                              setRetryDraft(null);
                            }}
                          >
                            Open a new draft with {retryDraft.model.name ?? retryDraft.model.id}
                          </Button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}

                {/* While a prompt is pending the card below is the status; a second line would repeat it.
                    Reserve the 1-line slot during an active turn so status transitions don't bounce the transcript. */}
                {(hasStreamingTurn || visibleLiveStatus) && !interactionPending && (
                  <p
                    role="status"
                    className={`flex min-h-5 items-center gap-2.5 text-sm ${visibleLiveStatus ? '' : 'invisible'}`}
                  >
                    {visibleLiveStatus && (
                      <>
                        <span
                          aria-hidden
                          className="t2-heartbeat h-2 w-2 shrink-0 rounded-full bg-teal-500 ring-2 ring-teal-400/30"
                        />
                        <span className="t2-shimmer truncate">{visibleLiveStatus}</span>
                      </>
                    )}
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
                          onDiscovered={(config) => configLoaded(currentTag(shellRef.current), config)}
                          settings={settings}
                          sessionId={sessionId}
                          onCreateNewSession={() => void createNewChat()}
                        />
                      )}
                      <Term2NativeEvidence view={session.view} frames={session.frames} />
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
                      variant="outline"
                      size="icon"
                      className="t2-enter pointer-events-auto rounded-full shadow-md"
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
                          <img src={img.previewUrl} alt={img.name} className="h-9 w-9 rounded-lg object-cover" />
                          <span className="max-w-[7rem] truncate text-xs text-zinc-600 dark:text-zinc-300">
                            {img.name}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${img.name}`}
                            onClick={() =>
                              editComposer({ attachments: attachments.filter((a) => a.id !== img.id) })
                            }
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
                      if (resendNotice) setNotice('resend', null);
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
                          disabled={composerDisabled || sendBlocked || (!input.trim() && attachments.length === 0)}
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
                document
                  .getElementById('term2-pending-interaction')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            />
          </aside>
        </>
      )}
      {dialog === 'provider' && settings && (
        <Term2ProviderSetup
          projection={settings}
          models={models}
          modelsLoading={loadingModels}
          onReload={reloadSetupSettings}
          onModelsChanged={reloadModels}
          onContinue={(model) => {
            const selection = { modelSelection: { provider: model.provider, model: model.id } };
            if (sessionId || isDraft) void handleUpdateSessionConfig(selection);
            else void saveBlankChatDefault(selection);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'folder' && (
        <Term2SetupDialog title="Choose a folder" wide onClose={() => setDialog(null)}>
          <Term2FolderSelector
            homeFolder={homeFolder}
            allowWrite={effectiveAllowWrite}
            savedWorkspaces={session.workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
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
