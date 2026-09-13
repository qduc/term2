import { randomUUID } from 'node:crypto';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ISubagentClient, ISubagentClientFactory } from './subagent-client-types.js';
import { SubagentToolPolicy, SubagentToolFactory } from './tool-policy.js';
import { NestedSubagentRunner, type CachedRoleTool } from './nested-runner.js';
import { ExecutionSubagentRunner } from './execution-runner.js';
import { MentorRunner } from './mentor-runner.js';
import type { SupportedSubagentRole } from './types.js';
import type { SkillsService } from '../skills/skills-service.js';
import { SubagentAsyncRegistry } from './subagent-async-registry.js';
import { SubagentSession } from './subagent-session.js';
import { loadRoleDefinition } from './role-loader.js';
import type { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import type { BackgroundSubagentApprovalPauseSink } from './foreground-subagent-lease.js';
import { SubagentRolePoolSelector } from './subagent-role-pool-selector.js';

export interface SubagentRuntimeDeps {
  logger: ILoggingService;
  settings: ISettingsService;
  sessionContextService: ISessionContextService;
  executionContext?: ExecutionContext;
  onEvent?: (event: ConversationEvent) => void;
  agentClient?: ISubagentClient;
  createClient?: ISubagentClientFactory['createClient'];
  skillsService?: SkillsService;
  toolOwnership: ToolOwnershipRegistry;
  /** Session-owned state for nested tools' legacy approval protocol only. */
  nestedCompatibility?: NestedToolCompatibilityState;
  /** Session-owned queue/control sink for pauses from adopted child runs. */
  backgroundApprovalPauseSink?: BackgroundSubagentApprovalPauseSink;
  readOnly?: boolean;
}

export interface SubagentRuntime {
  toolPolicy: SubagentToolPolicy;
  toolFactory: SubagentToolFactory;
  nestedRunner: NestedSubagentRunner;
  executionRunner: ExecutionSubagentRunner;
  mentorRunner: MentorRunner;
  asyncRegistry: SubagentAsyncRegistry;
  /** The one exact compatibility state used by nested tool creation. */
  nestedCompatibility: NestedToolCompatibilityState;
}

export function createSubagentRuntime(deps: SubagentRuntimeDeps): SubagentRuntime {
  const nestedCompatibility = deps.nestedCompatibility ?? new NestedToolCompatibilityState(deps.settings);
  // Peek (get_subagent_status): route subagent_tool_started events into the
  // registry so it can capture live per-run progress. The registry is assigned
  // after the runners below (its `run` callback references them), so the
  // optional chaining keeps this safe until then. Events fire only during
  // execution, which always happens after the registry is assigned.
  // `asyncRegistry` is assigned once below but referenced earlier by the
  // `onEventWithPeek` closure; prefer-const lint would complain here so
  // disable it for this declaration.
  // eslint-disable-next-line prefer-const
  let asyncRegistry: SubagentAsyncRegistry | undefined;
  const onEventWithPeek = (event: ConversationEvent): void => {
    asyncRegistry?.handleSubagentEvent(event);
    // Registry state is updated before the bridge routes the event. This is
    // what makes an adopted run's first terminal event background-owned.
    deps.onEvent?.(event);
  };

  const toolPolicy = new SubagentToolPolicy({
    settings: deps.settings,
    logger: deps.logger,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    agentClient: deps.agentClient,
  });

  const toolFactory = new SubagentToolFactory({
    settings: deps.settings,
    logger: deps.logger,
    executionContext: deps.executionContext,
    toolPolicy,
    skillsService: deps.skillsService,
    nestedCompatibility,
    readOnly: deps.readOnly,
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();
  // One cursor per role, shared by both spawn paths below (the foreground
  // `run_subagent` tool and the async registry's fresh-run resolution) so a
  // pool round-robins across every spawn regardless of which path it came
  // through.
  const rolePoolSelector = new SubagentRolePoolSelector(deps.settings);

  const nestedRunner = new NestedSubagentRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    toolFactory,
    onEvent: onEventWithPeek,
    roleToolCache,
    rolePoolSelector,
    skillsService: deps.skillsService,
    toolOwnership: deps.toolOwnership,
    ...(deps.backgroundApprovalPauseSink ? { backgroundApprovalPauseSink: deps.backgroundApprovalPauseSink } : {}),
  });

  const executionRunner = new ExecutionSubagentRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    createClient: deps.createClient,
    toolFactory,
    onEvent: onEventWithPeek,
    skillsService: deps.skillsService,
    toolOwnership: deps.toolOwnership,
  });

  // Reviewer explorers are fresh, contained child runs: their events are not
  // forwarded, so they never surface as orphan activity in the parent session.
  toolFactory.setExplorerRunner((task, signal) => {
    const agentId = randomUUID();
    const definition = rolePoolSelector.resolveForSpawn('explorer', loadRoleDefinition('explorer', deps.settings));
    return executionRunner.runInSession(
      agentId,
      { role: 'explorer', task, signal, parentTool: 'run_explorer' },
      definition,
      new SubagentSession(agentId, 'explorer'),
      undefined,
      signal,
      () => {},
    );
  });

  const mentorSession = new SubagentSession('mentor', 'mentor');
  const mentorRunner = new MentorRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    onEvent: onEventWithPeek,
    session: mentorSession,
  });

  asyncRegistry = new SubagentAsyncRegistry({
    logger: deps.logger,
    run: async ({ request, runId, session, signal, input, control, definition }) => {
      if (request.role === 'mentor') {
        return mentorRunner.run(runId, input, signal, session, request.executionBudget);
      }
      // `definition` is resolved once per run by `resolveDefinition` below and
      // carried across every later segment (including steering continuations
      // and an explicit `continue_run_id`), so it is never recomputed here —
      // recomputing per segment would draw another pool entry per turn
      // instead of once per spawn. The fallback only covers callers that
      // never went through `resolveDefinition` (e.g. a bare test double).
      const resolvedDefinition = definition ?? loadRoleDefinition(request.role, deps.settings);
      return executionRunner.runInSession(
        runId,
        { ...request, signal },
        {
          ...resolvedDefinition,
          ...(request.executionBudget ? { executionBudget: request.executionBudget } : {}),
        },
        session,
        undefined,
        signal,
        undefined,
        control,
        input,
      );
    },
    onEvent: deps.onEvent,
    sessionContextService: deps.sessionContextService,
    ttlMs: deps.settings.get('subagent.asyncSessionTtlMs') ?? 30 * 60 * 1000,
    messageCap: deps.settings.get('subagent.asyncMessageCap') ?? 50,
    sessionForRole: (role) => (role === 'mentor' ? mentorSession : undefined),
    // Called once per fresh (non-continuation) spawn; a configured pool
    // advances its round-robin cursor here.
    resolveDefinition: (role) => {
      const base = loadRoleDefinition(role as SupportedSubagentRole, deps.settings);
      return rolePoolSelector.resolveForSpawn(role as SupportedSubagentRole, base);
    },
    modelForRole: (role) => {
      const mentorPool = role === 'mentor' ? deps.settings.get('agent.mentorPool') : undefined;
      if (Array.isArray(mentorPool) && mentorPool.length > 0) return undefined;
      const definition = loadRoleDefinition(role as SupportedSubagentRole, deps.settings);
      return { provider: definition.provider, id: definition.model };
    },
  });

  return {
    toolPolicy,
    toolFactory,
    nestedRunner,
    executionRunner,
    mentorRunner,
    asyncRegistry,
    nestedCompatibility,
  };
}
