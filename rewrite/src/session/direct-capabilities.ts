/** Bind context leaves to the owning Session's synchronous acceptance boundary. */
import type { TurnId } from '../engine/index.js';
import type { Item, ItemId, ModelRequest } from '../model/index.js';
import type { Tool, ToolRegistry } from '../tools/index.js';
import type { Fact, FactLine } from './facts.js';
import {
  planDirectInstructions,
  startsDirectHumanWindow,
  planDirectHumanContext,
  type DirectContextState,
  type DirectContextFact,
} from './direct-context.js';
import { createDirectGoalCheckTool } from './direct-goal.js';
import { createDirectGoalStopPolicy, type DirectGoalHistoryItem } from './direct-goal-stop.js';
import { createDirectGoalVerifier } from './direct-goal-verification.js';
import type { DirectMemoryCapability, DirectAutomaticMemoryNotice } from './direct-memory.js';
import type { createDirectHooks, DirectHookAcceptedMetadata } from './direct-hooks.js';
import { createDirectRolloverTool, type DirectRolloverRequestOutcome } from './direct-rollover.js';
import type { DirectBackgroundTasks } from './direct-background.js';

export type DirectContextPort = {
  readonly sessionId: string;
  /** Live read-only physical identity; sessionId remains the original logical owner. */
  readonly backingSessionId: string;
  read(): DirectContextState;
  /** Generation CAS and candidate reduction occur before the sole writer append. */
  commit(expectedGeneration: number, facts: readonly DirectContextFact[]): boolean;
  readonly tasks: DirectBackgroundTasks;
  configureTaskCheckIn(
    target: string,
    policy: import('./direct-background-check-ins.js').DirectBackgroundCheckInPolicy,
  ): ReturnType<import('./direct-background-check-ins.js').DirectBackgroundCheckIns['configure']>;
};
export type DirectContextCapabilities = {
  readonly memory?: DirectMemoryCapability;
  readonly hooks?: ReturnType<typeof createDirectHooks>;
  readonly verification?: Pick<Parameters<typeof createDirectGoalVerifier>[0], 'operations' | 'limits'>;
  readonly verificationEnabled?: () => boolean;
  readonly unattended?: boolean;
  /** Effective source settings, re-read for each advisory tick. */
  readonly backgroundCheckIns?: () => import('./direct-background-check-ins.js').DirectBackgroundCheckInSettings;
  /** Source assembly names before native slots; refreshed on configuration. */
  readonly nativeToolSlots?: {
    readonly beforeMemory: readonly string[];
    readonly beforeRollover: readonly string[];
    readonly beforeGoal: readonly string[];
    readonly sessions: boolean;
  };
  /** Rollover milestone reminders for this session's root turns; a successor session gets fresh ones. */
  readonly contextMilestones?: import('../engine/index.js').TurnDeps['contextMilestones'];
  /** Model-facing rollover availability is distinct from native rollover control. */
  readonly modelRollover?: boolean;
  readonly automaticMemory?: (input: {
    readonly admissionId: string;
    readonly text: string;
    readonly images?: readonly unknown[];
  }) => Promise<DirectAutomaticMemoryNotice | undefined>;
};
export type DirectContextFactory = (port: DirectContextPort) => DirectContextCapabilities;

/** Small binding, not an engine or a writer: every write passes back to Session. */
export function bindDirectCapabilities(options: {
  readonly sessionId: string;
  readonly read: () => DirectContextState;
  readonly facts: () => readonly Fact[];
  readonly commit: (expectedGeneration: number, facts: readonly DirectContextFact[], turnId?: TurnId) => boolean;
  readonly validTurn: (turnId: TurnId) => boolean;
  readonly baseTools?: ToolRegistry;
  readonly capabilities?: DirectContextCapabilities;
  readonly canRollover?: () => boolean;
  readonly requestRollover?: (
    turnId: TurnId,
    request: import('./direct-command-types.js').DirectRolloverRequest,
  ) => DirectRolloverRequestOutcome;
}) {
  let capabilities = options.capabilities ?? {};
  let baseTools = options.baseTools;
  let hookWork = Promise.resolve();
  let ready: Promise<void> | undefined;
  const hook = (operation: () => Promise<void>): void => {
    hookWork = hookWork.then(operation).catch(() => {});
  };
  const ensureStarted = async (): Promise<void> => {
    ready ??= Promise.resolve()
      .then(() => capabilities.hooks?.start())
      .then(() => {})
      .catch(() => {});
    await ready;
  };
  const write = (turnId: TurnId, generation: number, facts: readonly DirectContextFact[]): boolean =>
    options.validTurn(turnId) && options.commit(generation, facts, turnId);

  const planRequest = (request: ModelRequest, turnId?: TurnId) => {
    const { instructions, requestGoal } = planDirectInstructions(
      request.instructions,
      options.read(),
      capabilities.memory,
    );
    const bound: Tool[] = [...(capabilities.memory?.tools ?? [])];
    // Visibility is stable across goal changes; execution rejects an inactive goal.
    bound.push(createDirectGoalCheckTool({ requestGoal, readGoal: () => options.read().goal }));
    if (capabilities.modelRollover !== false && options.canRollover?.())
      bound.push(
        createDirectRolloverTool((request) =>
          turnId && options.requestRollover
            ? options.requestRollover(turnId, request)
            : { ok: false, status: 'rollover_blocked', error: 'No live root owns this request.' },
        ),
      );
    const overrides = new Map(bound.map((tool) => [tool.spec.name, tool]));
    // Replace source declarations with Session-owned tools, never their legacy callbacks.
    const specs = request.tools.filter(
      (tool) => !['goal_check', 'propose_goal', 'session_rollover'].includes(tool.name) && !overrides.has(tool.name),
    );
    const tools: ToolRegistry = {
      get: (name) =>
        overrides.get(name) ??
        (['goal_check', 'propose_goal', 'session_rollover'].includes(name) ? undefined : baseTools?.get(name)),
      available: (ctx) => [
        ...(baseTools?.available(ctx) ?? []).filter(
          (tool) =>
            !overrides.has(tool.spec.name) &&
            !['goal_check', 'propose_goal', 'session_rollover'].includes(tool.spec.name),
        ),
        ...bound,
      ],
    };
    const ordered = [...specs];
    const slots = capabilities.nativeToolSlots;
    if (slots) {
      const memory = bound.filter(
        (tool) => !['goal_check', 'propose_goal', 'session_rollover'].includes(tool.spec.name),
      );
      const insertAfter = (names: readonly string[], additions: readonly Tool[]) => {
        const prior = new Set(names);
        const at = ordered.reduce((at, tool, index) => (prior.has(tool.name) ? index + 1 : at), 0);
        ordered.splice(at, 0, ...additions.map((tool) => tool.spec));
      };
      insertAfter(slots.beforeMemory, memory);
      const memoryNames = memory.map((tool) => tool.spec.name);
      const rollover = overrides.get('session_rollover');
      if (rollover) insertAfter([...slots.beforeRollover, ...memoryNames], [rollover]);
      const namesBeforeGoal = [...slots.beforeGoal, ...memoryNames, ...(rollover ? ['session_rollover'] : [])];
      const goalTools = ['propose_goal', 'goal_check'].flatMap((name) => {
        const tool = overrides.get(name);
        return tool ? [tool] : [];
      });
      insertAfter(namesBeforeGoal, goalTools);
    } else ordered.push(...bound.map((tool) => tool.spec));
    return { request: { ...request, instructions, tools: ordered }, tools };
  };

  return {
    /** Swap model-bound tools/verifier only; retain the single hooks/memory lifetime. */
    replace(nextTools: ToolRegistry | undefined, next: DirectContextCapabilities) {
      baseTools = nextTools;
      capabilities = next;
    },
    previewRequest: (request: ModelRequest) => planRequest(request).request,
    async prepareRequest(request: ModelRequest, input: { turnId: TurnId; modelStep: number; signal: AbortSignal }) {
      await ensureStarted();
      input.signal.throwIfAborted();
      if (!options.validTurn(input.turnId)) throw new Error('Stale Session request');
      return planRequest(request, input.turnId);
    },
    async normalStop(input: { turnId: TurnId; signal: AbortSignal }) {
      input.signal.throwIfAborted();
      const verify = capabilities.verification
        ? createDirectGoalVerifier({
            sessionId: options.sessionId,
            readAttempts: () => options.read().verification,
            commit: (generation, facts) => write(input.turnId, generation, facts),
            ...capabilities.verification,
          })
        : undefined;
      const policy = createDirectGoalStopPolicy({
        readGoal: () => options.read().goal,
        commitGoal: (generation, facts) => write(input.turnId, generation, facts),
        commitReminder: (fact) => write(input.turnId, options.read().goal.generation, [fact]),
        verificationEnabled: capabilities.verificationEnabled ?? (() => false),
        verify,
      });
      const goal = options.read().goal;
      return policy(
        {
          turnId: input.turnId,
          history: directAcceptedGoalWindow(options.facts()),
          reminders: options.read().goalReminders,
          goalToolAvailable: goal.goal?.status === 'active',
        },
        input.signal,
      );
    },
    humanPlan(admissionId: string, input: readonly Item[]) {
      if (!capabilities.memory) return { facts: [], modelInput: input };
      // Global facts are accepted once, not re-admitted on every human input.
      return planDirectHumanContext({
        state: options.read(),
        admissionId,
        input,
        memory: {
          ...capabilities.memory,
          facts: options.read().memory.globalSnapshot === undefined ? capabilities.memory.facts : [],
        },
      });
    },
    memoryFacts: () => (options.read().memory.globalSnapshot === undefined ? capabilities.memory?.facts ?? [] : []),
    finalizeHuman: capabilities.automaticMemory,
    accepted(line: FactLine) {
      if (!capabilities.hooks) return;
      const fact = line.fact;
      const metadata: DirectHookAcceptedMetadata =
        fact.type === 'interaction_closed'
          ? {
              resolutionSource: fact.resolutionSource ?? 'system',
              automaticApproval: fact.automaticApproval,
            }
          : {};
      hook(async () => {
        await ensureStarted();
        await capabilities.hooks!.accepted(line, metadata);
      });
    },
    status(...args: Parameters<NonNullable<DirectContextCapabilities['hooks']>['status']>) {
      if (capabilities.hooks)
        hook(async () => {
          await ensureStarted();
          await capabilities.hooks!.status(...args);
        });
    },
    async close(failed: boolean) {
      await hookWork;
      if (ready) await ready.catch(() => {});
      await capabilities.hooks?.end(failed ? 'fatal_error' : 'normal');
    },
  };
}

/** Accepted human-window evidence is independent of compacted provider history. */
export function directAcceptedGoalWindow(facts: readonly Fact[]): readonly DirectGoalHistoryItem[] {
  let window: DirectGoalHistoryItem[] = [];
  let turnId: TurnId | undefined;
  let stepOffset = 0;
  const partials = new Map<number, { text: string; completed: boolean }>();
  const admissions = new Map<string, import('./direct-queue-types.js').DirectQueueRecord>();
  for (const fact of facts) {
    if (fact.type === 'queue_submitted') admissions.set(fact.record.messageId, fact.record);
    if (fact.type === 'turn_started' || fact.type === 'queue_steered') {
      const human = startsDirectHumanWindow(fact, [...admissions.values()]);
      // An automatic steer is provider context, not a new goal or model-step boundary.
      if (fact.type === 'queue_steered' && !human) continue;
      if (fact.type === 'turn_started' && fact.retryContext) {
        if (fact.retryContext.sourceTurnId !== turnId) throw new Error('Retry goal window has no accepted source turn');
        const through = window.findIndex(({ item }) => item.id === fact.retryContext!.throughItemId);
        window = through < 0 ? [] : window.slice(0, through + 1);
        // Physical modelStep numbering restarts on a new Turn. Goal evidence
        // must not treat the retried step as the old step's parallel calls.
        stepOffset = Math.max(-1, ...window.map(({ modelStep }) => modelStep)) + 1;
      } else if (fact.type === 'turn_started' && !human) {
        stepOffset = Math.max(-1, ...window.map(({ modelStep }) => modelStep)) + 1;
        // A delivered result invalidates an earlier check, not the human-window budgets.
        window.push(...fact.input.map((item) => ({ item, modelStep: stepOffset })));
      } else {
        window = [];
        stepOffset = 0;
      }
      turnId = fact.turnId;
      partials.clear();
    } else if (fact.type === 'item' && fact.turnId === turnId) {
      const modelStep = stepOffset + (fact.modelStep ?? 0);
      if (fact.item.type === 'assistant_message') partials.set(modelStep, { text: '', completed: true });
      window.push({ item: fact.item, modelStep });
    } else if (fact.type === 'text_delta' && fact.turnId === turnId) {
      const step = stepOffset + (fact.modelStep ?? 0);
      const previous = partials.get(step) ?? { text: '', completed: false };
      partials.set(step, { ...previous, text: previous.text + fact.delta });
    } else if (fact.type === 'model_response_completed' && fact.turnId === turnId) {
      const partial = partials.get(stepOffset + fact.modelStep);
      if (partial?.text && !partial.completed)
        window.push({
          modelStep: stepOffset + fact.modelStep,
          item: {
            type: 'assistant_message',
            id: `${turnId}-model-${fact.modelStep}-partial` as ItemId,
            content: [{ type: 'text', text: partial.text }],
          },
        });
    }
  }
  return window;
}
