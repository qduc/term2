# Design: decompose the web chat shell

Status: merged as `f13a1ee0` (qduc/term2#432). Part two, which finishes what sections 11 and 15 left, is
[web-shell-decomposition-part2.md](web-shell-decomposition-part2.md). Built from
[the brief](web-shell-decomposition-brief.md). Owner's defaults taken: the in-house data layer, the race-window
differences in section 6.3, the nine ceilings in section 7.1. Where the build departs from this design, see
[section 15](#15-build-notes). The claims below about the old code come from reading it. Since then the status
line feed (`LIVE_STATUS`, `deferLiveStatus`, `visibleLiveStatus` and the post-tool delay timer) is gone: the
status line became a fixed slot that always has text while a turn runs, like the TUI's working line, so there is
nothing to hold back.

## 1. Where the brief is wrong or in conflict

Read this first; the rest of the design assumes these answers.

1. **"No behaviour change" and "uniform loading/error/refresh" conflict in four race windows.** Today each fetch
   has its own, slightly different rule for overlapping requests. One rule for all of them changes what happens
   inside those windows and nowhere else. The design takes the uniform rule and lists every difference in
   [section 6.3](#63-deliberate-differences-race-windows-only). If the owner wants strict equality there too, the
   builder reproduces the old rule at the call site named in that list; the structure does not change.
2. **Two of the "server data" items are not fetch state.**
   - `loadError` is the page's one error banner. Fetches write it, and so do `saveBlankChatDefault`, `createNewChat`,
     `submitMessage` (in a draft) and `failDraftStart`. It stays one value, renamed `pageError`, outside the data
     layer.
   - The open chat's config (`shell.config`, loaded by the `loadConfig` command) stays in the machine under the tag
     rule. Moving it into the data layer would undo hazard 1 of phase 3.
3. **The counts are off.** The shell has 25 `useState` (brief: 26) and 13 `useRef` (brief: 8; the grep missed the
   typed ones). 16 `useEffect`, 17 `useCallback` and 10 `useMemo` are right. `useTerm2Session.ts` has 7 `useState`,
   3 `useRef`, 2 `useEffect`, 15 `useCallback`, 1 `useMemo`, 1 `useSyncExternalStore`.
4. **The list of large web files is incomplete.** Extending the 500-line gate to `web-client/` meets nine files
   over the limit after this change, not three: `lib/api/term2.ts` 1,203, `settings/ProvidersSection.tsx` 986,
   `lib/term2/types.ts` 958, `settings/Term2SettingsPage.tsx` 940, `Term2FolderSelector.tsx` 816,
   `Term2ToolContent.tsx` 771, `settings/settings-catalog.ts` 575, `lib/term2/shell-machine.ts` 540,
   `Term2ModelPicker.tsx` 509. Each gets a ceiling ([section 7.1](#71-file-size-covers-web-client)).
   `lib/server/term2-gateway-client.js` (792) is not seen: the gate counts `.ts`/`.tsx` only.
5. **The new static rules cannot go in `scripts/gates/architecture-rules.mjs`.** Any change to that file asks for the
   owner's `architecture-change` label (`scripts/check-architecture-change.mjs`). They go in a new file,
   `scripts/gates/web-shell-rules.mjs`, called from `scripts/check-rules.mjs`.
6. **"Ceilings that only go down" is a hint today, not a failure.** `scripts/check-complexity.mjs` fails when a
   file grows past its ceiling and prints `under budget: lower the ceiling` when it shrinks. The design keeps that;
   it does not add a failure for an unlowered ceiling.
7. **The page also re-renders whole on every stream frame**, not only on every keystroke: `useTerm2Session` returns
   the view at the shell's top. The design fixes both with the same selector hook.

## 2. Target in one page

```
Term2SessionShell.tsx (layout only)
└─ Term2ShellProvider ── owns one ShellRuntime for the page's life (context value: stable objects, never state)
   ├─ ShellFeeds, PageEffects ── render nothing: props and derived facts → machine actions; title, shortcuts
   └─ regions ── each reads by selector, calls runtime.dispatch / runtime.ops

ShellRuntime (lib/term2/shell/, no React)
├─ store      the machine: step() + the one command runner            (shell-machine.ts, unchanged)
├─ session    OpenSession: the open chat's stream, view and requests  (was hooks/useTerm2Session.ts)
├─ data       ServerData: settings, models, skills, files, folders, chats   (lib/term2/data/)
├─ prefs      browser preferences and prompt history (localStorage)
├─ local      configBusy, pageError, retryError, retryDraft
├─ facts      everything derived from the five above (pure functions, one derived store)
└─ ops        the multi-step user actions (send, retry, apply config, new chat, folder changes)
```

Three rules hold the structure together:

- **State lives in stores outside React; components subscribe with a selector.** One primitive
  (`createStore`) and one hook (`useStoreSelector`). The context carries the runtime object, which never changes, so
  a provider re-render never re-renders a region.
- **Derived values are computed in one pure module** (`chat-facts.ts`), not in component bodies, so a handler and
  the screen cannot disagree about `sendBlocked`.
- **`shell-machine.ts` is not edited** except for the sentence in its header comment that names where it is held.
  `scripts/generated-verification/shell.mjs` and the flows stay byte-identical.

## 3. Module tree

Sizes are estimates; every new file stays under 350 lines.

### 3.1 `lib/term2/` (no React, no JSX, erasable TypeScript only, so `node` can import them as `shell.mjs` does)

| File | One job | Lines |
| --- | --- | --- |
| `store.ts` | `createStore`, `derivedStore`, `shallowEqual` | 60 |
| `data/resource.ts` | One fetched value with uniform loading, error, refresh and stale-drop | 110 |
| `data/server-data.ts` | The six resources and the writes that update them | 190 |
| `data/folder-info.ts` | `folderInfo()`: display name, full path and access of a folder (today `getWorkspaceInfo`) | 40 |
| `browser-prefs.ts` | Display mode, notifications, diagnostics, prompt history; reads and writes `localStorage` | 90 |
| `navigation.ts` | Every `window.history` write: open or leave a chat, settings URLs | 70 |
| `composer-text.ts` | `extractAtMention`, `fileToComposerImage`, the image limits | 70 |
| `shell/open-session.ts` | `OpenSession`: the open chat's `Term2SessionStore`, view, requests and their feedback | 330 |
| `shell/chat-facts.ts` | `deriveChatFacts()`: every value derived from machine, view and data | 300 |
| `shell/shell-commands.ts` | `createCommandRunner()`: the one place a `ShellCommand` runs | 130 |
| `shell/shell-operations.ts` | `createShellOperations()`: multi-step user actions | 340 |
| `shell/shell-runtime.ts` | `createShellRuntime()`: builds and wires the above; `dispatch`; `start`/`stop` | 110 |

Unchanged: `shell-machine.ts`, `session-store.ts`, `present.ts`, `queue.ts`, `types.ts`, `sse.ts`,
`animationHeartbeat.ts`, `receipt-cost.ts`, `shell-sandbox-notice.ts`.

Deleted: `hooks/useTerm2Session.ts`. `canSubmitSessionMessage` moves to `shell/open-session.ts`.

### 3.2 `hooks/`

| File | One job |
| --- | --- |
| `useStoreSelector.ts` | `useSyncExternalStore` with a selector and an equality function |

### 3.3 `components/term2/shell/`

| File | Renders | Lines |
| --- | --- | --- |
| `ShellContext.tsx` | `Term2ShellProvider`, `useShell`, `useShellEnv`, `useShellState`, `useSessionView`, `useChatFacts` | 90 |
| `ShellFeeds.tsx` | Nothing. The six effects that dispatch ([section 5.3](#53-feeds)) | 90 |
| `PageEffects.tsx` | Nothing. Tab title and notifications, visibility dataset, animation heartbeat, Cmd/Ctrl+K | 110 |
| `RunningTasksContext.tsx` | `RunningTasksProvider`, `useRunningTaskCounts`, `useShownTasks` (one `useRunningTasks` call) | 50 |
| `Wordmark.tsx` | The `~ term2` mark | 15 |
| `ChatSidebar.tsx` | `<aside>` with `Term2SessionList`; also exports `SidebarScrim` | 110 |
| `SettingsRegion.tsx` | `Term2SettingsPage` when `?settings=` is set | 50 |
| `ChatColumn.tsx` | The two wrapper `<div>`s, the `<section>`, `Term2StatusBanner`; owns `useTranscriptScroll` | 110 |
| `ChatHeaderRegion.tsx` | `ChatHeader` with its props | 60 |
| `TranscriptScroll.tsx` | `useTranscriptScroll()` and `TranscriptPin` (the two scroll effects) | 70 |
| `WelcomeChecklist.tsx` | The onboarding checklist (no chat, no draft) | 190 |
| `ChatNotices.tsx` | `GoalBanner`, `ModelBlockedCard`, `EmptyChatCard` | 150 |
| `TranscriptTurns.tsx` | The turn loop and `TranscriptTurn` (`memo`) | 240 |
| `TranscriptTail.tsx` | `LiveStatusLine`, `PendingInteraction`, `DiagnosticsDetails` | 110 |
| `ChatDock.tsx` | Jump-to-latest button, `Term2QueueBar`, the notice banner, `Composer` | 100 |
| `Composer.tsx` | Drop target, popovers, textarea and its key handling | 330 |
| `ComposerAttachments.tsx` | Armed-skill chip and image chips | 60 |
| `ComposerToolbar.tsx` | Skills popover and command menu, `ComposerPickers`, usage, `ComposerSendButtons` | 220 |
| `useQuickActions.ts` | The slash / Cmd+K action list | 120 |
| `TasksPanelRegion.tsx` | The running-tasks `<aside>` and its mobile scrim | 50 |
| `ShellDialogs.tsx` | `ProviderDialog`, `FolderDialog`, `HelpDialog`, `RewindDialog` | 120 |

`Term2SessionShell.tsx` becomes about 70 lines:

```tsx
export function Term2SessionShell(props: Term2SessionShellProps) {   // props unchanged
  const localControlEnabled = isTerm2LocalControlEnabled();
  const settingsSection = localControlEnabled ? parseSettingsSection(props.settingsSection ?? null) : null;
  const env = useMemo<ShellEnv>(() => ({ ... }), [...]);
  return (
    <Term2ShellProvider initialSessionId={props.initialSessionId} authUserId={props.authUserId ?? null} env={env}>
      <main className="relative flex h-dvh ...">   {/* same class string */}
        <ChatSidebar />
        <SettingsRegion />
        <ChatColumn />
        <TasksPanelRegion />
        <ProviderDialog />
        <FolderDialog />
        <SidebarScrim />
        <HelpDialog />
        <RewindDialog />
      </main>
    </Term2ShellProvider>
  );
}
```

The child order is today's DOM order (the sidebar scrim sits between the folder and help dialogs today). Keep it:
the DOM parity probe ([section 9](#9-evidence)) compares `outerHTML`.

## 4. Interfaces

### 4.1 Store primitive: `lib/term2/store.ts`

```ts
export interface ReadableStore<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}
export interface Store<T> extends ReadableStore<T> {
  /** Same reference in, no notification out. */
  set(next: T | ((current: T) => T)): void;
}
export function createStore<T>(initial: T): Store<T>;
/** Recomputed on `get()` only when an input's value changed identity; subscribes to every input. */
export function derivedStore<T>(inputs: readonly ReadableStore<unknown>[], compute: () => T): ReadableStore<T>;
export function shallowEqual<T>(a: T, b: T): boolean;
```

### 4.2 Selector hook: `hooks/useStoreSelector.ts`

```ts
export function useStoreSelector<S, T>(
  store: ReadableStore<S>,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T;
```

Implementation contract: `useSyncExternalStore(store.subscribe, getSelected, getSelected)`, where `getSelected`
caches `{ state, selector, selected }` in a ref, returns the cached `selected` when `state` and `selector` are
both unchanged, and otherwise keeps the previous `selected` when `isEqual(previous, next)`. A selector that
builds an object must pass `shallowEqual`, or it re-renders on every store change.

### 4.3 Context: `components/term2/shell/ShellContext.tsx`

```ts
export interface ShellEnv {
  readonly homeFolder?: string;
  readonly allowWrite: boolean;              // the launcher's --allow-write prop
  readonly localControlEnabled: boolean;
  readonly settingsSection: SettingsSectionId | null;   // null when local control is off
  readonly settingsProvider: string | null;
  readonly settingsOpen: boolean;
}
export function Term2ShellProvider(props: {
  initialSessionId: string | null;
  authUserId: string | null;
  env: ShellEnv;
  children: ReactNode;
}): ReactElement;

export function useShell(): ShellRuntime;     // the same object for the page's life
export function useShellEnv(): ShellEnv;
export function useShellState<T>(selector: (state: ShellState) => T, isEqual?: (a: T, b: T) => boolean): T;
export function useSessionView<T>(selector: (view: Term2SessionView) => T, isEqual?: (a: T, b: T) => boolean): T;
export function useChatFacts<T>(selector: (facts: ChatFacts) => T, isEqual?: (a: T, b: T) => boolean): T;
/** `env.allowWrite` or the saved setting `safety.workspaceAccess === 'read_write'` (today `effectiveAllowWrite`). */
export function useAllowWrite(): boolean;
```

Data, prefs and local state are read with `useStoreSelector(shell.data.models, (s) => s.data)` directly; they need
no wrapper.

The provider:

```tsx
const [runtime] = useState(() => createShellRuntime({ localControlEnabled: env.localControlEnabled }));
useEffect(() => { runtime.start(); return () => runtime.stop(); }, [runtime]);
return (
  <RuntimeContext value={runtime}><EnvContext value={env}>
    <ShellFeeds initialSessionId={initialSessionId} authUserId={authUserId} />
    <PageEffects />
    <RunningTasksProvider>{children}</RunningTasksProvider>
  </EnvContext></RuntimeContext>
);
```

### 4.4 Runtime: `lib/term2/shell/shell-runtime.ts`

```ts
export type ShellLocalState = {
  readonly configBusy: boolean;
  /** The page's error banner (today `loadError`). */
  readonly pageError: string | null;
  readonly retryError: { readonly turnId: string; readonly message: string } | null;
  readonly retryDraft: { readonly sessionId: string; readonly turnId: string; readonly model: ModelSummary } | null;
};
export interface ComposerHandle {
  focus(): void;
  /** Replaces the text, puts the cursor at its end and focuses (today's starter-prompt click). */
  setText(text: string): void;
  /** Cmd/Ctrl+K: toggles the palette, resets its highlighted row, focuses. */
  togglePalette(): void;
}
export interface ShellRuntime {
  readonly store: ReadableStore<ShellState>;
  dispatch(action: ShellAction): void;
  readonly session: OpenSession;
  readonly data: ServerData;
  readonly prefs: BrowserPrefs;
  readonly local: Store<ShellLocalState>;
  readonly facts: ReadableStore<ChatFacts>;
  readonly ops: ShellOperations;
  /** Set by `Composer` while mounted. */
  readonly composer: { current: ComposerHandle | null };
  /** Mount: opens the open chat's stream and starts the first loads. Safe to call again after `stop()`. */
  start(): void;
  stop(): void;
}
export function createShellRuntime(options: { localControlEnabled: boolean }): ShellRuntime;
```

`dispatch` is today's `dispatchShell` plus one line:

```ts
function dispatch(action: ShellAction) {
  const previous = state;
  const { state: next, commands } = step(previous, action);
  state = next;
  if (next.openChat !== previous.openChat) session.open(next.openChat);   // before listeners are told
  if (next !== previous) notify();
  for (const command of commands) runCommand(command);
}
```

`session.open` runs before the machine's listeners so that one render sees the new chat and its (empty) view
together. Today `useMemo([sessionId])` gives the same guarantee. It is not a command: the stream follows
`openChat` as that `useMemo` does, and `URL_CHANGED` is still the only action that changes `openChat`.

`start()` does what today's two mount effects do: `ops.reloadLists()`, and when `localControlEnabled`,
`data.settings.load()` and `data.models.load()`; then `session.start()`. `stop()` calls `session.stop()`.

### 4.5 Open session: `lib/term2/shell/open-session.ts`

```ts
export function canSubmitSessionMessage(status: Term2ConnectionStatus): boolean;   // moved, unchanged
export type SessionFeedback = {
  readonly submitError: { readonly sessionId: string; readonly message: string } | null;
  readonly command: { readonly sessionId: string; readonly tone: 'neutral' | 'error'; readonly message: string } | null;
  readonly commandPendingSessionId: string | null;
};
export class OpenSession {
  constructor(deps: { chatTitled(sessionId: string, firstLine: string): void });
  /** The open chat's view, or the constant `NO_SESSION` view. Notifies on every publication and on `open()`. */
  readonly view: ReadableStore<Term2SessionView>;
  readonly feedback: Store<SessionFeedback>;
  get sessionId(): string | null;
  /** Closes the previous chat's store and creates this one's; opens its stream if started. */
  open(sessionId: string | null): void;
  start(): void;
  stop(): void;
  frames(): readonly unknown[] | null;
  submit(text: string, options?: MessageSubmitOptions): Promise<boolean>;
  clearSubmitError(): void;
  invokeCommand(commandId: Term2CommandId): Promise<void>;
  manageQueue(action: QueueManageAction): Promise<boolean>;
  controlTask(action: TaskControlAction): Promise<boolean>;
  rewind(targetId: string, expectedRevision?: string, options?: { forResend?: boolean }): Promise<boolean>;
  abort(): Promise<void>;
  resolveInteraction(request: InteractionResolveRequest): Promise<void>;
  refresh(): void;
}
```

The method bodies are the hook's callback bodies, moved: `sessionIdRef.current` becomes `this.#sessionId`,
`storeRef.current` becomes `this.#store`, each `setXState` becomes `this.feedback.set`. The message tables
(`COMMAND_ERROR_MESSAGES`, `commandNoticeFor`, ...) move with them. `submit`'s title patch calls
`deps.chatTitled`. The session-scoped reads the hook computed at return (`submitError` for this session only,
`commandPending`, `commandNotice`) become facts.

### 4.6 Data layer: `lib/term2/data/`

```ts
// resource.ts
export type ResourceState<T> = {
  readonly data: T;
  /** A load the screen should show as loading. */
  readonly loading: boolean;
  /** A refresh that keeps the current data on screen. */
  readonly refreshing: boolean;
  /** `data` came from the server at least once for `key`. */
  readonly loaded: boolean;
  readonly error: string | null;
  readonly key: string | null;
};
export interface Resource<T> extends ReadableStore<ResourceState<T>> {
  /** Fetches and shows loading. Resolves to the data, or null when it failed or a newer request replaced it. */
  load(key?: string): Promise<T | null>;
  /** Fetches without the loading flag. Rejects on failure so the caller can word the error. */
  refresh(key?: string): Promise<T>;
  /** `load(key)` unless this key is loaded or loading. */
  ensure(key?: string): void;
  /** Installs data the caller already has (a write's response); marks it loaded. */
  set(data: T): void;
  update(change: (data: T) => T): void;
}
export function createResource<T>(options: {
  initial: T;
  fetch: (key: string | null) => Promise<T>;
}): Resource<T>;
```

One rule for overlapping requests: each request takes a number; only the highest-numbered request may install
data or clear `loading`/`refreshing`; a request for another `key` resets `data` to `initial` and `loaded` to false
when it starts.

```ts
// server-data.ts
export type ChatList = { readonly sessions: SessionListItem[]; readonly nextCursor: string | null };
export type FolderDetail = { readonly displayName: string; readonly fullPath: string; readonly access?: string };
export type FileScope = { readonly kind: 'session' | 'workspace'; readonly id: string };   // key: `${kind}:${id}`
export interface ServerData {
  readonly settings: Resource<SettingsProjection | null>;
  readonly models: Resource<ModelSummary[]>;
  readonly skills: Resource<SkillSummary[]>;
  readonly files: Resource<WorkspaceFileEntry[]>;
  readonly folders: Resource<WorkspaceAlias[]>;
  readonly chats: Resource<ChatList>;
  /** What a folder pick returned in this page load (today `workspaceMetadata`). */
  readonly folderDetails: Store<Readonly<Record<string, FolderDetail>>>;
  ensureFiles(scope: FileScope): void;
  loadMoreChats(): Promise<void>;                      // today loadNextSessions
  chatCreated(projection: SessionProjection): void;    // today createSession's list insert
  chatTitled(sessionId: string, firstLine: string): void;
  /** Writes against the loaded revision and installs the returned projection. Throws on failure or when not loaded. */
  writeSettings(changes: Array<{ key: string; value: unknown }>): Promise<SettingsProjection>;
}
/** With local control off, `models.load()` resolves null without a request (today `reloadModels` returns early). */
export function createServerData(options: { localControlEnabled: boolean; client?: typeof term2Client }): ServerData;
```

`workspaceCursor` is returned by the hook today and read by nothing; it is dropped.

### 4.7 Preferences: `lib/term2/browser-prefs.ts`

```ts
export type BrowserPrefsState = {
  readonly displayMode: Term2DisplayMode;        // 'concise' until hydrated
  readonly notificationsEnabled: boolean;
  readonly showDiagnostics: boolean;
  readonly promptHistory: readonly string[];
};
export interface BrowserPrefs extends ReadableStore<BrowserPrefsState> {
  /** Reads localStorage. Called once after mount, as today, so the server render and first client render agree. */
  hydrate(): void;
  setDisplayMode(mode: Term2DisplayMode): void;
  setNotifications(enabled: boolean): void;
  setDiagnostics(enabled: boolean): void;
  rememberPrompt(text: string): void;            // the `rememberPrompt` command's body
}
/** Read at stream creation, straight from localStorage (today `diagnosticsOn()` in the hook). */
export function diagnosticsOn(): boolean;
export function createBrowserPrefs(): BrowserPrefs;
```

### 4.8 Facts: `lib/term2/shell/chat-facts.ts`

```ts
export type ChatFactInputs = {
  readonly shell: ShellState;
  readonly view: Term2SessionView;
  readonly feedback: SessionFeedback;
  readonly settings: SettingsProjection | null;
  readonly models: ResourceState<ModelSummary[]>;
  readonly folders: readonly WorkspaceAlias[];
  readonly chats: readonly SessionListItem[];
  readonly folderDetails: Readonly<Record<string, FolderDetail>>;
  readonly configBusy: boolean;
  readonly localControlEnabled: boolean;
};
export type ChatFacts = {
  // selection and folder
  readonly sessionId: string | null;
  readonly isDraft: boolean;
  readonly selectedWorkspaceId: string | null;
  readonly openChatFolder: string | null;
  readonly selectedWorkspaceInfo: { readonly displayName: string; readonly fullPath: string; readonly access: string };
  readonly fileScope: FileScope | null;
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
  readonly deferLiveStatus: boolean;
  readonly visibleLiveStatus: string | null;
  readonly hasLiveAnimation: boolean;
  readonly tasksPanelVisible: boolean;
};
export function deriveChatFacts(inputs: ChatFactInputs): ChatFacts;
```

Each field is the expression of the same name in today's shell body, moved without rewording (the block from
`interactionPending` to `hasStreamingTurn`, the block from `sessionConfig` to `suggestedModel`, `readyToSend`,
`drainBoundary`, `liveStatus` to `visibleLiveStatus`, `hasLiveAnimation`, `sessionTitle`). Internally it is four
functions (`folderFacts`, `turnFacts`, `modelFacts`, `statusFacts`). The four `useMemo`s that build objects
(`draftModel`, `draftPickerConfig`, `sessionPickerConfig`, `configuredProviderIds`) become a one-entry memo keyed
on the same inputs, so their identity is as stable as today.

The runtime exposes `facts = derivedStore([store, session.view, session.feedback, data.settings, data.models,
data.folders, data.chats, data.folderDetails, local], compute)`. A keystroke recomputes the facts (no React work)
and every selector over them returns an equal value, so nothing re-renders.

Selectors that return an object pass `shallowEqual`: `pickerConfig` (inferred flat enough: its one nested field,
`toolPolicy`, keeps its identity from the config record), `selectedWorkspaceInfo`, `firstMessages`,
`commandNotice`.

### 4.9 Commands and operations

```ts
// shell-commands.ts
export function createCommandRunner(deps: {
  getState(): ShellState;
  dispatch(action: ShellAction): void;
  session: OpenSession;
  data: ServerData;
  prefs: BrowserPrefs;
  local: Store<ShellLocalState>;
  ops: Pick<ShellOperations, 'applySessionConfig'>;
  /** Resolves the promise `ops.send` returned for this request id. */
  sendSettled(requestId: string, accepted: boolean): void;
  localControlEnabled: boolean;
}): (command: ShellCommand) => void;
```

Its `switch` is today's `runShellCommandRef.current` body, case for case, with `failDraftStart` beside it.
`createSession` calls `term2Client.createSession` then `data.chatCreated`. `navigate` calls
`navigation.openChat(id)` or `navigation.leaveChat()`.

```ts
// shell-operations.ts
type ConfigSelection = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'mode' | 'approvalMode'>;
export interface ShellOperations {
  reloadLists(): Promise<void>;                                   // reloadControlPlane
  createNewChat(workspaceOverride?: string): void;
  selectChat(id: string): void;                                   // selectSession
  folderSelected(folder: SelectedTerm2Workspace): void;           // onFolderSelected
  savedFolderChanged(change: SavedFolderChange): Promise<void>;   // onSavedFolderChanged
  applySessionConfig(selection: ConfigSelection, tag?: Tag): Promise<boolean>;
  updateSessionConfig(selection: ConfigSelection): Promise<void>; // handleUpdateSessionConfig
  saveBlankChatDefault(selection: StagedConfig): Promise<void>;
  toggleFavorite(favoriteKey: string): Promise<void>;
  addImages(files: FileList | File[]): Promise<void>;
  send(delivery?: Delivery, overrideText?: string, options?: { textOnly?: boolean }): Promise<boolean>;  // submitMessage
  retryLastTurn(model?: ModelSummary): Promise<void>;
  resendFromTurn: ResendFromTurn;
  rewind(target: RewindTargetSummary, restoreText: boolean): Promise<void>;   // handleRewind
  toggleSkills(): void;                                           // openSkillsMenu
  openProviderSetup(): void;
  providerChosen(model: ModelSummary): void;                      // the provider dialog's onContinue
  dismissNotices(): void;                                         // the notice banner's X
}
export function createShellOperations(runtime: Omit<ShellRuntime, 'ops' | 'start' | 'stop'>): ShellOperations;
```

**The rule for moving a handler:** read `runtime.facts.get()` and `runtime.store.get()` once at the top of the
operation into `const`s with today's names, then keep the body. A value the body used after an `await` came from
the render that created the closure, so it stays the one read at the top; do not re-read after the `await` unless
today's code reads a ref there (`shellRef.current` is `runtime.store.get()`). Example, `retryLastTurn`: `sessionId`,
`lastTurn`, `commandDisabled`, `configBusy`, `modelBlocked`, `stagedForChat` and `models` are read once on entry;
the `setRetryDraft` after the failed `applySessionConfig` uses those entry values, as now.

## 5. How components reach the machine

### 5.1 Reading

```tsx
const input = useShellState((s) => s.composer.input);
const dialog = useShellState((s) => s.panels.dialog);
const turns = useSessionView((v) => v.turns);            // identity is stable: present() reuses unchanged turns
const sendBlocked = useChatFacts((f) => f.sendBlocked);
const models = useStoreSelector(shell.data.models, (s) => s.data);
```

### 5.2 Writing

Components call `shell.dispatch(action)` for a single transition and `shell.ops.*` for anything with an `await`
or more than one step. They do not call `term2Client` (rule `web-shell-requests`). Today's setter wrappers
(`setInput`, `setNotice`, `setDialog`, `setSidebarOpen`, ...) are deleted; the call sites dispatch the action the
wrapper built. Three small helpers live in `Composer.tsx` because only it uses them: `editComposer(patch)`,
`setInput(next)`, `setPaletteOpen(next)`.

Do not defer a dispatch from the textarea's `onChange` (no transition, no microtask): the store update must be
synchronous in the event, as `setState` is, or the caret jumps.

### 5.3 Feeds

`ShellFeeds.tsx` holds the only effects that dispatch. Each is today's effect with the same dependencies:

| Effect | Reads | Dispatches |
| --- | --- | --- |
| Address bar | `initialSessionId` prop | `URL_CHANGED` |
| First mount | `window.innerWidth` | `SIDEBAR_SET` when at least 768 px; then `prefs.hydrate()` |
| Signed-in user changed | `authUserId` prop, `prevUserIdRef` | removes `agentSession` from the URL; `URL_CHANGED` null; `DRAFT_DISCARDED` |
| First send | facts `readyToSend`, `sessionId`, `runningTurnId`; state `pendingFirstSend` | `READY_TO_SEND` |
| Notice drain | facts `drainBoundary`, `sessionId` | `BOUNDARY` |
| Status line | facts `liveStatus`, `deferLiveStatus` | `LIVE_STATUS` |

They stay React effects, not store subscriptions, on purpose: an effect runs after the commit, as today, and a
subscription would dispatch inside another dispatch's notification.

### 5.4 Commands run in one place

`createCommandRunner` in `shell-commands.ts` is the only code that switches on `ShellCommand['type']`, and
`dispatch` in `shell-runtime.ts` is its only caller. Results go back through `dispatch` with their command's tag;
`step` drops the stale ones. Nothing about the tag rule changes.

## 6. State ownership

"Machine" is `shell-machine.ts` state, unchanged. "Derived" means computed in `chat-facts.ts`. A region name is
the component that owns the value.

### 6.1 `Term2SessionShell.tsx`

**`useState` (25)**

| Today | After |
| --- | --- |
| `shell` | `ShellRuntime` (`store`, `dispatch`) |
| `draggingFile` | `Composer` |
| `retryError`, `retryDraft` | `runtime.local` (ops write them, `TranscriptTurn` reads them) |
| `loadingWorkspaces` | `data.folders` state `loading` |
| `loadingSessions` | `data.chats` state `loading` |
| `loadError` | `runtime.local.pageError` |
| `configBusy` | `runtime.local.configBusy` |
| `settings` | `data.settings` state `data` |
| `models`, `loadingModels`, `modelsChecked` | `data.models` state `data`, `loading`, `loaded` |
| `skills`, `loadingSkills` | `data.skills` state `data`, `loading` |
| `sessionFiles`, `loadingFiles`, `filesLoadedFor` | `data.files` state `data`, `loading`, `key` with `loaded` |
| `cursorPos`, `popoverIndex` | `Composer` |
| `displayMode`, `notificationsEnabled`, `showDiagnostics`, `promptHistory` | `runtime.prefs` |
| `workspaceMetadata` | `data.folderDetails` |
| `copiedTurn` | `TranscriptTurns` (with `copyTurn`) |

**`useRef` (13)**

| Today | After |
| --- | --- |
| `shellRef` | deleted; `runtime.store.get()` |
| `runShellCommandRef` | deleted; the runner is built once and reads state when called |
| `savedDraftRef`, `fileInputRef`, `skillPickedRef`, `composerRef` | `Composer` (`skillPickedRef` is passed to `ComposerToolbar`); other regions reach the textarea through `runtime.composer` |
| `fileScopeRef`, `fileLoadRequestRef` | deleted; `createResource`'s request number and key |
| `prevUserIdRef` | `ShellFeeds` |
| `sendWaitersRef` | a `Map` inside `createShellOperations` (`send` adds, `sendSettled` resolves) |
| `prevStatusRef` | `PageEffects` |
| `scrollRef`, `lastScrollTopRef` | `useTranscriptScroll()` in `ChatColumn` |

**`useEffect` (16)**

| Today (first line of the effect) | After |
| --- | --- |
| `dispatchShell({ type: 'URL_CHANGED', sessionId: initialSessionId })` | `ShellFeeds` |
| `if (window.innerWidth >= 768) setSidebarOpen(true)` and the saved preferences | `ShellFeeds`; the reads are `prefs.hydrate()` |
| `if (prevUserIdRef.current !== currentUserId)` | `ShellFeeds` |
| `void reloadControlPlane()` | `runtime.start()` |
| `void reloadSetupSettings(); void reloadModels()` | `runtime.start()` |
| `READY_TO_SEND` | `ShellFeeds` |
| `BOUNDARY` | `ShellFeeds` |
| `LIVE_STATUS` | `ShellFeeds` |
| `document.title` and notifications | `PageEffects` |
| `dataset.pageHidden` / `windowBlurred` | `PageEffects` |
| `startAnimationHeartbeat()` | `PageEffects` |
| Cmd/Ctrl+K listener | `PageEffects`; calls `runtime.composer.current?.togglePalette()` when a chat is open. It stays above the composer because it calls `preventDefault` on the welcome screen too, where no composer is mounted |
| `if (pinned && el) el.scrollTop = el.scrollHeight` | `TranscriptPin` |
| scroll restore on closing settings | `TranscriptPin` |
| textarea height | `Composer` |
| `if (atMention) ensureSessionFiles()` | `Composer`: `if (atMention && fileScope) data.ensureFiles(fileScope)`, dependencies `[atMention, fileScope]` |

**`useCallback` (17)**

| Today | After |
| --- | --- |
| `dispatchShell` | `runtime.dispatch` |
| `editComposer`, `setInput`, `setPaletteOpen` | `Composer` helpers |
| `setSidebarOpen`, `setSelectedWorkspaceId`, `configLoaded` | deleted; call sites dispatch `SIDEBAR_SET`, `FOLDER_CHOSEN`, `CONFIG_LOADED` |
| `openSettings`, `navigateSettings`, `closeSettings`, `leaveSession` | `navigation.ts` functions |
| `getWorkspaceInfo` | `folderInfo()` in `data/folder-info.ts` |
| `reloadModels` | `data.models.load()` (no request when local control is off) |
| `reloadControlPlane` | `ops.reloadLists` |
| `reloadSetupSettings` | `data.settings.load()` |
| `ensureSessionFiles` | `data.ensureFiles(scope)` |
| `createNewChat` | `ops.createNewChat` |

**`useMemo` (10)**

| Today | After |
| --- | --- |
| `selectedWorkspaceInfo`, `firstMessages`, `drainBoundary` | derived |
| `draftModel`, `draftPickerConfig`, `sessionPickerConfig`, `configuredProviderIds` | derived (internal steps of `modelFacts`) |
| `atMention`, `matchingFiles` | `Composer` |
| `quickActions` | `useQuickActions()` |

**Plain values and handlers in the component body**

| Today | After |
| --- | --- |
| `sessionId`, `isDraft`, `draftWorkspaceId`, `draftConfig`, `pendingFirstSend`, `stagedConfig`, `startingChat`, `discoveredConfig` | selectors over machine state, or derived |
| `setArmedSkill`, `setHistoryIndex`, `setNotice`, `setAttachmentError`, `setConfigError`, `setDialog`, `setSkillsOpen`, `setStagedConfig`, `setPinned`, `closeTasksPanel`, `chooseWorkspace` | deleted; call sites dispatch |
| `localControlEnabled`, `activeSettingsSection`, `settingsOpen` | `ShellEnv` |
| `effectiveAllowWrite` | `useAllowWrite()` |
| `openChatFolder`, `selectedWorkspaceId`, `currentFileScope` | derived |
| `updateDisplayMode`, `updateDiagnostics`, `updateNotifications` | `prefs` methods |
| `openSkillsMenu`, `onFolderSelected`, `onSavedFolderChanged`, `selectSession`, `applySessionConfig`, `saveBlankChatDefault`, `handleUpdateSessionConfig`, `handleToggleFavorite`, `addImageFiles`, `submitMessage`, `retryLastTurn`, `resendFromTurn`, `handleRewind`, `openProviderSetup` | `ops` (names in section 4.9) |
| `sendSettled`, `failDraftStart`, the command `switch` | `shell-commands.ts` |
| `handlePaste`, `handleDrop`, `insertFileMention`, `slashQuery`, `showQuickPalette`, the `onKeyDown` body | `Composer` |
| `onScroll`, `scrollToLatest` | `useTranscriptScroll()` |
| `copyTurn` | `TranscriptTurns` |
| `interactionPending` through `suggestedModel`, `readyToSend`, `runningTurnId`, `liveStatus`, `deferLiveStatus`, `visibleLiveStatus`, `hasRunningSubagent`, `hasLiveAnimation`, `sessionTitle`, `tasksPanelVisible` | derived |
| `activeGoal`, `activeVerification` | `GoalBanner`: `useSessionView((v) => v.session?.goal)` |
| `runningTasks` (`useRunningTasks(session.view)`) | `RunningTasksProvider`: one call, two contexts (counts for the header, the list for the panel). Two calls would keep two sets of grace timers |
| Module constants and functions (`settingsUrl`, `readLocalString`, `readPromptHistory`, `fileToDraftImage`, `extractAtMention`, `Wordmark`, `STARTER_PROMPTS`, `NO_WORKSPACE`, `NO_DRAFT_CONFIG`, the storage keys, the image limits) | `navigation.ts`, `browser-prefs.ts`, `composer-text.ts`, `Wordmark.tsx`, `ChatNotices.tsx`, `WelcomeChecklist.tsx`, `chat-facts.ts` |

### 6.2 `hooks/useTerm2Session.ts` (deleted)

| Today | After |
| --- | --- |
| `store` (`useMemo`), the start/close effect | `OpenSession.open`, `start`, `stop` |
| `view` (`useSyncExternalStore`) | `OpenSession.view`, read with `useSessionView` |
| `workspaces`, `sessions`, `sessionCursor` | `data.folders`, `data.chats` |
| `workspaceCursor` | deleted (nothing reads it) |
| `submitErrorState`, `commandState`, `commandPendingSessionId` | `OpenSession.feedback` |
| `storeRef`, `sessionIdRef` and the effect that sets it, `admittingSessionIdsRef` | private fields of `OpenSession` |
| `currentView` | `OpenSession.view.get()` |
| `refreshWorkspaces`, `refreshSessions` | `data.folders.refresh()`, `data.chats.refresh()` |
| `loadNextSessions` | `data.loadMoreChats()` |
| `createSession` | the `createSession` command: `term2Client.createSession` then `data.chatCreated` |
| `selectSession` | `navigation.openChat(id)` |
| `submit`, `clearSubmitError`, `invokeCommand`, `refresh`, `manageQueue`, `controlTask`, `rewind`, `abort`, `resolveInteraction` | `OpenSession` methods |
| `frames` | `OpenSession.frames()` |
| `canSubmitSessionMessage`, the message tables, `NO_SESSION` | `shell/open-session.ts` |
| `diagnosticsOn` | `browser-prefs.ts` |

### 6.3 Deliberate differences (race windows only)

These are the only places behaviour differs. None is on a path a flow walks (inferred from reading the flows).

1. **Overlapping loads of one resource.** Today two overlapping `reloadModels` calls clear `loadingModels` when the
   first finishes and keep whichever response arrives last; `refreshWorkspaces` and `refreshSessions` also keep
   the last to arrive. After: the request started last wins and the flag clears when it settles. Old rule, if
   wanted: an option on `createResource`.
2. **File listing after a failure.** Today a failed listing flips `loadingFiles`, which changes
   `ensureSessionFiles`' identity, which re-runs the `@` effect, which requests again: a retry loop for as long as
   the `@` popover is open (inferred from the dependency list; not reproduced). After: one request per change of
   the mention or the scope.
3. **File listing across a scope change.** Today a listing in flight for the old scope blocks the new scope's
   request until it finishes. After: the new scope's request starts at once and the old response is dropped.
4. **Timing of the open chat's identity.** Today `sessionIdRef` updates in an effect after the commit and the
   stream starts in an effect. After: both happen inside `dispatch`, a few milliseconds earlier.
5. **Handlers read current state.** Today a handler sees the values of the render that created it; an operation
   reads the stores when called. They differ only between a store change and the next commit.

## 7. Guards

Reminders, in the existing gate pattern. No GitHub settings, no label, no identity check.

### 7.1 File size covers `web-client/`

`scripts/check-complexity.mjs`: after `walk(path.join(repo, 'src'))`, also collect `.ts`/`.tsx` files under
`web-client/app`, `components`, `contexts`, `hooks` and `lib`, skipping directories named `node_modules`, `.next`
and `generated`. These files join the file-size loop only; the folder fan-out check stays `src/`-only (out of
scope: `components/term2/` has 28 direct files and nobody asked for that gate). Rule `file-size` in
`scripts/gates/rules.mjs` gets one sentence added to `fix`: "In web-client/, a component that outgrows the limit
usually renders two regions; a file under components/term2/shell/ over the limit has taken on a second region's
job."

Ceilings recorded in `scripts/complexity-budget.json` `fileCeilings`, at the line counts on `d6467f44`:

| File | Lines | Reason to record |
| --- | --- | --- |
| `web-client/lib/api/term2.ts` | 1203 | "The browser's one HTTP facade and its response validators; recorded when the gate first covered web-client (2026-11). Split validators from the client object when it is next reworked." |
| `web-client/components/term2/settings/ProvidersSection.tsx` | 986 | "Recorded when the gate first covered web-client (2026-11); the settings page was out of scope of the shell decomposition. Split per provider form when settings is next reworked." |
| `web-client/lib/term2/types.ts` | 958 | "Type declarations only, one vocabulary shared by the facade, the store and the components; recorded when the gate first covered web-client (2026-11)." |
| `web-client/components/term2/settings/Term2SettingsPage.tsx` | 940 | "Recorded when the gate first covered web-client (2026-11). It keeps its own copy of the settings projection; moving it onto lib/term2/data/server-data.ts is the next step and should shrink it." |
| `web-client/components/term2/Term2FolderSelector.tsx` | 816 | "Recorded when the gate first covered web-client (2026-11); one dialog with its own capability-token browse flow, out of scope of the shell decomposition." |
| `web-client/components/term2/Term2ToolContent.tsx` | 771 | "Output parsers and previews for every tool row; the transcript flows compare what it renders. Recorded when the gate first covered web-client (2026-11); split parsers from previews in a change of its own." |
| `web-client/components/term2/settings/settings-catalog.ts` | 575 | "Data: which settings appear where, with labels and keywords. One table reads better whole; recorded when the gate first covered web-client (2026-11)." |
| `web-client/lib/term2/shell-machine.ts` | 540 | "One pure step() whose cases are the shell's rules, checked together by shell.machine-rules; splitting it by slice would hide the cross-slice resets. Recorded when the gate first covered web-client (2026-11)." |
| `web-client/components/term2/Term2ModelPicker.tsx` | 509 | "Nine lines over; recorded when the gate first covered web-client (2026-11). Drop the ceiling when the picker is next touched." |

The builder re-counts before committing (the gate counts newlines) and confirms no other file is over 500.

### 7.2 New rules: `scripts/gates/web-shell-rules.mjs`

Exports `checkWebShell(repo, report, baseline)`, called from `scripts/check-rules.mjs` after `checkArchitecture`.
Both rules scan `web-client/components/term2/Term2SessionShell.tsx` and every file under
`web-client/components/term2/shell/`. Parse-only, like `architecture-rules.mjs`.

**`web-shell-effects`.** For each call to `useEffect`, `useLayoutEffect` or `useInsertionEffect`, walk the
callback's body without entering nested functions (so an event listener, a timer, a promise callback and the
cleanup are not seen). Report a call whose callee is:

- an identifier bound as the second element of `const [x, setX] = useState(...)` or `useReducer(...)` in the file;
- an identifier named `dispatch`, or a property access ending in `.dispatch`.

The list of shapes is not complete (a store's `.set` is not seen); the rule text says so, as `fixed-sleeps` does.
Exceptions: `webShellEffects` in `scripts/rule-baseline.json`, `{ "file", "count", "reason" }`, a per-file
ceiling that fails when exceeded and when the file has fewer than recorded (the `fixedSleeps` logic). One entry
ships:

```json
{ "file": "web-client/components/term2/shell/ShellFeeds.tsx", "count": 6,
  "reason": "The six places a prop or a fact derived from the open chat becomes a machine action (address bar, first mount, user change, first send, notice drain, status line). They are kept in this one file so a seventh is visible; each could go only if the machine read the session view itself." }
```

```js
'web-shell-effects': {
  title: 'Shell components do not write state from an effect',
  why:
    'An effect that sets state or dispatches when other state changes keeps a second, delayed copy of that state: ' +
    'for one render the two disagree, and a run that fires late lands on another chat. Six fixes went into effects ' +
    "of this kind before the shell's policy moved into web-client/lib/term2/shell-machine.ts. Shapes detected (the " +
    'list is not complete): a useState or useReducer setter, or a call named dispatch, made directly in the body of ' +
    'useEffect, useLayoutEffect or useInsertionEffect. Calls inside a listener, timer, promise callback or the ' +
    'cleanup are not flagged.',
  fix:
    'Derive the value while rendering (a selector, or web-client/lib/term2/shell/chat-facts.ts), or make the change ' +
    'part of the transition that causes it in shell-machine.ts. An effect that reads the DOM, subscribes to a ' +
    'browser event or starts a request is fine.',
  avoid:
    'Do not wrap the write in a helper, a timer or a promise so the checker stops seeing it, and do not move the ' +
    'component out of components/term2/shell/ to leave the scan.',
  exceptions: {
    file: 'scripts/rule-baseline.json',
    entry: 'webShellEffects: { "file": "<component file>", "count": N, "reason": "..." }',
    note: 'the count is a per-file ceiling that only goes down; a new feed belongs in ShellFeeds.tsx',
  },
},
```

**`web-shell-requests`.** Report any import of a value from `lib/api/term2` (resolved path, or a specifier ending
in `lib/api/term2`) in the scanned files. Type-only imports pass. Exceptions: `webShellRequests`,
`{ "file", "reason" }`; none ship.

```js
'web-shell-requests': {
  title: 'Shell components do not call the server',
  why:
    'Server data has one home, web-client/lib/term2/data/server-data.ts, with one meaning of loading, failed and ' +
    'refreshed, and one rule for a response that arrives late. A request made from a component brings back its own ' +
    'loading flag, error string and stale check: the dozen hand-written flags this layout replaced.',
  fix:
    'Read through a resource in server-data.ts (add one there for new data). Put an action with several steps in ' +
    'web-client/lib/term2/shell/shell-operations.ts and call it as shell.ops.<name>.',
  avoid: 'Do not pass term2Client in through props or context, and do not re-export it from another module.',
  exceptions: {
    file: 'scripts/rule-baseline.json',
    entry: 'webShellRequests: { "file": "<component file>", "reason": "..." }',
  },
},
```

Also in this step:

- `readDeviations` in `scripts/gates/rules.mjs` reads the two new baseline lists, so `check-baselines.mjs` and
  `gate-exceptions.mjs` show them.
- `scripts/check-rules.mjs` header comment lists rules 11 and 12.
- `scripts/prove-checks.sh` gains three seeds: a `useState` setter in an effect appended to
  `shell/ChatSidebar.tsx` (expects `\[web-shell-effects\]`), a `term2Client` import appended to
  `shell/ChatSidebar.tsx` (expects `\[web-shell-requests\]`), and 520 lines appended to a new
  `web-client/components/term2/shell/seeded-big.tsx` (expects `\[file-size\]`).

**Not guarded, on purpose:** leaf components outside `shell/` that fetch for themselves (`Term2RewindDialog`,
`Term2UsagePopover`, `Term2ProviderSetup`, `Term2FolderSelector`, the settings page); that `lib/term2/` imports no
React; that only `shell-commands.ts` switches on a command. The first is the next step's work; the other two fail
the typecheck or `shell.mjs`'s `node` import as soon as they are broken in the obvious way.

## 8. The data-layer decision

**Recommendation: no new dependency.** Build `createResource` (about 110 lines) and `server-data.ts`.

| | In-house `createResource` | TanStack Query v5 | SWR v2 |
| --- | --- | --- | --- |
| New runtime dependency | none | about 13 kB gzipped | about 5 kB gzipped |
| Loading / error / refresh | one state shape, section 4.6 | built in | built in |
| Late response dropped | request number | built in | built in |
| Behaviour that must be turned off to keep today's request pattern | none | retry (3), refetch on window focus, refetch on reconnect, cache kept after last reader | revalidate on focus, on reconnect, dedupe window, error retry |
| Read and write from outside React (the command runner, `OpenSession.submit`) | plain `get`/`set` | `queryClient.getQueryData` / `setQueryData` | global `mutate`; awkward |
| Paged chat list with a local insert and title patch | `update()` on one value | `useInfiniteQuery` plus manual cache edits per page | `useSWRInfinite` plus manual edits |
| We own its correctness | yes: covered by a new generated property (below) | no | no |
| Devtools, mutations, invalidation graph, polling | none | yes | partial |

Library sizes and defaults are from memory of their documentation, not measured or looked up for this design.

Why not a library now: the page has six values, each fetched by one call, none polled, none invalidated by
another, and the HTTP facade deliberately disables automatic retries (`SOURCE.md`, "facade requests disable generic
automatic HTTP retries"). Every default that makes TanStack Query worth having would be switched off to meet "no
behaviour change", and the flows count requests in places (the usage flow asserts no hydration request). What is
left is a cache keyed by string, which is what `createResource` is.

What would change the answer: the next step moves the settings page, the usage quota (re-read after each model
response), rewind targets and provider presets onto the data layer. If that brings invalidation between
resources or polling, adopt TanStack Query then. `ServerData` is the seam: components and operations see
`Resource<T>`, so the swap is confined to `lib/term2/data/` and `useStoreSelector` call sites keep working
against an adapter.

**If the owner prefers TanStack Query now**, the build changes only in `lib/term2/data/`: one `QueryClient` created
in `createShellRuntime` with `defaultOptions.queries = { retry: false, refetchOnWindowFocus: false,
refetchOnReconnect: false, staleTime: Infinity, gcTime: 0 }`; each `Resource<T>` becomes an adapter over a
`QueryObserver` exposing the same `get`/`subscribe`/`load`/`refresh`/`set`/`update`; the generated property below
is dropped. Everything outside `lib/term2/data/` is as designed. The default build order assumes no dependency, so
the builder does not wait on this answer.

**New generated property, `web.resource-latest-wins`** (in `scripts/generated-verification/wire.mjs` beside
`web.present-reuse`, or a new `web-data.mjs` registered in `run.mjs`): random sequences of at most 30 steps of
`load(key)`, `refresh(key)`, `set`, `update`, and resolving or rejecting any pending request in any order.
Invariants: installed data came from the request started last or from a later `set`/`update`; a response for
another key is never installed; `loading` and `refreshing` are false once the last-started request has settled;
`loaded` is true only when `key`'s data was installed. This is a bounded generated property, which the testing
policy allows; it is what makes owning the primitive honest.

## 9. Evidence

Risk level: treat as **high** and get an independent verifier. It is one UI surface (medium by the letter of the
`verification` skill), but it rewrites the send path, the approval-mode change and the stream's lifecycle in one
change, and the skill says to pick the higher level when unsure.

| Claim | Check |
| --- | --- |
| Compiles | `node scripts/build-web-fold.mjs && pnpm --dir web-client exec tsc --noEmit` |
| Behaviour unchanged | `pnpm build && node scripts/build-web.mjs && pnpm test:web-browser`: 18 flows pass; `git diff d6467f44 -- tests/web-client/browser scripts/generated-verification/shell.mjs` is empty |
| Machine and presenter unchanged | `pnpm verify:generated`; `git diff d6467f44 -- web-client/lib/term2/shell-machine.ts` shows the header comment only |
| The data primitive holds its rule | `pnpm verify:generated --property web.resource-latest-wins`, shown red once on a seeded fault (install without the request-number check) |
| Same DOM | **Temporary probe** (untracked, deleted before commit): a Playwright script using `tests/web-client/browser/launch.ts` that walks fixed states and saves `document.querySelector('main').outerHTML` with volatile values masked (session ids, timestamps, Radix `id`/`aria-controls`). States: welcome; folder dialog; draft; draft with `/` palette; draft with `@` popover; chat after one reply; tool row; failed turn; pending approval; streaming with the status line; skills popover; help dialog; rewind dialog; tasks panel; settings page; sidebar closed; 390 px wide. Run on `d6467f44` and on the branch; the files must be equal |
| Same CSS | Compare the built stylesheets under `web-client/.next/static/` between the two builds (sorted rules if chunk order differs). Inferred: Tailwind scans the new folder without configuration, because `app/globals.css` imports `tailwindcss` with no `@source` list |
| Same requests | **Temporary probe:** in the same script, record `method path` of every `/api/` request for one journey (open, pick folder, send, reply, open the `@` popover, open skills, switch chat, reload) on both revisions; the multisets must be equal |
| Typing does not re-render the transcript | **Temporary probe:** a scratch patch adds `(window.__renders ??= {})[name] = (window.__renders[name] ?? 0) + 1` to the body of each region (on `d6467f44`: to `Term2SessionShell` and `Term2TurnTimeline`). Type 20 characters into a chat with three turns. Expected on the branch: `Composer` at least 20; `TranscriptTurns`, `TranscriptTurn`, `ChatSidebar`, `ChatHeaderRegion`, `WelcomeChecklist` 0; `EmptyChatCard` at most 1. On `d6467f44`: `Term2SessionShell` at least 20. Report both tables. The patch is not committed |
| A stream frame re-renders one turn | Same probe during a streamed reply with three earlier turns: earlier `TranscriptTurn`s 0, `ChatSidebar` 0 |
| Guards catch what they claim | `bash scripts/prove-checks.sh` shows the three new seeds `caught`; `node scripts/check-complexity.mjs`, `node scripts/check-rules.mjs`, `node scripts/check-baselines.mjs`, `pnpm check:no-unit-tests` pass |
| CI budget | No flow is added; the `web-browser` lane's counted time is unchanged. `quality` gains the web walk (parse of about 60 more files) and one property |

No permanent render-count check is proposed: it would need instrumentation in shipped components. The structure
(no state in context, selectors required by the hook's signature) is what keeps the claim true.

## 10. Build order

One change, ten steps. After every step: the typecheck passes and the 18 flows pass (about 35 s). Commit per step
on the branch so a red flow names its step; the PR is opened once, after step 10.

0. **Baseline.** On `d6467f44`: run the flows; record the DOM, CSS, request and render-count probes.
1. **Primitives.** `store.ts`, `useStoreSelector.ts`, `data/resource.ts`, the `web.resource-latest-wins`
   property. Nothing uses them yet.
2. **Move module-level code out of the shell file.** `navigation.ts`, `composer-text.ts`, `browser-prefs.ts`,
   `data/folder-info.ts`, `Wordmark.tsx`. The component still calls them the same way.
3. **Data layer.** `server-data.ts`. In the shell, replace the 13 fetch `useState`s, `workspaceMetadata` and the
   two file refs with `useStoreSelector(data.x, (s) => s)`; the hook loses its lists. The shell creates `data`
   with `useState(() => createServerData())` for now.
4. **Open session.** `shell/open-session.ts` replaces `useTerm2Session`; the shell reads
   `useStoreSelector(session.view, (v) => v)`. Delete the hook. Run the request probe here.
5. **Runtime.** `shell/chat-facts.ts`, `shell-commands.ts`, `shell-operations.ts`, `shell-runtime.ts`. The shell
   component now creates the runtime, subscribes to `store`, `facts`, `local`, `prefs` whole, and its markup uses
   `facts.*` and `ops.*`. No markup moves. This is the riskiest step: handlers stop being closures. Run
   `pnpm verify:generated` and both probes for DOM and requests.
6. **Provider and non-visual components.** `ShellContext.tsx`, `ShellFeeds.tsx`, `PageEffects.tsx`,
   `RunningTasksContext.tsx`. The shell's body is now markup plus whole-store reads.
7. **Split the markup, leaf first, one region per commit**, each new region reading by selector from the start:
   `ShellDialogs`, `TasksPanelRegion`, `ChatSidebar` with `SidebarScrim`, `SettingsRegion`, `ChatHeaderRegion`,
   `WelcomeChecklist`, `ChatNotices`, `TranscriptTail`, `TranscriptTurns`, `TranscriptScroll` with `ChatColumn`,
   `ChatDock`, then `Composer` with its three helpers. Cut and paste the JSX; change only where a value comes
   from. Run the DOM probe after `TranscriptTurns` and after `Composer`.
8. **Remove the whole-store reads** left in `Term2SessionShell.tsx`; it is now the layout in section 3.3. Run the
   render-count probe.
9. **Guards.** Section 7, with the ceilings re-counted and `prove-checks.sh` run.
10. **Docs.** `web-client/SOURCE.md`: replace the `Term2SessionShell` and `useTerm2Session` rows of "Entry points"
    and the `UseTerm2SessionResult` paragraph with rows for `Term2SessionShell` (props unchanged),
    `shell/ShellContext.tsx`, `lib/term2/shell/shell-runtime.ts`, `open-session.ts`, `data/server-data.ts`; fix the
    line-7 provenance list. `shell-machine.ts` header: "Term2SessionShell holds the state" becomes
    "`shell/shell-runtime.ts` holds the state". Add the merge commit to this file's status line after merge. Other
    documents that name `useTerm2Session` (`docs/contracts/13-gateway-web-wire.md`,
    `web-client-composable-redesign.md`, the transcript plan) describe earlier states under `frontend/` paths;
    leave them.

Then the independent verifier, with the diff, the claims in section 9 and the probe outputs.

## 11. Scope

- **In:** `Term2SessionShell.tsx`, `hooks/useTerm2Session.ts`, the new modules, the guards, `SOURCE.md`.
- **Out, with a ceiling:** `Term2FolderSelector.tsx` (a self-contained dialog; its validate/browse/select calls
  carry one-use capability tokens, so they are not cacheable server data, and the shell work does not touch it);
  `Term2ToolContent.tsx` (pure parsers and previews whose output the transcript flows compare; splitting it is a
  separate risk with no link to the shell); `Term2ModelPicker.tsx`; the settings page and `ProvidersSection.tsx`.
- **Out, named as the next step:** the settings page keeps its own copy of the settings projection and reports it
  through `onLoaded`. In this change `SettingsRegion` passes `onLoaded={shell.data.settings.set}`, which is today's
  `onLoaded={setSettings}`. Moving the page, `Term2UsagePopover`'s quota, `Term2RewindDialog`'s targets and
  `Term2ProviderSetup`'s presets onto `ServerData` comes after.
- **Out:** moving `configBusy`, `retryError`, `retryDraft` and `pageError` into the machine. They belong there
  (they are per-chat intent and are not reset on a chat change today), but that changes `shell-machine.ts` and
  `shell.machine-rules`, and this change promises both untouched.
- **Out:** the folder fan-out gate for `web-client/`, and child component props (`Term2SessionList`, `ChatHeader`,
  `Term2ModelPicker`, ... keep their interfaces; regions adapt to them).

## 12. Risks

| Risk | What to do |
| --- | --- |
| A handler that was a closure now reads later state | The rule in section 4.9: read once on entry. The hazard flows (`shell-hazards.flow.ts`) cover the late-result cases |
| One render shows the new chat with the old chat's transcript | `session.open` inside `dispatch`, before listeners (section 4.4). Do not move it to an effect |
| A wrapper element or a reordered sibling changes layout or the accessibility tree | Cut and paste JSX; regions return fragments or the existing element, never a new `<div>`. DOM probe |
| A conditional class string split across files drops a Tailwind class | Keep every class string literal whole. CSS comparison |
| Two `useRunningTasks` calls disagree on the grace delay | One call in `RunningTasksProvider` |
| `TranscriptTurn` is memoised and misses a prop | Its props are the turn, its index, `turns.length` and whether it is last; everything else it reads by selector |
| Composer focus calls reach a composer that is not mounted | `runtime.composer.current?.` everywhere; today's `composerRef.current?.` has the same hole |
| Effects now run child-first (`ShellFeeds` before the provider's `start`) | `OpenSession.open` before `start` only records the id; `start` opens it |
| React dev StrictMode mounts twice | `stop()` then `start()` reuses the same `Term2SessionStore`, as the hook's effect does today |
| The textarea's `selectionStart` handling and IME composition | The `onChange`, `onKeyDown`, `onKeyUp`, `onClick` bodies move as they are; dispatch stays synchronous |
| `skillPickedRef` focus hand-off across `Composer` and `ComposerToolbar` | The ref is created in `Composer` and passed down; the popover's `onCloseAutoFocus` body is unchanged |

## 13. Do not

- Do not edit `shell-machine.ts` beyond its header comment, `session-store.ts`, `present.ts`, a flow, a property,
  or `scripts/gates/architecture-rules.mjs`.
- Do not put state in a React context value. Context carries the runtime and the env.
- Do not add a `useEffect` that dispatches or sets state outside `ShellFeeds.tsx`.
- Do not call `term2Client` from a component under `shell/`.
- Do not import the fold bundle or wire types anywhere new (`web-fold-imports`).
- Do not change a prop of a component outside `shell/`, a class name, a label, a title or an `aria-` attribute.
- Do not add a `<div>` to make a region a single element.
- Do not fix the behaviours you notice on the way (the never-reset `retryError`, `configBusy` shared across
  chats, the handlers that write history without a `navigate` command). List them in the handoff.
- Do not add a dependency. If the owner picks TanStack Query, it enters through `lib/term2/data/` only.
- Do not commit the probes or the render-count patch.

## 14. For the owner

1. Data layer: in-house `createResource` (recommended) or TanStack Query now? The build proceeds in-house unless
   told otherwise.
2. The five race-window differences in section 6.3: accept, or keep any of the old rules?
3. Nine ceilings in section 7.1, including one for `shell-machine.ts` itself: acceptable as the starting line?

## 15. Build notes

What the build did differently from the sections above, and what it found.

- **One pass, not ten commits.** The modules were written straight to the target structure, then checked as a
  whole: typecheck, the 18 browser flows (all green on the first run), every generated property, and the
  temporary probes from section 9.
- **Probes against `d6467f44`** (temporary, not committed):
  - DOM: 15 states (welcome, folder dialog, draft, `/` palette, `@` popover, chat, tool row, failed turn, pending
    approval, approved turn, help, rewind, settings, reload, 390 px). The baseline was run twice to calibrate the
    masking and the two runs were byte-identical. 12 of 15 states matched at once. In the other three the
    textarea gained an inline height on mount: the old height effect never ran on mount because the textarea did not
    exist when the shell mounted, while `Composer` mounts with it. `Composer` now sizes only when the text changes.
  - Requests: the multiset is equal. The order differs only where it also differed between two baseline runs (the
    usage popover's quota reads).
  - Render counts: 20 keystrokes in a chat with three turns rendered `Composer` 40 times (text and caret) and
    `TranscriptTurns`, every `TranscriptTurn`, `ChatSidebar`, `ChatHeaderRegion`, `ChatColumn` and
    `WelcomeChecklist` 0 times. `EmptyChatCard` rendered once, when the box stopped being empty. The baseline table
    was not measured: the old shell held the composer text in state at its top, so it re-rendered whole on every
    keystroke by construction. A send and a short streamed reply re-rendered each earlier turn 3-4 times: the turn
    count changes (`laterTurns`) and `commandDisabled`/`sendBlocked` flip as the chat starts and stops running.
    The probe's held step streams a single chunk, so the per-frame claim (one turn per frame) is not measured.
- **Interfaces that differ from section 4:**
  - `createChatFacts()` returns the deriver, so its memos live for the page; facts gained `startingChat` and
    `fileScopeKey`.
  - `ShellOperations` gained `sendSettled`, which the command runner calls.
  - `navigation.ts` also has `leaveRemovedFolderChat` and `forgetChatSilently`, keeping the two history writes
    that differ from `leaveChat` byte for byte.
  - With local control off, `data.models` is the catalog resource with `load`/`ensure` that make no request.
  - The new property lives in `scripts/generated-verification/web-data.mjs`, as target `data`.
- **`webShellEffects` records 7 for `ShellFeeds.tsx`**, not 6: the user-change feed dispatches twice.
- **Guards** caught each seeded violation in `prove-checks.sh`: a state setter in an effect, a facade import, and a
  520-line file. Two older seeds report NOT CAUGHT on this branch and also on `d6467f44` (duplicate basename, folder
  fan-out), so this change did not break them; they are left for their owners.
- **Not changed, as section 13 says, and noticed:** `retryError` is never reset on a chat change; `configBusy` is
  shared across chats; `selectChat`, `openSettings` and the folder-removal leave write history directly rather
  than through a `navigate` command.
- **Independent verifier, round one (on `73705219`): rejected**, with one blocking defect, now fixed:
  - **Edit or Retry of the first message rewound the chat and then dropped the text.** `resendFromTurn` re-read
    `sendBlocked` after the rewind. An emptied chat counts as a first send, which a model the catalog does not list
    blocks, so `send` refused without dispatching anything. The old closure used the values from before the
    rewind. `resendFromTurn` now sends with the facts it read on entry (`sendWith` in shell-operations.ts). The
    verifier's reproduction is now a permanent flow, `shell-hazards.flow.ts` ("editing the first message is
    sent..."): red on `73705219`, green after the fix.
  - Non-blocking, also fixed:
    - `web.resource-latest-wins` did not check `load()`'s return value, `ensure()`'s dedupe or `refresh()`'s
      rejection. It now does, and is red on each of those three seeded faults.
    - `web-shell-effects` missed `React.useEffect` / `React.useState`. It now catches them, with a new seed in
      `prove-checks.sh`.
    - `reloadLists` stopped before loading chats when a concurrent folder refresh failed. It now stops only on its
      own request's failure (`Resource.loadOrFail`).
  - The verifier's own probes found the same DOM in 20 states and the same request lists in three journeys on both
    builds, the same stream open/close sequence across chat switches, and no difference in `chat-facts.ts` field by
    field. Not exercised by anyone: folder removal and access change, loading more chats, desktop notifications,
    drag-and-drop, and the `@` listing after a failure or across a scope change.

