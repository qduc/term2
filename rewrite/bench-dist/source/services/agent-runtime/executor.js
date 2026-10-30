import { randomUUID } from 'node:crypto';
import { adaptLegacyDefinition } from './legacy-adapter.js';
import { isAbortLike, safeEmit } from '../subagents/utils.js';
/**
 * Compose a caller-provided AbortSignal with a timeout derived from the
 * resolved agent limits. Returns a signal that aborts on either the
 * caller signal, the timeout, or both.
 */
function composeTimeoutSignal(callerSignal, timeoutMs) {
    if (!timeoutMs && !callerSignal)
        return undefined;
    if (timeoutMs && !callerSignal)
        return AbortSignal.timeout(timeoutMs);
    if (!timeoutMs && callerSignal)
        return callerSignal;
    // Both present: compose via AbortSignal.any()
    return AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
}
/**
 * Map a SubagentResult to the public RunResult shape.
 * Internal fields (finalText, filesChanged, toolsUsed, nestedRunResult) are
 * never exposed through the public API.
 */
function filesChangedToArtifacts(files) {
    if (files.length === 0)
        return undefined;
    return files.map((p) => ({ path: p }));
}
/**
 * Map a SubagentResult to the public RunResult shape.
 * Internal fields (finalText, filesChanged, toolsUsed, nestedRunResult) are
 * never exposed through the public API.
 */
export function mapSubagentResultToRunResult(result) {
    const base = {
        status: result.status,
        artifacts: filesChangedToArtifacts(result.filesChanged),
        usage: result.usage,
    };
    if (result.status === 'completed') {
        base.output = result.finalText;
    }
    else {
        base.error = {
            code: mapSubagentStatusToErrorCode(result.status),
            message: result.error ?? 'Unknown error',
        };
    }
    return base;
}
function mapSubagentStatusToErrorCode(status) {
    switch (status) {
        case 'interrupted':
            return 'budget_exhausted';
        case 'cancelled':
            return 'cancelled';
        case 'failed':
            return 'agent_error';
        default:
            return 'agent_error';
    }
}
/**
 * Create a production executor that routes resolved agent definitions
 * through the existing ExecutionSubagentRunner (or MentorRunner for
 * mentor trusted roles) infrastructure.
 *
 * The executor:
 * 1. Converts ResolvedAgentDefinition → legacy SubagentDefinition via adaptLegacyDefinition
 * 2. Routes mentor roles to mentorRun, all others to runWithDef (ExecutionSubagentRunner.run)
 * 3. Composes caller signal with timeout from resolved limits
 * 4. Maps the SubagentResult → public RunResult, stripping internal fields
 */
export function createExecutor(runWithDef, logger, mentorRun, onEvent) {
    return async (input) => {
        const { definition, instructions, input: runInput } = input;
        const agentId = `agent-runtime-${randomUUID()}`;
        // Build SubagentDefinition from resolved agent.
        // Public AgentHandle.run() is always a root execution; the root budget
        // tracks children, not itself.
        const legacyDef = {
            ...adaptLegacyDefinition(definition, input.budget),
            // Override instructions with the fully-composed version that includes
            // skill instructions and serialized context.
            instructions,
            isRootExecution: true,
        };
        // Compose caller signal with timeout from resolved limits
        const effectiveSignal = composeTimeoutSignal(runInput.signal, definition.limits.timeoutMs);
        const request = {
            role: legacyDef.role,
            task: runInput.task,
            signal: effectiveSignal,
        };
        await safeEmit(logger, onEvent, {
            type: 'subagent_started',
            agentId,
            role: request.role,
            task: request.task,
        }, { propagate: true });
        logger.debug('AgentRuntime executor starting', {
            agentName: definition.name,
            agentId,
            taskLength: runInput.task.length,
            timeoutMs: definition.limits.timeoutMs,
        });
        // Route mentor trusted roles to MentorRunner for persistent session
        // state that AgentRuntime does not model. All other roles (including
        // custom one-shot agent handles) use ExecutionSubagentRunner.
        const isMentor = definition.name.toLowerCase() === 'mentor' ||
            legacyDef.role.toLowerCase() === 'mentor' ||
            legacyDef.name.toLowerCase() === 'mentor';
        let subagentResult;
        try {
            if (isMentor && mentorRun) {
                subagentResult = await mentorRun(agentId, runInput.task, effectiveSignal);
            }
            else {
                subagentResult = await runWithDef(agentId, request, legacyDef);
            }
        }
        catch (error) {
            await safeEmit(logger, onEvent, {
                type: 'subagent_completed',
                result: {
                    agentId,
                    role: request.role,
                    status: isAbortLike(error instanceof Error ? error.message : String(error), error) ? 'cancelled' : 'failed',
                    finalText: '',
                    filesChanged: [],
                    toolsUsed: [],
                    error: error instanceof Error ? error.message : String(error),
                },
            }, { propagate: true });
            throw error;
        }
        logger.debug('AgentRuntime executor completed', {
            agentName: definition.name,
            agentId,
            status: subagentResult.status,
        });
        await safeEmit(logger, onEvent, { type: 'subagent_completed', result: subagentResult }, { propagate: true });
        return mapSubagentResultToRunResult(subagentResult);
    };
}
//# sourceMappingURL=executor.js.map