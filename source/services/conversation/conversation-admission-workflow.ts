import type { InputSurgeDecision } from '../input-surge-guard.js';
import type { LargeUncachedInputDecision } from '../large-uncached-input-guard.js';
import { issueInputSurgeApproval, type InputSurgeApproval } from '../input-surge-approval.js';
import { injectSkillIntoTurn, type UserTurn } from '../../types/user-turn.js';

export type ConversationBusyMode = 'steer' | 'follow_up';

export type AdmissionOptions = {
  busyMode?: ConversationBusyMode;
};

type SenderOptions = AdmissionOptions & { inputSurgeApproval?: InputSurgeApproval };

export type AdmissionConfirmation =
  | {
      id: string;
      kind: 'surge';
      turn: UserTurn;
      reason: string;
      options: AdmissionOptions;
    }
  | {
      id: string;
      kind: 'large_uncached';
      turn: UserTurn;
      estimatedTokens: number;
      options: AdmissionOptions;
    };

export type AdmissionSubmitResult =
  | { kind: 'submitted'; completion: Promise<void> }
  | { kind: 'confirmation_required'; confirmation: AdmissionConfirmation };
export type AdmissionResolveResult = AdmissionSubmitResult | { kind: 'declined'; turn: UserTurn } | { kind: 'stale' };

type ConversationPreview = {
  previewInputSurge(turn: UserTurn): InputSurgeDecision;
  previewLargeUncachedInput(turn: UserTurn, now: number): LargeUncachedInputDecision;
};

type HistorySink = { addMessage(turn: UserTurn): void };
type Logger = { debug(message: string, metadata?: Record<string, unknown>): void };
type Send = (turn: UserTurn, options?: SenderOptions) => Promise<void>;

export type ConversationAdmissionWorkflowDependencies = {
  conversation: ConversationPreview;
  history: HistorySink;
  logger: Logger;
  send: Send;
  now?: () => number;
};

/**
 * Owns the policy that decides whether a user turn is admitted now or needs a
 * confirmation. The UI renders the current confirmation and translates its
 * answer; it never owns the staged turn, bypass capability, or admission order.
 */
export class ConversationAdmissionWorkflow {
  readonly #deps: Required<ConversationAdmissionWorkflowDependencies>;
  #pending: AdmissionConfirmation | null = null;
  #nextId = 0;
  readonly #listeners = new Set<() => void>();

  constructor(deps: ConversationAdmissionWorkflowDependencies) {
    this.#deps = { ...deps, now: deps.now ?? Date.now };
  }

  getSnapshot(): AdmissionConfirmation | null {
    return this.#pending;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  submit(turn: UserTurn, options: AdmissionOptions = {}): AdmissionSubmitResult {
    if (this.#pending) {
      return { kind: 'confirmation_required', confirmation: this.#pending };
    }
    return this.#attempt(turn, this.#admissionOptions(options));
  }

  resolve(id: string, decision: 'approve' | 'decline'): AdmissionResolveResult {
    const pending = this.#pending;
    if (!pending || pending.id !== id) {
      return { kind: 'stale' };
    }

    // Consume synchronously: a duplicate keypress cannot resolve a later
    // confirmation while the original decision is awaiting a send.
    this.#pending = null;
    this.#notify();

    if (decision === 'decline') {
      return { kind: 'declined', turn: pending.turn };
    }

    if (pending.kind === 'surge') {
      return this.#admit(pending.turn, {
        ...pending.options,
        inputSurgeApproval: issueInputSurgeApproval(
          pending.turn.skill ? injectSkillIntoTurn(pending.turn) : pending.turn,
        ),
      });
    }

    return this.#admit(pending.turn, pending.options);
  }

  #attempt(turn: UserTurn, options: AdmissionOptions): AdmissionSubmitResult {
    const surge = this.#deps.conversation.previewInputSurge(turn);
    if (surge.action === 'block') {
      const confirmation: AdmissionConfirmation = {
        id: this.#createId(),
        kind: 'surge',
        turn,
        reason: surge.reason || 'Input surge detected',
        options,
      };
      this.#setPending(confirmation);
      this.#deps.logger.debug('Input surge warning shown', {
        eventType: 'input_surge_warning_shown',
        category: 'provider',
        reason: surge.reason,
        stats: surge.stats,
        previousStats: surge.previousStats,
      });
      return { kind: 'confirmation_required', confirmation };
    }

    if (!options.busyMode) {
      const large = this.#deps.conversation.previewLargeUncachedInput(turn, this.#deps.now());
      if (large.action === 'warn') {
        const confirmation: AdmissionConfirmation = {
          id: this.#createId(),
          kind: 'large_uncached',
          turn,
          estimatedTokens: large.estimatedTokens,
          options,
        };
        this.#setPending(confirmation);
        this.#deps.logger.debug('Large uncached input warning shown', {
          eventType: 'large_uncached_input_warning_shown',
          category: 'provider',
          estimatedTokens: large.estimatedTokens,
          estimatedBytes: large.estimatedBytes,
          reasons: large.reasons,
        });
        return { kind: 'confirmation_required', confirmation };
      }
    }

    return this.#admit(turn, options);
  }

  #admit(turn: UserTurn, options: SenderOptions): { kind: 'submitted'; completion: Promise<void> } {
    this.#deps.history.addMessage(turn);
    try {
      return { kind: 'submitted', completion: this.#deps.send(turn, options) };
    } catch (error) {
      return { kind: 'submitted', completion: Promise.reject(error) };
    }
  }

  #createId(): string {
    this.#nextId += 1;
    return `admission-${this.#nextId}`;
  }

  #admissionOptions(options: AdmissionOptions): AdmissionOptions {
    return options.busyMode ? { busyMode: options.busyMode } : {};
  }

  #setPending(confirmation: AdmissionConfirmation): void {
    this.#pending = confirmation;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
