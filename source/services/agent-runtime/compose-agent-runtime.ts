import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ExecutionContext } from '../execution-context.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ISubagentClientFactory, ISubagentClient } from '../subagents/subagent-client-types.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { AgentPermissions, AgentLimits, ModelPolicy } from './types.js';
import type { SupportedSubagentRole, SubagentDefinition } from '../subagents/types.js';
import { AgentRuntime } from './agent-runtime.js';
import { SubagentToolPolicy, SubagentToolFactory } from '../subagents/tool-policy.js';
import { ExecutionSubagentRunner } from '../subagents/execution-runner.js';
import { MentorRunner } from '../subagents/mentor-runner.js';
import { createExecutor } from './executor.js';
import { adaptLegacyRole, adaptLegacyDefinition } from './legacy-adapter.js';

/**
 * Dependencies for creating a production-ready AgentRuntime that wires
 * through the existing subagent / session / approval / retry infrastructure.
 */
export interface CreateAgentRuntimeDeps {
  settings: ISettingsService;
  logger: ILoggingService;
  sessionContextService: ISessionContextService;
  executionContext?: ExecutionContext;
  /** Agent client for shell auto-approval evaluation in SubagentToolPolicy. */
  agentClient?: ISubagentClient;
  /** Factory for creating transient AgentClient instances for subagent runs. */
  createClient: ISubagentClientFactory['createClient'];
  /** Skills service for skill instruction resolution. */
  skillsService?: SkillsService;
  /** Event sink for subagent lifecycle events. */
  onEvent?: (event: ConversationEvent) => void;
  /** Parent agent context for nested agent creation. */
  parent?: {
    permissions?: AgentPermissions;
    limits?: AgentLimits;
    modelPolicy?: ModelPolicy;
  };
}

/**
 * Create a fully-wired AgentRuntime backed by the production
 * ExecutionSubagentRunner infrastructure.
 *
 * Usage:
 *   const runtime = createAgentRuntime({
 *     settings, logger, sessionContextService, createClient,
 *   });
 *   const handle = runtime.agent({ instructions: "...", permissions: {...} });
 *   const result = await handle.run({ task: "..." });
 */
export interface AgentRuntimeComposition {
  runtime: AgentRuntime;
  executionRunner: ExecutionSubagentRunner;
  mentorRunner: MentorRunner;
  resolveRoleDefinition: (role: SupportedSubagentRole | string) => SubagentDefinition;
}

/**
 * Minimal deps needed to create an AgentRuntime from an existing
 * SubagentRuntime (avoids duplicating tool policies).
 */
export interface AgentRuntimeFromSubagentRuntimeDeps {
  settings: ISettingsService;
  logger: ILoggingService;
  skillsService?: SkillsService;
  executionRunner: ExecutionSubagentRunner;
  mentorRunner: MentorRunner;
  parent?: {
    permissions?: AgentPermissions;
    limits?: AgentLimits;
    modelPolicy?: ModelPolicy;
  };
}

/**
 * Create an AgentRuntime backed by an existing SubagentRuntime's
 * execution and mentor runners. This avoids creating duplicate
 * independent tool policies when a SubagentManager (which owns a
 * SubagentRuntime) is already composed.
 */
export function createAgentRuntimeFromSubagentRuntime(deps: AgentRuntimeFromSubagentRuntimeDeps): AgentRuntime {
  const executor = createExecutor(
    (agentId, request, definition) => deps.executionRunner.run(agentId, request, definition),
    deps.logger,
    (agentId, task, signal) => deps.mentorRunner.run(agentId, task, signal),
  );

  return new AgentRuntime({
    settings: deps.settings,
    logger: deps.logger,
    skillsService: deps.skillsService,
    executor,
    parent: deps.parent,
  });
}

/**
 * Create a fully-wired AgentRuntime backed by the production
 * ExecutionSubagentRunner and MentorRunner infrastructure.
 *
 * The returned composition provides:
 * - runtime.agent(config) for one-shot custom agent handles.
 * - executionRunner and mentorRunner for trusted preset/role execution
 *   used by compatibility code (SubagentManager).
 * - resolveRoleDefinition for the shared ResolvedAgentDefinition
 *   adaptation path consumed by NestedSubagentRunner.
 */
export function createAgentRuntime(deps: CreateAgentRuntimeDeps): AgentRuntimeComposition {
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
  });

  const executionRunner = new ExecutionSubagentRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    createClient: deps.createClient,
    toolFactory,
    onEvent: deps.onEvent,
  });

  const mentorRunner = new MentorRunner({
    logger: deps.logger,
    settings: deps.settings,
    sessionContextService: deps.sessionContextService,
    executionContext: deps.executionContext,
    onEvent: deps.onEvent,
  });

  // Shared role definition adapter: legacy role to ResolvedAgentDefinition to SubagentDefinition
  const resolveRoleDefinition = (role: SupportedSubagentRole | string): SubagentDefinition => {
    const resolved = adaptLegacyRole(role, deps.settings);
    return adaptLegacyDefinition(resolved);
  };

  // Wire executor to ExecutionSubagentRunner.run() for one-shot agents
  // and MentorRunner.run() for mentor trusted roles.
  const executor = createExecutor(
    (agentId, request, definition) => executionRunner.run(agentId, request, definition),
    deps.logger,
    (agentId, task, signal) => mentorRunner.run(agentId, task, signal),
  );

  const runtime = new AgentRuntime({
    settings: deps.settings,
    logger: deps.logger,
    skillsService: deps.skillsService,
    executor,
    parent: deps.parent,
  });

  return { runtime, executionRunner, mentorRunner, resolveRoleDefinition };
}
