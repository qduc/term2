/** Workspace resume rows from the catalogue, plus a short prefix of each log for the title. */
import path from 'node:path';
import { withNativeCatalogue } from './native-catalogue.js';
import { directLogicalEnds } from '../session/direct-rolling-log.js';
import { readDirectResumeTitle, readDirectResumeUpdatedAt } from '../session/direct-list-preview.js';
import type { DirectLiveListing, DirectLocalStore } from '../session/direct-store.js';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';

/** Sessions in one project. Open sessions come from memory; the others are not replayed. */
export async function listDirectResumeSessions(
  directory: string,
  root: string,
  store: Pick<DirectLocalStore, 'liveListings'>,
  resolveWorkspace: (root: string, identity?: Workspace) => Workspace | Promise<Workspace>,
): Promise<Awaited<ReturnType<DirectLocalStore['listWorkspace']>>> {
  const live = store.liveListings();
  const entries = withNativeCatalogue(
    directory,
    (catalogue) => catalogue.list({ target: 'local', root: path.resolve(root) }, { includeBound: true }),
    { skip: live.map((session) => session.id) },
  );
  const ends = directLogicalEnds(directory);
  const listed = new Map(entries.map((entry) => [entry.id, entry]));
  const open = new Map(live.map((session) => [session.id, session]));
  const sessions: Awaited<ReturnType<DirectLocalStore['listWorkspace']>>['sessions'][number][] = [];
  for (const id of new Set([...listed.keys(), ...open.keys()])) {
    const entry = listed.get(id);
    const current = open.get(id);
    const storedRoot = current?.workspace.root ?? entry?.workspace;
    if (!storedRoot) continue;
    let workspace: Workspace;
    try {
      workspace = await resolveWorkspace(storedRoot, current?.workspace);
    } catch {
      continue;
    }
    if (workspace.target === 'local') workspace = { ...workspace, root: path.resolve(workspace.root) };
    if (workspace.target !== 'local' || workspace.root !== path.resolve(root)) continue;
    const model = modelOf(current, entry);
    if (!model) continue;
    const rootPath = ends.get(id)?.rootPath ?? path.join(directory, `${id}.jsonl`);
    let title: string | undefined;
    try {
      title = readDirectResumeTitle(rootPath);
    } catch {
      title = undefined;
    }
    const messageCount = current?.messageCount ?? entry?.displayed ?? undefined;
    let updatedAt = entry?.updated;
    if (current) {
      try {
        updatedAt = readDirectResumeUpdatedAt(ends.get(id)?.headPath ?? rootPath) ?? updatedAt;
      } catch {
        /* The catalogue time still describes the last indexed line. */
      }
    }
    sessions.push({
      id,
      workspace,
      model,
      ...(messageCount !== undefined && messageCount !== null ? { messageCount } : {}),
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return { sessions: sessions.sort((left, right) => left.id.localeCompare(right.id)) };
}

function modelOf(
  current: DirectLiveListing | undefined,
  entry: { readonly provider: string | null; readonly model: string } | undefined,
): ModelRef | undefined {
  if (current) return current.model;
  if (entry?.provider && entry.model) return { provider: entry.provider, model: entry.model };
  return undefined;
}
