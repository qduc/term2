/** Workspace-readable tools offered when a delegated invocation omits tools. */
export const DEFAULT_AGENT_SPEC_TOOLS = [
  'read_file',
  'grep',
  'glob',
  'read_code_outline',
  'code_context_search',
] as const;

/** The model-facing generic delegated-agent schema's provisionable tools. */
export const AGENT_SPEC_TOOL_NAMES = [
  ...DEFAULT_AGENT_SPEC_TOOLS,
  'web_search',
  'web_fetch',
  'shell',
  'apply_patch',
  'search_replace',
  'create_file',
] as const;
