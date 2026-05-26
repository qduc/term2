import type { AgentInputItem } from '@openai/agents';
import { createHash } from 'node:crypto';
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

  #hashString(str: string): string {
    return createHash('sha256').update(str).digest('hex');
  }

  #getSignatureConfidence(signature: string): 'high' | 'medium' | 'low' {
    if (signature.startsWith('call:') || signature.startsWith('id:')) {
      return 'high';
    }
    if (signature.startsWith('msg:')) {
      if (signature.includes('image:') || signature.includes('image_url:') || signature.includes('tool:')) {
        return 'high';
      }
      const firstColon = signature.indexOf(':');
      const secondColon = signature.indexOf(':', firstColon + 1);
      const thirdColon = signature.indexOf(':', secondColon + 1);
      if (thirdColon !== -1) {
        const contentStr = signature.slice(thirdColon + 1);
        const cleanContent = contentStr.replace(/(text:|part:|msg:)/g, '');
        if (!this.#isGenericOrShort(cleanContent)) {
          return 'medium';
        }
      }
      return 'low';
    }
    if (signature.startsWith('item:')) {
      const parts = signature.split(':');
      const name = parts[2] ?? '';
      if (!this.#isGenericOrShort(name)) {
        return 'medium';
      }
      return 'low';
    }
    return 'low';
  }

  #isGenericOrShort(text: string): boolean {
    const genericWords = new Set([
      'ok',
      'yes',
      'no',
      'cancel',
      'done',
      'help',
      'quit',
      'exit',
      'y',
      'n',
      'clear',
      'stop',
      'go',
      'run',
      'true',
      'false',
      'again',
      'reply',
    ]);
    const trimmed = text.trim().toLowerCase();
    if (trimmed.length < 3) {
      return true;
    }
    return genericWords.has(trimmed);
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

        const prefix = collapsed.slice(0, i);
        const suffix = collapsed.slice(i);

        // Require tool calls in the prefix before collapsing.
        const prefixCallSignatures = this.#collectCallSignatures(prefix);
        if (prefixCallSignatures.size > 0) {
          // Heuristic 1: prefix is an exact/ordered prefix match of the suffix.
          if (this.#isPrefixMatch(prefix, suffix)) {
            replayStart = i;
            break;
          }

          // Heuristic 2: the prefix contains tool calls, and all those tool calls are present in the suffix.
          const suffixCallSignatures = this.#collectCallSignatures(suffix);
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

  #preferIncomingItem(_existing: AgentInputItem, incoming: AgentInputItem): AgentInputItem {
    // Since the signatures match, we can prefer incoming because it represents the provider/SDK's latest canonical state.
    return incoming;
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

    // Message-like items: role + type + content parts + tool_calls.
    const role = typeof raw?.role === 'string' ? raw.role : '';
    if (role) {
      const type = typeof raw?.type === 'string' ? raw.type : '';
      const parts: string[] = [];
      const content = raw?.content;
      if (typeof content === 'string') {
        if (content) {
          parts.push(`text:${content}`);
        }
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object') {
            if (typeof c.type === 'string') {
              parts.push(`part:${c.type}`);
            }
            if (typeof c.text === 'string' && c.text) {
              parts.push(`text:${c.text}`);
            }
            // Image URLs / base64 image data
            if (typeof c.image === 'string' && c.image) {
              parts.push(`image:${this.#hashString(c.image)}`);
            }
            if (c.image_url && typeof c.image_url.url === 'string' && c.image_url.url) {
              parts.push(`image_url:${this.#hashString(c.image_url.url)}`);
            }
          }
        }
      }

      // Embed tool calls inside the signature if present
      const toolCalls = anyItem?.tool_calls ?? raw?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc && typeof tc === 'object') {
            const tcId = tc.id ?? tc.callId ?? tc.call_id ?? '';
            const tcName = tc.function?.name ?? tc.name ?? '';
            parts.push(`tool:${tcId}:${tcName}`);
          }
        }
      }

      return `msg:${role}:${type}:${parts.join('|')}`;
    }

    // Fallback: type + name if present.
    const type = typeof raw?.type === 'string' ? raw.type : '';
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
    const maxOverlap = Math.min(existing.length, incoming.length);

    for (let k = maxOverlap; k >= 1; k--) {
      let matches = true;
      let hasSubstantialMatch = false;

      for (let i = 0; i < k; i++) {
        const a = existing[existing.length - k + i];
        const b = incoming[i];
        const sigA = this.#signature(a);
        const sigB = this.#signature(b);
        if (sigA !== sigB) {
          matches = false;
          break;
        }
        const confidence = this.#getSignatureConfidence(sigA);
        if (confidence === 'high' || confidence === 'medium') {
          hasSubstantialMatch = true;
        }
      }

      const lastItem: any = existing[existing.length - 1];
      const lastRaw = lastItem?.rawItem ?? lastItem;
      const isSingleUserMessage = k === 1 && lastRaw?.role === 'user';

      if (matches && (hasSubstantialMatch || isSingleUserMessage)) {
        return k;
      }
    }

    return 0;
  }
}
