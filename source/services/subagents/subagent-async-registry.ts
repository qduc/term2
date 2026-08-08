import { randomUUID } from 'node:crypto';
import { createCodenameRunId } from './codename-run-id.js';
import type { ILoggingService, ISessionContextService, SessionTrafficContext } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { addTokenUsage, type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type {
  DiffStatEntry,
  SubagentRequest,
  SubagentResult,
  SubagentRunHandle,
  SubagentRunStatus,
  SubagentSegmentControl,
  SubagentCancelAcknowledgement,
  SubagentSteerAcknowledgement,
  ValidationEvidence,
} from './types.js';
import { SubagentRunControl } from './subagent-run-control.js';
import { SubagentSession } from './subagent-session.js';
import { isAbortLike, safeEmit, truncatePreview } from './utils.js';

export const SUBAGENT_RUN_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_STEERING_GUIDANCE_CHARACTERS = 2_000;
/** Defensive retry bound before accepting a (vanishingly unlikely) id collision. */
const MAX_RUN_ID_ATTEMPTS = 16;
const MAX_TURN_HISTORY = 5;
const TURN_TEXT_CHAR_LIMIT = 200;

type TurnSnapshot = {
  text: string;
  precedingToolCounts: Record<string, number>;
  truncated: boolean;
};

export type SubagentRegistryErrorCode =
  | 'not_found'
  | 'role_mismatch'
  | 'not_continuable'
  | 'already_active'
  | 'worker_blocked'
  | 'evicted'
  | 'invalid_name'
  | 'name_in_use';

export class SubagentRegistryError extends Error {
  readonly code: SubagentRegistryErrorCode;
  constructor(code: SubagentRegistryErrorCode, message: string) {
    super(message);
    this.name = 'SubagentRegistryError';
    this.code = code;
  }
}

type StoredRunStatus = 'running' | 'waiting_for_answer' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

type AccumulatedEvidence = {
  filesChanged: Set<string>;
  toolsUsed: Map<string, number>;
  diffStat: Map<string, DiffStatEntry>;
  validation?: ValidationEvidence;
  usage?: NormalizedUsage;
};

type StoredRun = {
  runId: string;
  role: string;
  task: string;
  name?: string;
  session: SubagentSession;
  status: StoredRunStatus;
  result?: SubagentResult;
  evidence: AccumulatedEvidence;
  control: SubagentRunControl;
  lastUsedAt: number;
  resolve: (result: SubagentResult) => void;
  promise: Promise<SubagentResult>;
  settled: boolean;
  removeParentAbortListener?: () => void;
  /** Peek progress state — live, captured from subagent_tool_started events. */
  startedAt: number;
  lastToolName?: string;
  lastToolAt?: number;
  toolCounts: Map<string, number>;
  turnHistory: TurnSnapshot[];
  pendingToolCounts: Map<string, number>;
  currentText: string;
  /**
   * The run's own traffic context, fixed when the run is created and re-applied
   * to every later segment. Providers key server-side state off it, so a
   * continuation that rebuilt it from the launching tool call would land the
   * continued turns in a different provider-side session than the first ones.
   */
  trafficContext?: SessionTrafficContext;
};

export interface SubagentAsyncRegistryDeps {
  logger: ILoggingService;
  run: (params: {
    request: SubagentRequest;
    runId: string;
    session: SubagentSession;
    signal: AbortSignal;
    /** A fresh user-turn input for this segment, never SDK RunState reuse. */
    input: string;
    control: SubagentSegmentControl;
  }) => Promise<SubagentResult>;
  onEvent?: (event: ConversationEvent) => void;
  /**
   * Used to scope each run's provider traffic to the run itself. Optional only
   * so unit tests that never reach a provider can omit it; production wiring in
   * `createSubagentRuntime` always supplies it.
   */
  sessionContextService?: ISessionContextService;
  now?: () => number;
  ttlMs?: number;
  messageCap?: number;
  createRunId?: () => string;
  sessionForRole?: (role: string) => SubagentSession | undefined;
  setInterval?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

/** Owns async subagent sessions, terminal records, continuation policy and retention. */
export class SubagentAsyncRegistry {
  #logger: ILoggingService;
  #run: SubagentAsyncRegistryDeps['run'];
  #onEvent?: (event: ConversationEvent) => void;
  #runs = new Map<string, StoredRun>();
  #activeNameToRunId = new Map<string, string>();
  #sessions = new Map<string, SubagentSession>();
  #evicted = new Set<string>();
  #now: () => number;
  #ttlMs: number;
  #messageCap: number;
  #createRunId: () => string;
  #sessionContextService?: ISessionContextService;
  #sessionCap = 50;
  #sessionForRole?: (role: string) => SubagentSession | undefined;
  #timer: ReturnType<typeof setInterval>;
  #clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  #disposed = false;

  constructor(deps: SubagentAsyncRegistryDeps) {
    this.#logger = deps.logger;
    this.#run = deps.run;
    this.#onEvent = deps.onEvent;
    this.#now = deps.now ?? Date.now;
    this.#ttlMs = deps.ttlMs ?? 30 * 60 * 1000;
    this.#messageCap = deps.messageCap ?? 50;
    this.#createRunId = deps.createRunId ?? createCodenameRunId;
    this.#sessionContextService = deps.sessionContextService;
    this.#sessionForRole = deps.sessionForRole;
    this.#clearInterval = deps.clearInterval ?? clearInterval;
    this.#timer = (deps.setInterval ?? setInterval)(
      () => this.#evictExpired(),
      Math.max(1000, Math.min(this.#ttlMs, 60_000)),
    );
    this.#timer.unref?.();
  }

  startRun(request: SubagentRequest, _legacyParentSignal?: AbortSignal): SubagentRunHandle {
    if (this.#disposed) throw new Error('Subagent async registry is disposed');
    const role = request.role;
    if (!['explorer', 'worker', 'mentor', 'librarian'].includes(role)) {
      throw new SubagentRegistryError('not_continuable', `Unknown subagent role: ${role}`);
    }
    const name = request.name;
    if (name !== undefined && !SUBAGENT_RUN_NAME_PATTERN.test(name)) {
      throw new SubagentRegistryError('invalid_name', `Invalid async subagent name: ${name}`);
    }
    if (name !== undefined && this.#activeNameToRunId.has(name)) {
      throw new SubagentRegistryError('name_in_use', `Async subagent name is already active: ${name}`);
    }
    const continuation = request.continueRunId;
    let session: SubagentSession;
    let trafficContext: SessionTrafficContext | undefined;
    if (continuation) {
      const previous = this.#runs.get(continuation);
      if (!previous) {
        throw new SubagentRegistryError(
          this.#evicted.has(continuation) ? 'evicted' : 'not_found',
          `Async subagent run not found: ${continuation}`,
        );
      }
      if (previous.role !== role)
        throw new SubagentRegistryError(
          'role_mismatch',
          `Run ${continuation} belongs to role ${previous.role}, not ${role}`,
        );
      if (isActiveStatus(previous.status))
        throw new SubagentRegistryError('already_active', `Async subagent run ${continuation} is already active`);
      if (previous.status !== 'completed')
        throw new SubagentRegistryError(
          'not_continuable',
          `Async subagent run ${continuation} cannot be continued from status ${previous.status}`,
        );
      if (role === 'worker')
        throw new SubagentRegistryError('worker_blocked', 'Worker runs cannot be continued asynchronously');
      if (role !== 'mentor' && role !== 'librarian' && role !== 'explorer') {
        throw new SubagentRegistryError('not_continuable', `Role ${role} cannot be continued`);
      }
      session = previous.session;
      trafficContext = previous.trafficContext;
    } else {
      const reuseDefault = role === 'mentor' || role === 'librarian';
      const key = reuseDefault ? `role:${role}` : randomUUID();
      session = this.#sessionForRole?.(role) ?? this.#sessions.get(key) ?? new SubagentSession(key, role);
      this.#sessions.set(key, session);
    }

    for (const active of this.#runs.values()) {
      if (isActiveStatus(active.status) && active.session === session) {
        throw new SubagentRegistryError('already_active', `Session for role ${role} is already active`);
      }
    }
    this.#evictToSessionCap();

    const runId = continuation ?? this.#allocateRunId();
    trafficContext ??= this.#deriveTrafficContext(runId);
    const control = new SubagentRunControl();
    let resolve!: (result: SubagentResult) => void;
    const promise = new Promise<SubagentResult>((r) => (resolve = r));
    const stored: StoredRun = {
      runId,
      role,
      task: request.task,
      ...(name !== undefined ? { name } : {}),
      session,
      status: 'running',
      control,
      evidence: {
        filesChanged: new Set(),
        toolsUsed: new Map(),
        diffStat: new Map(),
      },
      lastUsedAt: this.#now(),
      resolve,
      promise,
      settled: false,
      startedAt: this.#now(),
      toolCounts: new Map(),
      turnHistory: [],
      pendingToolCounts: new Map(),
      currentText: '',
      ...(trafficContext ? { trafficContext } : {}),
    };
    this.#runs.set(runId, stored);
    if (name !== undefined) this.#activeNameToRunId.set(name, runId);
    const parentSignal = request.signal ?? _legacyParentSignal;
    if (parentSignal) {
      const onAbort = () => this.#cancelRun(stored);
      parentSignal.addEventListener('abort', onAbort, { once: true });
      stored.removeParentAbortListener = () => parentSignal.removeEventListener('abort', onAbort);
      if (parentSignal.aborted) onAbort();
    }
    safeEmit(this.#logger, this.#onEvent, {
      type: 'subagent_started',
      agentId: runId,
      ...(name !== undefined ? { name } : {}),
      role,
      task: request.task,
      parentTool: request.parentTool ?? 'run_subagent',
      async: true,
    });
    this.#startSegment(stored, request, request.task);
    return { runId, role, ...(name !== undefined ? { name } : {}), status: 'running', task: request.task };
  }

  hasActiveRunForRole(role: string): boolean {
    return [...this.#runs.values()].some((run) => run.role === role && isActiveStatus(run.status));
  }

  /**
   * Non-blocking progress snapshot for one run, or all non-evicted runs when
   * `runId` is omitted. Never awaits a run promise and never carries
   * completion detail — that stays on `get_subagent_result`.
   */
  getRunStatus(runId?: string): SubagentRunStatus | SubagentRunStatus[] {
    if (runId !== undefined) {
      const run = this.#runs.get(runId);
      if (!run)
        return {
          runId,
          role: '',
          status: 'not_found',
          task: '',
          taskPreview: '',
          startedAt: 0,
          elapsedMs: 0,
          toolCounts: {},
        };
      return this.#snapshot(run);
    }
    // Live runs first, then settled; neither carries finalText.
    const live = [...this.#runs.values()].filter((run) => isActiveStatus(run.status));
    const settled = [...this.#runs.values()].filter((run) => !isActiveStatus(run.status));
    return [...live, ...settled].map((run) => this.#snapshot(run));
  }

  #snapshot(run: StoredRun): SubagentRunStatus {
    const counts = mapToRecord(run.toolCounts);
    const pendingToolCounts = mapToRecord(run.pendingToolCounts);
    return {
      runId: run.runId,
      ...(run.name !== undefined ? { name: run.name } : {}),
      role: run.role,
      status: run.status,
      task: run.task,
      taskPreview: truncatePreview(run.task),
      startedAt: run.startedAt,
      elapsedMs: this.#now() - run.startedAt,
      ...(run.lastToolName !== undefined ? { lastToolName: run.lastToolName } : {}),
      ...(run.lastToolAt !== undefined ? { lastToolAt: run.lastToolAt } : {}),
      toolCounts: counts,
      ...(run.turnHistory.length > 0
        ? {
            turnHistory: run.turnHistory.map((turn) => ({
              text: turn.text,
              precedingToolCounts: { ...turn.precedingToolCounts },
              truncated: turn.truncated,
            })),
          }
        : {}),
      ...(run.currentText.trim() ? { currentText: run.currentText } : {}),
      ...(Object.keys(pendingToolCounts).length > 0 ? { pendingToolCounts } : {}),
    };
  }

  /**
   * Receive a conversation event and update the owning run's peek progress.
   * No-op for events whose `agentId` is not a run this registry owns (sync /
   * nested subagent events are ignored here). This is the only path by which
   * the registry learns `subagent_tool_started` mid-run.
   */
  handleSubagentEvent(event: ConversationEvent): void {
    if (
      event.type !== 'subagent_tool_started' &&
      event.type !== 'subagent_text_turn' &&
      event.type !== 'subagent_streaming_text'
    )
      return;
    const run = this.#runs.get(event.agentId);
    if (!run || !isActiveStatus(run.status)) return;

    if (event.type === 'subagent_streaming_text') {
      run.currentText = event.text;
      return;
    }

    if (event.type === 'subagent_text_turn') {
      run.turnHistory.push({
        text: event.text.slice(0, TURN_TEXT_CHAR_LIMIT),
        precedingToolCounts: mapToRecord(run.pendingToolCounts),
        truncated: event.text.length > TURN_TEXT_CHAR_LIMIT,
      });
      if (run.turnHistory.length > MAX_TURN_HISTORY) run.turnHistory.shift();
      run.pendingToolCounts.clear();
      run.currentText = '';
      return;
    }

    const name = event.toolName;
    if (!name) return;
    run.toolCounts.set(name, (run.toolCounts.get(name) ?? 0) + 1);
    run.pendingToolCounts.set(name, (run.pendingToolCounts.get(name) ?? 0) + 1);
    run.lastToolName = name;
    run.lastToolAt = this.#now();
  }

  getResult(runId: string, signal?: AbortSignal): Promise<SubagentResult> {
    const run = this.#runs.get(runId);
    if (!run)
      return Promise.reject(
        new SubagentRegistryError(
          this.#evicted.has(runId) ? 'evicted' : 'not_found',
          `Async subagent run not found: ${runId}`,
        ),
      );
    run.lastUsedAt = this.#now();
    if (run.result) return Promise.resolve(run.result);
    if (signal?.aborted) return Promise.reject(new Error('The get_subagent_result call was aborted.'));
    return run.promise;
  }

  abortRun(runId: string): void {
    const run = this.#runs.get(runId);
    if (run && isActiveStatus(run.status)) this.#cancelRun(run);
  }

  /**
   * Non-blocking public cancellation addressed by canonical runId first, then
   * its active name. `abortRun` remains the internal user-stop compatibility API.
   */
  cancelRun(target: string): SubagentCancelAcknowledgement {
    const run = this.#resolveActiveTarget(target);
    if (!run) return { ok: false, code: 'not_active', target };
    this.#cancelRun(run);
    return { ok: true, runId: run.runId, status: 'cancelling' };
  }

  /**
   * Queue bounded steering for an active execution run without awaiting its result.
   * Canonical active run ids are resolved before active names.
   */
  sendMessage(target: string, guidance: string, replyToParam?: string | null): SubagentSteerAcknowledgement {
    // OpenAI strict tool schemas turn optional params into nullable-with-null-default,
    // so an absent reply_to arrives as null. Treat it as absent, not as an answer.
    const replyTo = replyToParam ?? undefined;
    const run = this.#resolveActiveTarget(target);
    if (!run) return { ok: false, code: 'not_active', target };
    if (run.role === 'mentor') return { ok: false, code: 'unsupported_control', target };
    const message = guidance.trim();
    if (message.length === 0 || message.length > MAX_STEERING_GUIDANCE_CHARACTERS) {
      return { ok: false, code: 'invalid_guidance', target };
    }
    if (run.status === 'cancelling') {
      return replyTo === undefined
        ? { ok: false, code: 'not_active', target }
        : { ok: false, code: 'question_not_pending', target };
    }
    if (replyTo !== undefined) {
      const pending = run.control.pendingQuestion;
      if (!pending) return { ok: false, code: 'question_not_pending', target };
      if (pending.messageId !== replyTo) return { ok: false, code: 'question_mismatch', target };
      if (!run.control.answer(replyTo, message)) return { ok: false, code: 'question_not_pending', target };
      run.status = 'running';
      return { ok: true, runId: run.runId, status: 'running', delivery: 'answered' };
    }
    // Steering cannot reach a waiting `ask_orchestrator` call: it is queued behind a
    // tool that only an answer resumes. Refusing it keeps the blocker visible instead
    // of stranding the run on an acknowledgement the orchestrator reads as handled.
    if (run.control.pendingQuestion) return { ok: false, code: 'question_pending', target };
    if (!run.control.canStartContinuation()) return { ok: false, code: 'steer_limit_reached', target };
    run.control.enqueueSteering(message);
    return { ok: true, runId: run.runId, status: 'running', delivery: 'queued' };
  }

  cancelAllRuns(): void {
    for (const run of this.#runs.values()) if (isActiveStatus(run.status)) this.#cancelRun(run);
  }

  #cancelRun(run: StoredRun): void {
    if (run.status !== 'running' && run.status !== 'waiting_for_answer') return;
    run.status = 'cancelling';
    run.control.requestCancellation();
  }

  reset(): void {
    this.cancelAllRuns();
    for (const [runId, run] of this.#runs) {
      if (!isActiveStatus(run.status)) this.#runs.delete(runId);
    }
    this.#sessions.clear();
    this.#evicted.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearInterval(this.#timer);
    this.reset();
  }

  #evictToSessionCap(): void {
    while (this.#sessions.size > this.#sessionCap) {
      const candidate = [...this.#runs.values()]
        .filter((run) => !isActiveStatus(run.status))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!candidate) return;
      this.#runs.delete(candidate.runId);
      this.#evicted.add(candidate.runId);
      if (![...this.#runs.values()].some((run) => run.session === candidate.session)) {
        for (const [key, session] of this.#sessions) if (session === candidate.session) this.#sessions.delete(key);
      }
    }
  }

  evictExpired(): void {
    this.#evictExpired();
  }

  #evictExpired(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, run] of this.#runs) {
      if (!isActiveStatus(run.status) && run.lastUsedAt <= cutoff) {
        this.#runs.delete(id);
        this.#evicted.add(id);
      }
    }
  }

  /**
   * Allocate a fresh run id, retrying the factory against an active, settled, or
   * evicted id. A collision would silently overwrite a stored run, so even the
   * vanishingly unlikely codename collision is defended here rather than
   * relying on the factory's entropy alone.
   */
  /**
   * Scopes the run's provider traffic to the run, under whichever context
   * launched it — so a background subagent started by another subagent nests
   * beneath its parent instead of flattening back onto the conversation.
   */
  #deriveTrafficContext(runId: string): SessionTrafficContext | undefined {
    const launchContext = this.#sessionContextService?.getContext();
    if (!launchContext) return undefined;
    const parentKey = launchContext.providerHistoryKey ?? launchContext.sessionId;
    return { ...launchContext, providerHistoryKey: `${parentKey}:subagent:${runId}` };
  }

  #allocateRunId(): string {
    for (let attempt = 0; attempt < MAX_RUN_ID_ATTEMPTS; attempt++) {
      const candidate = this.#createRunId();
      if (!this.#runs.has(candidate) && !this.#evicted.has(candidate)) return candidate;
    }
    return this.#createRunId();
  }

  #resolveActiveTarget(target: string): StoredRun | undefined {
    const byRunId = this.#runs.get(target);
    if (byRunId && isActiveStatus(byRunId.status)) return byRunId;
    const byName = this.#activeNameToRunId.get(target);
    if (!byName) return undefined;
    const run = this.#runs.get(byName);
    return run && isActiveStatus(run.status) ? run : undefined;
  }

  #startSegment(run: StoredRun, request: SubagentRequest, input: string): void {
    if (run.settled) return;
    const controller = run.control.beginSegment();
    void this.#executeSegment(run, request, input, controller);
  }

  async #executeSegment(
    run: StoredRun,
    request: SubagentRequest,
    input: string,
    controller: AbortController,
  ): Promise<void> {
    let result: SubagentResult;
    try {
      const runSegment = () =>
        this.#run({
          request,
          runId: run.runId,
          session: run.session,
          signal: controller.signal,
          input,
          control: {
            onToolStart: () => run.control.onToolStart(),
            onToolComplete: () => run.control.onToolComplete(),
            askOrchestrator: (question) => this.#askOrchestrator(run, question),
          },
        });

      // Every segment — first launch, `continue_run_id`, steering continuation —
      // runs under the run's own context, so they share one provider-side session.
      result = await (run.trafficContext && this.#sessionContextService
        ? this.#sessionContextService.runWithContext(run.trafficContext, runSegment)
        : runSegment());
      run.session.trimHistory(this.#messageCap);
      result = { ...result, agentId: run.runId };
    } catch (error: any) {
      const cancelled = isAbortLike(error?.message, error) || controller.signal.aborted;
      result = {
        agentId: run.runId,
        role: run.role,
        status: cancelled ? 'cancelled' : 'failed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
        error: error?.message ?? String(error),
      };
    }
    run.control.endSegment(controller);
    this.#accumulateEvidence(run.evidence, result);
    if (run.control.cancellationRequested) {
      this.#settle(run, this.#assembleTerminalResult(run, result));
      return;
    }

    const guidance = run.control.consumeSteering();
    if (guidance !== undefined && run.control.startContinuation()) {
      this.#startSegment(run, request, buildContinuationInput(guidance));
      return;
    }
    this.#settle(run, this.#assembleTerminalResult(run, result));
  }

  #settle(run: StoredRun, result: SubagentResult): void {
    if (run.settled) return;
    run.status = result.status;
    run.result = result;
    run.lastUsedAt = this.#now();
    run.settled = true;
    if (run.name !== undefined && this.#activeNameToRunId.get(run.name) === run.runId) {
      this.#activeNameToRunId.delete(run.name);
    }
    run.control.settle();
    run.removeParentAbortListener?.();
    run.resolve(result);
    if (!this.#disposed) safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result, async: true });
  }

  #askOrchestrator(run: StoredRun, question: string): Promise<string> {
    if (run.status !== 'running')
      return Promise.reject(new Error('The subagent run is no longer accepting questions.'));
    const asked = run.control.ask(question);
    run.status = 'waiting_for_answer';
    safeEmit(this.#logger, this.#onEvent, {
      type: 'subagent_question',
      async: true,
      messageId: asked.messageId,
      runId: run.runId,
      ...(run.name !== undefined ? { name: run.name } : {}),
      role: run.role,
      question: asked.question,
    });
    return asked.answer;
  }

  #assembleTerminalResult(run: StoredRun, segment: SubagentResult): SubagentResult {
    const status = run.control.cancellationRequested ? 'cancelled' : segment.status;
    const error =
      status === 'cancelled'
        ? segment.status === 'cancelled' && segment.error
          ? segment.error
          : 'The subagent run was aborted.'
        : segment.error;
    const usage = run.evidence.usage;
    const diffStat = [...run.evidence.diffStat.values()];

    return {
      agentId: run.runId,
      ...(run.name !== undefined ? { name: run.name } : {}),
      role: run.role,
      status,
      finalText: status === 'completed' ? segment.finalText : '',
      filesChanged: [...run.evidence.filesChanged],
      toolsUsed: [...run.evidence.toolsUsed].map(([toolName, count]) => ({ toolName, count })),
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
      ...(diffStat.length > 0 ? { diffStat } : {}),
      ...(run.evidence.validation ? { validation: run.evidence.validation } : {}),
    };
  }

  #accumulateEvidence(evidence: AccumulatedEvidence, result: SubagentResult): void {
    for (const path of result.filesChanged) evidence.filesChanged.add(path);
    for (const { toolName, count } of result.toolsUsed) {
      evidence.toolsUsed.set(toolName, (evidence.toolsUsed.get(toolName) ?? 0) + count);
    }
    for (const entry of result.diffStat ?? []) {
      const existing = evidence.diffStat.get(entry.path);
      evidence.diffStat.set(entry.path, {
        path: entry.path,
        added: (existing?.added ?? 0) + entry.added,
        deleted: (existing?.deleted ?? 0) + entry.deleted,
      });
    }
    if (result.validation) evidence.validation = result.validation;
    if (result.usage) evidence.usage = addTokenUsage(evidence.usage, result.usage);
  }
}

function isActiveStatus(status: StoredRunStatus): status is 'running' | 'waiting_for_answer' | 'cancelling' {
  return status === 'running' || status === 'waiting_for_answer' || status === 'cancelling';
}

function mapToRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(counts);
}

function buildContinuationInput(guidance: string): string {
  return [
    'Your prior segment was interrupted. Completed side effects may remain.',
    'Before following this guidance, inspect and reconcile current work and any partial results.',
    'Coalesced steering guidance:',
    guidance,
  ].join('\n\n');
}
