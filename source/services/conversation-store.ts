import type { AgentInputItem } from '@openai/agents';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

type RemovedUserTurn = { text: string; imageCount: number; images?: UserTurn['images'] };

export const SHELL_CONTEXT_PREFIX = '[Previous Shell Session]';

/**
 * ConversationStore maintains the canonical conversation history for the app.
 *
 * The Agents SDK can accept either a string (single new user input) or an
 * AgentInputItem[] (full conversation history). For providers without
 * server-managed conversation chaining (e.g. OpenRouter), we must provide the
 * full history on each turn.
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
   * Append a mode-change notice as a persisted system message at the tail of
   * the history. Append-only (never spliced mid-history) so the previously
   * cached prefix stays byte-identical and only grows.
   */
  addModeNotice(text: string): void {
    const trimmed = text ?? '';
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
      if (text.startsWith(SHELL_CONTEXT_PREFIX)) continue;
      const imageCount = ConversationStore.#extractImageCount(raw);
      turns.push({ index: i, text, imageCount });
    }
    return turns;
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
      if (text.startsWith(SHELL_CONTEXT_PREFIX)) continue;
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
      if (text.startsWith(SHELL_CONTEXT_PREFIX)) continue;
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
        if (text.startsWith(SHELL_CONTEXT_PREFIX)) continue;
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
