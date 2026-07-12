import { z } from 'zod';
import type { AgentRuntime } from '../services/agent-runtime/agent-runtime.js';
import { WorkflowEvaluatorImpl } from '../services/agent-runtime/workflow/workflow-evaluator.js';
import type { WorkflowLimits } from '../services/agent-runtime/workflow/workflow-types.js';
import type { ToolDefinition } from './types.js';
import { createBaseMessage, getCallIdFromItem, normalizeToolArguments } from './format-helpers.js';

const schema = z.object({
  code: z
    .string()
    .describe(
      'Self-contained modern JavaScript workflow body (not TypeScript): use agent(...), top-level await, and return a JSON-safe value.',
    ),
});
const description = `Run bounded, disposable JavaScript orchestration in an isolated sandbox. The only application API is agent(config): config accepts name?, required instructions, model? ('lower', 'default', or 'higher'), and tools?; it returns a handle with run({ task, context?, output? }). context must be a JSON-safe object. output is the native structured-output request { schema, name? } and is passed to AgentHandle unchanged, so native invalid_schema and invalid_output errors are returned as child results. Child results are { ok: true, output, usage? } or { ok: false, error: { code, message }, usage? }; use await sequentially or Promise.all() for concurrent runs. Return only JSON-safe data.

Children inherit only parent capabilities: workspace read interfaces are interchangeable; any parent editor capability admits apply_patch, search_replace, and create_file; web_search and web_fetch require the exact matching parent capability. Existing filesystem/network scope policy remains enforced. Interactive approvals (including ask_user), nested agents, unsandboxed operations, unsafe shell commands, out-of-scope writes, and locked writes are not available: operations are rejected rather than suspending/resuming a workflow. Limits cover total timeout/cancellation, run count, concurrency, source bytes, returned-output bytes, and cumulative console bytes. The result includes admission-ordered run summaries with stable runId, requested name, and resolved name/provider/model when available, plus duration, usage, and error metadata.`;

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
