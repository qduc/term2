import type { AgentInputItem } from '@openai/agents';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import { normalizeRunItem } from './run-item-normalizer.js';

type RemovedUserTurn = { text: string; imageCount: number; images?: UserTurn['images'] };
type RemovedToolOutput = { index: number; callId?: string; toolName?: string; output?: unknown; itemType: string };

/**
 * A user turn the conversation can be rewound to, plus what rewinding there
 * would discard. Rewinding to a turn removes that turn and everything after it,
 * so the discard counts are cumulative from the turn to the end of history.
 */
export interface RewindTarget {
  /** 1-based, user-facing turn number. The only turn identifier the UI shows. */
  turnNumber: number;
  /** Index of this turn's item in the provider-facing history array. */
  index: number;
  text: string;
  imageCount: number;
  /** User turns removed by rewinding here, including this one. */
  discardedTurns: number;
  /** Assistant replies removed by rewinding here. */
  discardedReplies: number;
  /** Distinct paths of files mutated by tool calls that rewinding would discard. */
  discardedFiles: string[];
}

export const SHELL_CONTEXT_PREFIX = '[Previous Shell Session]';
const LEGACY_MODE_NOTICE_PREFIX = '[Mode Notice] ';

/**
 * Tools whose calls mutate files on disk. Rewinding does not revert these edits,
 * so the picker names them to show what the conversation will stop accounting for.
 */
const FILE_MUTATING_TOOLS = new Set([TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE, TOOL_NAME_CREATE_FILE]);

/**
 * ConversationStore maintains the live provider-facing transcript projection.
 *
 * The Agents SDK can accept either a string (single new user input) or an
 * AgentInputItem[] (full conversation history). For providers without
 * server-managed conversation chaining (e.g. OpenRouter), we must provide the
 * full history on each turn.
 *
 * This store does not own the complete durable conversation state. Tool
 * lifecycle recovery, assistant journal replay, and cross-stream precedence
 * rules belong to conversation-state-projector.
 */
export class ConversationStore {
  #history: AgentInputItem[] = [];

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

    const item: AgentInputItem = {
      role: 'user',
      type: 'message',
      content,
    } as AgentInputItem;
    this.#history.push(item);
  }

  addUserMessage(text: string): void {
    const trimmed = text ?? '';
    const item: AgentInputItem = {
      role: 'user',
      type: 'message',
      content: trimmed,
    };
    this.#history.push(item);
  }

  /**
   * Add an item that was deserialized from a saved conversation.
   * Unlike addUserMessage, this preserves the original item structure
   * (role, type, content, callId, etc.) so that tool calls, function results,
   * and other non-user items are restored faithfully.
   */
  addImportedItem(item: AgentInputItem): void {
    this.#history.push(item);
  }

  addShellContext(historyText: string): void {
    const trimmed = historyText ?? '';
    if (!trimmed.trim()) {
      return;
    }
    const item: AgentInputItem = {
      role: 'user',
      type: 'message',
      content: trimmed,
    };
    this.#history.push(item);
  }

  /**
   * Append newly-generated items to the store. Use when the input was a delta
   * (conversation-chaining) — the store already contains the user turn(s).
   */
  appendOutput(items: AgentInputItem[]): void {
    if (!Array.isArray(items) || items.length === 0) return;
    this.#history.push(...this.#cloneHistory(items));
  }

  /**
   * Overwrite the store with a full transcript. Use when the input was
   * full-history — the SDK returns the authoritative conversation.
   */
  replaceHistory(items: AgentInputItem[]): void {
    if (!Array.isArray(items) || items.length === 0) return;
    this.#history = this.#cloneHistory(items);
  }

  getHistory(): AgentInputItem[] {
    return this.#cloneHistory(this.#history);
  }

  getLastUserMessage(): string {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const item: any = this.#history[i];
      const raw = item?.rawItem ?? item;
      if (raw?.role !== 'user') {
        continue;
      }

      const content = raw?.content;
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .filter((c: any) => (c?.type === 'input_text' || c?.type === 'output_text') && typeof c?.text === 'string')
          .map((c: any) => c.text)
          .join('');
      }

      return '';
    }

    return '';
  }

  clear(): void {
    this.#history = [];
  }

  /**
   * Remove the last user message from history.
   * Used when retrying after a tool hallucination error.
   */
  removeLastUserMessage(): void {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      const item: any = this.#history[i];
      const raw = item?.rawItem ?? item;
      if (raw?.role === 'user') {
        this.#history.splice(i, 1);
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
    return removed;
  }

  static #extractText(raw: any): string {
    const content = raw?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => (c?.type === 'input_text' || c?.type === 'output_text') && typeof c?.text === 'string')
        .map((c: any) => c.text)
        .join('');
    }
    return '';
  }

  static #extractImageCount(raw: any): number {
    const content = raw?.content;
    return Array.isArray(content) ? content.filter((c: any) => c?.type === 'input_image').length : 0;
  }

  static #extractImages(raw: any): UserTurn['images'] {
    const content = raw?.content;
    if (!Array.isArray(content)) return undefined;

    const images = content
      .filter((c: any) => c?.type === 'input_image' && typeof c.image === 'string')
      .map((c: any, index: number) => {
        const match = /^data:([^;,]+);base64,(.*)$/.exec(c.image as string);
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

  static #extractRemovedUserTurn(raw: any): RemovedUserTurn {
    const images = ConversationStore.#extractImages(raw);
    const result: RemovedUserTurn = {
      text: ConversationStore.#extractText(raw),
      imageCount: images?.length ?? 0,
    };
    if (images) {
      result.images = images;
    }
    return result;
  }

  static #isSyntheticUserMessage(text: string): boolean {
    return text.startsWith(SHELL_CONTEXT_PREFIX) || text.startsWith(LEGACY_MODE_NOTICE_PREFIX);
  }

  static #extractRemovedToolOutput(item: any, index: number): RemovedToolOutput {
    const toolResult = normalizeRunItem(item).find((normalized) => normalized.type === 'tool_result');
    return {
      index,
      itemType: (item?.rawItem ?? item)?.type ?? 'unknown',
      callId: toolResult?.callId,
      toolName: toolResult?.toolName,
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
      const item: any = this.#history[i];
      const raw = item?.rawItem ?? item;
      if (raw?.role !== 'user') continue;
      const text = ConversationStore.#extractText(raw);
      if (ConversationStore.#isSyntheticUserMessage(text)) continue;
      const imageCount = ConversationStore.#extractImageCount(raw);
      turns.push({ index: i, text, imageCount });
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
        const raw = item?.rawItem ?? item;

        if (raw?.role === 'assistant') {
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
        turnNumber: position + 1,
        index: turn.index,
        text: turn.text,
        imageCount: turn.imageCount,
        discardedTurns: turns.length - position,
        discardedReplies,
        discardedFiles,
      };
    });
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
      return;
    }
    const turns = this.listUserTurns();
    if (turns.length <= maxUserTurns) {
      return;
    }
    const keepIndex = turns[turns.length - maxUserTurns]!.index;
    this.#history = this.#history.slice(keepIndex);
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
      const item: any = this.#history[i];
      const raw = item?.rawItem ?? item;
      if (raw?.role !== 'user') continue;
      const text = ConversationStore.#extractText(raw);
      if (ConversationStore.#isSyntheticUserMessage(text)) continue;
      anchor = i;
      break;
    }

    if (anchor === -1) return null;

    const item: any = this.#history[anchor];
    const raw = item?.rawItem ?? item;
    const removed = ConversationStore.#extractRemovedUserTurn(raw);

    this.#history.splice(anchor);
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
      const item: any = this.#history[i];
      const raw = item?.rawItem ?? item;
      if (raw?.role !== 'user') continue;
      const text = ConversationStore.#extractText(raw);
      if (ConversationStore.#isSyntheticUserMessage(text)) continue;
      count++;
      if (count === n) {
        anchor = i;
        break;
      }
    }

    if (anchor === -1) {
      // Fewer than n genuine user turns exist; remove all from the first one
      for (let i = 0; i < this.#history.length; i++) {
        const item: any = this.#history[i];
        const raw = item?.rawItem ?? item;
        if (raw?.role !== 'user') continue;
        const text = ConversationStore.#extractText(raw);
        if (ConversationStore.#isSyntheticUserMessage(text)) continue;
        anchor = i;
        break;
      }
      if (anchor === -1) return null;
    }

    const item: any = this.#history[anchor];
    const raw = item?.rawItem ?? item;
    const removed = ConversationStore.#extractRemovedUserTurn(raw);

    this.#history.splice(anchor);
    return removed;
  }

  /**
   * Inject an error-context message into the history so the model receives
   * explicit feedback about what went wrong (e.g. a JSON parsing failure).
   * Uses the 'developer' role which acts as a system-level hint.
   */
  addErrorContext(errorMessage: string): void {
    const item: AgentInputItem = {
      role: 'system',
      type: 'message',
      content: errorMessage,
    };
    this.#history.push(item);
  }

  #cloneHistory(items: AgentInputItem[]): AgentInputItem[] {
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
}
