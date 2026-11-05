/**
 * Legacy's session browser over the native store: each native lineage in scope becomes the restored
 * conversation shape the legacy canonical backend reads, so list/search/read page, score and format
 * exactly as legacy does. Ids are shown bare (no `conv_` prefix), as legacy shows its session ids.
 */
import { statSync } from 'node:fs';
import type { DirectPublicState } from '../session/direct-state.js';
import {
  directWriterLockHeld,
  replayNativeLineage,
  withNativeCatalogue,
  type NativeCatalogueEntry,
  type NativeCatalogueScope,
} from './native-catalogue.js';
import {
  extractDisplayOutput,
  INTERRUPTED_SYSTEM_MESSAGE,
  RESTART_UNOBSERVED_TOOL_RESULT,
  type RestoredState,
  type SessionBrowserStore,
} from './source-tools.js';

const NATIVE_PREFIX = 'conv_';
const bare = (id: string) => (id.startsWith(NATIVE_PREFIX) ? id.slice(NATIVE_PREFIX.length) : id);
const version = (entry: NativeCatalogueEntry) => `${entry.updated}:${entry.displayed ?? ''}:${entry.messages}`;

type Converted = { readonly version: string; readonly parts: readonly RestoredState[] | null };

/** The legacy command row text: the first of these arguments, else the tool name (conversation-replay.ts). */
function commandText(toolName: string, input: unknown): string {
  let args: unknown = input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      // Legacy keeps a string that is not JSON as it is.
    }
  }
  const fields = typeof args === 'object' && args !== null ? (args as Record<string, string>) : undefined;
  const command = fields
    ? fields.command ?? fields.question ?? fields.pattern ?? fields.query ?? fields.path ?? fields.task ?? ''
    : typeof args === 'string'
    ? args
    : '';
  return command || toolName;
}

/** The legacy command row output: JSON outputs show their display text (conversation-replay.ts). */
function outputText(output: string): string {
  let parsed: unknown = output;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (typeof parsed === 'object' && parsed !== null) return extractDisplayOutput(parsed as Record<string, unknown>);
  return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
}

/**
 * Public timeline slots in order, as the legacy saved messages a TUI session would have persisted. Legacy reads
 * a session whose turn has not settled (the live one too) as interrupted: its unfinished tools get the restart
 * text and a system notice follows (conversation-replay.ts).
 */
function savedMessages(state: DirectPublicState, reasoning: ReadonlyMap<string, string>): unknown[] {
  const open = state.activeTurnId;
  const messages = new Map(state.messages.map((message) => [message.id, message]));
  const tools = new Map(state.tools.map((tool) => [tool.executionId as string, tool]));
  const saved: unknown[] = [];
  for (const slot of state.timeline) {
    if (slot.kind === 'message') {
      const message = messages.get(slot.id);
      if (!message || message.role === 'tool') continue;
      const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
      saved.push({ sender: message.role === 'assistant' ? 'bot' : message.role, text });
    } else if (slot.kind === 'tool') {
      const tool = tools.get(slot.id);
      // A script's nested calls are part of its run_code row in legacy, not rows of their own.
      if (!tool || tool.parentExecutionId) continue;
      saved.push({
        sender: 'command',
        command: commandText(tool.toolName, tool.input),
        output:
          tool.output !== undefined
            ? outputText(tool.output)
            : open && tool.turnId === open
            ? RESTART_UNOBSERVED_TOOL_RESULT
            : '',
        toolName: tool.toolName,
      });
    } else if (slot.kind === 'reasoning') {
      const text = reasoning.get(`reasoning:${slot.id}`);
      if (text !== undefined) saved.push({ sender: 'reasoning', text });
    }
  }
  if (open) saved.push({ sender: 'system', text: INTERRUPTED_SYSTEM_MESSAGE });
  return saved;
}

/**
 * A lineage as legacy would have saved it: one conversation per rollover part, each later part naming the one it
 * rolled over from. A part is named by the log it was written to, the id a rollover briefing gives its predecessor.
 */
function convert(directory: string, entry: NativeCatalogueEntry): readonly RestoredState[] | null {
  try {
    const { metadata, parts, reasoning } = replayNativeLineage(directory, entry.id);
    const ids = parts.map((part) => bare(part.sessionId));
    return parts.map((part, index) => {
      const model = part.state.configuration?.configuration.model ?? part.state.model;
      return {
        id: ids[index]!,
        createdAt: part.firstAt,
        updatedAt: part.lastAt,
        projectPath: metadata.workspace,
        model: model.model,
        provider: model.provider,
        ...(index > 0 ? { rolloverFrom: ids[index - 1]! } : {}),
        messages: savedMessages(part.state, reasoning),
      } as unknown as RestoredState;
    });
  } catch {
    return null;
  }
}

/** One scope's store. Conversions are kept per lineage until its catalogue row changes. */
export function nativeSessionBrowserStore(directory: string, scope: NativeCatalogueScope): SessionBrowserStore {
  const converted = new Map<string, Converted>();
  const entries = (all = false) =>
    withNativeCatalogue(directory, (catalogue) =>
      catalogue.list(all ? { target: scope.target, root: null } : scope, all ? { includeBound: true } : undefined),
    );
  const load = (entry: NativeCatalogueEntry) => {
    const current = version(entry);
    const kept = converted.get(entry.id);
    if (kept?.version === current) return kept.parts;
    const parts = convert(directory, entry);
    converted.set(entry.id, { version: current, parts });
    return parts;
  };
  /** The lineage holding a browser id, and that id's part. A lineage's first log carries the lineage id. */
  const find = (id: string, all = false) => {
    const listed = entries(all);
    const own = listed.find((entry) => bare(entry.id) === id);
    if (own) return { entry: own, conversation: load(own)?.find((part) => part.id === id) ?? null };
    for (const entry of listed) {
      const part = load(entry)?.find((candidate) => candidate.id === id);
      if (part) return { entry, conversation: part };
    }
    return undefined;
  };
  const loaded = (found: ReturnType<typeof find>) => {
    if (!found) return { status: 'not_found' as const };
    if (!found.conversation)
      return { status: 'unreadable' as const, error: new Error('Session transcript is unavailable.') };
    return { status: 'loaded' as const, conversation: found.conversation, sourceVersion: version(found.entry) };
  };
  return {
    browse(_projectPath, _sshHost, idPrefix) {
      const conversations: RestoredState[] = [];
      const sourceVersions = new Map<string, string>();
      let unavailable = 0;
      for (const entry of entries()) {
        const parts = load(entry);
        if (!parts) {
          if (idPrefix === undefined || bare(entry.id).toLowerCase().startsWith(idPrefix.toLowerCase())) unavailable++;
          continue;
        }
        for (const part of parts) {
          if (idPrefix !== undefined && !part.id.toLowerCase().startsWith(idPrefix.toLowerCase())) continue;
          conversations.push(part);
          sourceVersions.set(part.id, version(entry));
        }
      }
      // Legacy lists sessions newest first; rollover parts are separate sessions there.
      conversations.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      return { conversations, unavailable, sourceVersions, directoryVersion: this.directoryVersion() ?? undefined };
    },
    sourceVersion(id) {
      const found = find(id);
      return found ? version(found.entry) : null;
    },
    directoryVersion() {
      try {
        const stat = statSync(directory, { bigint: true });
        return `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch {
        return null;
      }
    },
    loadForProject(id) {
      const found = find(id);
      if (found) return loaded(found);
      const elsewhere = find(id, true);
      return elsewhere?.conversation
        ? { status: 'project_mismatch', conversation: elsewhere.conversation }
        : { status: 'not_found' };
    },
    loadUnscoped: (id) => loaded(find(id, true)),
    // Only the newest part of a lineage is still being written; its writer holds the lineage's lock.
    lock(id) {
      const found = find(id, true);
      if (!found || load(found.entry)?.at(-1)?.id !== id || !directWriterLockHeld(directory, found.entry.id))
        return null;
      return { status: 'held', pid: 0, startedAt: '', host: '' };
    },
  };
}

/** The bare id the browser shows for a native session id. */
export const nativeBrowserId = bare;
