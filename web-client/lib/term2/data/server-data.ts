/**
 * The chat page's server data in one place (docs/plans/web-client/web-shell-decomposition.md, section 4.6, and
 * web-shell-decomposition-part2.md, section 3): the settings projection, the model catalog, skills, the `@` file
 * listing, saved folders, the chat list, the open chat's rewind points, and the provider catalog, each a
 * `Resource` with the same loading, error and late-response rule. Settings writes go through one queue
 * (settings-writer.ts); a provider, credential or sign-in write re-reads what it made stale. The open chat's config is
 * not here: it stays in the shell machine under the tag rule. No React here.
 */
import { SettingsConflictError, Term2ApiError, term2Client } from '../../api/term2';
import { createStore, type Store } from '../store';
import type {
  ModelSummary,
  ProviderPresetEntry,
  ProviderWriteInput,
  RewindTargetSummary,
  SessionListItem,
  SessionProjection,
  SettingsProjection,
  SkillSummary,
  SshHostAlias,
  WorkspaceAlias,
  WorkspaceFileEntry,
} from '../types';
import { createResource, type Resource } from './resource';
import type { FolderDetail } from './folder-info';
import { createSettingsWriter, type SettingsChange } from './settings-writer';

export type ChatList = { readonly sessions: SessionListItem[]; readonly nextCursor: string | null };
export type FileScope = { readonly kind: 'session' | 'workspace'; readonly id: string };
export const fileScopeKey = (scope: FileScope) => `${scope.kind}:${scope.id}`;
export type ProviderCatalog = { readonly presets: ProviderPresetEntry[]; readonly types: string[] };
type Client = typeof term2Client;

/** A write that changed a provider, a key or a sign-in, and re-reads what it made stale before it resolves. */
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

/** Whether a settings write failed because the settings changed somewhere else (their projection is installed). */
export const isSettingsConflict = (error: unknown) => error instanceof SettingsConflictError;
/** The HTTP status of a failed request, when the server answered. */
export const errorStatus = (error: unknown): number | null => (error instanceof Term2ApiError ? error.status : null);

export interface ServerData {
  readonly settings: Resource<SettingsProjection | null>;
  readonly models: Resource<ModelSummary[]>;
  readonly skills: Resource<SkillSummary[]>;
  readonly sshHosts: Resource<SshHostAlias[]>;
  readonly files: Resource<WorkspaceFileEntry[]>;
  readonly folders: Resource<WorkspaceAlias[]>;
  readonly chats: Resource<ChatList>;
  /** What a folder pick returned in this page load. */
  readonly folderDetails: Store<Readonly<Record<string, FolderDetail>>>;
  addSshWorkspace(body: {
    target: string;
    port?: number;
    directory?: string;
    access: 'read' | 'read_write';
  }): Promise<WorkspaceAlias>;
  ensureFiles(scope: FileScope): void;
  loadMoreChats(): Promise<void>;
  applySnapshot(sessions: readonly SessionListItem[], nextCursor: string | null): void;
  upsertSession(session: SessionListItem): void;
  removeSession(sessionId: string): void;
  chatCreated(projection: SessionProjection): void;
  chatTitled(sessionId: string, firstLine: string): void;
  /** Key: chat id. Never `ensure`d: a turn or a rewind changes the list. */
  readonly rewindTargets: Resource<RewindTargetSummary[]>;
  readonly providerCatalog: Resource<ProviderCatalog>;
  /**
   * Queued: one at a time, each against the revision held when its turn comes. Installs the returned projection, or
   * after a conflict the server's (and rejects). Throws when settings are not loaded.
   */
  writeSettings(changes: SettingsChange[]): Promise<SettingsProjection>;
  /** Settings, then the model list. Resolves to the settings read, or null when it failed. Never rejects. */
  providersChanged(): Promise<SettingsProjection | null>;
  readonly providers: ProviderWrites;
}

const NO_MODELS: ModelSummary[] = [];
const NO_SKILLS: SkillSummary[] = [];
const NO_FILES: WorkspaceFileEntry[] = [];
const NO_FOLDERS: WorkspaceAlias[] = [];
const NO_CHATS: ChatList = { sessions: [], nextCursor: null };

function sortCanonical(sessions: readonly SessionListItem[]): SessionListItem[] {
  return [...sessions].sort((a, b) =>
    a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export function createServerData(options: { localControlEnabled: boolean }): ServerData {
  const client = term2Client;
  const settings = createResource<SettingsProjection | null>({
    initial: null,
    fetch: () => client.readSettings(),
    describeError: (error) =>
      error instanceof Term2ApiError && error.status === 503
        ? 'Local settings are not available in this deployment.'
        : error instanceof Error && error.message
          ? error.message
          : 'Settings could not be loaded.',
  });
  const catalog = createResource<ModelSummary[]>({
    initial: NO_MODELS,
    fetch: async () => (await client.listModels()).models,
  });
  // With local control off there is no model catalog to ask for.
  const models: Resource<ModelSummary[]> = options.localControlEnabled
    ? catalog
    : { ...catalog, load: async () => null, ensure: () => undefined };
  const skills = createResource<SkillSummary[]>({
    initial: NO_SKILLS,
    fetch: async (key) => (await client.listSkills(key || undefined)).skills,
  });
  const sshHosts = createResource<SshHostAlias[]>({
    initial: [],
    fetch: async () => (await client.listSshHosts()).hosts,
  });
  const files = createResource<WorkspaceFileEntry[]>({
    initial: NO_FILES,
    fetch: async (key) => {
      const [kind, ...rest] = (key ?? '').split(':');
      const id = rest.join(':');
      const listing = kind === 'session' ? await client.listSessionFiles(id) : await client.listWorkspaceFiles(id);
      return listing.entries;
    },
  });
  const folders = createResource<WorkspaceAlias[]>({
    initial: NO_FOLDERS,
    fetch: async () => (await client.listWorkspaces(20)).workspaces,
  });
  const chats = createResource<ChatList>({
    initial: NO_CHATS,
    fetch: async () => {
      const page = await client.listSessions(20);
      return { sessions: page.sessions, nextCursor: page.nextCursor };
    },
  });
  const folderDetails = createStore<Readonly<Record<string, FolderDetail>>>({});
  const rewindTargets = createResource<RewindTargetSummary[]>({
    initial: [],
    fetch: async (key) => (await client.listRewindTargets(key!)).targets,
  });
  const providerCatalog = createResource<ProviderCatalog>({
    initial: { presets: [], types: [] },
    fetch: () => client.listProviderPresets(),
  });
  const writeSettings = createSettingsWriter({
    settings,
    write: (input) => client.writeSettings(input),
    conflictProjection: (error) => (error instanceof SettingsConflictError ? error.projection : null),
  });
  // Settings, then the model list: the order a provider row awaits before its notice. `refresh`, not `load`:
  // nothing shows settings as loading meanwhile.
  const providersChanged = async () => {
    const latest = await settings.refresh().catch(() => null);
    await models.load();
    return latest;
  };
  const reread = async (what: 'settings' | 'settings+models') => {
    if (what === 'settings') await settings.refresh().catch(() => null);
    else await providersChanged();
  };

  return {
    settings,
    models,
    skills,
    sshHosts,
    files,
    folders,
    chats,
    folderDetails,
    async addSshWorkspace(body) {
      const workspace = await client.addSshWorkspace(body);
      await folders.refresh().catch(() => null);
      return workspace;
    },
    ensureFiles: (scope) => files.ensure(fileScopeKey(scope)),
    async loadMoreChats() {
      const cursor = chats.get().data.nextCursor;
      if (!cursor) return;
      const page = await client.listSessions(20, cursor);
      chats.update((current) => ({
        sessions: sortCanonical([
          ...current.sessions,
          ...page.sessions.filter((item) => !current.sessions.some((existing) => existing.id === item.id)),
        ]),
        nextCursor: page.nextCursor,
      }));
    },
    applySnapshot(sessions, nextCursor) {
      chats.replace({ sessions: sortCanonical(sessions), nextCursor });
    },
    upsertSession(session) {
      chats.update((current) => ({
        sessions: sortCanonical([session, ...current.sessions.filter((item) => item.id !== session.id)]),
        nextCursor: current.nextCursor,
      }));
    },
    removeSession(sessionId) {
      chats.update((current) => ({
        sessions: current.sessions.filter((item) => item.id !== sessionId),
        nextCursor: current.nextCursor,
      }));
    },
    chatCreated(projection) {
      chats.update((current) => ({
        ...current,
        sessions: sortCanonical([
          {
            id: projection.id,
            workspaceId: projection.workspaceId,
            status: projection.status,
            createdAt: projection.createdAt,
            updatedAt: projection.updatedAt,
            latestSequence: projection.latestSequence,
            ...(projection.title ? { title: projection.title } : {}),
            ...(projection.model ? { model: projection.model } : {}),
          },
          ...current.sessions.filter((item) => item.id !== projection.id),
        ]),
      }));
    },
    chatTitled(sessionId, firstLine) {
      chats.update((current) => ({
        ...current,
        sessions: sortCanonical(
          current.sessions.map((item) =>
            item.id === sessionId && !item.title
              ? { ...item, title: firstLine, updatedAt: new Date().toISOString() }
              : item,
          ),
        ),
      }));
    },
    rewindTargets,
    providerCatalog,
    writeSettings,
    providersChanged,
    providers: {
      async saveProvider(input) {
        const result = await client.writeProvider(input);
        if (result.ok) await providersChanged();
        return result;
      },
      async deleteProvider(providerId) {
        const result = await client.deleteProvider(providerId);
        if (result.ok) await providersChanged();
        return result;
      },
      async setCredential(id, value, what = 'settings+models') {
        const result = await client.setCredential(id, value);
        await reread(what);
        return result;
      },
      async deleteCredential(id, what = 'settings+models') {
        const result = await client.deleteCredential(id);
        await reread(what);
        return result;
      },
      async oauthLogin(provider) {
        const result = await client.oauthLogin(provider);
        if (result.status === 'completed') await providersChanged();
        return result;
      },
      async oauthSelect(provider, accountId) {
        const result = await client.oauthSelect(provider, accountId);
        if (result.ok) await providersChanged();
        return result;
      },
      async oauthDelete(provider, accountId) {
        const result = await client.oauthDelete(provider, accountId);
        if (result.ok) await providersChanged();
        return result;
      },
    },
  };
}
