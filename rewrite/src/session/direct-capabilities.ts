/** Bind context leaves to the owning Session's synchronous acceptance boundary. */
import type { TurnId } from '../engine/index.js';
import type { Item, ItemId, ModelRequest } from '../model/index.js';
import type { Tool, ToolRegistry } from '../tools/index.js';
import type { Fact, FactLine } from './facts.js';
import {
  planDirectInstructions,
  planDirectHumanContext,
  type DirectContextState,
  type DirectContextFact,
} from './direct-context.js';
import { createDirectGoalCheckTool, createDirectProposeGoalTool, type DirectGoalState } from './direct-goal.js';
import { createDirectGoalStopPolicy, type DirectGoalHistoryItem } from './direct-goal-stop.js';
import { createDirectGoalVerifier } from './direct-goal-verification.js';
import type { DirectMemoryCapability, DirectAutomaticMemoryNotice } from './direct-memory.js';
import type { createDirectHooks, DirectHookAcceptedMetadata } from './direct-hooks.js';
import type { DirectBackgroundTasks } from './direct-background.js';

export type DirectContextPort = {
  readonly sessionId: string;
  read(): DirectContextState;
  /** Generation CAS and candidate reduction occur before the sole writer append. */
  commit(expectedGeneration: number, facts: readonly DirectContextFact[]): boolean;
  readonly tasks: DirectBackgroundTasks;
};
export type DirectContextCapabilities = {
  readonly memory?: DirectMemoryCapability;
  readonly hooks?: ReturnType<typeof createDirectHooks>;
  readonly verification?: Pick<Parameters<typeof createDirectGoalVerifier>[0], 'operations' | 'limits'>;
  readonly verificationEnabled?: () => boolean;
  readonly unattended?: boolean;
  readonly proposeGoal?: boolean;
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
}) {
  const capabilities = options.capabilities ?? {};
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
    if (requestGoal.goal?.status === 'active') {
      bound.push(createDirectGoalCheckTool({ requestGoal, readGoal: () => options.read().goal }));
    }
    if (capabilities.proposeGoal && !requestGoal.goal && !requestGoal.proposalMade) {
      bound.push(
        createDirectProposeGoalTool({
          readGoal: () => options.read().goal,
          commit: (generation, facts) => (turnId ? write(turnId, generation, facts) : false),
          async approve(goal, context) {
            if (!context.interact) return { approved: false, source: 'system' };
            const before = options.facts().length;
            const decision = await context.interact({
              kind: 'approval',
              toolName: 'propose_goal',
              input: { goal },
              summary: `Create durable goal: ${goal.outcome}`,
              presentation: { requiresExplicitUser: true, goalId: goal.id },
            });
            // Only an accepted closure for THIS proposal and real user source
            // can grant it. Headless policy answers retain system provenance.
            const facts = options.facts().slice(before);
            const opened = facts.find(
              (fact) =>
                fact.type === 'interaction_opened' &&
                fact.request.toolName === 'propose_goal' &&
                fact.request.presentation?.goalId === goal.id,
            );
            const closed =
              opened?.type === 'interaction_opened'
                ? facts.find(
                    (fact) => fact.type === 'interaction_closed' && fact.requestId === opened.request.requestId,
                  )
                : undefined;
            return {
              approved:
                decision.kind === 'allow' &&
                closed?.type === 'interaction_closed' &&
                closed.resolution.kind === 'allow' &&
                closed.resolutionSource === 'user',
              source: closed?.type === 'interaction_closed' ? closed.resolutionSource ?? 'system' : 'system',
            };
          },
        }),
      );
    }
    const overrides = new Map(bound.map((tool) => [tool.spec.name, tool]));
    // Never retain a stale/source goal declaration when no direct goal exists.
    const specs = request.tools.filter(
      (tool) => !['goal_check', 'propose_goal'].includes(tool.name) && !overrides.has(tool.name),
    );
    const tools: ToolRegistry = {
      get: (name) =>
        overrides.get(name) ??
        (['goal_check', 'propose_goal'].includes(name) ? undefined : options.baseTools?.get(name)),
      available: (ctx) => [
        ...(options.baseTools?.available(ctx) ?? []).filter(
          (tool) => !overrides.has(tool.spec.name) && !['goal_check', 'propose_goal'].includes(tool.spec.name),
        ),
        ...bound,
      ],
    };
    return { request: { ...request, instructions, tools: [...specs, ...bound.map((tool) => tool.spec)] }, tools };
  };

  return {
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
        unattended: capabilities.unattended,
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
  for (const fact of facts) {
    if (fact.type === 'turn_started' || fact.type === 'queue_steered') {
      if (fact.type === 'turn_started' && fact.retryContext) {
        if (fact.retryContext.sourceTurnId !== turnId) throw new Error('Retry goal window has no accepted source turn');
        const through = window.findIndex(({ item }) => item.id === fact.retryContext!.throughItemId);
        window = through < 0 ? [] : window.slice(0, through + 1);
        // Physical modelStep numbering restarts on a new Turn. Goal evidence
        // must not treat the retried step as the old step's parallel calls.
        stepOffset = Math.max(-1, ...window.map(({ modelStep }) => modelStep)) + 1;
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
