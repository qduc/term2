/** Read-only CLI discovery. Native logical lineages are the only history source. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readDirectSessionStart } from '../session/session-start.js';
import { readDirectListDetails } from '../session/list-preview.js';
import { withNativeCatalogue, type NativeCatalogueEntry } from './native-catalogue.js';
import { resolveDirectRemoteConnection } from './remote-config.js';
import type { SessionOptions } from './cli-args.js';
import { formatResumeList } from '../session/conversation/resume-list.js';
import { displaySessionId, storedSessionId } from '../protocol/session-id.js';

const NATIVE_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Selection = { readonly target: string; readonly root: string | null };

async function selection(options: SessionOptions): Promise<Selection> {
  if (!options.ssh) return { target: 'local', root: path.resolve(process.cwd()) };
  // Resolves SSH config only, without connecting. The runtime still obtains the
  // current workspace grant before opening a selected conversation for writing.
  const connection = await resolveDirectRemoteConnection({
    target: options.ssh.target,
    ...(options.ssh.remoteDir === null ? {} : { directory: options.ssh.remoteDir }),
    ...(options.ssh.port === null ? {} : { port: options.ssh.port }),
    lite: options.lite,
    access: 'read_write',
  });
  return { target: connection.target, root: connection.directory ?? null };
}

function belongsTo({ metadata }: ReturnType<typeof readDirectSessionStart>, selected: Selection): boolean {
  const target = metadata.workspaceIdentity?.target ?? (metadata.binding?.client === 'ssh' ? null : 'local');
  if (target !== selected.target) return false;
  if (selected.root === null) return true;
  const normalize = selected.target === 'local' ? path.resolve : path.posix.normalize;
  return normalize(metadata.workspace) === normalize(selected.root);
}

type Unreadable = readonly { readonly logical: string; readonly reason: string }[];

function recentWithUnreadable(
  directory: string,
  selected: Selection,
): { entries: readonly NativeCatalogueEntry[]; unreadable: Unreadable } {
  return withNativeCatalogue(directory, (catalogue) => ({
    entries: catalogue.list({
      ...selected,
      ...(selected.target === 'local' ? {} : { binding: { client: 'ssh', id: selected.target } }),
    }),
    unreadable: catalogue.unreadable,
  }));
}

/**
 * Says that conversations exist which this build cannot open, and why, so a missing list is not read as lost
 * history (for example after a downgrade). The reason is the reader's own message, which names the file.
 */
function describeUnreadable(unreadable: Unreadable): string {
  if (unreadable.length === 0) return '';
  const count = `${unreadable.length} saved conversation${unreadable.length === 1 ? '' : 's'}`;
  const newer = unreadable.some((row) => row.reason.includes('unsupported log version'));
  return [
    `${count} cannot be read by this version of Term2${
      newer ? ' (written in a log format it does not know; a newer Term2 probably wrote it)' : ''
    }. ${unreadable.length === 1 ? 'It was' : 'They were'} left unchanged.`,
    ...unreadable.slice(0, 5).map((row) => `  ${row.reason}`),
    ...(unreadable.length > 5 ? [`  and ${unreadable.length - 5} more`] : []),
    ...(newer ? ['Open them with the Term2 version that wrote them, or update Term2.'] : []),
  ].join('\n');
}

/** A resume refusal the CLI prints as is, without its `error ` prefix, as legacy cli.tsx does. */
export class ResumeRefusal extends Error {}

function notFound(reference: string): Error {
  return new ResumeRefusal(
    `No conversation found to resume (${displaySessionId(
      reference,
    )}).\nRun "term2 --resume ls" to list available conversations.`,
  );
}

/** Resolve native IDs and exact imported UUID aliases before any writable open. */
export async function resolveNativeResume(directory: string, options: SessionOptions): Promise<SessionOptions> {
  const requested = options.resumeId;
  if (requested === null) return options;
  // The standalone migrator chooses this deterministic native ID. This is only
  // spelling normalization: no legacy-store read, fuzzy match, or fallback.
  const reference = storedSessionId(requested);
  const selected = await selection(options);
  let lineage: ReturnType<typeof readDirectSessionStart>;
  if (reference === 'last') {
    const { entries, unreadable } = recentWithUnreadable(directory, selected);
    const latest = entries[0];
    if (!latest) {
      const missing = notFound(reference);
      if (unreadable.length === 0) throw missing;
      throw new ResumeRefusal(`${describeUnreadable(unreadable)}\n${missing.message}`);
    }
    return { ...options, resumeId: latest.id };
  } else {
    if (!NATIVE_ID.test(reference) || !existsSync(path.join(directory, `${reference}.jsonl`))) {
      throw notFound(reference);
    }
    lineage = readDirectSessionStart(directory, reference);
    if (!belongsTo(lineage, selected)) {
      // Legacy cli.tsx's project_mismatch lines, naming the reference as typed.
      const { metadata } = lineage;
      const target = metadata.workspaceIdentity?.target ?? (metadata.binding?.client === 'ssh' ? 'unknown' : 'local');
      const lines = [
        `Error: Conversation ${requested} belongs to a different project path (${metadata.workspace}).`,
        `Resume it from that project directory with: term2 --resume ${requested}`,
        `Current project path: ${selected.root ?? 'unknown'}`,
      ];
      if (target !== 'local' || selected.target !== 'local') {
        lines.push(
          `Conversation SSH Host: ${target === 'local' ? 'none' : target}`,
          `Current SSH Host: ${selected.target === 'local' ? 'none' : selected.target}`,
        );
      }
      throw new ResumeRefusal(lines.join('\n'));
    }
  }
  return { ...options, resumeId: lineage.logicalSessionId };
}

/** Rows for legacy's `--resume ls` listing (src/shared/utils/resume-list.ts formats them), from the native catalogue. */
export async function listNativeConversations(directory: string, options: SessionOptions) {
  const found = recentWithUnreadable(directory, await selection(options));
  const conversations = found.entries.slice(0, 10);
  const details = readDirectListDetails(
    directory,
    conversations.map((lineage) => lineage.id),
  );
  const rows = conversations.map((lineage) => ({
    id: displaySessionId(lineage.id),
    updatedAt: lineage.updated,
    ...details.get(lineage.id),
    ...(lineage.target === 'local' ? {} : { sshHost: lineage.target, projectPath: lineage.workspace }),
    activeProfileId: lineage.profile,
    model: lineage.model,
    messageCount: lineage.displayed ?? lineage.messages,
  }));
  // The rows are what the listing shows; `unreadable` rides along for the text around them.
  return Object.assign(rows, { unreadable: found.unreadable });
}

/** The text of `--resume ls`: the list, or "No saved conversations found.", and a note on any unreadable logs. */
export function listingText(rows: Awaited<ReturnType<typeof listNativeConversations>>): string {
  // A directory that is really empty says so; one holding only unreadable logs must not read as empty.
  const list = rows.length === 0 && rows.unreadable.length > 0 ? '' : formatResumeList(rows);
  return [list, describeUnreadable(rows.unreadable)].filter(Boolean).join('\n\n');
}
