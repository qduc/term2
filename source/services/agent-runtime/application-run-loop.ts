import { z } from 'zod';
import type { ProviderInput, ProviderInputItem } from '../../contracts/provider-input.js';
import type { JsonSchemaDefinition } from '../../contracts/model-types.js';
import type { ApplicationRunEvent } from '../../contracts/application-stream.js';
import {
  createContinuationHandle,
  unwrapContinuationHandle,
  type ContinuationHandle,
} from '../../contracts/continuation-handle.js';
import { createAgentStream, type AgentStream } from '../agent-stream.js';
import type {
  StreamedModelMessagePart,
  StreamedModelProviderOptions,
  StreamedModelToolResultPart,
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  ContextCompactionSessionState,
  StreamedModelTurnRequest,
  StreamedModelTool,
} from '../../contracts/streamed-model-turn.js';
import type {
  AnyToolDefinition,
  ToolExecutionLifecycleContext,
  ToolExecutionLifecyclePort,
  ToolRegistry,
} from '../../tools/types.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
import type { Term2HookScope } from '../hooks/hook-contracts.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { isCancellationError, isHarnessInvariantError } from '../../lib/harness-invariant-error.js';
import { ApprovalLedger, type ToolInvocationContext } from './tool-invocation-context.js';
import {
  RunBudget,
  isRunBudgetInteraction,
  type RunBudgetEvent,
  type RunBudgetInteraction,
  type RunBudgetPolicy,
} from './run-budget.js';
import { addTokenUsage, normalizeUsage } from '../../utils/ai/token-usage.js';
import { computeModelCost, type ModelRequestCost, type ServiceTier } from '../../services/cost/model-cost.js';
import { getCatalogPricingVersion, getModelPricing } from '../../services/cost/pricing.js';
import {
  GenerationGuard,
  GenerationGuardError,
  GenerationStreamDeadlines,
  type GenerationGuardOptions,
} from './generation-guard.js';

/**
 * Fields of `modelSettings` the run loop and provider adapters actually read.
 * Codex-only request fields are modeled separately so they cannot escape into
 * another provider's opaque option bag. The index signature remains for legacy
 * provider settings before they are projected by the application configuration.
 */
export interface AgentModelSettings {
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  maxTokens?: number;
  /** Hard per-request stream-output budget across text, reasoning, and tool arguments. */
  maxStreamOutputChars?: number;
  /** Optional total wall-clock ceiling for each provider request; 0 disables it. Opt-in backstop. */
  maxModelRequestDurationMs?: number;
  /** Provider-neutral inactivity window: abort if no streamed delta arrives within this many ms; 0 disables it. */
  maxModelStreamIdleMs?: number;
  retry?: { maxRetries?: number };
  providerData?: Record<string, unknown>;
  codex?: { promptCacheKey?: string; include?: readonly string[] };
  [key: string]: unknown;
}

/** The application-owned agent shape consumed by the replacement run loop. */
export interface ApplicationAgent {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  modelSettings?: AgentModelSettings;
  defaultRunOptions?: any;
  outputType?: JsonSchemaDefinition | 'text';
  readonly tools: ToolRegistry;
}

export interface ApplicationRequestPreparation {
  /** Observe the exact application request immediately before model dispatch. */
  readonly prepare: (request: StreamedModelTurnRequest) => void;
  /** Keep request preparation context alive for the complete async model request. */
  readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface ApplicationBoundaryCompaction {
  readonly compact: (input: {
    history: readonly ProviderInputItem[];
    automaticCompactionsThisRun: number;
    signal?: AbortSignal;
    onStarted: (provider: string) => void;
  }) => Promise<
    | { kind: 'unchanged' }
    | { kind: 'failed'; provider: string }
    | {
        kind: 'compacted';
        history: ProviderInputItem[];
        modelInput: ProviderInputItem[];
        costRecords?: ModelRequestCost[];
      }
  >;
}

export interface ApplicationRunLoopOptions {
  readonly signal?: AbortSignal;
  /** Existing provider response to continue from on the first model turn. */
  readonly previousResponseId?: string | null;
  /** Skip previous_response_id and transport history compression for the next model request. */
  readonly disableChainingForAttempt?: boolean;
  /** Identity of the provider making this run. Required to establish response provenance. */
  readonly providerId?: string;
  /** Whether this provider accepts response IDs for continuation requests. */
  readonly supportsConversationChaining?: boolean;
  readonly sessionId?: string;
  /** Public hook correlation for the logical session turn. */
  readonly turnId?: string;
  /** Root/subagent ownership for observational tool events. */
  readonly hookScope?: Term2HookScope;
  /** Per-run user context delivered to tools as `ToolInvocationContext.context`. */
  readonly context?: unknown;
  /**
   * The run's approval ledger; a fresh one is created when omitted. Pass a
   * pre-seeded ledger to honor decisions already taken (e.g. parent approvals
   * replayed into a nested run — the F5 mechanism).
   */
  readonly approvals?: ApprovalLedger;
  /**
   * Legacy model-turn ceiling. With `runBudget`, the policy's `turnBackstop`
   * owns staged behavior while this value remains visible to legacy tools;
   * without one it preserves {@link MaxTurnsExceededError} compatibility.
   */
  readonly maxTurns?: number;
  /** Settings-backed staged containment policy. Omit only for legacy callers. */
  readonly runBudget?: RunBudgetPolicy;
  /** Observational escalation events; delivery and judgment remain outside the loop. */
  readonly onRunBudgetEvent?: (event: RunBudgetEvent) => void;
  /** Subagent containment: critical evidence gets one tool-free terminal call. */
  readonly wrapUpOnCriticalRunBudget?: boolean;
  /** Root-only provider request preparation, retained by continuations. */
  readonly requestPreparation?: ApplicationRequestPreparation;
  /** Application-owned local compaction evaluated at each request boundary. */
  readonly boundaryCompaction?: ApplicationBoundaryCompaction;
  /** Per-request output and deadline guard; model settings provide the normal runtime defaults. */
  readonly generationGuard?: GenerationGuardOptions;
  /**
   * End the segment once the pending approval's tool result is in history,
   * instead of crossing the request boundary into another model call. The
   * segment then finishes with no interruptions, so it is terminal and its
   * history — the tool call *and* its result — is committed. Cancelling an
   * `ask_user` prompt uses this: the user gets the turn back, and the model
   * still sees that the question was asked and went unanswered.
   */
  readonly stopAfterApprovalResolution?: boolean;
}

/**
 * Compatibility error for legacy callers without a staged run budget. The loop
 * owns turn counting — the SDK-era `callModelInputFilter` hook is deliberately
 * not reintroduced.
 */
export class MaxTurnsExceededError extends Error {
  readonly maxTurns: number;

  constructor(maxTurns: number) {
    super(`Max turns (${maxTurns}) exceeded`);
    this.name = 'MaxTurnsExceededError';
    this.maxTurns = maxTurns;
  }
}

export interface ApplicationRunLoopDeps {
  readonly resolveModel: (model: string) => StreamedModelTurn | Promise<StreamedModelTurn>;
  readonly toolLifecycle?: ToolExecutionLifecyclePort;
  /**
   * Called when a tool body is about to run. Used by the session tool ledger to
   * mark dispatch so stream recovery can distinguish "never ran" from "outcome
   * unobserved". Resolved via getter so the session can wire the tracker after
   * the client is constructed.
   */
  readonly getOnToolDispatch?: () => ((callId: string) => void) | undefined;
  /**
   * Resolves the conservative cap for independent calls from one response.
   * Read when settling a completed response so runtime settings apply at the
   * next request boundary; child budgets remain authoritative.
   */
  readonly resolveMaxParallelToolCalls?: () => number | undefined;
  /**
   * Diagnostics sink. Optional so no construction site or test has to supply
   * one. Used to report the fate of steers, which is otherwise invisible: a
   * turn spans several runs, and a steer only survives the run it was handed to.
   */
  readonly logDiagnostic?: (message: string, meta: Record<string, unknown>) => void;
  readonly contextCompactionSessionState?: ContextCompactionSessionState;
}

/**
 * The fate of a message handed to `steer`/`retractSteer`/`editSteer`.
 *
 * `'admitted'` — the running turn took it at a request boundary.
 * `'released'` — no further boundary is coming (turn ending, or none
 * running); the caller must send it as its own turn instead.
 * `'retracted'` — `retractSteer` pulled it out before either of the above.
 */
export type SteerOutcome = 'admitted' | 'released' | 'retracted';

/** A user message waiting for the running turn's next request boundary. */
type PendingSteer = {
  readonly id?: string;
  readonly items: readonly ProviderInputItem[];
  readonly resolve: (outcome: SteerOutcome) => void;
};

type PendingApproval = {
  callId: string;
  toolName: string;
  argumentsText: string;
  interruption: Record<string, unknown>;
  definition: AnyToolDefinition;
  params: unknown;
  plan: ToolPlanEntry;
};

type ToolPlanEntry = {
  readonly event: Extract<StreamedModelTurnEvent, { type: 'tool_call' }>;
  readonly definition?: AnyToolDefinition;
  params?: unknown;
  parallelSafe: boolean;
  status: 'ready' | 'approval_pending' | 'completed';
  output?: string;
};

type RunState = {
  agent: ApplicationAgent;
  input: StreamedModelTurnInput[];
  history: ProviderInputItem[];
  pendingApproval?: PendingApproval;
  pendingApprovals?: PendingApproval[];
  approvalDecision?: 'approved' | 'rejected';
  approvalDecisionCallId?: string;
  approvalMessage?: string;
  responseId?: string;
  usage?: unknown;
  /** The run's user context (from options), preserved across continuation. */
  context?: unknown;
  /** This run's approval ledger, preserved across continuation. */
  approvals: ApprovalLedger;
  /** Model turns taken so far, preserved across continuation. */
  turnCount: number;
  /** Local automatic compactions already paid for in this run. */
  automaticCompactionsThisRun?: number;
  /** Turn budget for the run; undefined means unbounded. */
  maxTurns?: number;
  /** Per-run staged budget and deterministic stall sensor, retained across approval continuation. */
  runBudget?: RunBudget;
  onRunBudgetEvent?: (event: RunBudgetEvent) => void;
  wrapUpOnCriticalRunBudget?: boolean;
  /** Copied from the run-budget policy: 'warn' never pauses the run. */
  runBudgetEscalation?: 'warn' | 'pause';
  criticalWrapUpPending?: boolean;
  criticalWrapUpDispatched?: boolean;
  /** Main-agent evidence that must be resolved before another request or tool dispatch. */
  pendingRunBudgetInteraction?: RunBudgetInteraction;
  runBudgetInteractionDecision?: 'continue' | 'stop';
  /** Whether the current interaction's finite extension has already been taken. */
  runBudgetGrantConsumed?: boolean;
  /** A critical check-in already counted the next model request before pausing. */
  requestBoundaryReady?: boolean;
  /** Cumulative model-request cost records for this run, preserved across continuation. */
  costRecords?: ModelRequestCost[];
  /** Keep provider response IDs out of requests for providers that do not support them. */
  supportsConversationChaining: boolean;
  /** One-shot: the next model request must be a fresh full-history inference. */
  disableChainingForAttempt?: boolean;
  /** Provider currently executing this continuation. */
  currentProviderId?: string;
  /** Provider that originated responseId; absent on legacy handles. */
  responseProviderId?: string;
  /** Root-only provider request preparation, retained by continuations. */
  requestPreparation?: ApplicationRequestPreparation;
  sessionId?: string;
  turnId?: string;
  hookScope?: Term2HookScope;
  toolAttempts?: Map<string, number>;
  toolPlan?: ToolPlanEntry[];
  approve?: (_interruption?: unknown) => void;
  reject?: (_interruption?: unknown, options?: { message?: string }) => void;
};

class EventQueue {
  #items: ApplicationRunEvent[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<ApplicationRunEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  push(item: ApplicationRunEvent): void {
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

/**
 * Process-wide monotonic counter for model-request cost ids.
 *
 * Request ids must be unique across every run in the process: root runs,
 * subagent runs, and approval continuations all feed the same session
 * accumulator, which dedups by id to make event + terminal double-delivery
 * safe. A run-local sequence (as in a per-run counter) would collide across
 * turns and silently drop later turns' records.
 */
let nextCostRequestSeq = 0;
let nextToolBatchSeq = 0;
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 3;

/**
 * Small provider-neutral agent loop. It owns model-turn sequencing and tool
 * execution; providers only implement `StreamedModelTurn`.
 */
export class ApplicationRunLoop {
  readonly #deps: ApplicationRunLoopDeps;
  readonly #contextCompactionSessionState: ContextCompactionSessionState;
  #activeAbortController: AbortController | null = null;
  #runInFlight = false;
  #segmentGeneration = 0;
  /**
   * Set when a segment ends holding approvals, meaning the turn is pausing
   * rather than finishing. Injections offered during the pause wait here for
   * the continuation segment instead of being refused for want of a run.
   */
  #turnPaused = false;
  /**
   * Set while a caller that owns turn boundaries has a turn open, from before
   * its first request is built until after its last one settles.
   *
   * `#runInFlight` and `#turnPaused` only ever describe a *segment*, so between
   * them they leave every gap in a turn where no run exists yet: the startup
   * before the first request (provider model discovery, hooks, input
   * preparation) and the backoff before a retry restarts the stream. A turn is
   * steerable across those gaps, and only the caller that opened the turn knows
   * they belong to it.
   */
  #turnOpen = false;
  #pendingSteers: PendingSteer[] = [];
  /** The run whose budget an out-of-band grant applies to, held across a pause. */
  #activeRunBudgetState: RunState | undefined;

  constructor(deps: ApplicationRunLoopDeps) {
    this.#deps = deps;
    this.#contextCompactionSessionState = deps.contextCompactionSessionState ?? { disabled: false };
  }

  /**
   * Declare a turn open, making it steerable before its first run exists.
   *
   * Anything still waiting belongs to a turn that never closed, and can never
   * be admitted now.
   */
  openTurn(): void {
    this.#releasePendingSteers({ reason: 'superseded_by_new_turn' });
    this.#turnOpen = true;
    this.#turnPaused = false;
  }

  /**
   * Declare the turn over. Whatever is still waiting had no boundary left, so
   * it is handed back for the caller to send as its own turn.
   */
  closeTurn(): void {
    this.#turnOpen = false;
    this.#turnPaused = false;
    this.#releasePendingSteers({ reason: 'turn_closed' });
  }

  abort(): void {
    this.abortSegment();
    // An aborted turn will not resume, so nothing may keep waiting on it.
    this.#turnOpen = false;
    this.#turnPaused = false;
    this.#releasePendingSteers({ reason: 'aborted' });
  }

  /**
   * Stop the segment currently streaming without judging the turn's fate.
   *
   * Resuming a paused turn goes through here, so waiting injections survive;
   * only `abort`, which means the turn itself is over, discards them.
   */
  abortSegment(): void {
    this.#activeAbortController?.abort();
    this.#activeAbortController = null;
  }

  /**
   * Grant one finite continuation extension to the current logical run.
   *
   * The interactive prompt calls this before resuming because it has to show
   * the human a refusal rather than a silent stop. The grant is recorded so the
   * matching `approve` does not charge a second one.
   */
  grantRunBudgetExtension(grantedBy: 'parent' | 'human' = 'human'): { granted: boolean; extensionsGranted: number } {
    const state = this.#activeRunBudgetState;
    if (!state?.runBudget) return { granted: false, extensionsGranted: 0 };
    const grant = state.runBudget.grantExtension(grantedBy);
    if (grant.granted) state.runBudgetGrantConsumed = true;
    return grant;
  }

  /**
   * Charge this interaction's extension unless a caller already took it.
   *
   * An ungranted arrival here means nobody was prompted — the continuation
   * applier, non-interactive mode, `--auto-approve`. That is a parent-class
   * grant, so it is capped and eventually refuses.
   */
  #takeRunBudgetGrant(state: RunState): boolean {
    if (state.runBudgetGrantConsumed) {
      state.runBudgetGrantConsumed = false;
      return true;
    }
    if (!state.runBudget) return true;
    return state.runBudget.grantExtension('parent').granted;
  }

  /**
   * Hand the running turn a user message to send with its next model request.
   *
   * The loop admits it at a request boundary — after the tool results of the
   * current round are in history and before the next request is built — so the
   * model reads it in sequence without the turn being interrupted. Nothing is
   * cancelled, and a tool already running is untouched.
   *
   * The wait spans the whole turn, not just the segment it was offered to: a
   * turn that pauses for an approval resumes as a new segment, and the message
   * is admitted at that segment's first boundary. A caller that declares its
   * turn boundaries with `openTurn`/`closeTurn` extends the wait further still,
   * to the gaps where no segment exists at all — before the first request, and
   * across a retry that restarts the stream.
   *
   * Resolves `'admitted'` once the message has been admitted, `'released'`
   * when the turn ends first (or none is running) — it offered no further
   * request boundary, so the caller must send the message as its own turn
   * instead — and `'retracted'` when `retractSteer` pulled it out first.
   *
   * `options.id` correlates this steer with `retractSteer`/`editSteer`. A
   * steer offered without an id can never be retracted or edited in place —
   * only released or admitted.
   */
  steer(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome> {
    if (items.length === 0) return Promise.resolve('released');
    if (!this.#turnOpen && !this.#runInFlight && !this.#turnPaused) return Promise.resolve('released');
    return new Promise<SteerOutcome>((resolve) => {
      this.#pendingSteers.push({ id: options?.id, items, resolve });
    });
  }

  /**
   * Drop a still-waiting steer before it reaches a request boundary. Returns
   * `false` when the id is unknown, including when it was already admitted.
   *
   * Invariant: this and `#admitPendingSteers` are both synchronous, and the
   * latter drains `#pendingSteers` in a single pass — so the two can never
   * interleave. A retraction is decided in the same tick against whatever is
   * currently in `#pendingSteers`; once an item has been admitted it is no
   * longer in that array for this method to find. No locking is needed to
   * close the race between "the user retracts" and "the turn admits".
   */
  retractSteer(id: string): boolean {
    const index = this.#pendingSteers.findIndex((steer) => steer.id === id);
    if (index < 0) return false;
    const [steer] = this.#pendingSteers.splice(index, 1);
    steer!.resolve('retracted');
    return true;
  }

  /**
   * Replace a waiting steer's items in place, keeping its position (and thus
   * its priority relative to other pending steers) and its id. Returns
   * `false` when the id is unknown, including when it was already admitted —
   * same synchronicity invariant as `retractSteer`.
   */
  editSteer(id: string, items: readonly ProviderInputItem[]): boolean {
    const index = this.#pendingSteers.findIndex((steer) => steer.id === id);
    if (index < 0) return false;
    this.#pendingSteers[index] = { ...this.#pendingSteers[index]!, items };
    return true;
  }

  /** Settle every steer this run did not admit so callers stop waiting on it. */
  #releasePendingSteers(reason: Record<string, unknown> = {}): void {
    const pending = this.#pendingSteers;
    this.#pendingSteers = [];
    if (pending.length > 0) {
      this.#deps.logDiagnostic?.('Steer released at run end', { released: pending.length, ...reason });
    }
    for (const steer of pending) steer.resolve('released');
  }

  /**
   * Append waiting steers to the turn as ordinary user messages.
   *
   * They enter history and model input exactly as a user turn does — never
   * folded into a tool result — so the provider sees the user speaking after
   * the tool results of the round that was in flight when they typed.
   */
  #admitPendingSteers(state: RunState, stream: AgentStream, queue: EventQueue): void {
    if (this.#pendingSteers.length === 0) return;
    const admitted = this.#pendingSteers;
    this.#pendingSteers = [];
    this.#deps.logDiagnostic?.('Steer admitted at request boundary', {
      admitted: admitted.length,
      turnCount: state.turnCount,
    });
    for (const steer of admitted) {
      for (const item of steer.items) {
        state.history.push(item);
        state.input.push(...normalizeApplicationInput([item]));
        outputPush(stream, queue, { type: 'item', item });
      }
      steer.resolve('admitted');
    }
  }

  startStream(agent: ApplicationAgent, input: ProviderInput, options: ApplicationRunLoopOptions = {}): AgentStream {
    // Without a declared turn scope, a fresh stream is the only evidence this
    // loop gets that a new turn has begun: anything still waiting belonged to
    // the previous one and must not leak into work the user did not aim it at.
    // With one, this call may equally be the same turn restarting after a
    // retry, which the loop cannot tell apart — so `openTurn`/`closeTurn` own
    // the decision instead.
    this.#turnPaused = false;
    if (!this.#turnOpen) this.#releasePendingSteers({ reason: 'superseded_by_new_turn' });
    const state: RunState = {
      agent,
      input: normalizeInput(input),
      history: normalizeHistory(input),
      // A response ID is usable only after its provider origin is recorded.
      // This also makes old callers that omit providerId fail closed.
      responseId:
        options.disableChainingForAttempt !== true &&
        options.providerId &&
        options.supportsConversationChaining === true
          ? options.previousResponseId ?? undefined
          : undefined,
      pendingApprovals: [],
      supportsConversationChaining: options.supportsConversationChaining === true,
      currentProviderId: options.providerId,
      responseProviderId:
        options.providerId && options.supportsConversationChaining === true && options.previousResponseId
          ? options.providerId
          : undefined,
      requestPreparation: options.requestPreparation,
      disableChainingForAttempt: options.disableChainingForAttempt === true,
      sessionId: options.sessionId,
      turnId: options.turnId,
      hookScope: options.hookScope,
      context: options.context,
      approvals: options.approvals ?? new ApprovalLedger(),
      turnCount: 0,
      maxTurns: options.maxTurns,
      ...(options.runBudget
        ? {
            runBudget: new RunBudget(options.runBudget),
            onRunBudgetEvent: options.onRunBudgetEvent,
            wrapUpOnCriticalRunBudget: options.wrapUpOnCriticalRunBudget,
            runBudgetEscalation: options.runBudget.escalation,
          }
        : {}),
      automaticCompactionsThisRun: 0,
    };
    state.approve = (interruption) => {
      if (isRunBudgetInteraction(interruption)) {
        // Continuing past an exhausted envelope must cost a finite extension no
        // matter which surface answered. A caller that already took the grant
        // (the interactive prompt, which needs the outcome before resuming)
        // marks it consumed; every other path — the continuation applier,
        // non-interactive, --auto-approve — lands here ungranted and takes it
        // now. Without this, an auto-approved 'y' would resume with every stage
        // still latched and never check in again.
        state.runBudgetInteractionDecision = this.#takeRunBudgetGrant(state) ? 'continue' : 'stop';
        return;
      }
      state.approvalDecision = 'approved';
      state.approvalDecisionCallId = getInterruptionCallId(interruption);
    };
    state.reject = (interruption, approvalOptions) => {
      if (isRunBudgetInteraction(interruption)) {
        state.runBudgetInteractionDecision = 'stop';
        return;
      }
      state.approvalDecision = 'rejected';
      state.approvalDecisionCallId = getInterruptionCallId(interruption);
      state.approvalMessage = approvalOptions?.message;
    };
    return this.#run(state, options);
  }

  continueRunStream(handle: ContinuationHandle, options: ApplicationRunLoopOptions = {}): AgentStream {
    const state = unwrapContinuationHandle(handle) as RunState;
    if (!state || typeof state !== 'object' || !('agent' in state) || !('input' in state)) {
      throw new Error('Invalid application continuation state');
    }
    // Handles created before the ledger existed cannot resume meaningfully;
    // give them a fresh ledger rather than crashing on `approvals` access.
    if (!state.approvals) state.approvals = new ApprovalLedger();
    // A continuation handle from before approval batching carried only the
    // current pending item. Normalize it into the queue used by current runs.
    if (!state.pendingApprovals) state.pendingApprovals = state.pendingApproval ? [state.pendingApproval] : [];
    if (!state.pendingApproval && state.pendingApprovals.length > 0) {
      state.pendingApproval = state.pendingApprovals[0];
    }
    // Handles created before cost accounting existed have no record list.
    if (!state.costRecords) state.costRecords = [];
    if (!state.runBudget && options.runBudget) {
      state.runBudget = new RunBudget(options.runBudget);
    }
    if (options.runBudget) state.runBudgetEscalation = options.runBudget.escalation;
    if (options.onRunBudgetEvent) state.onRunBudgetEvent = options.onRunBudgetEvent;
    if (options.wrapUpOnCriticalRunBudget) state.wrapUpOnCriticalRunBudget = true;
    // Response IDs are provider-owned. A handle from before provenance was
    // recorded, a missing providerId, or a provider switch must never forward
    // its opaque ID. In particular, do not use previousResponseId as a
    // compatibility fallback here: its origin cannot be proven.
    const previousProviderId = state.currentProviderId;
    const sameProvider =
      typeof previousProviderId === 'string' &&
      typeof options.providerId === 'string' &&
      previousProviderId === options.providerId;
    if (!sameProvider || options.supportsConversationChaining !== true) {
      state.responseId = undefined;
      state.responseProviderId = undefined;
    } else if (options.previousResponseId) {
      // A same-provider caller may supply a refreshed continuity anchor (for
      // example after persisted-session recovery). Its origin is now proven
      // by the provider identity carried in this continuation state.
      state.responseId = options.previousResponseId;
      state.responseProviderId = options.providerId;
    }
    state.currentProviderId = options.providerId;
    // The turn budget belongs to the run, so a resumed run keeps spending the
    // same one rather than starting over after every approval pause.
    if (typeof state.turnCount !== 'number') state.turnCount = 0;
    if (state.maxTurns === undefined) state.maxTurns = options.maxTurns;
    if (typeof state.supportsConversationChaining !== 'boolean') {
      state.supportsConversationChaining = options.supportsConversationChaining === true;
    } else {
      // AgentClient supplies the current provider capability on every resume.
      state.supportsConversationChaining = options.supportsConversationChaining === true;
    }
    // A continuation receives a fresh immutable snapshot from the session;
    // refresh the preparation closure when supplied, while preserving the
    // root closure for callers that do not provide one again.
    if (options.requestPreparation) state.requestPreparation = options.requestPreparation;
    if (options.disableChainingForAttempt === true) {
      state.disableChainingForAttempt = true;
      state.responseId = undefined;
      state.responseProviderId = undefined;
    }
    if (options.sessionId !== undefined) state.sessionId = options.sessionId;
    if (options.turnId !== undefined) state.turnId = options.turnId;
    if (options.hookScope !== undefined) state.hookScope = options.hookScope;
    return this.#run(state, options);
  }

  #run(state: RunState, options: ApplicationRunLoopOptions): AgentStream {
    const queue = new EventQueue();
    const segmentGeneration = ++this.#segmentGeneration;
    this.abortSegment();
    const controller = new AbortController();
    this.#activeAbortController = controller;
    this.#runInFlight = true;
    state.runBudget?.resume();
    // This segment is running, so the turn is no longer paused between them.
    this.#turnPaused = false;
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const effectiveOptions = { ...options, signal: controller.signal };
    const toolContext: ToolInvocationContext = {
      context: state.context,
      approvals: state.approvals,
      signal: effectiveOptions.signal,
      // A getter, not a snapshot: the context object outlives every turn, and
      // tools read it while deciding whether to warn about the turn budget.
      get turn() {
        return { count: state.turnCount, max: state.maxTurns };
      },
      get budget() {
        return state.runBudget
          ? {
              takeSoftEvidence: () => state.runBudget?.takeSoftEvidence(),
              takeStallEvidence: () => state.runBudget?.takeStallEvidence(),
              remainingPolicy: () => state.runBudget?.remainingPolicy(),
            }
          : undefined;
      },
    };
    const output: ApplicationRunEvent[] = [];
    const stream = createAgentStream({
      [Symbol.asyncIterator]: () => ({ next: () => queue.next() }),
      completed: Promise.resolve(undefined),
      history: state.history,
      newItems: output,
      output,
      finalOutput: undefined,
      lastResponseId: state.responseId ?? null,
      interruptions: [],
      state: createContinuationHandle(state),
      rawResponses: [],
      get runUsage() {
        return state.usage;
      },
      get runCostRecords() {
        return state.costRecords ?? [];
      },
    });

    let exitError: unknown;
    stream.completed = this.#execute(state, stream, queue, effectiveOptions, toolContext, controller)
      .catch((error) => {
        exitError = error;
        stream.cancelled = error instanceof Error && error.name === 'AbortError';
        queue.close(error);
        throw error;
      })
      .finally(() => {
        state.runBudget?.pause();
        if (segmentGeneration !== this.#segmentGeneration) return;
        if (this.#activeAbortController === controller) this.#activeAbortController = null;
        this.#runInFlight = false;
        // A segment that ends holding approvals has paused the turn, not ended
        // it: the caller resumes through continueRunStream, which offers
        // another request boundary. Injections wait for it. Only a segment
        // that ends with nothing outstanding has truly finished the turn, and
        // then anything still waiting has to be sent as its own turn instead.
        const pendingApprovals = state.pendingApprovals?.length ?? 0;
        const pendingBudgetInteraction = state.pendingRunBudgetInteraction !== undefined;
        const cancelled = stream.cancelled === true;
        this.#turnPaused = (pendingApprovals > 0 || pendingBudgetInteraction) && !cancelled && exitError === undefined;
        if (this.#turnPaused) return;
        if (this.#activeRunBudgetState === state) this.#activeRunBudgetState = undefined;
        // A declared turn outlives its segments — this one may be about to be
        // retried, or resumed past a post-execute gate. Its owner says when it
        // is over.
        if (this.#turnOpen) return;
        this.#releasePendingSteers({
          pendingApprovals,
          pendingBudgetInteraction,
          cancelled,
          error: exitError instanceof Error ? exitError.name : exitError ? String(exitError) : undefined,
          turnCount: state.turnCount,
        });
      });
    this.#activeRunBudgetState = state.runBudget ? state : undefined;
    return stream;
  }

  async #execute(
    state: RunState,
    stream: AgentStream & { finalOutput?: string },
    queue: EventQueue,
    options: ApplicationRunLoopOptions,
    toolContext: ToolInvocationContext,
    requestAbortController: AbortController,
  ): Promise<unknown> {
    while (true) {
      if (options.signal?.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });

      if (state.pendingRunBudgetInteraction) {
        if (state.runBudgetInteractionDecision === 'stop') {
          state.pendingRunBudgetInteraction = undefined;
          state.runBudgetInteractionDecision = undefined;
          return finish(stream, state, queue);
        }
        if (state.runBudgetInteractionDecision === 'continue') {
          state.pendingRunBudgetInteraction = undefined;
          state.runBudgetInteractionDecision = undefined;
        } else {
          return this.#pauseForRunBudgetInteraction(state, stream, queue);
        }
      }

      state.pendingApprovals ??= state.pendingApproval ? [state.pendingApproval] : [];
      if (state.pendingApprovals.length > 0 && state.approvalDecision) {
        const selectedIndex = state.approvalDecisionCallId
          ? state.pendingApprovals.findIndex(
              (pending) => getInterruptionCallId(pending.interruption) === state.approvalDecisionCallId,
            )
          : -1;
        if (state.approvalDecisionCallId && selectedIndex < 0) {
          throw new Error(`Approval decision references unknown pending tool call: ${state.approvalDecisionCallId}`);
        }
        const pendingIndex = selectedIndex >= 0 ? selectedIndex : 0;
        const pending = state.pendingApprovals[pendingIndex];
        const approved = state.approvalDecision === 'approved';
        if (approved) {
          state.approvals.approveTool({ toolName: pending.toolName, callId: pending.callId });
        } else {
          state.approvals.rejectTool(
            { toolName: pending.toolName, callId: pending.callId },
            { message: state.approvalMessage },
          );
        }
        pending.plan.status = 'ready';
        if (!approved) pending.plan.output = state.approvalMessage ?? 'rejected';
        state.pendingApprovals.splice(pendingIndex, 1);
        state.pendingApproval = state.pendingApprovals[0];
        state.approvalDecision = undefined;
        state.approvalDecisionCallId = undefined;
        state.approvalMessage = undefined;
        await this.#settleToolPlan(state, stream, queue, toolContext);
        stream.interruptions = state.pendingApprovals.map((item) => item.interruption);
        if (state.pendingApprovals.length > 0) {
          this.#turnPaused = true;
          return finish(stream, state, queue);
        }
        // Nothing is outstanding, so this segment is terminal — see
        // `stopAfterApprovalResolution`. Stopping here rather than at the
        // request boundary below is what keeps the just-recorded tool result
        // in the committed history.
        if (options.stopAfterApprovalResolution) return finish(stream, state, queue);
      }

      // A budget interaction can park a response after its tool calls are
      // recorded but before any body runs. Resume those retained calls only
      // after processing an ordinary approval decision for that same plan.
      if (state.toolPlan) {
        await this.#settleToolPlan(state, stream, queue, toolContext);
        if (state.pendingApprovals?.length) {
          stream.interruptions = state.pendingApprovals.map((item) => item.interruption);
          this.#turnPaused = true;
          return finish(stream, state, queue);
        }
      }

      // The request boundary: every tool result of the previous round is in
      // history, and the next request has not been built. A user message
      // admitted here reaches the model in sequence, mid-turn.
      if (!state.requestBoundaryReady) {
        this.#admitPendingSteers(state, stream, queue);
        this.#evaluateRunBudget(state, stream, queue);
        if (state.pendingRunBudgetInteraction) return this.#pauseForRunBudgetInteraction(state, stream, queue);

        if (options.boundaryCompaction) {
          const compactionStartedAt = Date.now();
          const compaction = await options.boundaryCompaction.compact({
            history: state.history,
            automaticCompactionsThisRun: state.automaticCompactionsThisRun ?? 0,
            signal: options.signal,
            onStarted: (provider) =>
              outputPush(stream, queue, { type: 'context_compaction_started', provider, strategy: 'local' }),
          });
          if (compaction.kind === 'compacted') {
            state.history.splice(0, state.history.length, ...compaction.history);
            state.input.splice(0, state.input.length, ...normalizeApplicationInput(compaction.modelInput));
            state.responseId = undefined;
            state.responseProviderId = undefined;
            if (compaction.costRecords?.length) {
              state.costRecords ??= [];
              state.costRecords.push(...compaction.costRecords);
            }
            state.automaticCompactionsThisRun = (state.automaticCompactionsThisRun ?? 0) + 1;
            outputPush(stream, queue, {
              type: 'context_compaction_completed',
              provider: state.currentProviderId ?? 'unknown',
              strategy: 'local',
              durationMs: Math.max(0, Date.now() - compactionStartedAt),
            });
          } else if (compaction.kind === 'failed') {
            outputPush(stream, queue, {
              type: 'context_compaction_failed',
              provider: compaction.provider,
              strategy: 'local',
              durationMs: Math.max(0, Date.now() - compactionStartedAt),
            });
          }

          // Summarization is an asynchronous part of this same request
          // boundary. Admit anything that arrived while it was in flight after
          // applying a replacement, so the steer cannot be overwritten by the
          // checkpoint or miss a terminal model request.
          this.#admitPendingSteers(state, stream, queue);
          this.#evaluateRunBudget(state, stream, queue);
          if (state.pendingRunBudgetInteraction) return this.#pauseForRunBudgetInteraction(state, stream, queue);
        }

        state.turnCount += 1;
        this.#evaluateRunBudget(state, stream, queue);
        if (state.pendingRunBudgetInteraction) {
          state.requestBoundaryReady = true;
          return this.#pauseForRunBudgetInteraction(state, stream, queue);
        }
        // Retain the legacy error only for callers that have not adopted staged
        // budgets. A configured run budget turns the same count into critical
        // evidence and lets the decision surface choose what happens next.
        if (!state.runBudget && state.maxTurns !== undefined && state.turnCount > state.maxTurns) {
          throw new MaxTurnsExceededError(state.maxTurns);
        }
      } else {
        state.requestBoundaryReady = undefined;
      }

      const model = await this.#deps.resolveModel(state.agent.model);
      let sawToolCall = false;
      const streamedToolCalls: Array<Extract<StreamedModelTurnEvent, { type: 'tool_call' }>> = [];
      let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
      let pendingNativeReasoning: PendingNativeReasoning | undefined;
      // Stable process-unique request id, allocated immediately before dispatch
      // so a cost record can be settled exactly once (success or failure).
      const requestId = this.#nextRequestId();

      const criticalWrapUp = state.criticalWrapUpPending === true && state.criticalWrapUpDispatched !== true;
      if (criticalWrapUp) state.criticalWrapUpDispatched = true;
      const disableChaining = state.disableChainingForAttempt === true;
      if (disableChaining) {
        state.disableChainingForAttempt = false;
        state.responseId = undefined;
        state.responseProviderId = undefined;
      }
      const request: StreamedModelTurnRequest = {
        instructions: criticalWrapUp
          ? `${state.agent.instructions}\n\nBudget containment is terminal. Do not call tools. In this one final response, summarize what you completed, the evidence you have, and what remains.`
          : state.agent.instructions,
        ...(state.supportsConversationChaining &&
        !disableChaining &&
        state.responseId &&
        state.responseProviderId !== undefined &&
        state.responseProviderId === state.currentProviderId
          ? { previousResponseId: state.responseId }
          : {}),
        ...(disableChaining ? { disableChaining: true } : {}),
        input: state.input,
        tools: toModelTools(criticalWrapUp ? [] : state.agent.tools),
        applicationTools: criticalWrapUp ? [] : state.agent.tools,
        ...(state.agent.modelSettings?.temperature !== undefined
          ? { temperature: state.agent.modelSettings.temperature as number }
          : {}),
        ...(state.agent.modelSettings?.reasoning ? { reasoning: state.agent.modelSettings.reasoning as any } : {}),
        ...(state.agent.modelSettings?.maxTokens !== undefined
          ? { maxTokens: state.agent.modelSettings.maxTokens }
          : {}),
        ...(state.agent.outputType !== undefined ? { outputType: state.agent.outputType } : {}),
        ...(state.agent.modelSettings?.codex ? { codex: state.agent.modelSettings.codex } : {}),
        ...(state.agent.modelSettings?.providerData
          ? {
              providerOptions: this.#contextCompactionSessionState.disabled
                ? Object.fromEntries(
                    Object.entries(state.agent.modelSettings.providerData).filter(
                      ([key]) => key !== 'contextCompaction',
                    ),
                  )
                : state.agent.modelSettings.providerData,
            }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const generationGuard = new GenerationGuard({
        maxOutputCharacters: state.agent.modelSettings?.maxStreamOutputChars,
        maxTextCharacters: state.agent.modelSettings?.maxStreamOutputChars,
        maxReasoningCharacters: state.agent.modelSettings?.maxStreamOutputChars,
        maxToolArgumentCharacters: state.agent.modelSettings?.maxStreamOutputChars,
        maxCumulativeToolArgumentCharacters: state.agent.modelSettings?.maxStreamOutputChars,
        requestDeadlineMs: state.agent.modelSettings?.maxModelRequestDurationMs,
        maxStreamIdleMs: state.agent.modelSettings?.maxModelStreamIdleMs,
        ...options.generationGuard,
      });
      const consume = async (): Promise<void> => {
        const deadline = new GenerationStreamDeadlines(
          { totalMs: generationGuard.requestDeadlineMs, idleMs: generationGuard.maxStreamIdleMs },
          () => requestAbortController.abort(),
          () => generationGuard.progress,
        );
        let iterator: AsyncIterator<StreamedModelTurnEvent> | undefined;
        let iteratorFinished = false;
        try {
          iterator = model.stream(request)[Symbol.asyncIterator]();
          while (true) {
            const next = await deadline.wait(iterator.next());
            if (next.done) {
              iteratorFinished = true;
              return;
            }
            // Any streamed event is transport activity: re-arm the inactivity
            // window so long legitimate reasoning is never mistaken for a stall.
            deadline.recordActivity();
            const event = next.value;
            if (event.type === 'completion') {
              generationGuard.observeCompletion(event.output);
              completion = event;
              continue;
            }
            if (event.type === 'text_delta') {
              generationGuard.observeText(event.text);
              outputPush(stream, queue, { type: 'text_delta', text: event.text });
              continue;
            }
            if (event.type === 'codex_rate_limits') {
              outputPush(stream, queue, { type: 'codex_rate_limits', rateLimits: event.rateLimits });
              continue;
            }
            if (event.type === 'reasoning_delta') {
              const accepted = generationGuard.observeReasoning(event.text);
              if (!accepted) continue;
              const forwarded = accepted === event.text ? event : { ...event, text: accepted };
              pendingNativeReasoning = appendNativeReasoning(pendingNativeReasoning, forwarded);
              outputPush(stream, queue, { type: 'reasoning_delta', text: accepted });
              continue;
            }
            if (event.type === 'tool_call_streaming_delta') {
              generationGuard.observeToolArgumentProgress(event.argumentCharCount);
              outputPush(stream, queue, event);
              continue;
            }
            if (event.type === 'context_compaction_started' || event.type === 'context_compaction_completed') {
              outputPush(stream, queue, event);
              continue;
            }
            if (event.type === 'tool_call') {
              generationGuard.observeToolCall(event.arguments);
              pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
              sawToolCall = true;
              streamedToolCalls.push(event);
            }
          }
        } finally {
          deadline.dispose();
          if (iterator && !iteratorFinished) void iterator.return?.().catch(() => undefined);
        }
      };
      const dispatch = async (): Promise<void> => {
        state.requestPreparation?.prepare(request);
        await consume();
      };
      try {
        if (state.requestPreparation) await state.requestPreparation.run(dispatch);
        else await dispatch();
      } catch (error) {
        if (error instanceof GenerationGuardError) requestAbortController.abort();
        // Dispatch began, but no terminal completion was accepted. Record an
        // unpriced marker so the summary stays honest (partial) rather than
        // appearing exact. Observational only: the error still propagates.
        const cancelled = error instanceof Error && error.name === 'AbortError';
        const record = this.#appendCostRecord(state, {
          requestId,
          provider: state.currentProviderId,
          model: state.agent.model,
          tier: resolveServiceTier(request),
          outcome: cancelled ? 'cancelled' : 'failed',
        });
        // Only the live queue sees cost records: `output`/`newItems` feed
        // persistence and replay, and a cost event must never become a
        // restored history item.
        queue.push({ type: 'cost_update', record });
        this.#evaluateRunBudget(state, stream, queue);
        throw error;
      }

      if (!completion) {
        // A few application-owned model fixtures (and legacy adapters) end a
        // tool-call stream immediately after the call and use the next request
        // as the continuation boundary. Preserve that contract while routing
        // the calls through the same ordered dispatcher. An empty stream still
        // fails closed as an incomplete model turn.
        if (streamedToolCalls.length === 0) throw new Error('Application model turn ended without completion');
        if (criticalWrapUp) return finish(stream, state, queue);
        await this.#dispatchToolCalls(state, stream, queue, streamedToolCalls, toolContext);
        if (state.pendingApprovals && state.pendingApprovals.length > 0) {
          stream.interruptions = state.pendingApprovals.map((item) => item.interruption);
          this.#turnPaused = true;
          return finish(stream, state, queue);
        }
        continue;
      }
      // Commit the authoritative terminal state before handling terminal-only
      // tool calls. Approval may pause immediately after this point, and the
      // continuation must still carry the response that produced the calls.
      // Response IDs are provider-chain state, not generic run metadata. Keep
      // them out of continuation handles for providers that do not support
      // chaining, while still exposing the completed provider response on the
      // current stream for diagnostics.
      if (state.supportsConversationChaining && state.currentProviderId !== undefined) {
        state.responseId = completion.responseId;
        state.responseProviderId = state.currentProviderId;
      } else {
        state.responseId = undefined;
        state.responseProviderId = undefined;
      }
      let normalizedCompletionUsage: ReturnType<typeof normalizeModelUsage>;
      if (completion.usage !== undefined) {
        normalizedCompletionUsage = normalizeModelUsage(completion.usage);
        if (normalizedCompletionUsage) {
          const accumulated = addTokenUsage(normalizeModelUsage(state.usage), normalizedCompletionUsage);
          state.usage = {
            ...(accumulated.prompt_tokens !== undefined ? { inputTokens: accumulated.prompt_tokens } : {}),
            ...(accumulated.completion_tokens !== undefined ? { outputTokens: accumulated.completion_tokens } : {}),
            // `total_tokens` is the billable normalized total, including cache
            // creation tokens. Keep it alongside the application aliases so the
            // authoritative run accumulator never reconstructs a smaller total.
            ...(accumulated.total_tokens !== undefined ? { totalTokens: accumulated.total_tokens } : {}),
            ...(accumulated.cache_read_tokens !== undefined
              ? { cachedInputTokens: accumulated.cache_read_tokens }
              : {}),
            ...(accumulated.cache_creation_tokens !== undefined
              ? { cacheWriteTokens: accumulated.cache_creation_tokens }
              : {}),
          };
        } else {
          // Providers may carry a future/opaque usage shape. Preserve the old
          // pass-through behavior when normalization cannot recognize it.
          state.usage = completion.usage;
        }
      } else {
        normalizedCompletionUsage = undefined;
      }
      // Attribute cost while the dispatched request's identity is still known.
      // Emit it immediately so the UI can show this request's cost before the
      // run ends; the terminal result re-delivers the cumulative record list
      // and the session accumulator ignores the duplicates by request id.
      // Only the live queue sees the event: `output`/`newItems` feed
      // persistence and replay, and a cost event must never become a restored
      // history item.
      const record = this.#appendCostRecord(state, {
        requestId,
        provider: state.currentProviderId,
        model: state.agent.model,
        tier: resolveServiceTier(request),
        outcome: 'completed',
        usage: normalizedCompletionUsage,
        providerUsd: completion.costUsd,
      });
      queue.push({ type: 'cost_update', record });
      // Cost and usage arrive in the same completion metadata, so surface both
      // live. The footer is a per-request indicator: emit this request's own
      // usage, never the run accumulator in `state.usage`.
      if (normalizedCompletionUsage) queue.push({ type: 'usage_update', usage: normalizedCompletionUsage });
      this.#evaluateRunBudget(state, stream, queue);
      stream.lastResponseId = completion.responseId;
      stream.rawResponses?.push(completion);
      // Some provider adapters report function calls only in the terminal
      // completion rather than as separate stream events. Their reasoning may
      // likewise be terminal-only, so associate it before replaying calls.
      const toolCalls = [...streamedToolCalls];
      if (!sawToolCall) {
        for (const item of completion.output) {
          if (item.type === 'reasoning') pendingNativeReasoning = appendNativeReasoning(pendingNativeReasoning, item);
        }
        for (const item of completion.output) {
          if (item.type !== 'tool_call') continue;
          pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
          sawToolCall = true;
          toolCalls.push(item);
        }
      }
      // A native reasoning item belongs to the completed assistant turn even
      // when no tool call follows it. Commit it before assistant text so both
      // stateless continuation and persisted canonical history retain the
      // provider-specific metadata exactly once.
      pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);

      // Provider-native completion items (notably OpenAI compaction items)
      // must stay in the live provider history. The session layer later
      // applies compaction's replacement rule; keeping the item here also
      // makes it available to an in-flight tool continuation before that
      // terminal history commit occurs.
      for (const item of completion.output) {
        if (item.type !== 'provider_opaque') continue;
        const historyItem: ProviderInputItem = {
          ...item.item,
          providerOpaque: { provider: item.provider },
        };
        state.history.push(historyItem);
        state.input.push(item);
        outputPush(stream, queue, { type: 'item', item });
      }

      const assistantText = completion.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content)
        .map((part) => part.text)
        .join('');
      if (assistantText) {
        stream.finalOutput = assistantText;
        const item: ProviderInputItem = {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: assistantText }],
        };
        state.history.push(item);
        outputPush(stream, queue, { type: 'item', item });
        state.input.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: assistantText }] });
      }

      // Tool calls are dispatched only after the reasoning, provider-opaque,
      // and assistant-text items from the same completion are committed. A
      // response that carries both prose and a tool call must serialize as
      // text -> function_call -> function_call_result; dispatching first left
      // the text stranded after its own tool result, where the assistant
      // message merger glued it onto the *next* turn's tool call and every
      // request ended with a bare assistant message. Models read that as a
      // turn truncated mid-sentence and restart instead of progressing.
      if (!state.criticalWrapUpPending && toolCalls.length > 0) {
        await this.#dispatchToolCalls(state, stream, queue, toolCalls, toolContext);
      }

      // A critical subagent gets exactly this final tool-free model call.
      if (criticalWrapUp) return finish(stream, state, queue);

      if (state.pendingRunBudgetInteraction && toolCalls.length > 0) {
        return this.#pauseForRunBudgetInteraction(state, stream, queue);
      }

      if (state.pendingApprovals.length > 0) {
        stream.interruptions = state.pendingApprovals.map((item) => item.interruption);
        this.#turnPaused = true;
        return finish(stream, state, queue);
      }
      if (!sawToolCall) {
        // Evidence discovered when a response has already completed needs no
        // human boundary: there is no later request or tool to block.
        state.pendingRunBudgetInteraction = undefined;
        return finish(stream, state, queue);
      }
    }
  }

  async #dispatchToolCalls(
    state: RunState,
    stream: AgentStream,
    queue: EventQueue,
    events: readonly Extract<StreamedModelTurnEvent, { type: 'tool_call' }>[],
    toolContext: ToolInvocationContext,
  ): Promise<void> {
    const plan: ToolPlanEntry[] = events.map((event): ToolPlanEntry => {
      const definition = state.agent.tools.find((tool) => tool.name === event.name);
      const callItem: ProviderInputItem = {
        type: 'function_call',
        callId: event.id,
        name: event.name,
        arguments: event.arguments,
      };
      state.history.push(callItem);
      state.input.push({ type: 'tool_call', id: event.id, name: event.name, arguments: event.arguments });
      outputPush(stream, queue, { type: 'item', item: callItem });
      return {
        event,
        definition,
        parallelSafe: false,
        status: 'ready' as const,
      };
    });
    state.toolPlan = plan;

    for (const entry of plan) {
      const { event, definition } = entry;
      if (!definition) {
        entry.output = `Unknown tool: ${event.name}`;
        continue;
      }

      // Keep the raw-model invocation contract: normalization repairs the
      // accepted object shape but intentionally does not Zod-parse it, which
      // would apply schema defaults before execute. web_fetch relies on its
      // executor fallbacks on the strict JSON-schema path.
      entry.params = normalizeToolParameters(parseArguments(event.arguments), definition.parameters);
      const stallEvent = state.runBudget?.observeToolCall({
        name: event.name,
        argumentsText: event.arguments,
        effect: definition.effect,
      });
      if (stallEvent) {
        this.#emitRunBudgetEvent(state, stallEvent, 'Tool stall evidence', stream, queue);
      }

      // Consult this run's ledger before prompting: a decision already taken
      // (in the parent run and replayed in, or earlier in this run) must not
      // prompt again. This is what makes approval replay observable.
      const alreadyDecided = state.approvals.isToolApproved({ toolName: event.name, callId: event.id });
      if (alreadyDecided === false) {
        entry.output = state.approvals.getRejectionMessage(event.name, event.id) ?? 'Tool execution was not approved.';
        continue;
      }

      if (alreadyDecided !== true && (await definition.needsApproval(entry.params, toolContext))) {
        entry.status = 'approval_pending';
        const pending: PendingApproval = {
          callId: event.id,
          toolName: event.name,
          argumentsText: event.arguments,
          interruption: {
            type: 'tool_approval_item',
            rawItem: { type: 'function_call', callId: event.id, name: event.name, arguments: event.arguments },
            callId: event.id,
            name: event.name,
            arguments: event.arguments,
          },
          definition,
          params: entry.params,
          plan: entry,
        };
        state.pendingApprovals ??= [];
        state.pendingApprovals.push(pending);
        continue;
      }

      entry.parallelSafe = await isParallelSafe(definition, entry.params, toolContext);
    }

    state.pendingApproval = state.pendingApprovals?.[0];
    stream.interruptions = (state.pendingApprovals ?? []).map((item) => item.interruption);
    this.#deps.logDiagnostic?.('tool parallel eligibility', {
      decisions: plan.map((entry) => ({
        callId: entry.event.id,
        toolName: entry.event.name,
        parallelSafe: entry.parallelSafe,
        approvalPending: entry.status === 'approval_pending',
      })),
    });
    // A main-agent budget escalation is a real boundary: retain the planned
    // calls, but do not execute one more tool while human judgement is pending.
    if (!state.pendingRunBudgetInteraction) {
      await this.#settleToolPlan(state, stream, queue, toolContext);
    }
  }

  async #settleToolPlan(
    state: RunState,
    stream: AgentStream,
    queue: EventQueue,
    toolContext: ToolInvocationContext,
  ): Promise<void> {
    const plan = state.toolPlan;
    if (!plan) return;
    const maxParallelToolCalls = Math.max(
      1,
      Math.floor(this.#deps.resolveMaxParallelToolCalls?.() ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS),
    );

    while (true) {
      const firstPending = plan.find((entry) => entry.status !== 'completed');
      if (!firstPending) {
        state.toolPlan = undefined;
        return;
      }
      if (firstPending.status === 'approval_pending') return;

      const group: ToolPlanEntry[] = [];
      for (const entry of plan) {
        if (entry.status === 'completed') continue;
        if (entry.status === 'approval_pending') break;
        if (group.length > 0 && (!entry.parallelSafe || !group[0].parallelSafe || group.length >= maxParallelToolCalls))
          break;
        group.push(entry);
        if (!entry.parallelSafe) break;
      }

      const batchId = `tool-batch-${++nextToolBatchSeq}`;
      this.#deps.logDiagnostic?.('tool batch dispatched', {
        batchId,
        callIds: group.map((entry) => entry.event.id),
        parallel: group.length > 1,
        maxParallelToolCalls,
        dispatchOrder: group.map((entry) => entry.event.id),
      });
      if (group.length > 1) {
        const results = await Promise.allSettled(
          group.map((entry) => this.#invokePlannedTool(entry, toolContext, state)),
        );
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected) throw rejected.reason;
        for (const [index, result] of results.entries()) {
          this.#appendToolResult(state, stream, queue, group[index], (result as PromiseFulfilledResult<unknown>).value);
        }
      } else {
        const result = await this.#invokePlannedTool(group[0], toolContext, state);
        this.#appendToolResult(state, stream, queue, group[0], result);
      }
      this.#deps.logDiagnostic?.('tool batch settled', {
        batchId,
        settlementOrder: group.map((entry) => entry.event.id),
      });
    }
  }

  async #invokePlannedTool(
    entry: ToolPlanEntry,
    toolContext: ToolInvocationContext,
    state: RunState,
  ): Promise<unknown> {
    entry.status = 'completed';
    if (entry.output !== undefined) return entry.output;
    return this.#invokeTool(entry.definition!, entry.params, toolContext, entry.event.id, state);
  }

  #appendToolResult(
    state: RunState,
    stream: AgentStream,
    queue: EventQueue,
    entry: ToolPlanEntry,
    result: unknown,
  ): void {
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    const resultItem: ProviderInputItem = {
      type: 'function_call_result',
      callId: entry.event.id,
      name: entry.event.name,
      output,
    };
    state.history.push(resultItem);
    state.input.push({ type: 'tool_result', id: entry.event.id, output });
    outputPush(stream, queue, { type: 'item', item: resultItem });
    this.#evaluateRunBudget(state, stream, queue);
  }

  /**
   * A tool that throws must not take the run down with it.
   *
   * Most tools already report failure by returning `Error: ...` as their
   * output, which the model reads and acts on. The handful that throw got the
   * opposite treatment for no principled reason: the exception escaped to
   * `#execute`, closed the event queue, and ended the turn — so the model never
   * saw a recoverable problem like a path that does not exist, and the caller
   * lost the whole turn. Worse, `#handleToolCall` pushes the `function_call`
   * into history before executing, so an escape leaves a call with no matching
   * result.
   *
   * Errors are therefore normalized into tool output, with two exceptions that
   * must still propagate: cancellation (the run is ending on purpose) and
   * `HarnessInvariantError` (a bug here, which the model cannot act on).
   */
  async #invokeTool(
    definition: AnyToolDefinition,
    params: unknown,
    toolContext: ToolInvocationContext,
    callId: string,
    state?: RunState,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const attempt = state
      ? ((state.toolAttempts ??= new Map()).set(callId, (state.toolAttempts.get(callId) ?? 0) + 1),
        state.toolAttempts.get(callId)!)
      : 1;
    const lifecycleContext: ToolExecutionLifecycleContext = {
      ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state?.turnId ? { turnId: state.turnId } : {}),
      toolCallId: callId,
      toolName: definition.name,
      normalizedArguments: params,
      attempt,
      scope: state?.hookScope ?? 'root',
    };
    // Dispatch mark must run before execute so a mid-tool stream failure can
    // settle the ledger as unknown rather than aborted.
    this.#deps.getOnToolDispatch?.()?.(callId);
    await this.#notifyToolLifecycle(() => this.#deps.toolLifecycle?.before(lifecycleContext));
    try {
      const result = await definition.execute(params, toolContext, { toolCall: { callId } });
      await this.#notifyToolLifecycle(() =>
        this.#deps.toolLifecycle?.after(lifecycleContext, result, Date.now() - startedAt),
      );
      return result;
    } catch (error) {
      if (isCancellationError(error) || isHarnessInvariantError(error) || error instanceof MaxTurnsExceededError) {
        await this.#notifyToolLifecycle(() =>
          this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, false),
        );
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const result = `Error: ${message}`;
      await this.#notifyToolLifecycle(() =>
        this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, true),
      );
      return result;
    }
  }

  #nextRequestId(): string {
    nextCostRequestSeq += 1;
    return `req-${nextCostRequestSeq}`;
  }

  #appendCostRecord(
    state: RunState,
    input: {
      requestId: string;
      provider: string | undefined;
      model: string;
      tier: ServiceTier;
      outcome: 'completed' | 'failed' | 'cancelled';
      usage?: ReturnType<typeof normalizeModelUsage>;
      providerUsd?: number | string;
    },
  ): ModelRequestCost {
    const record = computeModelCost({
      requestId: input.requestId,
      provider: input.provider ?? 'unknown',
      model: input.model,
      serviceTier: input.tier,
      outcome: input.outcome,
      usage: input.usage,
      providerUsd: input.providerUsd,
      getPrice: (provider, model, tier) => getModelPricing(provider, model, tier),
      pricingVersion: getCatalogPricingVersion(),
    });
    state.costRecords = [...(state.costRecords ?? []), record];
    return record;
  }

  #evaluateRunBudget(state: RunState, stream?: AgentStream, queue?: EventQueue): void {
    if (!state.runBudget) return;
    for (const event of state.runBudget.evaluate({
      turns: state.turnCount,
      costRecords: state.costRecords ?? [],
    })) {
      this.#emitRunBudgetEvent(state, event, 'Run budget evidence', stream, queue);
    }
  }

  #emitRunBudgetEvent(
    state: RunState,
    event: RunBudgetEvent,
    message: string,
    stream?: AgentStream,
    queue?: EventQueue,
  ): void {
    if (event.type === 'budget_stage' && event.stage === 'critical' && state.wrapUpOnCriticalRunBudget) {
      state.criticalWrapUpPending = true;
    }
    if (
      !state.wrapUpOnCriticalRunBudget &&
      !state.pendingRunBudgetInteraction &&
      state.runBudgetEscalation !== 'warn' &&
      this.#requiresHumanBudgetDecision(event)
    ) {
      state.pendingRunBudgetInteraction = { type: 'run_budget_interaction', event };
      state.runBudgetGrantConsumed = false;
    }
    if (stream && queue) outputPush(stream, queue, { type: 'run_budget', evidence: event });
    try {
      state.onRunBudgetEvent?.(event);
    } catch {
      // Evidence observers are delivery adapters, not budget owners.
      this.#deps.logDiagnostic?.('Run budget event observer failed', { type: event.type });
    }
    this.#deps.logDiagnostic?.(message, event);
  }

  #requiresHumanBudgetDecision(event: RunBudgetEvent): boolean {
    return event.type === 'tool_stall' || (event.type === 'budget_stage' && event.stage !== 'soft');
  }

  #pauseForRunBudgetInteraction(state: RunState, stream: AgentStream, queue: EventQueue): unknown {
    const interaction = state.pendingRunBudgetInteraction;
    if (!interaction) return finish(stream, state, queue);
    stream.interruptions = [interaction];
    this.#turnPaused = true;
    return finish(stream, state, queue);
  }

  async #notifyToolLifecycle(operation: (() => void | Promise<void>) | undefined): Promise<void> {
    if (!operation) return;
    try {
      await operation();
    } catch {
      // Lifecycle observers are passive. A broken observer must not alter tool
      // execution or turn recovery semantics.
    }
  }
}

function outputPush(stream: AgentStream, queue: EventQueue, item: ApplicationRunEvent): void {
  stream.output.push(item);
  if (stream.newItems !== stream.output) stream.newItems.push(item);
  queue.push(item);
}

function finish(stream: AgentStream, state: RunState, queue: EventQueue): unknown {
  stream.history = state.history;
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

type PendingNativeReasoning = {
  id?: string;
  text: string;
  providerMetadata: StreamedModelProviderOptions;
};

/**
 * Only replay native reasoning when the provider explicitly supplies the
 * Chat-Completions continuation field. Generic reasoning remains display-only
 * so providers with different native formats are not given a foreign field.
 */
/**
 * True when any lane namespace in the metadata carries an `encrypted_content`
 * blob — the shape every Responses adapter produces, whichever vendor it is.
 */
function hasNamespacedEncryptedReasoning(metadata: StreamedModelProviderOptions | undefined): boolean {
  if (!metadata) return false;
  return Object.values(metadata).some((value) => asRecord(value)?.encrypted_content !== undefined);
}

function appendNativeReasoning(
  current: PendingNativeReasoning | undefined,
  event: {
    readonly id?: string;
    readonly text: string;
    readonly providerMetadata?: StreamedModelProviderOptions;
  },
): PendingNativeReasoning | undefined {
  const nativeReasoning = event.providerMetadata?.reasoning_content;
  if (typeof nativeReasoning === 'string') {
    const text =
      current?.text === nativeReasoning
        ? current.text
        : current?.text && nativeReasoning.startsWith(current.text)
        ? nativeReasoning
        : `${current?.text ?? ''}${nativeReasoning}`;
    return {
      ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
      text,
      providerMetadata: { ...event.providerMetadata, reasoning_content: text },
    };
  }
  // Responses providers return encrypted reasoning only on their terminal
  // output. Their metadata is namespaced, so retain it without turning it into
  // the Chat-Completions-only reasoning_content convention. Match on the
  // namespaced shape rather than an allowlist of lane names: an allowlist
  // silently drops the reasoning of every Responses lane added later.
  if (hasNamespacedEncryptedReasoning(event.providerMetadata)) {
    return {
      ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
      text: event.text,
      providerMetadata: event.providerMetadata!,
    };
  }
  return current;
}

function commitPendingNativeReasoning(
  state: RunState,
  stream: AgentStream,
  queue: EventQueue,
  pending: PendingNativeReasoning | undefined,
): undefined {
  if (!pending) return undefined;
  const reasoningInput: StreamedModelTurnInput = {
    type: 'reasoning',
    ...(pending.id ? { id: pending.id } : {}),
    text: pending.text,
    providerMetadata: pending.providerMetadata,
  };
  const reasoningHistory: ProviderInputItem = {
    type: 'reasoning',
    ...(pending.id ? { id: pending.id } : {}),
    content: [{ type: 'reasoning_text', text: pending.text }],
    providerData: pending.providerMetadata,
  };
  state.input.push(reasoningInput);
  state.history.push(reasoningHistory);
  outputPush(stream, queue, { type: 'item', item: reasoningHistory });
  return undefined;
}

/**
 * Resolve the effective billing service tier from the dispatched request. The
 * default service tier is standard; only a flex/batch request that was actually
 * dispatched resolves to its tier, and anything unrecognized fails closed.
 */
function resolveServiceTier(request: StreamedModelTurnRequest): ServiceTier {
  const options = request.providerOptions as Record<string, unknown> | undefined;
  const raw = options?.service_tier ?? options?.serviceTier;
  if (raw === 'flex' || raw === 'batch' || raw === 'standard') return raw;
  return raw === undefined ? 'standard' : 'unknown';
}

function normalizeModelUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object') return undefined;
  const rawUsage = usage as Record<string, unknown>;
  return normalizeUsage({
    ...rawUsage,
    cacheReadTokens: rawUsage.cachedInputTokens ?? rawUsage.cacheReadTokens,
    cacheCreationTokens: rawUsage.cacheWriteTokens ?? rawUsage.cacheCreationTokens,
  });
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function isParallelSafe(
  definition: AnyToolDefinition,
  params: unknown,
  context: ToolInvocationContext,
): Promise<boolean> {
  if (typeof definition.parallelSafe === 'function') {
    try {
      return await definition.parallelSafe(params as never, context);
    } catch {
      return false;
    }
  }
  return definition.parallelSafe === true;
}

function getInterruptionCallId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const callId = (value as { callId?: unknown }).callId;
  return typeof callId === 'string' ? callId : undefined;
}

function toModelTools(tools: ToolRegistry): StreamedModelTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: isJsonSchema(tool.parameters) ? tool.parameters : z.toJSONSchema(tool.parameters),
  }));
}

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isZodToolParameterSchema(value);
}

/**
 * The canonical application projection used for both model requests and
 * continuation-prefix comparisons. Keep this at the application boundary so
 * callers never need to inspect opaque continuation state.
 */
export function normalizeApplicationInput(
  input: ProviderInput | readonly ProviderInputItem[],
): StreamedModelTurnInput[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
  const items = (Array.isArray(input) ? input : [input]) as readonly ProviderInputItem[];
  return items.flatMap((item) => normalizeInputItem(item));
}

function normalizeInput(input: ProviderInput): StreamedModelTurnInput[] {
  return normalizeApplicationInput(input);
}

function normalizeHistory(input: ProviderInput): ProviderInputItem[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }];
  return Array.isArray(input) ? [...input] : [input];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function unsupportedInput(description: string): never {
  throw new Error(`Unsupported restored input ${description}`);
}

function normalizeTextPart(value: unknown, description: string): { type: 'text'; text: string } {
  if (typeof value === 'string') return { type: 'text', text: value };
  const record = asRecord(value);
  if (
    !record ||
    !['text', 'input_text', 'output_text'].includes(String(record.type)) ||
    typeof record.text !== 'string'
  ) {
    unsupportedInput(description);
  }
  return { type: 'text', text: record.text };
}

function normalizeMessageImage(record: UnknownRecord): StreamedModelMessagePart {
  const image = record.image ?? record.image_url;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (image === undefined) return { type: 'image', ...(detail ? { detail } : {}) };
  if (typeof image === 'string') return { type: 'image', image, ...(detail ? { detail } : {}) };
  const reference = asRecord(image);
  if (typeof reference?.id === 'string')
    return { type: 'image', image: { id: reference.id }, ...(detail ? { detail } : {}) };
  unsupportedInput('message image reference');
}

function normalizeMessagePart(value: unknown): StreamedModelMessagePart {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeMessageImage(record);
  return normalizeTextPart(value, record?.type ? `message content: ${record.type}` : 'message content');
}

function normalizeMessageContent(value: unknown): StreamedModelMessagePart[] {
  if (value === undefined || value === null) return [{ type: 'text', text: '' }];
  return (Array.isArray(value) ? value : [value]).map((part) => normalizeMessagePart(part)!);
}

function isTextMessagePart(
  part: StreamedModelMessagePart,
): part is Extract<StreamedModelMessagePart, { type: 'text' }> {
  return part.type === 'text';
}

function normalizeToolImagePart(record: UnknownRecord): Extract<StreamedModelToolResultPart, { type: 'image' }> {
  const rawImage = record.image ?? record.image_url;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (rawImage === undefined) return { type: 'image', ...(detail ? { detail } : {}) };
  if (typeof rawImage === 'string') return { type: 'image', image: rawImage, ...(detail ? { detail } : {}) };
  const image = asRecord(rawImage);
  if (!image) unsupportedInput('tool image reference');
  const normalized =
    typeof image.id === 'string'
      ? { id: image.id }
      : typeof image.url === 'string'
      ? { url: image.url }
      : typeof image.fileId === 'string'
      ? { fileId: image.fileId }
      : (typeof image.data === 'string' || image.data instanceof Uint8Array) && typeof image.mediaType === 'string'
      ? { data: image.data, mediaType: image.mediaType }
      : undefined;
  if (!normalized) unsupportedInput('tool image reference');
  return { type: 'image', image: normalized, ...(detail ? { detail } : {}) };
}

function normalizeToolFilePart(record: UnknownRecord): Extract<StreamedModelToolResultPart, { type: 'file' }> {
  const rawFile = record.file ?? record.file_id ?? record.file_url;
  const outerFilename = typeof record.filename === 'string' ? record.filename : undefined;
  if (typeof rawFile === 'string') return { type: 'file', file: rawFile };
  const file = asRecord(rawFile);
  if (!file) unsupportedInput('tool file reference');
  if (typeof file.id === 'string')
    return { type: 'file', file: { id: file.id, ...(outerFilename ? { filename: outerFilename } : {}) } };
  if (typeof file.url === 'string')
    return { type: 'file', file: { url: file.url, ...(outerFilename ? { filename: outerFilename } : {}) } };
  const filename = outerFilename ?? (typeof file.filename === 'string' ? file.filename : undefined);
  if (
    (typeof file.data === 'string' || file.data instanceof Uint8Array) &&
    typeof file.mediaType === 'string' &&
    filename !== undefined
  ) {
    return { type: 'file', file: { data: file.data, mediaType: file.mediaType, filename } };
  }
  unsupportedInput('tool file reference');
}

function normalizeToolResultPart(value: unknown): StreamedModelToolResultPart {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeToolImagePart(record);
  if (record?.type === 'file' || record?.type === 'input_file') return normalizeToolFilePart(record);
  return normalizeTextPart(value, record?.type ? `tool result part: ${record.type}` : 'tool result part');
}

function normalizeToolResultOutput(value: unknown): string | StreamedModelToolResultPart[] {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (!Array.isArray(value)) unsupportedInput('tool result output');
  return value.map(normalizeToolResultPart);
}

function normalizeReasoningText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .map((part) => {
      const record = asRecord(part);
      if (
        !record ||
        !['reasoning_text', 'text', 'summary_text'].includes(String(record.type)) ||
        typeof record.text !== 'string'
      ) {
        return unsupportedInput('reasoning content part');
      }
      return record.text;
    })
    .join('');
}

/** True when the adapter marked this item as provider-native and opaque. */
function isProviderOpaque(
  item: ProviderInputItem,
): item is ProviderInputItem & { providerOpaque: { provider: string } } {
  const marker = item.providerOpaque;
  return typeof marker?.provider === 'string' && marker.provider.length > 0;
}

function normalizeInputItem(item: ProviderInputItem): StreamedModelTurnInput[] {
  if (isProviderOpaque(item)) {
    const { providerOpaque: _marker, ...providerItem } = item;
    return [{ type: 'provider_opaque', provider: item.providerOpaque.provider, item: providerItem }];
  }
  if (item.type === 'function_call') {
    return [
      {
        type: 'tool_call',
        id: String(item.callId ?? item.call_id ?? ''),
        name: String(item.name ?? ''),
        arguments: String(item.arguments ?? '{}'),
      },
    ];
  }
  if (item.type === 'function_call_result' || item.type === 'function_call_output') {
    return [
      {
        type: 'tool_result',
        id: String(item.callId ?? item.call_id ?? item.tool_call_id ?? ''),
        output: normalizeToolResultOutput(item.output),
      },
    ];
  }
  if (item.type === 'reasoning') {
    const providerMetadata: StreamedModelProviderOptions | undefined = item.providerData;
    return [
      {
        type: 'reasoning',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        text: normalizeReasoningText(item.content ?? item.output ?? ''),
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    ];
  }
  if (item.type !== undefined && item.type !== 'message') unsupportedInput(`item type: ${String(item.type)}`);
  const role =
    item.role === undefined
      ? 'user'
      : item.role === 'assistant' || item.role === 'system' || item.role === 'user'
      ? item.role
      : unsupportedInput(`message role: ${String(item.role)}`);
  const content = normalizeMessageContent(item.content);
  if (role === 'system') {
    const textContent = content.filter(isTextMessagePart);
    if (textContent.length !== content.length) unsupportedInput('system message content');
    return [{ type: 'message', role, content: textContent }];
  }
  return [{ type: 'message', role, content }];
}
