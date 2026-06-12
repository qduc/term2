import {
  type AgentInputItem,
  type SessionHistoryRewriteAwareSession,
  type SessionHistoryRewriteArgs,
  applySessionHistoryMutations,
} from '@openai/agents';
import { ConversationStore } from './conversation-store.js';

/**
 * ConversationStoreSessionAdapter implements the SDK's Session interface
 * (specifically SessionHistoryRewriteAwareSession) and wraps the synchronous ConversationStore.
 * This ensures that the Agents SDK and Term2 use a single shared history store.
 */
export class ConversationStoreSessionAdapter implements SessionHistoryRewriteAwareSession {
  private readonly store: ConversationStore;
  private readonly sessionId: string;

  constructor(store: ConversationStore, sessionId: string) {
    this.store = store;
    this.sessionId = sessionId;
  }

  /**
   * Ensure and return the identifier for this session.
   */
  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  /**
   * Retrieve items from the conversation history.
   *
   * @param limit - The maximum number of items to return. When provided the most
   * recent {@link limit} items should be returned in chronological order.
   */
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const history = this.store.getHistory();
    if (limit === undefined) {
      return history;
    }
    if (limit <= 0) {
      return [];
    }
    return history.slice(Math.max(history.length - limit, 0));
  }

  /**
   * Append new items to the conversation history.
   *
   * @param items - Items to add to the session history.
   */
  async addItems(items: AgentInputItem[]): Promise<void> {
    this.store.appendOutput(items);
  }

  /**
   * Remove and return the most recent item from the conversation history if it
   * exists.
   */
  async popItem(): Promise<AgentInputItem | undefined> {
    const history = this.store.getHistory();
    if (history.length === 0) {
      return undefined;
    }
    const lastItem = history[history.length - 1];
    const newHistory = history.slice(0, -1);
    if (newHistory.length === 0) {
      this.store.clear();
    } else {
      this.store.replaceHistory(newHistory);
    }
    return lastItem;
  }

  /**
   * Remove all items that belong to the session and reset its state.
   */
  async clearSession(): Promise<void> {
    this.store.clear();
  }

  /**
   * Applies persisted-history mutations and returns a new canonical item list.
   *
   * @param args - The mutations to apply.
   */
  async applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> {
    if (!args.mutations || args.mutations.length === 0) {
      return;
    }
    const history = this.store.getHistory();
    const updatedHistory = applySessionHistoryMutations(history, args.mutations);
    if (updatedHistory.length === 0) {
      this.store.clear();
    } else {
      this.store.replaceHistory(updatedHistory);
    }
  }
}
