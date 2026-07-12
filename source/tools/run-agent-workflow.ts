import { z } from 'zod';
import type { AgentRuntime } from '../services/agent-runtime/agent-runtime.js';
import { WorkflowEvaluatorImpl } from '../services/agent-runtime/workflow/workflow-evaluator.js';
import type { WorkflowLimits } from '../services/agent-runtime/workflow/workflow-types.js';
import type { ToolDefinition } from './types.js';
import { createBaseMessage, getCallIdFromItem, normalizeToolArguments } from './format-helpers.js';

const schema = z.object({ code: z.string().describe('JavaScript workflow source. Use return and top-level await.') });
const description = `Run a bounded JavaScript workflow in an isolated disposable sandbox. The workflow receives agent(config), whose handle has run({ task, context? }). Use await sequentially or Promise.all() concurrently. Return only JSON-safe data. Workflow agents may request only read-only tools already available to you.`;

export function createRunAgentWorkflowToolDefinition(deps: {
  runtime: Pick<AgentRuntime, 'agent'>;
  parentTools: readonly string[];
  limits?: Partial<WorkflowLimits>;
}): ToolDefinition<z.infer<typeof schema>> {
  return {
    name: 'run_agent_workflow',
    description,
    parameters: schema,
    needsApproval: () => false,
    execute: async ({ code }, context) => {
      const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
      return JSON.stringify(await new WorkflowEvaluatorImpl({ ...deps }).evaluate({ code, signal }));
    },
    formatCommandMessage: (item, index, argumentsById) => {
      const callId = getCallIdFromItem(item);
      const args =
        normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ??
        (callId ? normalizeToolArguments(argumentsById.get(callId)) : {}) ??
        {};
      return [
        createBaseMessage(item, index, 0, false, {
          command: 'run_agent_workflow',
          output: typeof item?.output === 'string' ? item.output : 'Workflow completed',
          toolName: 'run_agent_workflow',
          toolArgs: args,
        }),
      ];
    },
  };
}
