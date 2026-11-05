import type { ApplicationRunEvent } from '../../shared/contracts/application-stream.js';
import { type AgentStream } from '../agent-stream.js';
import type { RunState } from './run-state.js';
/** Synchronous acceptance always precedes asynchronous stream publication. */
export class EventQueue {
  constructor(private readonly acceptBeforePublish?: (event: ApplicationRunEvent) => void) {}
  #items: ApplicationRunEvent[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<ApplicationRunEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  push(item: ApplicationRunEvent): void {
    this.acceptBeforePublish?.(item);
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }

  close(error?: unknown): void {
    this.#closed = true;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<ApplicationRunEvent>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.#closed) {
      if (this.#failure) return Promise.reject(this.#failure);
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}
export function outputPush(stream: AgentStream, queue: EventQueue, item: ApplicationRunEvent): void {
  stream.output.push(item);
  if (stream.newItems !== stream.output) stream.newItems.push(item);
  queue.push(item);
}

export function finish(stream: AgentStream, state: RunState, queue: EventQueue): unknown {
  stream.history = state.history;
  stream.historyReplacedByCompaction = state.compactedDuringRun === true;
  stream.terminalCause = state.terminalCause;
  stream.latestProviderInputTokens = state.lastCompletedInputTokens;
  if (
    state.supportsConversationChaining &&
    state.responseId &&
    state.responseProviderId !== undefined &&
    state.responseProviderId === state.currentProviderId
  ) {
    stream.lastResponseId = state.responseId;
  } else {
    stream.lastResponseId = null;
  }
  queue.close();
  return { usage: state.usage, output: stream.output, costRecords: state.costRecords ?? [] };
}
