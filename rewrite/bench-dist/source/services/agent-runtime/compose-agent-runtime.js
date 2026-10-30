import { createLegacyNestedRunDriver } from './legacy-nested-driver.js';
import { AgentRuntime } from './agent-runtime.js';
import { SubagentToolPolicy, SubagentToolFactory } from '../subagents/tool-policy.js';
import { ExecutionSubagentRunner } from '../subagents/execution-runner.js';
import { MentorRunner } from '../subagents/mentor-runner.js';
import { createExecutor } from './executor.js';
import { adaptLegacyRole, adaptLegacyDefinition } from './legacy-adapter.js';
import { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
/**
 * Create an AgentRuntime backed by an existing SubagentRuntime's
 * execution and mentor runners. This avoids creating duplicate
 * independent tool policies when a SubagentManager (which owns a
 * SubagentRuntime) is already composed.
 */
export function createAgentRuntimeFromSubagentRuntime(deps) {
    const executor = createExecutor((agentId, request, definition) => deps.executionRunner.run(agentId, request, definition), deps.logger, (agentId, task, signal) => deps.mentorRunner.run(agentId, task, signal), deps.onEvent);
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
export function createAgentRuntime(deps) {
    const driverFactory = deps.driverFactory ?? createLegacyNestedRunDriver;
    const nestedCompatibility = new NestedToolCompatibilityState(deps.settings);
    const toolPolicy = new SubagentToolPolicy({
        settings: deps.settings,
        logger: deps.logger,
        sessionContextService: deps.sessionContextService,
        executionContext: deps.executionContext,
        agentClient: deps.agentClient,
    });
    const toolFactory = new SubagentToolFactory({
        driverFactory,
        modelBinding: deps.modelBinding,
        settings: deps.settings,
        logger: deps.logger,
        executionContext: deps.executionContext,
        toolPolicy,
        nestedCompatibility,
    });
    const executionRunner = new ExecutionSubagentRunner({
        logger: deps.logger,
        settings: deps.settings,
        sessionContextService: deps.sessionContextService,
        executionContext: deps.executionContext,
        createClient: deps.createClient,
        toolFactory,
        onEvent: deps.onEvent,
        toolOwnership: deps.toolOwnership,
    });
    const mentorRunner = new MentorRunner({
        driverFactory,
        modelBinding: deps.modelBinding,
        logger: deps.logger,
        settings: deps.settings,
        sessionContextService: deps.sessionContextService,
        executionContext: deps.executionContext,
        onEvent: deps.onEvent,
    });
    // Shared role definition adapter: legacy role to ResolvedAgentDefinition to SubagentDefinition
    const resolveRoleDefinition = (role) => {
        const resolved = adaptLegacyRole(role, deps.settings);
        return adaptLegacyDefinition(resolved);
    };
    // Wire executor to ExecutionSubagentRunner.run() for one-shot agents
    // and MentorRunner.run() for mentor trusted roles.
    const executor = createExecutor((agentId, request, definition) => executionRunner.run(agentId, request, definition), deps.logger, (agentId, task, signal) => mentorRunner.run(agentId, task, signal), deps.onEvent);
    const runtime = new AgentRuntime({
        settings: deps.settings,
        logger: deps.logger,
        skillsService: deps.skillsService,
        executor,
        parent: deps.parent,
    });
    return { runtime, executionRunner, mentorRunner, resolveRoleDefinition };
}
//# sourceMappingURL=compose-agent-runtime.js.map