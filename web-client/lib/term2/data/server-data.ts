/**
 * The chat page's server data in one place (docs/plans/web-client/web-shell-decomposition.md, section 4.6): the
 * settings projection, the model catalog, skills, the `@` file listing, saved folders and the chat list, each a
 * `Resource` with the same loading, error and late-response rule. The open chat's config is not here: it stays in
 * the shell machine under the tag rule. No React here.
 */
import { term2Client } from '../../api/term2';
import { createStore, type Store } from '../store';
import type {
  ModelSummary,
  SessionListItem,
  SessionProjection,
  SettingsProjection,
  SkillSummary,
  WorkspaceAlias,
  WorkspaceFileEntry,
} from '../types';
import { createResource, type Resource } from './resource';
import type { FolderDetail } from './folder-info';

export type ChatList = { readonly sessions: SessionListItem[]; readonly nextCursor: string | null };
export type FileScope = { readonly kind: 'session' | 'workspace'; readonly id: string };
export const fileScopeKey = (scope: FileScope) => `${scope.kind}:${scope.id}`;

export interface ServerData {
  readonly settings: Resource<SettingsProjection | null>;
  readonly models: Resource<ModelSummary[]>;
  readonly skills: Resource<SkillSummary[]>;
  readonly files: Resource<WorkspaceFileEntry[]>;
  readonly folders: Resource<WorkspaceAlias[]>;
  readonly chats: Resource<ChatList>;
  /** What a folder pick returned in this page load. */
  readonly folderDetails: Store<Readonly<Record<string, FolderDetail>>>;
  ensureFiles(scope: FileScope): void;
  loadMoreChats(): Promise<void>;
  chatCreated(projection: SessionProjection): void;
  chatTitled(sessionId: string, firstLine: string): void;
  /** Writes against the loaded revision and installs the returned projection. Throws on failure or when not loaded. */
  writeSettings(changes: Array<{ key: string; value: unknown }>): Promise<SettingsProjection>;
}

const NO_MODELS: ModelSummary[] = [];
const NO_SKILLS: SkillSummary[] = [];
const NO_FILES: WorkspaceFileEntry[] = [];
const NO_FOLDERS: WorkspaceAlias[] = [];
const NO_CHATS: ChatList = { sessions: [], nextCursor: null };

export function createServerData(options: { localControlEnabled: boolean }): ServerData {
  const client = term2Client;
  const settings = createResource<SettingsProjection | null>({ initial: null, fetch: () => client.readSettings() });
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
    fetch: async () => (await client.listSkills()).skills,
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

  return {
    settings,
    models,
    skills,
    files,
    folders,
    chats,
    folderDetails,
    ensureFiles: (scope) => files.ensure(fileScopeKey(scope)),
    async loadMoreChats() {
      const cursor = chats.get().data.nextCursor;
      if (!cursor) return;
      const page = await client.listSessions(20, cursor);
      chats.update((current) => ({
        sessions: [
          ...current.sessions,
          ...page.sessions.filter((item) => !current.sessions.some((existing) => existing.id === item.id)),
        ],
        nextCursor: page.nextCursor,
      }));
    },
    chatCreated(projection) {
      chats.update((current) => ({
        ...current,
        sessions: [
          {
            id: projection.id,
            workspaceId: projection.workspaceId,
            status: projection.status,
            createdAt: projection.createdAt,
            updatedAt: projection.updatedAt,
            latestSequence: projection.latestSequence,
          },
          ...current.sessions.filter((item) => item.id !== projection.id),
        ],
      }));
    },
    chatTitled(sessionId, firstLine) {
      chats.update((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === sessionId && !item.title
            ? { ...item, title: firstLine, updatedAt: new Date().toISOString() }
            : item,
        ),
      }));
    },
    async writeSettings(changes) {
      const current = settings.get().data;
      if (!current) throw new Error('Settings are not loaded.');
      const result = await client.writeSettings({ expectedRevision: current.revision, changes });
      settings.set(result.projection);
      return result.projection;
    },
  };
}
