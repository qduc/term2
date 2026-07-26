import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_MAILBOX_MESSAGES = 4;
const DEFAULT_MAX_MAILBOX_CHARACTERS = 4_000;
const DEFAULT_MAX_CONTINUATION_SEGMENTS = 3;
const MAX_QUESTION_CHARACTERS = 1_200;
const TRUNCATION_MARKER = '[Earlier steering omitted]';

export interface SubagentRunControlOptions {
  maxMailboxMessages?: number;
  maxMailboxCharacters?: number;
  maxContinuationSegments?: number;
  createQuestionId?: () => string;
}

export interface PendingSubagentQuestion {
  messageId: string;
  question: string;
}

export interface AskedSubagentQuestion extends PendingSubagentQuestion {
  answer: Promise<string>;
}

type QuestionWaiter = PendingSubagentQuestion & {
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
};

/**
 * Per-logical-run coordination state. The registry owns lifecycle and identity;
 * runners receive only the narrow callbacks they need for a segment.
 */
export class SubagentRunControl {
  #maxMailboxMessages: number;
  #maxMailboxCharacters: number;
  #maxContinuationSegments: number;
  #createQuestionId: () => string;
  #controller: AbortController | undefined;
  #abortReason: 'steer' | 'cancel' | undefined;
  #activeToolCount = 0;
  #interruptWhenToolsIdle = false;
  #cancellationRequested = false;
  #mailbox: string[] = [];
  #mailboxCharacters = 0;
  #mailboxTruncated = false;
  #continuationSegments = 0;
  #question: QuestionWaiter | undefined;

  constructor(options: SubagentRunControlOptions = {}) {
    this.#maxMailboxMessages = options.maxMailboxMessages ?? DEFAULT_MAX_MAILBOX_MESSAGES;
    this.#maxMailboxCharacters = options.maxMailboxCharacters ?? DEFAULT_MAX_MAILBOX_CHARACTERS;
    this.#maxContinuationSegments = options.maxContinuationSegments ?? DEFAULT_MAX_CONTINUATION_SEGMENTS;
    this.#createQuestionId = options.createQuestionId ?? randomUUID;
  }

  get currentSegmentController(): AbortController | undefined {
    return this.#controller;
  }

  get activeToolCount(): number {
    return this.#activeToolCount;
  }

  get cancellationRequested(): boolean {
    return this.#cancellationRequested;
  }

  get hasQueuedSteering(): boolean {
    return this.#mailbox.length > 0;
  }

  get currentSegmentAbortReason(): 'steer' | 'cancel' | undefined {
    return this.#abortReason;
  }

  get continuationSegments(): number {
    return this.#continuationSegments;
  }

  canStartContinuation(): boolean {
    return !this.#cancellationRequested && this.#continuationSegments < this.#maxContinuationSegments;
  }

  startContinuation(): boolean {
    if (!this.canStartContinuation()) return false;
    this.#continuationSegments++;
    return true;
  }

  get pendingQuestion(): PendingSubagentQuestion | undefined {
    return this.#question && { messageId: this.#question.messageId, question: this.#question.question };
  }

  beginSegment(): AbortController {
    if (this.#controller) throw new Error('A subagent segment is already active.');
    const controller = new AbortController();
    this.#controller = controller;
    this.#abortReason = undefined;
    if (this.#cancellationRequested) this.#abortCurrentSegment('cancel');
    return controller;
  }

  endSegment(controller: AbortController): void {
    if (this.#controller !== controller) return;
    this.#controller = undefined;
    this.#abortReason = undefined;
    this.#activeToolCount = 0;
    this.#interruptWhenToolsIdle = false;
  }

  onToolStart(): void {
    this.#activeToolCount++;
  }

  onToolComplete(): void {
    if (this.#activeToolCount === 0) return;
    this.#activeToolCount--;
    if (this.#activeToolCount === 0 && this.#interruptWhenToolsIdle) this.#abortCurrentSegment();
  }

  enqueueSteering(message: string): void {
    this.#mailbox.push(message);
    this.#mailboxCharacters += message.length;
    while (
      this.#mailbox.length > this.#maxMailboxMessages ||
      (this.#mailbox.length > 1 && this.#mailboxCharacters > this.#maxMailboxCharacters)
    ) {
      const removed = this.#mailbox.shift();
      this.#mailboxCharacters -= removed?.length ?? 0;
      this.#mailboxTruncated = true;
    }
    this.#interruptWhenToolsIdle = true;
    if (this.#activeToolCount === 0) this.#abortCurrentSegment();
  }

  consumeSteering(): string | undefined {
    if (this.#mailbox.length === 0) return undefined;
    const messages = this.#mailbox;
    const truncated = this.#mailboxTruncated;
    this.#mailbox = [];
    this.#mailboxCharacters = 0;
    this.#mailboxTruncated = false;
    return [truncated ? TRUNCATION_MARKER : undefined, ...messages].filter(Boolean).join('\n');
  }

  ask(question: string): AskedSubagentQuestion {
    const boundedQuestion = question.trim();
    if (boundedQuestion.length === 0) throw new Error('A subagent question cannot be empty.');
    if (boundedQuestion.length > MAX_QUESTION_CHARACTERS)
      throw new Error(`Question exceeds ${MAX_QUESTION_CHARACTERS} characters.`);
    if (this.#question) throw new Error('A subagent question is already pending.');
    let resolve!: (answer: string) => void;
    let reject!: (reason: Error) => void;
    const answer = new Promise<string>((resolveAnswer, rejectAnswer) => {
      resolve = resolveAnswer;
      reject = rejectAnswer;
    });
    const pending = { messageId: this.#createQuestionId(), question: boundedQuestion, resolve, reject };
    this.#question = pending;
    return { messageId: pending.messageId, question, answer };
  }

  answer(messageId: string, answer: string): boolean {
    if (!this.#question || this.#question.messageId !== messageId) return false;
    const pending = this.#question;
    this.#question = undefined;
    pending.resolve(answer);
    return true;
  }

  requestCancellation(): void {
    this.#cancellationRequested = true;
    this.#mailbox = [];
    this.#mailboxCharacters = 0;
    this.#mailboxTruncated = false;
    this.#rejectPendingQuestion(new Error('The subagent run was cancelled.'));
    this.#abortCurrentSegment('cancel');
  }

  settle(reason = new Error('The subagent run was cancelled.')): void {
    this.#mailbox = [];
    this.#mailboxCharacters = 0;
    this.#mailboxTruncated = false;
    this.#rejectPendingQuestion(reason);
  }

  #rejectPendingQuestion(reason: Error): void {
    if (!this.#question) return;
    const pending = this.#question;
    this.#question = undefined;
    pending.reject(reason);
  }

  #abortCurrentSegment(reason: 'steer' | 'cancel' = 'steer'): void {
    this.#abortReason = reason;
    if (this.#controller && !this.#controller.signal.aborted) this.#controller.abort();
  }
}
