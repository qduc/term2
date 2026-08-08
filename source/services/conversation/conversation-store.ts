import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import { projectConversationMessage } from './conversation-message-projection.js';
import { normalizeRunItem } from './run-item-normalizer.js';

export { SHELL_CONTEXT_PREFIX } from './conversation-message-projection.js';

export type ProviderHistorySnapshot = {
  revision: number;
  identity: string;
  /** Stable transcript provenance across revisions of this store. */
  origin?: string;
  history: readonly ProviderInputItem[];
};

type RemovedUserTurn = { text: string; imageCount: number; images?: UserTurn['images'] };
export type RewoundTarget = RemovedUserTurn & { discardedTurns: number };
type RemovedToolOutput = { index: number; callId?: string; toolName?: string; output?: unknown; itemType: string };

/**
 * An opaque, snapshot-scoped address for a rewindable user turn.
 *
 * It deliberately carries no provider-history position. Any transcript
 * mutation changes the store revision, so a target collected before that
 * mutation cannot later select a different turn by accident.
 */
export type RewindTargetId = string & { readonly __rewindTargetId: unique symbol };

/**
 * A user turn the conversation can be rewound to, plus what rewinding there
 * would discard. Rewinding to a turn removes that turn and everything after it,
 * so the discard counts are cumulative from the turn to the end of history.
 */
export interface RewindTarget {
  /** Snapshot-scoped opaque address accepted by {@link ConversationStore.rewindToTarget}. */
  id: RewindTargetId;
  /** 1-based, user-facing turn number. The only turn identifier the UI shows. */
  turnNumber: number;
  text: string;
  imageCount: number;
  /** User turns removed by rewinding here, including this one. */
  discardedTurns: number;
  /** Assistant replies removed by rewinding here. */
  discardedReplies: number;
  /** Distinct paths of files mutated by tool calls that rewinding would discard. */
  discardedFiles: string[];
}

/**
 * Tools whose calls mutate files on disk. Rewinding does not revert these edits,
 * so the picker names them to show what the conversation will stop accounting for.
 */
const FILE_MUTATING_TOOLS = new Set([TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE, TOOL_NAME_CREATE_FILE]);

/**
 * ConversationStore maintains the live provider-facing transcript projection.
 *
 * The application turn boundary accepts either a string (single new user
 * input) or a full conversation history. For providers without server-managed
 * conversation chaining (e.g. OpenRouter), we must provide the full history
 * on each turn.
 *
 * This store does not own the complete durable conversation state. Tool
 * lifecycle recovery, assistant journal replay, and cross-stream precedence
 * rules belong to conversation-state-projector.
 */
export class ConversationStore {
  #history: ProviderInputItem[] = [];
  #historyRevision = 0;
  #historyIdentity = crypto.randomUUID();

  addUserTurn(input: string | UserTurn): void {
    const turn = normalizeUserTurn(input);
    const images = turn.images ?? [];
    const text = turn.text ?? '';

    if (images.length === 0) {
      this.addUserMessage(text);
      return;
    }

    const content: any[] = [];
    if (text) {
      content.push({ type: 'input_text', text });
    }
    for (const image of images) {
      content.push({
        type: 'input_image',
        image: `data:${image.mimeType};base64,${image.data}`,
        detail: 'auto',
      });
    }

    const item: ProviderInputItem = {
      role: 'user',
      type: 'message',
      content,
    };
    this.#history.push(item);
    this.#historyRevision++;
  }

  addUserMessage(text: string): void {
    const trimmed = text ?? '';
    const item: ProviderInputItem = {
      role: 'user',
      type: 'message',
      content: trimmed,
    };
    this.#history.push(item);
    this.#historyRevision++;
  }

  /**
   * Add an item that was deserialized from a saved conversation.
   * Unlike addUserMessage, this preserves the original item structure
   * (role, type, content, callId, etc.) so that tool calls, function results,
   * and other non-user items are restored faithfully.
   */
  addImportedItem(item: ProviderInputItem): void {
    this.#history.push(item);
    this.#historyRevision++;
  }

  addShellContext(historyText: string): void {
    const trimmed = historyText ?? '';
    if (!trimmed.trim()) {
      return;
    }
    const item: ProviderInputItem = {
      role: 'user',
      type: 'message',
      content: trimmed,
    };
    this.#history.push(item);
    this.#historyRevision++;
  }

  /**
   * Append newly-generated items to the store. Use when the input was a delta
   * (conversation-chaining) — the store already contains the user turn(s).
   */
  appendOutput(items: ProviderInputItem[]): void {
    if (!Array.isArray(items) || items.length === 0) return;
    this.#history.push(...this.#cloneHistory(items));
    this.#historyRevision++;
  }

  /**
   * Overwrite the store with a full transcript. Use when the input was
   * full-history — the inherited transport returns the authoritative
   * conversation.
   */
  replaceHistory(items: ProviderInputItem[]): void {
    if (!Array.isArray(items) || items.length === 0) return;
    this.#history = this.#cloneHistory(items);
    this.#historyRevision++;
  }

  getHistory(): ProviderInputItem[] {
    return this.#cloneHistory(this.#history);
  }

  /**
   * Returns a read-only copy of the complete provider-facing transcript. The
   * revision/identity pair is the prefix anchor for provider-private
   * continuation instrumentation; callers cannot mutate the store through it.
   */
  getProviderHistorySnapshot(): ProviderHistorySnapshot {
    const history = this.#freezeHistory(this.#cloneSnapshotHistory(this.#history));
    const origin = `history:${this.#historyIdentity}`;
    return Object.freeze({
      revision: this.#historyRevision,
      identity: `${origin}:${this.#historyRevision}`,
      origin,
      history,
    });
  }

  getLastUserMessage(): string {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const message = projectConversationMessage(this.#history[i]);
      if (message?.role === 'user') return message.text;
    }

    return '';
  }

  clear(): void {
    this.#history = [];
    this.#historyRevision++;
  }

  /**
   * Remove the last user message from history.
   * Used when retrying after a tool hallucination error.
   */
  removeLastUserMessage(): void {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      if (projectConversationMessage(this.#history[i])?.role === 'user') {
        this.#history.splice(i, 1);
        this.#historyRevision++;
        return;
      }
    }
  }

  peekLastToolOutput(): RemovedToolOutput | null {
    const anchor = this.#findLastToolOutputIndex();
    if (anchor === -1) return null;
    return ConversationStore.#extractRemovedToolOutput(this.#history[anchor], anchor);
  }

  /**
   * Remove everything after the last tool output while keeping that tool
   * output itself in the transcript so the model can retry from there.
   */
  removeAfterLastToolOutput(): RemovedToolOutput | null {
    const anchor = this.#findLastToolOutputIndex();
    if (anchor === -1) return null;

    const removed = ConversationStore.#extractRemovedToolOutput(this.#history[anchor], anchor);
    this.#history.splice(anchor + 1);
    this.#historyRevision++;
    return removed;
  }

  static #extractImages(message: NonNullable<ReturnType<typeof projectConversationMessage>>): UserTurn['images'] {
    const images = message.images
      .map((image, index: number) => {
        const match = /^data:([^;,]+);base64,(.*)$/.exec(image.image);
        if (!match) return null;
        const [, mimeType, data] = match;
        return {
          id: crypto.randomUUID() as string,
          data,
          mimeType,
          byteSize: Buffer.from(data, 'base64').length,
          displayNumber: index + 1,
        };
      })
      .filter((image): image is NonNullable<UserTurn['images']>[number] => image !== null);

    return images.length > 0 ? images : undefined;
  }

  static #extractRemovedUserTurn(message: NonNullable<ReturnType<typeof projectConversationMessage>>): RemovedUserTurn {
    const images = ConversationStore.#extractImages(message);
    const result: RemovedUserTurn = {
      text: message.text,
      imageCount: images?.length ?? 0,
    };
    if (images) {
      result.images = images;
    }
    return result;
  }

  static #extractRemovedToolOutput(item: any, index: number): RemovedToolOutput {
    const toolResult = normalizeRunItem(item).find((normalized) => normalized.type === 'tool_result');
    const providerItem = item?.rawItem ?? item;
    const providerToolName = providerItem?.name ?? providerItem?.toolName;
    return {
      index,
      itemType: providerItem?.type ?? 'unknown',
      callId: toolResult?.callId,
      // Canonical normalization uses "unknown" when a provider omitted the
      // name; preserve this public method's historical `undefined` result.
      toolName: typeof providerToolName === 'string' && providerToolName ? toolResult?.toolName : undefined,
      output: toolResult?.output,
    };
  }

  #findLastToolOutputIndex(): number {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      if (normalizeRunItem(this.#history[i]).some((item) => item.type === 'tool_result')) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Returns a list of genuine user turns (excluding shell context items),
   * each with their index in the history array, text, and image count.
   */
  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    const turns: { index: number; text: string; imageCount: number }[] = [];
    for (let i = 0; i < this.#history.length; i++) {
      const message = projectConversationMessage(this.#history[i]);
      if (message?.role !== 'user' || message.isSynthetic) continue;
      turns.push({ index: i, text: message.text, imageCount: message.imageCount });
    }
    return turns;
  }

  /**
   * Returns every genuine user turn the conversation can be rewound to, each
   * annotated with what rewinding there would discard. Turn numbers are 1-based
   * and are the only turn identifier exposed to the UI or to `/rewind N`.
   */
  listRewindTargets(): RewindTarget[] {
    const turns = this.listUserTurns();

    return turns.map((turn, position) => {
      let discardedReplies = 0;
      const discardedFiles: string[] = [];

      for (let i = turn.index; i < this.#history.length; i++) {
        const item: any = this.#history[i];
        if (projectConversationMessage(item)?.role === 'assistant') {
          discardedReplies++;
          continue;
        }

        for (const path of ConversationStore.#extractMutatedPaths(item)) {
          if (!discardedFiles.includes(path)) {
            discardedFiles.push(path);
          }
        }
      }

      return {
        id: this.#createRewindTargetId(turn.index),
        turnNumber: position + 1,
        text: turn.text,
        imageCount: turn.imageCount,
        discardedTurns: turns.length - position,
        discardedReplies,
        discardedFiles,
      };
    });
  }

  /**
   * Atomically rewind to a previously listed target. The target is valid only
   * for the exact store snapshot that issued it; stale or unknown targets are
   * rejected without changing the transcript.
   */
  rewindToTarget(targetId: RewindTargetId): RewoundTarget | null {
    const target = this.listRewindTargets().find((candidate) => candidate.id === targetId);
    if (!target) return null;

    const anchor = this.#findRewindTargetIndex(targetId);
    if (anchor === -1) return null;

    const message = projectConversationMessage(this.#history[anchor]);
    if (!message || message.role !== 'user' || message.isSynthetic) return null;

    const removed = ConversationStore.#extractRemovedUserTurn(message);
    this.#history.splice(anchor);
    this.#historyRevision++;
    return { ...removed, discardedTurns: target.discardedTurns };
  }

  /**
   * Pulls file paths out of a mutating tool call. Arguments arrive as a JSON
   * string from most providers and as an object from some, and apply_patch nests
   * one path per operation, so all three shapes are handled. Malformed arguments
   * yield no paths rather than throwing — a preview must never break a rewind.
   */
  static #extractMutatedPaths(item: unknown): string[] {
    const toolCall = normalizeRunItem(item).find((normalized) => normalized.type === 'tool_call');
    if (!toolCall || !FILE_MUTATING_TOOLS.has(toolCall.toolName)) return [];

    let args: any = toolCall.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return [];
      }
    }
    if (!args || typeof args !== 'object') return [];

    const paths: string[] = [];
    if (typeof args.path === 'string' && args.path) {
      paths.push(args.path);
    }
    if (Array.isArray(args.operations)) {
      for (const operation of args.operations) {
        if (operation && typeof operation.path === 'string' && operation.path) {
          paths.push(operation.path);
        }
      }
    }
    return paths;
  }

  /**
   * Remove the oldest genuine user turns so that at most `maxUserTurns` remain,
   * keeping all items from the first retained turn onward. This preserves a
   * valid provider-facing transcript that starts at a user turn.
   */
  trimUserTurns(maxUserTurns: number): void {
    if (maxUserTurns <= 0) {
      this.#history = [];
      this.#historyRevision++;
      return;
    }
    const turns = this.listUserTurns();
    if (turns.length <= maxUserTurns) {
      return;
    }
    const keepIndex = turns[turns.length - maxUserTurns]!.index;
    this.#history = this.#history.slice(keepIndex);
    this.#historyRevision++;
  }

  /**
   * Remove the last genuine user turn and everything after it.
   * Skips shell-context items (identified by SHELL_CONTEXT_PREFIX).
   * Used by /undo to rewind to before the last user turn.
   * Returns { text, imageCount } of the removed item, or null if none found.
   */
  removeLastUserTurn(): RemovedUserTurn | null {
    let anchor = -1;
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const message = projectConversationMessage(this.#history[i]);
      if (message?.role !== 'user' || message.isSynthetic) continue;
      anchor = i;
      break;
    }

    if (anchor === -1) return null;

    const message = projectConversationMessage(this.#history[anchor]);
    if (!message) return null;
    const removed = ConversationStore.#extractRemovedUserTurn(message);

    this.#history.splice(anchor);
    this.#historyRevision++;
    return removed;
  }

  /**
   * Removes the last n genuine user turns (and everything after the earliest
   * one's anchor). Returns info from the earliest removed turn, or null if
   * no genuine turns found.
   */
  removeNLastUserTurns(n: number): RemovedUserTurn | null {
    if (n <= 0) return null;

    // Walk backwards to find the nth-from-last genuine user turn
    let count = 0;
    let anchor = -1;
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const message = projectConversationMessage(this.#history[i]);
      if (message?.role !== 'user' || message.isSynthetic) continue;
      count++;
      if (count === n) {
        anchor = i;
        break;
      }
    }

    if (anchor === -1) {
      // Fewer than n genuine user turns exist; remove all from the first one
      for (let i = 0; i < this.#history.length; i++) {
        const message = projectConversationMessage(this.#history[i]);
        if (message?.role !== 'user' || message.isSynthetic) continue;
        anchor = i;
        break;
      }
      if (anchor === -1) return null;
    }

    const message = projectConversationMessage(this.#history[anchor]);
    if (!message) return null;
    const removed = ConversationStore.#extractRemovedUserTurn(message);

    this.#history.splice(anchor);
    this.#historyRevision++;
    return removed;
  }

  #createRewindTargetId(index: number): RewindTargetId {
    return `rewind:${this.#historyIdentity}:${this.#historyRevision}:${index}` as RewindTargetId;
  }

  #findRewindTargetIndex(targetId: RewindTargetId): number {
    for (const turn of this.listUserTurns()) {
      if (this.#createRewindTargetId(turn.index) === targetId) return turn.index;
    }
    return -1;
  }

  /**
   * Inject an error-context message into the history so the model receives
   * explicit feedback about what went wrong (e.g. a JSON parsing failure).
   * Uses the 'developer' role which acts as a system-level hint.
   */
  addErrorContext(errorMessage: string): void {
    const item: ProviderInputItem = {
      role: 'system',
      type: 'message',
      content: errorMessage,
    };
    this.#history.push(item);
    this.#historyRevision++;
  }

  #cloneHistory(items: ProviderInputItem[]): ProviderInputItem[] {
    // Avoid leaking references to external callers.
    // structuredClone is available in modern Node; fall back to a deep copy fallback.
    try {
      return structuredClone(items);
    } catch {
      try {
        return JSON.parse(JSON.stringify(items));
      } catch {
        return items.slice();
      }
    }
  }

  #freezeHistory(items: ProviderInputItem[]): readonly ProviderInputItem[] {
    const seen = new WeakSet<object>();
    const freeze = (value: any): any => {
      if (!value || typeof value !== 'object' || Object.isFrozen(value) || seen.has(value)) return value;
      seen.add(value);
      for (const child of Object.values(value)) freeze(child);
      return Object.freeze(value);
    };
    return freeze(items);
  }

  #cloneSnapshotHistory(items: ProviderInputItem[]): ProviderInputItem[] {
    try {
      return structuredClone(items);
    } catch {
      const seen = new WeakMap<object, unknown>();
      const clone = (value: any): any => {
        if (!value || typeof value !== 'object') return value;
        const existing = seen.get(value);
        if (existing) return existing;
        const copy: any = Array.isArray(value) ? [] : {};
        seen.set(value, copy);
        for (const [key, child] of Object.entries(value)) copy[key] = clone(child);
        return copy;
      };
      return clone(items);
    }
  }
}
