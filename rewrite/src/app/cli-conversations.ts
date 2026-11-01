/** Read-only CLI discovery. Native logical lineages are the only history source. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readDirectLogLineage, readDirectLogLineages, type DirectLogLineage } from '../session/direct-rolling-log.js';
import { latestDirectConfiguration } from '../session/direct-configuration.js';
import { resolveDirectRemoteConnection } from './direct-remote-config.js';
import type { SessionOptions } from './cli-args.js';

const NATIVE_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMPORTED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

function belongsTo(lineage: DirectLogLineage, selected: Selection): boolean {
  const { metadata } = lineage;
  const target = metadata.workspaceIdentity?.target ?? (metadata.binding?.client === 'ssh' ? null : 'local');
  if (target !== selected.target) return false;
  if (selected.root === null) return true;
  const normalize = selected.target === 'local' ? path.resolve : path.posix.normalize;
  return normalize(metadata.workspace) === normalize(selected.root);
}

function recent(directory: string, selected: Selection): readonly DirectLogLineage[] {
  return readDirectLogLineages(directory)
    .filter((lineage) => belongsTo(lineage, selected))
    .sort((a, b) => {
      const updated = (lineage: DirectLogLineage): string => lineage.entries.at(-1)!.at;
      return updated(b).localeCompare(updated(a)) || a.logicalSessionId.localeCompare(b.logicalSessionId);
    });
}

function notFound(reference: string): Error {
  return new Error(
    `No conversation found to resume (${reference}).\nRun "term2 --resume ls" to list available conversations.`,
  );
}

/** Resolve native IDs and exact imported UUID aliases before any writable open. */
export async function resolveNativeResume(directory: string, options: SessionOptions): Promise<SessionOptions> {
  const requested = options.resumeId;
  if (requested === null) return options;
  // The standalone migrator chooses this deterministic native ID. This is only
  // spelling normalization: no legacy-store read, fuzzy match, or fallback.
  const reference = IMPORTED_UUID.test(requested) ? `conv_${requested}` : requested;
  const selected = await selection(options);
  let lineage: DirectLogLineage;
  if (reference === 'last') {
    const latest = recent(directory, selected)[0];
    if (!latest) throw notFound(reference);
    lineage = latest;
  } else {
    if (!NATIVE_ID.test(reference) || !existsSync(path.join(directory, `${reference}.jsonl`))) {
      throw notFound(reference);
    }
    lineage = readDirectLogLineage(directory, reference);
    if (!belongsTo(lineage, selected)) {
      throw new Error(
        `Conversation ${reference} belongs to a different project path or SSH workspace.\n` +
          `Resume it from that project directory with: term2 --resume ${reference}`,
      );
    }
  }
  return { ...options, resumeId: lineage.logicalSessionId };
}

export async function listNativeConversations(directory: string, options: SessionOptions): Promise<string> {
  const conversations = recent(directory, await selection(options)).slice(0, 10);
  const lines = ['Recent Conversations (last 10):'];
  for (const lineage of conversations) {
    const facts = lineage.entries.map((entry) => entry.fact);
    const configuration = latestDirectConfiguration(facts);
    const model = configuration?.configuration.model ?? lineage.metadata.model;
    const profile = configuration?.profile ?? lineage.metadata.profile;
    // Imported transcript observations are ordinary native display facts; their
    // hidden context-restoration turn is not a user admission. Deduplicate by
    // message identity when an observation supplies a derived message's display.
    const messages = new Map<string, string>();
    for (const fact of facts) {
      if (fact.type === 'turn_started' && fact.display !== false) {
        for (const item of fact.input) {
          if (item.type === 'user_message')
            messages.set(item.id, item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' '));
        }
      } else if (fact.type === 'transcript_message') {
        if (fact.message.role === 'user')
          messages.set(
            fact.message.id,
            fact.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' '),
          );
        else messages.delete(fact.message.id);
      }
    }
    const preview = messages.values().next().value?.replace(/\s+/g, ' ');
    lines.push(
      `\n${lineage.logicalSessionId}  ${lineage.entries.at(-1)!.at}`,
      `  ${messages.size} message${messages.size === 1 ? '' : 's'} | model: ${model.model} | mode: ${profile.id.replace(
        /^builtin:/,
        '',
      )}`,
      ...(preview ? [`  ${preview}`] : []),
      `  term2 --resume ${lineage.logicalSessionId}`,
    );
  }
  if (conversations.length === 0) lines.push('No conversations found for this project.');
  return `${lines.join('\n')}\n`;
}
