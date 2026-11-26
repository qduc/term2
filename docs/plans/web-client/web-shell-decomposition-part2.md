# Design: finish the web chat shell decomposition (part two)

Design only; nothing here is built. It finishes what
[part one](web-shell-decomposition.md) (merged as `f13a1ee0`, #432) left in its sections 11 and 15. Claims about the
code come from reading `main` at `f13a1ee0`; inferences are marked. Paths are relative to `web-client/` unless they
start with `scripts/`, `tests/` or `docs/`.

## 1. Where the brief is wrong or in conflict

Read this first; the rest assumes these answers.

1. **`pageError` is not per-chat intent.** It is the page's one banner: a failed folder or chat list load writes
   it (`reloadLists`), and so do a failed first send, a failed default save and a failed folder refresh. A list
   failure outlives a chat change. The design moves it into the machine (so `ShellRuntime.local` can go) but does
   **not** reset it on a chat change. Resetting it would be a third behaviour change that nobody asked for.
2. **Moving `retryDraft` into per-chat state changes it too.** Today it is `{ sessionId, turnId, model }` and is
   shown only when `sessionId` matches the open chat, so it survives leaving the chat and coming back. As per-chat
   intent it is cleared on leaving, like `retryError`. This is listed as a change in
   [section 7](#7-behaviour-changes); the brief names only two.
3. **Three more components import the HTTP facade, and the brief names one.** Besides `Term2FolderSelector.tsx`:
   `Term2SavedFolderMenu.tsx` (`changeWorkspaceAccess`, `removeWorkspace`) and `Term2SessionConfig.tsx`
   (`updateSessionConfig`, `readSessionConfig`, the diagnostics panel). Neither holds fetched data: the first makes
   two writes and reports the result through `onChanged`; the second owns one configure command and its receipt.
   All three stay as they are and are recorded as exceptions with reasons
   ([section 9.1](#91-web-shell-requests-covers-every-component)).
4. **"No behaviour change" and "one settings projection" conflict in one place.** The settings page writes
   settings one at a time and installs the server's projection after a conflict; the chat's two settings writes
   (`toggleFavorite`, `saveBlankChatDefault`) do neither (`writeSettings` in `lib/term2/data/server-data.ts` has no
   queue and no conflict handling). One write path means the chat's writes get the page's rule. Listed in section 7.
5. **"No visual change" needs a rule for a screen that opens over data the page already has.** The settings page,
   the provider dialog and the rewind dialog each start with nothing and show a loading line until their own
   request answers, on every opening. A shared resource already holds the last answer. The design keeps today's
   screens exactly (loading until this opening's request answers; [section 3.4](#34-a-screen-that-loads-on-opening)).
   Showing the held data at once is the obvious improvement and is left for the owner
   ([section 14](#14-for-the-owner)).
6. **Not every ceiling shrinks.** `lib/term2/shell-machine.ts` (ceiling 540) gains about 80 lines. The design
   splits its type declarations into `lib/term2/shell-state.ts`, which leaves `step()` whole and both files under
   500, so that ceiling is dropped instead of raised. `ProvidersSection.tsx` shrinks by a few lines only.
7. **The settings page has no browser flow today.** No flow opens it (the only settings coverage is the raw BFF
   request in `bff-guards.flow.ts`). "The 19 flows stay green" therefore says nothing about item 1. The design
   adds one flow and uses temporary probes for the rest.
8. **Request cancellation goes.** The three leaf fetches abort their request on unmount; a `Resource` does not
   cancel, it drops the late answer. The server sees those requests finish. The list of requests made is the same.

## 2. Target in one page

```
ShellRuntime (lib/term2/shell/)
├─ store      the machine; now also configApply, retryError, retryDraft (per chat) and pageError (page)
├─ session    unchanged
├─ data       ServerData: + quota, rewindTargets, providerCatalog, one settings write queue,
│             provider/credential/sign-in writes that re-read what they made stale
├─ prefs      unchanged
├─ local      deleted
├─ facts      unchanged shape; reads configApply from the machine
└─ ops        same names; + retryReply; history writes for chats go through `navigate`

lib/term2/chat-navigation.ts   openChat, leaveChat, forgetChatSilently: imported by shell-commands.ts only
lib/term2/navigation.ts        settings URLs only (unchanged functions)
```

Three rules, all extensions of part one's:

- **A component under `components/` does not import the HTTP facade.** Three recorded exceptions.
- **Per-chat intent lives in the machine and is cleared whenever `generation` changes.**
- **Only the `navigate` command writes the chat into the address bar.** The settings parameters stay direct
  ([section 5.4](#54-settings-navigation-stays-direct)).

## 3. Data layer

### 3.1 The decision, leaf by leaf

| Today | In the data layer? | Why |
| --- | --- | --- |
| Settings page's projection (`projection`, `revisionRef`, `writeChain`, `onLoaded`) | **Yes**: it is `data.settings`. The copy and `onLoaded` are deleted | It is the same value the shell already holds; the two are kept equal by a callback, and they write with separate revisions |
| Settings page's write queue and conflict rule | **Yes**: `data.writeSettings` | One revision needs one queue |
| Settings page's row status, saved timers, confirm dialog, search text, `modelsChecked` | No, page state | They describe this page's rows, not the server |
| Provider presets (settings page and `Term2ProviderSetup`) | **Yes**: `data.providerCatalog` | One value, two readers, fetched by one call |
| Provider, credential and sign-in writes (`ProvidersSection`, the page's credential rows) | **Yes**: `data.providers.*` | Each makes settings (and usually the model list) stale; the re-read belongs with the write, not at nine call sites |
| Quota (`Term2UsagePopover`) | **Yes**: `data.quota`, keyed by chat | A fetched value with a key and a late-answer rule: what `Resource` is. When to re-read stays in the popover: it is a fact about what the popover has seen |
| Rewind targets (`Term2RewindDialog`, and `resendFromTurn`) | **Yes**: `data.rewindTargets`, keyed by chat, always re-read | The dialog shows loading, error and a list. The operation reads through the same resource so there is one read path; it uses what its own request returned |
| Folder browse (`Term2FolderSelector`) | **No** (confirmed) | `validateCandidate` returns a `candidateId`; `browseCandidate` and `selectCandidate` spend it, and a failed select re-validates. Each answer is only good for the next step of that one dialog: there is nothing to cache or share. Its result already reaches the data layer through `ops.folderSelected` |
| Saved-folder writes (`Term2SavedFolderMenu`) | No | Two writes whose result goes to `ops.savedFolderChanged`, which already refreshes folders and chats |
| Diagnostics configure (`Term2SessionConfig`) | No | It owns one command's original request and receipt for retry (`SOURCE.md`); the result reaches the machine as `CONFIG_LOADED` |

### 3.2 TanStack Query, decided again

Part one said to reconsider if this step brought invalidation between resources or polling. What the code shows:

- **Polling: none.** No timer re-reads server data (`setInterval`/`setTimeout` under `components/term2`, `lib/term2`
  and `hooks` are UI timers, the stream's retry and the machine's `later`). Quota is re-read when a string changes
  (`responses:model:open` in `Term2UsagePopover`), which is `refresh(key)` called from an effect.
- **Invalidation: one edge.** A provider, credential or sign-in write is followed by a settings read and then a
  model-list read, awaited in that order before the row's notice shows (`run` and `onAdded` in
  `ProvidersSection.tsx`). The page's own credential rows re-read settings only. That is one function,
  `providersChanged()`, not a graph.
- **Writes: optimistic concurrency on one revision**, queued, with the server's projection installed after a
  conflict. With TanStack Query this is a scoped mutation plus `setQueryData`: the same code, in its vocabulary.
- **Request pattern.** Each opening of the settings page, provider dialog and rewind dialog makes its requests
  again; the probes in part one compared request lists. Retry, focus refetch and cache reuse would all stay off.

**Recommendation: no new dependency.** The step adds three resources and one option to `createResource`; nothing
needs a primitive the in-house layer lacks. The no-dependency path is the design below, and it is the default
build. If the owner prefers TanStack Query, part one's section 8 still describes the swap (an adapter per
`Resource` inside `lib/term2/data/`); nothing in this design leaks past `ServerData`, so it can be done later
without touching a component.

What would change the answer next time: a value that must refresh on a timer or on window focus, or a second
invalidation edge that has to be discovered rather than called.

### 3.3 Interfaces

```ts
// lib/term2/data/resource.ts: one new option
export function createResource<T>(options: {
  initial: T;
  fetch: (key: string | null) => Promise<T>;
  /** The words `error` holds for a failed request. Default: the error's message. */
  describeError?: (error: unknown) => string;
}): Resource<T>;
```

```ts
// lib/term2/data/settings-writer.ts (new; no facade import, so the generated property can load it)
export type SettingsChange = { readonly key: string; readonly value: unknown };
/**
 * Settings writes, one at a time, each against the revision the store holds when its turn comes. A write that
 * fails does not stop the next. After a conflict the server's projection is installed and the write rejects.
 */
export function createSettingsWriter(deps: {
  settings: Resource<SettingsProjection | null>;
  write(input: { expectedRevision: string; changes: SettingsChange[] }): Promise<{ projection: SettingsProjection }>;
  /** The projection a conflict error carries, or null for any other error. */
  conflictProjection(error: unknown): SettingsProjection | null;
}): (changes: SettingsChange[]) => Promise<SettingsProjection>;
```

Body: `chain = chain.then(run, run)` where `run` reads `settings.get().data`, throws `new Error('Settings are not
loaded.')` when it is null, awaits `write`, calls `settings.set(result.projection)` and returns it; on an error
with a conflict projection it calls `settings.set(projection)` and rethrows the original error. The caller gets the
promise of its own `run`, not of the chain.

```ts
// lib/term2/data/server-data.ts: additions
export type ProviderCatalog = { readonly presets: ProviderPresetEntry[]; readonly types: string[] };
type Client = typeof term2Client;
export interface ProviderWrites {
  /** Re-reads settings, then the model list, when `ok`. */
  saveProvider(input: ProviderWriteInput): ReturnType<Client['writeProvider']>;
  deleteProvider(providerId: string): ReturnType<Client['deleteProvider']>;
  /** `reread`: what the write made stale. Default 'settings+models'. */
  setCredential(id: string, value: string, reread?: 'settings' | 'settings+models'): ReturnType<Client['setCredential']>;
  deleteCredential(id: string, reread?: 'settings' | 'settings+models'): ReturnType<Client['deleteCredential']>;
  /** Re-reads when the sign-in completed. */
  oauthLogin(provider: string): ReturnType<Client['oauthLogin']>;
  oauthSelect(provider: string, accountId: string): ReturnType<Client['oauthSelect']>;
  oauthDelete(provider: string, accountId: string): ReturnType<Client['oauthDelete']>;
}
export interface ServerData {
  // ...the six resources, folderDetails, ensureFiles, loadMoreChats, chatCreated, chatTitled: unchanged
  /** The chat's subscription allowance. Key: chat id. Null until read. */
  readonly quota: Resource<SessionQuota | null>;
  /** Key: chat id. Never `ensure`d: a turn or a rewind changes the list. */
  readonly rewindTargets: Resource<RewindTargetSummary[]>;
  readonly providerCatalog: Resource<ProviderCatalog>;
  /** Now queued and conflict-aware (settings-writer.ts). Same signature. */
  writeSettings(changes: SettingsChange[]): Promise<SettingsProjection>;
  /** Settings, then the model list. Resolves to the settings read, or null when it failed. Never rejects. */
  providersChanged(): Promise<SettingsProjection | null>;
  readonly providers: ProviderWrites;
}
```

- `settings` gets `describeError`: the page's wording, moved from `reload` in `Term2SettingsPage.tsx` (503 →
  `'Local settings are not available in this deployment.'`, else the error's message, else `'Settings could not be
  loaded.'`). Nothing else reads `settings.error` today (checked by grep).
- `quota.fetch = (key) => client.readSessionQuota(key!)`; `rewindTargets.fetch = async (key) => (await
  client.listRewindTargets(key!)).targets`; `providerCatalog.fetch = () => client.listProviderPresets()`, initial
  `{ presets: [], types: [] }`.
- `providersChanged`: `const latest = await settings.refresh().catch(() => null); await models.load(); return
  latest;`. `refresh`, not `load`: nothing shows `settings.loading`.
- Each `providers.*` method awaits the facade call, then, when it succeeded by its own result (`ok === true`;
  `status === 'completed'` for `oauthLogin`; resolved for credentials), awaits `providersChanged()` (or
  `settings.refresh().catch(() => null)` for `reread: 'settings'`) and returns the facade's result. A thrown
  error propagates with no re-read. This is the order `run` has today: write, settings, models, then the notice.

### 3.4 A screen that loads on opening

```ts
// hooks/useLoadOnOpen.ts (new)
export type Opened<T> = {
  /** 'loading' until the request this screen started has answered. */
  readonly status: 'loading' | 'failed' | 'ready';
  /** The resource's data; meaningful when `status` is 'ready'. */
  readonly data: T;
  readonly error: string | null;
  /** Asks again and shows loading. */
  reload(): void;
};
export function useLoadOnOpen<T>(resource: Resource<T>, key?: string | null): Opened<T>;
```

Contract: an effect with dependencies `[resource, key, attempt]` calls `resource.loadOrFail(key)` and records
`{ key, attempt, ok }` from the promise's callbacks (not in the effect body). `status` is derived while rendering:
`'loading'` unless the record matches the current `key` and `attempt`. `reload` bumps `attempt`. `data` and `error`
come from `useStoreSelector(resource, (s) => s)`.

### 3.5 Each leaf after the move

`components/term2/shell/ShellContext.tsx` gains `export const useServerData = (): ServerData => useShell().data`.
All four leaves are only rendered under `Term2ShellProvider` (checked: `SettingsRegion`, `ShellDialogs`,
`ComposerToolbar`).

**`Term2UsagePopover.tsx`.** Props unchanged. `useSessionQuota` becomes:

```ts
const data = useServerData();
useEffect(() => {
  if (sessionId) void data.quota.refresh(sessionId).catch(() => undefined);
}, [data, sessionId, refresh]);
return useStoreSelector(data.quota, (s) => (s.key === sessionId ? s.data : null));
```

A failed read keeps the previous value, as now; another chat's key empties it, as now.

**`Term2RewindDialog.tsx`.** Props unchanged. `const opened = useLoadOnOpen(data.rewindTargets, sessionId)`.
`targets = opened.status === 'ready' ? opened.data : []`; `loading = opened.status === 'loading'`. The first
selection is derived, not set in a callback: `selectedId ?? defaultTargetId(targets, initialTurnId)` with today's
expression. The local `error` state keeps only a failed rewind; shown is `error ?? (opened.status === 'failed' ?
opened.error || 'Could not load rewind points.' : null)`.

**`resendFromTurn` (`shell-operations.ts`).** `({ targets } = await term2Client.listRewindTargets(sessionId))`
becomes `targets = await data.rewindTargets.loadOrFail(sessionId)`. `loadOrFail` rejects with the original error,
so the returned message is unchanged, and it resolves to what this request fetched even if another replaced it.

**`Term2ProviderSetup.tsx`.** Props lose `onReload` and `onModelsChanged`. `const opened =
useLoadOnOpen(data.providerCatalog)`; `catalog = opened.status === 'ready' ? opened.data : null`; `catalogError =
opened.status === 'failed'`; "Try again" calls `opened.reload()`. `catalog`, `catalogError`, `attempt` state and
the effect go.

**`settings/ProvidersSection.tsx`.** Props lose `onReload` and `onModelsChanged`; `presets` and `providerTypes`
stay (the dialog filters them). It reads `useServerData()` once at the top and passes `data` to `ProviderDetail`
and `AddProvider` in place of the two callbacks.
- `run`: `const done = await operation(); if (done) setNotice(...)`. The two re-read lines go; each operation
  calls `data.providers.<write>` and keeps its `if (!result.ok) throw` line.
- `testConnection`: `await data.models.load()`.
- `onAdded`: `const latest = data.settings.get().data; const added = latest?.settings.providers.find((p) =>
  !before.has(p.id)); onNavigate(added?.id ?? null);` (the write has already re-read).

**`settings/Term2SettingsPage.tsx`.** Props lose `onLoaded` and `onModelsChanged`; the rest stay.

```ts
const data = useServerData();
const settings = useStoreSelector(data.settings, (s) => s);
// This opening: the page shows nothing it did not read itself, as before.
const [opening, setOpening] = useState<'loading' | 'failed' | 'ready'>('loading');
const reload = useCallback(async () => {
  try { const latest = await data.settings.refresh(); setOpening('ready'); return latest; }
  catch { setOpening((s) => (s === 'ready' ? s : 'failed')); return null; }
}, [data]);
const projection = opening === 'ready' ? settings.data : null;
const loading = opening === 'loading';
const loadError = settings.error;
const catalog = useLoadOnOpen(data.providerCatalog);
const presets = catalog.status === 'ready' ? catalog.data.presets : NO_PRESETS;
const providerTypes = catalog.status === 'ready' && catalog.data.types.length > 0 ? catalog.data.types : DEFAULT_PROVIDER_TYPES;
useEffect(() => {
  void reload();
  void data.models.load().finally(() => setModelsChecked(true));
}, []);   // once per opening, as now
```

Deleted: `projection`/`loading`/`loadError`/`presets`/`providerTypes` state, `revisionRef`, `writeChain`,
`applyProjection`. `saveServer` is `setStatus(saving)` then `writeOne`; `writeOne` is `await
data.writeSettings(changes)` with today's `catch`, minus the two `applyProjection` calls (the writer installs
both). The page may no longer import `SettingsConflictError` or `Term2ApiError` as values (section 9.1), so
`server-data.ts` exports `isSettingsConflict(error): boolean` and `errorStatus(error): number | null` (the
`Term2ApiError` status, for the "doesn’t accept that value" wording on 400) and the `catch` uses those. The
credential rows call `data.providers.setCredential(id, value, 'settings')` and `deleteCredential(id, 'settings')`
and drop their `await reload()`.

**Regions.** `SettingsRegion` drops `onLoaded` and `onModelsChanged`. `ProviderDialog` drops `onReload` and
`onModelsChanged`.

## 4. The machine

### 4.1 Files

`lib/term2/shell-state.ts` (new): every type now in `shell-machine.ts` (`ShellState`, `ShellAction`,
`ShellCommand`, `Composer`, `Notices`, `Panels`, `OutgoingMessage`, `Tag`, ...) and the constants and helpers that
are data (`EMPTY_COMPOSER`, `NO_NOTICES`, `initialShellState`, `currentTag`, `isCurrentTag`, the two delays).
`lib/term2/shell-machine.ts` keeps its header, `step()` and its private helpers, and starts with `export * from
'./shell-state'`, so no importer changes and `scripts/generated-verification/shell.mjs` keeps its import line.

### 4.2 State

```ts
// added to ShellState
/** A settings change being applied to the open chat. Cleared when the page shows something else. */
readonly configApply: { readonly requestId: string } | null;
/** A Retry under a reply that could not be sent. Cleared when the page shows something else. */
readonly retryError: { readonly turnId: string; readonly message: string } | null;
/** A failed "switch and retry": offer the prompt as a new draft with that model. Cleared likewise. */
readonly retryDraft: { readonly turnId: string; readonly model: ModelSummary } | null;
/** The page's one error banner. Page-level: a chat change does not clear it. */
readonly pageError: string | null;
```

`const NO_CHAT_INTENT = { configApply: null, retryError: null, retryDraft: null }`. It is spread into the next
state by every case that bumps `generation`: `URL_CHANGED` (both branches, the handoff too), `NEW_DRAFT`,
`DRAFT_DISCARDED`, `USER_CHANGED`. `initialShellState` sets all four to null.

### 4.3 Actions and commands

```ts
// added to ShellAction
| { readonly type: 'CONFIG_APPLY_STARTED'; readonly tag: Tag; readonly requestId: string }
| { readonly type: 'CONFIG_APPLY_SETTLED'; readonly tag: Tag; readonly requestId: string }
| { readonly type: 'RETRY_ERROR'; readonly tag: Tag; readonly error: { readonly turnId: string; readonly message: string } | null }
| { readonly type: 'RETRY_DRAFT'; readonly tag: Tag; readonly draft: { readonly turnId: string; readonly model: ModelSummary } | null }
| { readonly type: 'PAGE_ERROR'; readonly message: string | null }
/** A chat picked from the list. The address bar changes; URL_CHANGED opens it. */
| { readonly type: 'CHAT_PICKED'; readonly sessionId: string; readonly workspaceId: string | null }
/** Another user signed in: nothing of the previous user's stays. */
| { readonly type: 'USER_CHANGED' }

// changed in ShellCommand
| { readonly type: 'navigate'; readonly sessionId: string | null; readonly history?: 'replace' }
```

`step` cases:

```ts
case 'CONFIG_APPLY_STARTED':
  // One change at a time per chat.
  return isCurrent(state, action.tag) && state.openChat && !state.configApply
    ? result({ ...state, configApply: { requestId: action.requestId } })
    : result(state);
case 'CONFIG_APPLY_SETTLED':
  return isCurrent(state, action.tag) && state.configApply?.requestId === action.requestId
    ? result({ ...state, configApply: null })
    : result(state);
case 'RETRY_ERROR':
  return isCurrent(state, action.tag) ? result({ ...state, retryError: action.error }) : result(state);
case 'RETRY_DRAFT':
  return isCurrent(state, action.tag) ? result({ ...state, retryDraft: action.draft }) : result(state);
case 'PAGE_ERROR':
  return action.message === state.pageError ? result(state) : result({ ...state, pageError: action.message });
case 'CHAT_PICKED':
  return result(action.workspaceId ? { ...state, chosenFolder: action.workspaceId } : state, [
    { type: 'navigate', sessionId: action.sessionId },
  ]);
case 'USER_CHANGED':
  return result(
    {
      ...state, ...LEFT_SCREEN, ...NO_CHAT_INTENT,
      panels: panelsLeaving(state.panels),
      generation: state.generation + 1,
      draft: null, starting: false, sendIntent: null, startError: null, pendingFirstSend: null,
    },
    [{ type: 'navigate', sessionId: null, history: 'replace' }],
  );
```

Changed cases: `DRAFT_START_FAILED` (current tag) also sets `pageError: action.message`, which is what
`failDraftStart` writes today under the same test. `NEW_DRAFT` (when it is not refused) also sets `pageError:
null`: `createNewChat` clears it under the same condition (`facts.startingChat` is `shell.starting`), and it is the
only dispatcher of `NEW_DRAFT`.

`CHAT_PICKED` always emits `navigate`, also for the chat already open, because `selectChat` pushes a history entry
then too.

### 4.4 Who dispatches

| Today | After |
| --- | --- |
| `setLocal({ configBusy: true })` / `finally` in `applySessionConfig` | `const requestId = crypto.randomUUID(); dispatch(CONFIG_APPLY_STARTED { tag, requestId })`; `if (store.get().configApply?.requestId !== requestId) return false;` ... `finally { dispatch(CONFIG_APPLY_SETTLED { tag, requestId }) }`. The entry guard reads `store.get().configApply` |
| `local.get().configBusy` in `retryLastTurn` | `store.get().configApply !== null`, read on entry |
| `setLocal({ retryDraft })` in `retryLastTurn` (both) | `dispatch(RETRY_DRAFT { tag, draft })` with `tag = currentTag(store.get())` read on entry |
| `setLocal({ retryError: null })` in `resendFromTurn` | `dispatch(RETRY_ERROR { tag: currentTag(store.get()), error: null })` |
| `onError` in `TranscriptTurns.tsx` writing `local` | New `ops.retryReply: ResendFromTurn`: reads the tag on entry, awaits `resendFromTurn`, on a message dispatches `RETRY_ERROR { tag, error: { turnId, message } }`, returns the message. `Term2RetryReply` loses its `onError` prop |
| The "Open a new draft with ..." button writing `local` | Its last line becomes `dispatch(RETRY_DRAFT { tag: currentTag(shell.store.get()), draft: null })` |
| `setPageError(x)` in `shell-operations.ts` (7 sites) | `dispatch(PAGE_ERROR { message: x })`; the one before `NEW_DRAFT` is dropped |
| `deps.local.set(pageError)` in `failDraftStart` | deleted; `DRAFT_START_FAILED` sets it |
| `configBusy` input of `createChatFacts` | deleted; `sendBlocked` reads `shell.configApply !== null` |
| `local` in the `facts` input list and in `createCommandRunner`/`createShellOperations` deps | deleted |

## 5. The address bar

### 5.1 `lib/term2/chat-navigation.ts`

`openChat`, `leaveChat` and `forgetChatSilently` move here from `navigation.ts`, bodies unchanged.
`leaveRemovedFolderChat` is deleted. `shell-commands.ts` is the only importer
([section 9.2](#92-web-chat-navigation)). `navigation.ts` keeps `settingsUrl`, `openSettings`, `navigateSettings`,
`closeSettings`.

```ts
case 'navigate':
  if (command.history === 'replace') {
    // No history entry and no popstate, so nothing reports this change back: report it here.
    chatNavigation.forgetChatSilently();
    dispatch({ type: 'URL_CHANGED', sessionId: null });
  } else if (command.sessionId) chatNavigation.openChat(command.sessionId);
  else chatNavigation.leaveChat();
  return;
```

### 5.2 The three handlers

| Handler | After | State and history compared with today |
| --- | --- | --- |
| `ops.selectChat` | `dispatch(CHAT_PICKED { sessionId: id, workspaceId: selected?.workspaceId ?? null })`, then the small-screen `SIDEBAR_SET` | Same history write, same folder choice, in one step instead of two dispatches |
| Folder removal in `ops.savedFolderChanged` | `dispatch({ type: 'DRAFT_DISCARDED' })` under today's condition | `DRAFT_DISCARDED` is "back to the welcome screen" and emits `navigate` exactly when a chat is open. Differences: section 7, item 6 |
| User change in `ShellFeeds.tsx` | `dispatch({ type: 'USER_CHANGED' })`; the import of `forgetChatSilently` and the two other dispatches go | Same end state as today's `URL_CHANGED(null)` then `DRAFT_DISCARDED` (generation +2, no chat, no draft, empty box), still within the one effect run. Difference: section 7, item 7 |

`webShellEffects` for `ShellFeeds.tsx` goes from 7 to 6, and its reason drops "(two actions)".

### 5.3 Why the user change reports its own `URL_CHANGED`

Every other `navigate` waits for the page to report the new address (the `initialSessionId` prop, through Next's
router). Waiting here would leave the previous user's chat open and streaming until the router re-renders. Today
it closes in the same effect run. The command runner writes the address bar and then reports what it wrote;
`URL_CHANGED` is still the only action that changes `openChat`, and the later report from the prop is a no-op.

### 5.4 Settings navigation stays direct

`openSettings`, `navigateSettings` and `closeSettings` write `?settings=` and `?provider=`. The machine holds no
copy of either: `ShellEnv` reads them from props on every render, and no machine state depends on them. A command
for each would be a history write with no transition, and the rule exists to stop a second copy of *the open chat*
from being set by hand. They stay as plain functions called from components and from `ops.openProviderSetup`.

## 6. State ownership

| Today | Owner today | After |
| --- | --- | --- |
| `configBusy` | `runtime.local` | machine `configApply` (per chat) |
| `retryError` | `runtime.local` | machine `retryError` (per chat) |
| `retryDraft` (with `sessionId`) | `runtime.local` | machine `retryDraft` (per chat; `sessionId` field dropped) |
| `pageError` | `runtime.local` | machine `pageError` (page) |
| `ShellLocalState`, `ShellRuntime.local` | `shell-runtime.ts` | deleted |
| Readers of `shell.local` (`WelcomeChecklist`, `ChatColumn`, `ComposerToolbar`, `ChatNotices`, `TranscriptTurns`) | `useStoreSelector(shell.local, ...)` | `useShellState((s) => s.pageError)`, `(s) => s.configApply !== null`; `TranscriptTurns` selects `{ configBusy, retryError, retryDraft }` for its turn with `shallowEqual` and renders the offer on `retryDraft && turn.userText` |
| `ChatColumn`'s `shell.local.get().pageError` in `onRetry` | | `shell.store.get().pageError` |
| Chat history writes in `selectChat`, `savedFolderChanged`, `ShellFeeds` | called directly | the `navigate` command |
| Settings page: `projection`, `loading`, `loadError`, `revisionRef` | `Term2SettingsPage` state | `data.settings` plus the page's `opening` |
| Settings page: `writeChain`, conflict install | `Term2SettingsPage` | `data.writeSettings` (`settings-writer.ts`) |
| Settings page: `presets`, `providerTypes` | `Term2SettingsPage` state | `data.providerCatalog` via `useLoadOnOpen` |
| Settings page: `rowStatus`, `savedTimers`, `confirm`, `query`, `modelsChecked`, refs | `Term2SettingsPage` | unchanged |
| `onLoaded` (page → shell copy) | prop | deleted |
| Provider/credential/sign-in writes and their two re-reads | `ProvidersSection`, the page | `data.providers.*`, `data.providersChanged` |
| `ProvidersSection`: `busy`, `notice`, `editingConnection`, `signingIn`, form state | component | unchanged |
| `Term2ProviderSetup`: `catalog`, `catalogError`, `attempt` | component state | `data.providerCatalog` via `useLoadOnOpen` |
| `Term2ProviderSetup`: `path`, `provider`, `selectedModel` | component | unchanged |
| `Term2UsagePopover`: `quota` | `useSessionQuota` state | `data.quota` |
| `Term2UsagePopover`: `open`, the `responses` count and refresh string | component | unchanged |
| `Term2RewindDialog`: `targets`, `loading`, load error | component state | `data.rewindTargets` via `useLoadOnOpen` |
| `Term2RewindDialog`: `selectedId`, `busy`, rewind error | component | unchanged (`selectedId` null means "the default") |
| `resendFromTurn`'s target read | facade call in `shell-operations.ts` | `data.rewindTargets.loadOrFail` |
| `Term2FolderSelector`, `Term2SavedFolderMenu`, `Term2SessionConfig` | own requests | unchanged, recorded exceptions |

## 7. Behaviour changes

Everything else is meant to be unchanged. "Property" is `shell.machine-rules` unless named.

| # | Change | Why | Shown by |
| --- | --- | --- | --- |
| 1 | A settings change in flight in chat A no longer disables the pickers, Retry or Send in chat B | Fix asked for (`configBusy` per chat) | Flow A; property P1, P2 |
| 2 | A Retry's error under a reply is gone after leaving the chat | Fix asked for | Flow B; property P1 |
| 3 | The "open a new draft with ..." offer is gone after leaving the chat (today it survives leaving and coming back) | Follows from holding it per chat (section 1, item 2) | Property P1 |
| 4 | A Retry error or draft offer whose request answers after the user left is dropped (today it is stored and shown on return) | The tag rule | The property's existing stale-result assertion, which now sees the two new tagged actions |
| 5 | After leaving chat A mid-change and returning, a second change to A can start while the first is in flight (today one global flag blocks it). The gateway's revision check refuses one of them | Follows from 1. Race window only | Not exercised |
| 6 | Leaving a chat whose folder was removed: the message box empties at once (not when the address change is reported); the URL keeps its hash and never ends in a bare `?`; no history entry is added when the address bar names no chat | It now goes through `navigate` and `leaveChat` | Flow C |
| 7 | A user change also drops a first message waiting for its new chat (`pendingFirstSend`), and the address bar is cleared even when the machine has no chat open yet | The previous user's send must not run for the next user. Reached only between a first send's `navigate` and its report | Property P6 |
| 8 | The chat's two settings writes (favourite, blank-chat default) wait their turn behind other settings writes, and after a conflict the store holds the server's projection, so the next write works (today every later write conflicts until a reload; inferred from `writeSettings` having no `catch`) | One write path (section 1, item 4) | Property `web.settings-writes-in-order` |
| 9 | Quota, rewind-target and preset requests are no longer aborted when their screen closes; a late answer is dropped | `Resource` has no cancel | Request probe: same list |
| 10 | A load failure that is not an `Error` shows its string form instead of the fallback sentence, in the rewind dialog only | `Resource.error` is `messageOf(error)`. The facade throws `Term2ApiError` (inferred: not reachable) | Not exercised |

## 8. Checks

### 8.1 `scripts/generated-verification/shell.mjs` (extended, nothing removed)

New script steps: `pick_chat` (`CHAT_PICKED` for a chat in `CHATS`, folder or null), `user` (`USER_CHANGED`),
`config` (`CONFIG_APPLY_STARTED` with the current tag; when accepted, push `{ type: 'configApply', tag, requestId
}` to `pending`, settled by `CONFIG_APPLY_SETTLED`), `retry_fail` and `retry_offer` (push a late result with the
current tag; settling dispatches `RETRY_ERROR` / `RETRY_DRAFT` with a value or null), `page_error` (`PAGE_ERROR`
with a message or null). The harness's `navigate` branch is unchanged: it reports `URL_CHANGED` back.

New assertions, in `dispatch` after `state = next`:

- **P1.** `generation` changed ⇒ `configApply`, `retryError` and `retryDraft` are null.
  Message: `per-chat intent survived a change of what the page shows`.
- **P2.** `configApply` non-null ⇒ a chat is open, and the harness's record of the accepted start has the current
  tag. An accepted `CONFIG_APPLY_STARTED` never replaces one in flight (`before.configApply` was null).
- **P3.** A current `CONFIG_APPLY_SETTLED` with the held id leaves `configApply` null; with another id it changes
  nothing.
- **P4.** `pageError` differs from before only after `PAGE_ERROR`, an accepted `NEW_DRAFT` (null) or a current
  `DRAFT_START_FAILED` (its message). In particular `URL_CHANGED` leaves it.
- **P5.** `CHAT_PICKED` emits exactly one command, `navigate` to its chat, and changes nothing but `chosenFolder`
  (compared before the harness reports the URL back). After the report, `openChat` is that chat.
- **P6.** After `USER_CHANGED` and its report: `openChat`, `draft`, `sendIntent`, `pendingFirstSend`, `sending`
  are null, `starting` is false, the composer is `EMPTY_COMPOSER`, and its one command is `navigate` to null with
  `history: 'replace'`. The existing `unopened` bookkeeping treats `USER_CHANGED` like `DRAFT_DISCARDED`.
- The existing assertion "a result whose tag is not current changes nothing" covers the four new tagged actions
  with no edit.

Seeded faults to show red once each (not committed): drop `...NO_CHAT_INTENT` from `URL_CHANGED` (P1); remove
`!state.configApply` from `CONFIG_APPLY_STARTED` (P2); let `URL_CHANGED` clear `pageError` (P4); drop
`pendingFirstSend: null` from `USER_CHANGED` (P6).

### 8.2 `scripts/generated-verification/web-data.mjs`

- **`web.resource-latest-wins`, extended.** Build the resource with `describeError: (e) =>
  `described:${e.message}``. New invariant after every step: `error` is `described:failed <id>` exactly when the
  request started last has settled as a failure, and null otherwise (a local `set`/`update` does not change it).
  Seed: have a superseded request's failure write `error`.
- **`web.settings-writes-in-order`, new.** Imports `createSettingsWriter` and `createResource`. Steps (at most 30):
  `write`, `reread` (`settings.set` of a projection with a new revision, as a re-read installs), and `settle` with
  one of ok / conflict / fail. Invariants: at most one `write` call is unanswered at any time; each call's
  `expectedRevision` is the revision the store held when the call was made; a successful write's projection is
  installed and its caller resolves to it; a conflict's projection is installed and its caller rejects; a failed
  write leaves the store alone and the next write still runs; a write with nothing loaded rejects without a call.
  Seeds: call `write` without the chain; skip the install on conflict.

### 8.3 Browser flows (three in `shell-hazards.flow.ts`, one new file)

Flows A and B fail on `main` as it is. Write them first and record that run as their red.

- **A. "a settings change still in flight in one chat does not lock the next chat's controls".** Start as "an
  approval change that resolves after switching chats ...": two chats, hold chat A's first config `POST`, switch
  to B. Then, with A still held: B's approval chip is enabled; pick Smart auto-approve in B; the chip names it.
  Release A. Reload: B still names it. Proves change 1 end to end, including that B's own change is not refused.
  Red: on `f13a1ee0` (the chip is disabled), or with `URL_CHANGED` keeping `configApply`.
- **B. "a failed Retry's error does not wait for the user in the chat they left".** `twoChatsWithAOpen`; fulfil
  chat A's `GET .../rewind-targets` with a 500 once; press Retry under A's reply; an alert appears in that turn.
  Open B, then A: the turn has no alert. Proves change 2. Red: on `f13a1ee0`, or with `retryError` left out of
  `NO_CHAT_INTENT`.
- **C. "removing the open chat's folder leaves the chat".** One chat open; sidebar "Folder options for
  <folder>", "Remove folder…", confirm "Remove folder". Expect the welcome screen and no `agentSession` in the
  URL. Proves the folder-removal leave still happens through the machine; nobody exercised this path before
  (part one, section 15). Red: delete the `DRAFT_DISCARDED` dispatch from `savedFolderChanged`.
- **D. `tests/web-client/browser/settings.flow.ts`: "two settings changed one after the other on the settings
  page are both saved".** Open the settings page from the chat header; change two switch rows in quick succession
  (the builder picks two from `settings/settings-catalog.ts` that are not safety confirmations); both rows reach
  "Saved"; reload at the same URL: both hold. Go Back: the chat is shown. Proves the page reads and writes through
  `ServerData`, the queue reaches the page, and `closeSettings` still works. Red: make `createSettingsWriter`
  call `write` without waiting (the second write gets the gateway's 409 and its row shows the conflict message).

23 flows after this change. Check `node scripts/check-ci-budget.mjs` for the `web-browser` lane; four short flows
are expected to fit (inferred, not measured).

## 9. Guards

Reminders, in the existing pattern. No change to `scripts/gates/architecture-rules.mjs`.

### 9.1 `web-shell-requests` covers every component

In `scripts/gates/web-shell-rules.mjs`: `web-shell-effects` keeps its scan (`Term2SessionShell.tsx` and
`components/term2/shell/`). `web-shell-requests` scans every `.ts`/`.tsx` under `web-client/components/` and
`web-client/hooks/`. Violation line: `` `${file}:${line}: imports the HTTP facade ('${specifier}') into a
component` ``. An entry in `webShellRequests` whose file no longer imports the facade is reported:
`` `rule-baseline.json webShellRequests names ${file}, which does not import the HTTP facade; remove it` ``.

`scripts/rule-baseline.json`:

```json
"webShellRequests": [
  { "file": "web-client/components/term2/Term2FolderSelector.tsx",
    "reason": "Its validate, browse and select calls each spend a capability token the previous answer issued, inside one dialog: nothing to cache or share. Its result reaches the data layer through ops.folderSelected." },
  { "file": "web-client/components/term2/Term2SavedFolderMenu.tsx",
    "reason": "Two writes (change access, remove) with the menu's own busy and error line; the result goes to ops.savedFolderChanged, which refreshes folders and chats. Move them behind ServerData if a third caller appears." },
  { "file": "web-client/components/term2/Term2SessionConfig.tsx",
    "reason": "The diagnostics panel owns one configure command's original request and receipt for retry (SOURCE.md); it holds no fetched data and reports discovery to the machine as CONFIG_LOADED." }
]
```

Rule text in `scripts/gates/rules.mjs`:

```js
'web-shell-requests': {
  title: 'Components do not call the server',
  why:
    'Server data has one home, web-client/lib/term2/data/server-data.ts, with one meaning of loading, failed and ' +
    'refreshed, one rule for a response that arrives late, and one queue for settings writes. A request made from ' +
    'a component brings back its own loading flag, error string, stale check and copy of the data: the settings ' +
    'page once kept a second settings projection this way and reported it to the shell through a callback.',
  fix:
    'Read through a resource in server-data.ts (add one there for new data) with useStoreSelector, or ' +
    'hooks/useLoadOnOpen.ts for a screen that asks when it opens. Put a write that makes other data stale beside ' +
    'the re-read it needs (data.providers, data.writeSettings). Put an action with several steps in ' +
    'web-client/lib/term2/shell/shell-operations.ts and call it as shell.ops.<name>.',
  avoid: 'Do not pass term2Client in through props or context, and do not re-export it from another module.',
  exceptions: {
    file: 'scripts/rule-baseline.json',
    entry: 'webShellRequests: { "file": "<component file>", "reason": "..." }',
    note: 'for a component whose requests are steps of its own flow and leave nothing to share',
  },
},
```

### 9.2 `web-chat-navigation`

New rule in `web-shell-rules.mjs`, reusing `facadeImports`' import matching. Scan `.ts`/`.tsx` under
`web-client/components`, `hooks` and `lib` (skip `generated`, `node_modules`). Report any import, type-only or
not, whose specifier resolves to `web-client/lib/term2/chat-navigation` from a file other than
`web-client/lib/term2/shell/shell-commands.ts`. Violation line:
`` `${file}:${line}: imports chat-navigation; only shell-commands.ts writes the open chat into the address bar` ``.

```js
'web-chat-navigation': {
  title: 'Only the navigate command writes the open chat into the address bar',
  why:
    'The address bar owns which chat is open, and the shell machine learns of a change only as URL_CHANGED. A ' +
    'handler that writes history itself changes the chat without the machine deciding it: the machine cannot ' +
    'clear what belongs to the old chat first, and shell.machine-rules cannot see the move. Three handlers did ' +
    'this until they were moved (docs/plans/web-client/web-shell-decomposition-part2.md, section 5).',
  fix:
    'Dispatch an action whose step() case returns a navigate command (CHAT_PICKED, NEW_DRAFT, DRAFT_DISCARDED, ' +
    'USER_CHANGED), or add one. The settings parameters are not the open chat: use lib/term2/navigation.ts.',
  avoid: 'Do not copy the history write into another module or call window.history from a component.',
  exceptions: null,
},
```

`scripts/check-rules.mjs`' header comment lists it as rule 13.

### 9.3 `scripts/prove-checks.sh`

Two seeds added; the existing four web seeds stay.

- "a leaf component imports the HTTP facade": append a `term2Client` import to
  `web-client/components/term2/Term2QueueBar.tsx`, expect `\[web-shell-requests\]`.
- "a component writes the chat into the address bar": append `import { openChat as seededOpen } from
  "../../../lib/term2/chat-navigation"; export const seededNav = seededOpen;` to
  `web-client/components/term2/shell/ChatSidebar.tsx`, expect `\[web-chat-navigation\]`.

### 9.4 File-size ceilings (`scripts/complexity-budget.json`)

Re-count after the build (the gate counts newlines). A ceiling equals the file's count or is removed.

| File | Now | Expected | Action |
| --- | --- | --- | --- |
| `web-client/lib/term2/shell-machine.ts` | 540 | about 450 | Remove the entry. If it is still over 500, set the count and say in the reason that the types already live in `shell-state.ts` |
| `web-client/lib/term2/shell-state.ts` | new | about 260 | none |
| `web-client/components/term2/settings/Term2SettingsPage.tsx` | 940 | about 880 | Lower. Reason: "Recorded when the gate first covered web-client (2026-11). It reads and writes through lib/term2/data/server-data.ts; what remains is one component rendering every section. Split per section when settings is next reworked." |
| `web-client/components/term2/settings/ProvidersSection.tsx` | 986 | about 980 | Lower to the count; reason unchanged |
| The other six | | unchanged | none |

`Term2FolderSelector.tsx`'s reason stays true. No new file may exceed 500; `server-data.ts` is expected near 260
and `shell-operations.ts` near 410.

## 10. Build order

One change. After each step the typecheck passes (`node scripts/build-web-fold.mjs && pnpm --dir web-client exec
tsc --noEmit`) and `pnpm verify:generated --target shell` and `--target data` run.

0. **Baseline on `f13a1ee0`.** `pnpm build && node scripts/build-web.mjs && pnpm test:web-browser` (19 green);
   `pnpm verify:generated`. Record the probes of section 11. Write flows A and B and record them red.
1. **Split the machine's types.** `shell-state.ts`; `shell-machine.ts` re-exports. No behaviour. `shell.mjs`
   untouched and green.
2. **Machine state and rules.** Section 4.2 and 4.3 in `shell-state.ts`/`shell-machine.ts`; extend `shell.mjs`
   (section 8.1); show the four seeds red. Nothing dispatches the new actions yet, and `local` still exists.
3. **Move `local` into the machine.** Section 4.4 and the reader rows of section 6; delete `ShellLocalState` and
   `local`; `Term2RetryReply` loses `onError`. Flows A and B turn green; the 19 stay green.
4. **Navigation.** `chat-navigation.ts`; the runner's `navigate` case; `selectChat`, `savedFolderChanged`,
   `ShellFeeds`; baseline count 6. Add flow C.
5. **Data primitives.** `describeError`; `settings-writer.ts`; the `ServerData` additions; `useLoadOnOpen.ts`;
   `useServerData`; both `web-data.mjs` properties with their seeds. `writeSettings` now queues, so the chat's two
   writes change here (change 8). No component uses the rest yet.
6. **Leaves, smallest first, flows after each:** `Term2UsagePopover`; `Term2RewindDialog` with `resendFromTurn`;
   `Term2ProviderSetup` with `ProvidersSection` and `ProviderDialog` (they share props, so they move together);
   `Term2SettingsPage` with `SettingsRegion`. Add flow D. Run the probes.
7. **Guards.** Section 9; `bash scripts/prove-checks.sh`; `node scripts/check-rules.mjs`,
   `node scripts/check-complexity.mjs`, `node scripts/check-baselines.mjs`, `pnpm check:no-unit-tests`.
8. **Docs.** `SOURCE.md` (below); the header comment of `shell-machine.ts` (slices: add per-chat intent and the
   page error; "handlers emit `navigate`" now names `chat-navigation.ts`); file headers of `server-data.ts`,
   `shell-runtime.ts`, `navigation.ts`; part one's status line (it names a branch; replace with "merged as
   `f13a1ee0`") and one line there pointing to this file; a "Build notes" section at the end of this file.

`SOURCE.md` edits, in "Entry points and caller responsibilities": the `shell-runtime.ts` row (no `local`); the
`server-data.ts` row (nine resources, the settings write queue, `providers`, `providersChanged`, `useLoadOnOpen`);
the `Term2SettingsPage` row (it reads `data.settings` and no longer loads or reports its own projection; props
without `onLoaded`/`onModelsChanged`); the `shell-machine.ts#step` row (the four new state fields, the seven
actions, `navigate`'s `history`); a new row for `lib/term2/chat-navigation.ts`; in "Facade and BFF boundaries", the
`readSessionQuota` sentence keeps its meaning (the popover decides when; `data.quota` holds the value).

Then the independent verifier.

## 11. Evidence

Risk: **high** (the `verification` skill's level for approval and settings paths: this change rewrites the gate on
applying an approval mode, the settings write path including credentials, and the machine). Independent verifier
required; give them the diff, section 7 and the probe outputs.

| Claim | Check |
| --- | --- |
| Compiles | the typecheck command in section 10 |
| Existing behaviour holds | 19 existing flows green; `git diff f13a1ee0 -- tests/web-client/browser` shows additions only |
| The two fixes | Flows A and B: red on `f13a1ee0`, green on the branch |
| Machine rules | `pnpm verify:generated --target shell`; each seed of section 8.1 red once; `git diff f13a1ee0 -- scripts/generated-verification/shell.mjs` removes no assertion |
| Data rules | `pnpm verify:generated --target data`; each seed of section 8.2 red once |
| Navigation still works | Flow C; the existing flows switch chats through the sidebar (`CHAT_PICKED`) |
| Settings page reads and writes one projection | Flow D |
| Same DOM in the moved leaves | **Temporary probe**, not committed, as in part one's section 9: `main.outerHTML` with volatile values masked, on `f13a1ee0` and the branch, for: settings page in each section, a provider's detail, add-provider list; the provider dialog at each of its three paths; the rewind dialog loading and loaded; the usage popover open; a failed Retry's alert; the welcome screen with a page error (stop the gateway's folder list with a route) |
| Same requests | **Temporary probe:** `method path` of every `/api/` request for: open settings, change a setting, add and remove an API key for one provider, toggle a provider; open and close the rewind dialog; send a message with the usage chip shown and open it; Retry a reply. Equal multisets on both revisions |
| Guards catch what they claim | `prove-checks.sh` shows the two new seeds caught |
| Not verified by anything here | A real user change (the client has one fixed user: property only); OAuth sign-in; change 5 |

## 12. Risks

| Risk | What to do |
| --- | --- |
| `applySessionConfig` returns before `CONFIG_APPLY_SETTLED` on some path and the chat stays busy | Keep the dispatch in `finally`; P3 covers the machine side, flow A the wiring |
| A stale `CONFIG_APPLY_SETTLED` is dropped and leaves a flag behind | It cannot: leaving cleared `configApply` (P1) |
| The settings page flashes held data before its own read | `projection` is null until `opening === 'ready'`; DOM probe of the loading state |
| A later failed re-read blanks the open settings page | `opening` never leaves `'ready'`; today's `reload` keeps the projection too |
| `providers.*` re-reads in a different order or count | Section 3.3's rule per method; request probe |
| The page's credential rows now also re-read models | They pass `'settings'` |
| `useLoadOnOpen` in React dev StrictMode asks twice | So do today's effects; the last request wins and both callbacks record the same key |
| `export * from './shell-state'` under `tsx` in `shell.mjs` | `web-data.mjs` already loads `resource.ts`, which imports `../store` the same way |
| Nested `dispatch` from the runner's `replace` branch | `dispatch` assigns state before running commands; the nested call sees the new state. Do not move the command loop before the assignment |
| `TranscriptTurn` re-renders more: its selector now reads the machine store | It returns three scalars/objects compared with `shallowEqual`; re-run part one's render-count probe for 20 keystrokes (expect 0) |
| A flow added to `tests/web-client/browser/` later looks like a deletion to the label check | It only flags deleted or emptied files; adding is free |

## 13. Do not

- Do not weaken or delete an assertion in `shell.mjs`, `web-data.mjs` or a flow, and do not touch
  `scripts/gates/architecture-rules.mjs`, `session-store.ts`, `present.ts` or the fold.
- Do not add an action other than `URL_CHANGED` that changes `openChat`.
- Do not reset `pageError` on a chat change.
- Do not use `ensure` for rewind targets, quota, presets or the settings page's read: each opening asks again.
- Do not show held data before a screen's own request answers (section 3.4), unless the owner says so.
- Do not move `Term2FolderSelector`, `Term2SavedFolderMenu` or `Term2SessionConfig` onto `ServerData`.
- Do not route settings navigation through the machine.
- Do not pass `ServerData` or the facade through props; leaves call `useServerData()`.
- Do not change a class name, label, title or `aria-` attribute, or the order of elements.
- Do not add a dependency.
- Do not commit the probes.

## 14. For the owner

1. **Data layer:** stay in-house (recommended, section 3.2), or adopt TanStack Query?
2. **`retryDraft`** is cleared on leaving the chat, like `retryError` (section 7, change 3). Accept, or keep it
   across a leave-and-return?
3. **`pageError`** stays page-level and is not cleared on a chat change (section 1, item 1). Accept?
4. **Screens that open over held data** keep their loading line (section 1, item 5). Accept, or show the held
   settings, presets and rewind targets at once and refresh behind them (a visible change, a small follow-up)?
5. **The chat's settings writes** now queue and recover from a conflict (section 7, change 8). Accept?
6. **A third reminder rule**, `web-chat-navigation` (section 9.2). Keep, or rely on the file split alone?
