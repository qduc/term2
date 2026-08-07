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
}

export interface SubagentRuntime {
  toolPolicy: SubagentToolPolicy;
  toolFactory: SubagentToolFactory;
  nestedRunner: NestedSubagentRunner;
  executionRunner: ExecutionSubagentRunner;
  mentorRunner: MentorRunner;
  asyncRegistry: SubagentAsyncRegistry;
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
    deps.onEvent?.(event);
    asyncRegistry?.handleSubagentEvent(event);
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
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();

  const nestedRunner = new NestedSubagentRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    toolFactory,
    onEvent: onEventWithPeek,
    roleToolCache,
    skillsService: deps.skillsService,
    toolOwnership: deps.toolOwnership,
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
    run: async ({ request, runId, session, signal, input, control }) => {
      if (request.role === 'mentor') {
        return mentorRunner.run(runId, input, signal, session, request.executionBudget);
      }
      const definition = loadRoleDefinition(request.role, deps.settings);
      return executionRunner.runInSession(
        runId,
        { ...request, signal },
        { ...definition, ...(request.executionBudget ? { executionBudget: request.executionBudget } : {}) },
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
  });

  return {
    toolPolicy,
    toolFactory,
    nestedRunner,
    executionRunner,
    mentorRunner,
    asyncRegistry,
  };
}
