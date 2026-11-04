/** Workspace resume rows from the catalogue, plus a short prefix of each log for the title. */
import { statSync } from 'node:fs';
import path from 'node:path';
import { withNativeCatalogue, type NativeIndexer } from './native-catalogue.js';
import { directLogicalEnds, readDirectLogHeaderLine } from './direct-rolling-log.js';
import { readDirectResumeTitle } from './direct-list-preview.js';
import type { DirectLiveListing, DirectLocalStore } from './direct-store.js';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';

/** Rows the picker shows, as in legacy (`listRecentConversations(..., 10)`). */
const RESUME_LIMIT = 10;

/**
 * The newest sessions that start in `root`, by head-file time, from headers alone. Legacy stats every log and
 * parses only the newest few; indexing the rest (a cold catalogue reads every log whole) is not needed to list them.
 */
function recentInWorkspace(ends: ReturnType<typeof directLogicalEnds>, root: string): Set<string> {
  const stamped: { id: string; rootPath: string; time: number }[] = [];
  for (const [id, end] of ends) {
    try {
      stamped.push({ id, rootPath: end.rootPath, time: statSync(end.headPath).mtimeMs });
    } catch {
      /* A log that vanished is not listed. */
    }
  }
  stamped.sort((a, b) => b.time - a.time);
  const recent = new Set<string>();
  for (const candidate of stamped) {
    if (recent.size >= RESUME_LIMIT) break;
    try {
      const line = readDirectLogHeaderLine(candidate.rootPath);
      const workspace = line ? (JSON.parse(line.toString('utf8')).fact?.workspace as unknown) : undefined;
      // Anything this cannot judge is left to the catalogue's own workspace check.
      if (typeof workspace === 'string' && path.resolve(workspace) !== root) continue;
    } catch {
      continue;
    }
    recent.add(candidate.id);
  }
  return recent;
}

/** Sessions in one project. Open sessions come from memory; the others are not replayed. */
export async function listDirectResumeSessions(
  directory: string,
  indexer: NativeIndexer,
  root: string,
  store: Pick<DirectLocalStore, 'liveListings'>,
  resolveWorkspace: (root: string, identity?: Workspace) => Workspace | Promise<Workspace>,
): Promise<Awaited<ReturnType<DirectLocalStore['listWorkspace']>>> {
  const live = store.liveListings();
  const resolvedRoot = path.resolve(root);
  const ends = directLogicalEnds(directory);
  const recent = recentInWorkspace(ends, resolvedRoot);
  const entries = withNativeCatalogue(
    directory,
    indexer,
    (catalogue) =>
      catalogue
        .list({ target: 'local', root: resolvedRoot }, { includeBound: true })
        .filter((entry) => recent.has(entry.id)),
    // Lineages outside the recent set are left unread (and unstamped) until a search needs them.
    { skip: [...ends.keys()].filter((id) => !recent.has(id) || live.some((session) => session.id === id)) },
  );
  const listed = new Map(entries.map((entry) => [entry.id, entry]));
  // An open session competes for the newest ten by its log time like any other (legacy counts it in the ten).
  const open = new Map(live.filter((session) => recent.has(session.id)).map((session) => [session.id, session]));
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
    try {
      // Legacy ages every row by the file's mtime, not by the timestamp inside its last line.
      updatedAt = statSync(ends.get(id)?.headPath ?? rootPath).mtime.toISOString();
    } catch {
      /* The catalogue time still describes the last indexed line. */
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
