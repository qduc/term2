/**
 * Legacy's session browser over the native store: each native lineage in scope becomes the restored
 * conversation shape the legacy canonical backend reads, so list/search/read page, score and format
 * exactly as legacy does. Ids are shown bare (no `conv_` prefix), as legacy shows its session ids.
 */
import { statSync } from 'node:fs';
import type { DirectPublicState } from '../session/direct-state.js';
import {
  replayNativeLineage,
  withNativeCatalogue,
  type NativeCatalogueEntry,
  type NativeCatalogueScope,
} from './native-catalogue.js';
import { nativeTranscript } from './native-transcript.js';
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

type Converted = { readonly version: string; readonly conversation: RestoredState | null };

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

function convert(directory: string, entry: NativeCatalogueEntry): RestoredState | null {
  try {
    const { metadata, firstAt, lastAt, state, documents } = replayNativeLineage(directory, entry.id, nativeTranscript);
    const reasoning = new Map(documents.filter((doc) => doc.kind === 'reasoning').map((doc) => [doc.id, doc.text]));
    const model = state.configuration?.configuration.model ?? state.model;
    return {
      id: bare(entry.id),
      createdAt: firstAt,
      updatedAt: lastAt,
      projectPath: metadata.workspace,
      model: model.model,
      provider: model.provider,
      ...(metadata.rolloverFrom ? { rolloverFrom: bare(metadata.rolloverFrom) } : {}),
      messages: savedMessages(state, reasoning),
    } as unknown as RestoredState;
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
    if (kept?.version === current) return kept.conversation;
    const conversation = convert(directory, entry);
    converted.set(entry.id, { version: current, conversation });
    return conversation;
  };
  const find = (id: string, all = false) => entries(all).find((entry) => bare(entry.id) === id);
  const loaded = (entry: NativeCatalogueEntry | undefined) => {
    const conversation = entry ? load(entry) : null;
    if (!entry) return { status: 'not_found' as const };
    if (!conversation) return { status: 'unreadable' as const, error: new Error('Session transcript is unavailable.') };
    return { status: 'loaded' as const, conversation, sourceVersion: version(entry) };
  };
  return {
    browse(_projectPath, _sshHost, idPrefix) {
      const conversations: RestoredState[] = [];
      const sourceVersions = new Map<string, string>();
      let unavailable = 0;
      for (const entry of entries()) {
        const id = bare(entry.id);
        if (idPrefix !== undefined && !id.toLowerCase().startsWith(idPrefix.toLowerCase())) continue;
        const conversation = load(entry);
        if (!conversation) {
          unavailable++;
          continue;
        }
        conversations.push(conversation);
        sourceVersions.set(id, version(entry));
      }
      return { conversations, unavailable, sourceVersions, directoryVersion: this.directoryVersion() ?? undefined };
    },
    sourceVersion(id) {
      const entry = find(id);
      return entry ? version(entry) : null;
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
      const entry = find(id);
      if (entry) return loaded(entry);
      const elsewhere = find(id, true);
      const conversation = elsewhere ? load(elsewhere) : null;
      return conversation ? { status: 'project_mismatch', conversation } : { status: 'not_found' };
    },
    loadUnscoped: (id) => loaded(find(id, true)),
    // Native sessions hold no legacy conversation lock; another process's open session is not detected.
    lock: () => null,
  };
}

/** The bare id the browser shows for a native session id. */
export const nativeBrowserId = bare;
