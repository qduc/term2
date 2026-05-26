import type { AgentInputItem } from '@openai/agents';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import { repairConversationHistory } from './conversation-history-repair.js';

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
   * Updates the internal history of the instance based on the provided result object.
   *
   * @param {any} result The result object containing a `history` property, which is an array of items
   *                     representing the conversation history to be merged or updated.
   * @return {void} This method does not return a value, but it modifies the internal state of the instance.
   */
  updateFromResult(result: any): void {
    const incoming = result?.history;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return;
    }

    const next = this.#collapseReplayedHistoryPrefixes(this.#cloneHistory(incoming as AgentInputItem[]));

    if (this.#history.length === 0) {
      this.#history = next;
    } else if (next.length >= this.#history.length && this.#isPrefixMatch(this.#history, next)) {
      // If the incoming history looks like a full transcript (superset), prefer it.
      this.#history = next;
    } else {
      // Otherwise, merge by detecting any overlap between the end of the existing
      // history and the beginning of the incoming history.
      const overlap = this.#findSuffixPrefixOverlap(this.#history, next);
      if (overlap > 0) {
        // Preserve richer incoming items (e.g. assistant reasoning_details) for the
        // overlapped region. This is important because overlap detection uses a
        // signature that intentionally ignores many fields.
        const mergedExisting = this.#cloneHistory(this.#history);
        for (let i = 0; i < overlap; i++) {
          const existingIndex = mergedExisting.length - overlap + i;
          mergedExisting[existingIndex] = this.#preferIncomingItem(mergedExisting[existingIndex], next[i]);
        }
        this.#history = [...mergedExisting, ...next.slice(overlap)];
      } else {
        this.#history = [...this.#history, ...next];
      }
    }

    // Repair the history to deduplicate any SDK-interleaved replayed history or tool pairs.
    this.#history = repairConversationHistory(this.#history).history as AgentInputItem[];
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
    // structuredClone is available in modern Node; fall back to a shallow copy.
    try {
      return structuredClone(items);
    } catch {
      return items.slice();
    }
  }

  #collapseReplayedHistoryPrefixes(items: AgentInputItem[]): AgentInputItem[] {
    let collapsed = items;

    while (collapsed.length > 1) {
      const firstSignature = this.#signature(collapsed[0]);
      let replayStart = -1;

      for (let i = collapsed.length - 1; i > 0; i--) {
        if (this.#signature(collapsed[i]) !== firstSignature) {
          continue;
        }

        const prefixCallSignatures = this.#collectCallSignatures(collapsed.slice(0, i));
        if (prefixCallSignatures.size === 0) {
          continue;
        }

        const suffixCallSignatures = this.#collectCallSignatures(collapsed.slice(i));
        let allPrefixCallsReplayed = true;
        for (const signature of prefixCallSignatures) {
          if (!suffixCallSignatures.has(signature)) {
            allPrefixCallsReplayed = false;
            break;
          }
        }

        if (allPrefixCallsReplayed) {
          replayStart = i;
          break;
        }
      }

      if (replayStart === -1) {
        return collapsed;
      }

      collapsed = collapsed.slice(replayStart);
    }

    return collapsed;
  }

  #collectCallSignatures(items: AgentInputItem[]): Set<string> {
    const signatures = new Set<string>();
    for (const item of items) {
      const signature = this.#signature(item);
      if (signature.startsWith('call:')) {
        signatures.add(signature);
      }
    }
    return signatures;
  }

  #preferIncomingItem(existing: AgentInputItem, incoming: AgentInputItem): AgentInputItem {
    const eAny: any = existing as any;
    const iAny: any = incoming as any;
    const eRaw: any = eAny?.rawItem ?? eAny;
    const iRaw: any = iAny?.rawItem ?? iAny;

    // Prefer the incoming item if it provides reasoning_details/tool_calls that
    // the existing overlapped item doesn't have.
    const isAssistantMessage =
      iRaw?.role === 'assistant' && iRaw?.type === 'message' && eRaw?.role === 'assistant' && eRaw?.type === 'message';

    if (isAssistantMessage) {
      const incomingReasoning = iAny?.reasoning_details ?? iRaw?.reasoning_details;
      const existingReasoning = eAny?.reasoning_details ?? eRaw?.reasoning_details;
      if (existingReasoning == null && incomingReasoning != null) {
        return incoming;
      }

      // Preserve OpenRouter "reasoning" (reasoning tokens) field as well.
      const incomingReasoningText =
        iAny?.reasoning ?? iRaw?.reasoning ?? iAny?.reasoning_content ?? iRaw?.reasoning_content;
      const existingReasoningText =
        eAny?.reasoning ?? eRaw?.reasoning ?? eAny?.reasoning_content ?? eRaw?.reasoning_content;
      if (existingReasoningText == null && incomingReasoningText != null) {
        return incoming;
      }

      const incomingToolCalls = iAny?.tool_calls ?? iRaw?.tool_calls;
      const existingToolCalls = eAny?.tool_calls ?? eRaw?.tool_calls;
      if (existingToolCalls == null && incomingToolCalls != null) {
        return incoming;
      }
    }

    return existing;
  }

  #signature(item: AgentInputItem): string {
    const anyItem: any = item as any;
    const raw = anyItem?.rawItem ?? anyItem;

    // Tool calls / outputs are related by call ID. SDK item IDs can change
    // when a continuation replays full history, so call IDs are the stable key.
    const callId = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id;
    if (typeof callId === 'string' && callId) {
      return `call:${callId}:${raw?.type ?? ''}`;
    }

    // Prefer stable IDs when present.
    if (typeof raw?.id === 'string' && raw.id) {
      return `id:${raw.id}`;
    }

    // Message-like items: role + content text.
    const role = typeof raw?.role === 'string' ? raw.role : '';
    const type = typeof raw?.type === 'string' ? raw.type : '';
    let text = '';
    const content = raw?.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c: any) => typeof c?.text === 'string')
        .map((c: any) => c.text)
        .join('');
    }

    if (role) {
      return `msg:${role}:${type}:${text}`;
    }

    // Fallback: type + name if present.
    const name = typeof raw?.name === 'string' ? raw.name : '';
    return `item:${type}:${name}`;
  }

  #isPrefixMatch(prefix: AgentInputItem[], full: AgentInputItem[]): boolean {
    if (prefix.length > full.length) {
      return false;
    }

    for (let i = 0; i < prefix.length; i++) {
      if (this.#signature(prefix[i]) !== this.#signature(full[i])) {
        return false;
      }
    }

    return true;
  }

  #findSuffixPrefixOverlap(existing: AgentInputItem[], incoming: AgentInputItem[]): number {
    const maxWindow = 50;
    const maxOverlap = Math.min(existing.length, incoming.length, maxWindow);

    for (let k = maxOverlap; k >= 1; k--) {
      let matches = true;
      for (let i = 0; i < k; i++) {
        const a = existing[existing.length - k + i];
        const b = incoming[i];
        if (this.#signature(a) !== this.#signature(b)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return k;
      }
    }

    return 0;
  }
}
