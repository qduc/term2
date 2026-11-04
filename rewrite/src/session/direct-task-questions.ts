import { randomUUID } from 'node:crypto';
import type { SubagentMessageResult } from '../tools/index.js';
import type { DirectBackgroundFact, DirectOrchestratorQuestion, DirectTaskId } from './direct-background-types.js';
import { directTaskAbortError } from './direct-background-types.js';

type Pending = DirectOrchestratorQuestion & {
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
};

/** One pending question per background task: a child's `ask_orchestrator` call waits
 * here until its parent replies to that message, or the task stops. Separate from user
 * interactions. Every release follows the accepted `task_question_closed` fact; recovery
 * closes facts, never rehydrates these promises. */
export class DirectTaskQuestions {
  readonly #pending = new Map<DirectTaskId, Pending>();
  constructor(private readonly accept: (fact: DirectBackgroundFact) => void, private readonly now: () => number) {}

  pending(taskId: DirectTaskId): DirectOrchestratorQuestion | undefined {
    const entry = this.#pending.get(taskId);
    return entry && { messageId: entry.messageId, question: entry.question };
  }

  /** One bounded question per child, with a fresh correlation ID for each call. */
  ask(taskId: DirectTaskId, question: string): Promise<string> {
    const text = question.trim();
    if (!text || text.length > 1200) return Promise.reject(new Error('Invalid orchestrator question.'));
    if (this.#pending.has(taskId)) return Promise.reject(new Error('An orchestrator question is already pending.'));
    return new Promise((resolve, reject) => {
      const entry = { messageId: randomUUID(), question: text, resolve, reject };
      this.#pending.set(taskId, entry);
      try {
        this.accept({ type: 'task_question_opened', at: this.now(), taskId, question: this.pending(taskId)! });
      } catch (error) {
        this.#pending.delete(taskId);
        reject(error);
      }
    });
  }

  /** Refuse uncorrelated steering/mismatches without consuming the live waiter. */
  answer(taskId: DirectTaskId, target: string, message: string, replyTo?: string): SubagentMessageResult {
    const entry = this.#pending.get(taskId);
    const failure = (code: Extract<SubagentMessageResult, { ok: false }>['code']): SubagentMessageResult => ({
      ok: false,
      code,
      target,
    });
    const text = message.trim();
    if (!text || text.length > 2000) return failure('invalid_guidance');
    if (!replyTo) return failure(entry ? 'question_pending' : 'unsupported_control');
    if (!entry) return failure('question_not_pending');
    if (entry.messageId !== replyTo) return failure('question_mismatch');
    this.accept({
      type: 'task_question_closed',
      at: this.now(),
      taskId,
      messageId: entry.messageId,
      resolution: { kind: 'answered', answer: text },
    });
    this.#pending.delete(taskId);
    entry.resolve(text);
    return { ok: true, runId: taskId, status: 'running', delivery: 'answered' };
  }

  /** Stop/settlement invalidates the waiter, without fabricating an answer. */
  cancel(taskId: DirectTaskId, kind: 'cancelled' | 'interrupted' = 'cancelled'): void {
    const entry = this.#pending.get(taskId);
    if (!entry) return;
    try {
      this.accept({
        type: 'task_question_closed',
        at: this.now(),
        taskId,
        messageId: entry.messageId,
        resolution: { kind },
      });
    } finally {
      this.#pending.delete(taskId);
      entry.reject(directTaskAbortError());
    }
  }

  /** The sole writer failed: revoke all waits without compensating writes. */
  poison(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}
