import { randomUUID } from 'node:crypto';
import type { ExecutorInput, ExecutorFn } from './agent-handle.js';
import type { RunResult, RunErrorCode, ArtifactReference } from './types.js';
import type { SubagentDefinition, SubagentResult, SubagentRequest } from '../subagents/types.js';
import type { ILoggingService } from '../service-interfaces.js';
import { adaptLegacyDefinition } from './legacy-adapter.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { isAbortLike, safeEmit } from '../subagents/utils.js';

/**
 * Signature for executing a subagent with a pre-built definition.
 * Matches the ExecutionSubagentRunner.run() shape.
 */
export type SubagentRunWithDefFn = (
  agentId: string,
  request: SubagentRequest,
  definition: SubagentDefinition,
) => Promise<SubagentResult>;

/**
 * Signature for running a mentor-style agent directly from a task string.
 * Matches MentorRunner.run() shape.
 */
export type MentorRunFn = (agentId: string, task: string, signal?: AbortSignal) => Promise<SubagentResult>;

/**
 * Compose a caller-provided AbortSignal with a timeout derived from the
 * resolved agent limits. Returns a signal that aborts on either the
 * caller signal, the timeout, or both.
 */
function composeTimeoutSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!timeoutMs && !callerSignal) return undefined;
  if (timeoutMs && !callerSignal) return AbortSignal.timeout(timeoutMs);
  if (!timeoutMs && callerSignal) return callerSignal;
  // Both present: compose via AbortSignal.any()
  return AbortSignal.any([callerSignal!, AbortSignal.timeout(timeoutMs!)]);
}

/**
 * Map a SubagentResult to the public RunResult shape.
 * Internal fields (finalText, filesChanged, toolsUsed, nestedRunResult) are
 * never exposed through the public API.
 */
function filesChangedToArtifacts(files: string[]): ArtifactReference[] | undefined {
  if (files.length === 0) return undefined;
  return files.map((p) => ({ path: p }));
}

/**
 * Map a SubagentResult to the public RunResult shape.
 * Internal fields (finalText, filesChanged, toolsUsed, nestedRunResult) are
 * never exposed through the public API.
 */
export function mapSubagentResultToRunResult<T = string>(result: SubagentResult): RunResult<T> {
  const base: RunResult<T> = {
    status: result.status,
    artifacts: filesChangedToArtifacts(result.filesChanged),
    usage: result.usage,
  };

  if (result.status === 'completed') {
    base.output = result.finalText as unknown as T;
  } else {
    base.error = {
      code: mapSubagentStatusToErrorCode(result.status),
      message: result.error ?? 'Unknown error',
    };
  }

  return base;
}

function mapSubagentStatusToErrorCode(status: SubagentResult['status']): RunErrorCode {
  switch (status) {
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
export function createExecutor(
  runWithDef: SubagentRunWithDefFn,
  logger: ILoggingService,
  mentorRun?: MentorRunFn,
  onEvent?: (event: ConversationEvent) => void,
): ExecutorFn {
  return async <T = string>(input: ExecutorInput): Promise<RunResult<T>> => {
    const { definition, instructions, input: runInput } = input;
    const agentId = `agent-runtime-${randomUUID()}`;

    // Build SubagentDefinition from resolved agent.
    // Public AgentHandle.run() is always a root execution; the root budget
    // tracks children, not itself.
    const legacyDef: SubagentDefinition = {
      ...adaptLegacyDefinition(definition, input.budget),
      // Override instructions with the fully-composed version that includes
      // skill instructions and serialized context.
      instructions,
      isRootExecution: true,
    };

    // Compose caller signal with timeout from resolved limits
    const effectiveSignal = composeTimeoutSignal(runInput.signal, definition.limits.timeoutMs);

    const request: SubagentRequest = {
      role: legacyDef.role,
      task: runInput.task,
      signal: effectiveSignal,
    };

    safeEmit(logger, onEvent, {
      type: 'subagent_started',
      agentId,
      role: request.role,
      task: request.task,
    });

    logger.debug('AgentRuntime executor starting', {
      agentName: definition.name,
      agentId,
      taskLength: runInput.task.length,
      timeoutMs: definition.limits.timeoutMs,
    });

    // Route mentor trusted roles to MentorRunner for persistent session
    // state that AgentRuntime does not model. All other roles (including
    // custom one-shot agent handles) use ExecutionSubagentRunner.
    const isMentor =
      definition.name.toLowerCase() === 'mentor' ||
      legacyDef.role.toLowerCase() === 'mentor' ||
      legacyDef.name.toLowerCase() === 'mentor';

    let subagentResult: SubagentResult;
    try {
      if (isMentor && mentorRun) {
        subagentResult = await mentorRun(agentId, runInput.task, effectiveSignal);
      } else {
        subagentResult = await runWithDef(agentId, request, legacyDef);
      }
    } catch (error) {
      safeEmit(logger, onEvent, {
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
      });
      throw error;
    }

    logger.debug('AgentRuntime executor completed', {
      agentName: definition.name,
      agentId,
      status: subagentResult.status,
    });

    safeEmit(logger, onEvent, { type: 'subagent_completed', result: subagentResult });

    return mapSubagentResultToRunResult<T>(subagentResult);
  };
}
