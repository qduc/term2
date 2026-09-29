import type { AgentConfig, AgentLimits, AgentSpec, AgentSpecToolName } from './types.js';

/** Workspace-readable tools used when a task-shaped invocation omits tools. */
export const DEFAULT_AGENT_SPEC_TOOLS = [
  'read_file',
  'grep',
  'glob',
  'read_code_outline',
  'code_context_search',
] as const;

/** Tools that the shared subagent capability factory can provision on demand. */
export const AGENT_SPEC_TOOL_NAMES = [
  ...DEFAULT_AGENT_SPEC_TOOLS,
  'web_search',
  'web_fetch',
  'shell',
  'apply_patch',
  'search_replace',
  'create_file',
] as const satisfies readonly AgentSpecToolName[];

/** Existing preset prompts use 200 as a generous max-turn tripwire. */
export const AGENT_SPEC_DEFAULT_MAX_TURNS = 200;

/**
 * Translate the task-shaped public spec into the shared AgentRuntime config.
 * Both AgentRuntime.runAgent and SubagentManager use this mapper so context,
 * constraints, completion guidance, defaults, and permissions cannot drift.
 */
export function agentSpecToConfig(spec: AgentSpec): AgentConfig {
  const selectedTools = spec.tools ?? DEFAULT_AGENT_SPEC_TOOLS;
  const sortedContext =
    spec.context === undefined
      ? undefined
      : JSON.stringify(Object.fromEntries(Object.entries(spec.context).sort(([a], [b]) => a.localeCompare(b))));
  const instructions = [
    ...(spec.constraints?.length
      ? [`Invocation constraints:\n${spec.constraints.map((item) => `- ${item}`).join('\n')}`]
      : []),
    ...(spec.doneWhen ? [`Completion criterion:\n${spec.doneWhen}`] : []),
    ...(sortedContext ? [`Invocation context (JSON):\n\`\`\`json\n${sortedContext}\n\`\`\``] : []),
  ].join('\n\n');
  const limits: AgentLimits = { maxTurns: spec.budget?.maxTurns ?? AGENT_SPEC_DEFAULT_MAX_TURNS };

  return {
    name: 'agent',
    instructions,
    tools: selectedTools,
    permissions: spec.permissions ?? { tools: [...selectedTools] },
    limits,
    ...(spec.budget?.maxTokens !== undefined ? { responseMaxTokens: spec.budget.maxTokens } : {}),
    ...(spec.model ? { model: spec.model } : {}),
  };
}
