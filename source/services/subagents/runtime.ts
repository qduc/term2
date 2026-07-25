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

export interface SubagentRuntimeDeps {
  logger: ILoggingService;
  settings: ISettingsService;
  sessionContextService: ISessionContextService;
  executionContext?: ExecutionContext;
  onEvent?: (event: ConversationEvent) => void;
  agentClient?: ISubagentClient;
  createClient?: ISubagentClientFactory['createClient'];
  skillsService?: SkillsService;
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
  });

  const roleToolCache = new Map<SupportedSubagentRole, CachedRoleTool>();

  const nestedRunner = new NestedSubagentRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    toolFactory,
    onEvent: deps.onEvent,
    roleToolCache,
    skillsService: deps.skillsService,
  });

  const executionRunner = new ExecutionSubagentRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    createClient: deps.createClient,
    toolFactory,
    onEvent: deps.onEvent,
    skillsService: deps.skillsService,
  });

  const mentorSession = new SubagentSession('mentor', 'mentor');
  const mentorRunner = new MentorRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    onEvent: deps.onEvent,
    session: mentorSession,
  });

  const asyncRegistry = new SubagentAsyncRegistry({
    logger: deps.logger,
    run: async ({ request, runId, session, signal }) => {
      if (request.role === 'mentor') {
        return mentorRunner.runInSession(runId, request.task, signal, session);
      }
      const definition = loadRoleDefinition(request.role, deps.settings);
      return executionRunner.runInSession(runId, { ...request, signal }, definition, session);
    },
    onEvent: deps.onEvent,
    ttlMs: deps.settings.get<number>('subagent.asyncSessionTtlMs') ?? 30 * 60 * 1000,
    messageCap: deps.settings.get<number>('subagent.asyncMessageCap') ?? 50,
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
