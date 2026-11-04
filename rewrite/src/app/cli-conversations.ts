/** Read-only CLI discovery. Native logical lineages are the only history source. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readDirectSessionStart } from '../session/direct-session-start.js';
import { withNativeCatalogue, type NativeCatalogueEntry } from './native-catalogue.js';
import { resolveDirectRemoteConnection } from './direct-remote-config.js';
import type { SessionOptions } from './cli-args.js';
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

function recent(directory: string, selected: Selection): readonly NativeCatalogueEntry[] {
  return withNativeCatalogue(directory, (catalogue) =>
    catalogue.list({
      ...selected,
      ...(selected.target === 'local' ? {} : { binding: { client: 'ssh', id: selected.target } }),
    }),
  );
}

function notFound(reference: string): Error {
  return new Error(
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
    const latest = recent(directory, selected)[0];
    if (!latest) throw notFound(reference);
    return { ...options, resumeId: latest.id };
  } else {
    if (!NATIVE_ID.test(reference) || !existsSync(path.join(directory, `${reference}.jsonl`))) {
      throw notFound(reference);
    }
    lineage = readDirectSessionStart(directory, reference);
    if (!belongsTo(lineage, selected)) {
      throw new Error(
        `Conversation ${displaySessionId(reference)} belongs to a different project path or SSH workspace.\n` +
          `Resume it from that project directory with: term2 --resume ${displaySessionId(reference)}`,
      );
    }
  }
  return { ...options, resumeId: lineage.logicalSessionId };
}

export async function listNativeConversations(directory: string, options: SessionOptions): Promise<string> {
  const conversations = recent(directory, await selection(options)).slice(0, 10);
  const lines = ['Recent Conversations (last 10):'];
  for (const lineage of conversations) {
    lines.push(
      `\n${displaySessionId(lineage.id)}  ${lineage.updated}`,
      `  ${lineage.messages} message${lineage.messages === 1 ? '' : 's'} | model: ${
        lineage.model
      } | mode: ${lineage.profile.replace(/^builtin:/, '')}`,
      `  term2 --resume ${displaySessionId(lineage.id)}`,
    );
  }
  if (conversations.length === 0) lines.push('No conversations found for this project.');
  return `${lines.join('\n')}\n`;
}
