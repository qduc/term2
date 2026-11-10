import type { AnyToolDefinition } from '../../types.js';
import { TOOL_NAME_GOAL_CHECK, type ProhibitedToolName } from '../../tool-names.js';

export const TOOL_NAME_RUN_CODE = 'run_code';
export const TOOL_NAME_DESCRIBE = 'describe';
export const WORKFLOW_PROHIBITED_TOOL_NAMES = ['ask_user', 'run_subagent', 'run_agent_workflow'] as const;

/** Model-facing admission contract; enforced unchanged by the injected runtime. */
export const RUN_CODE_LIMITS = {
  maxCalls: 200,
  maxConcurrency: 8,
  maxAgentStarts: 16,
  maxAgentConcurrency: 4,
  maxAgentCalls: 200,
  maxResultChars: 100_000,
  maxMediaBytes: 8 * 1024 * 1024,
  maxMediaTotalBytes: 32 * 1024 * 1024,
  maxMediaAttachments: 32,
  maxCodeBytes: 65_536,
  maxOutputBytes: 262_144,
  maxConsoleBytes: 262_144,
} as const;

const PROHIBITED_TOOL_NAMES: readonly ProhibitedToolName[] = [
  ...WORKFLOW_PROHIBITED_TOOL_NAMES,
  TOOL_NAME_RUN_CODE,
  'ask_mentor',
  'session_rollover',
  TOOL_NAME_GOAL_CHECK,
  'bash',
  'enter_worktree',
  'exit_worktree',
];
export const RUN_CODE_PROHIBITED_TOOLS: ReadonlySet<string> = new Set(PROHIBITED_TOOL_NAMES);

const DIRECT_FILE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'create_file', 'search_replace', 'apply_patch']);

/** File tools and shell retain the same wrapped execution on either surface. */
export function isDirectlyCallable(tool: Pick<AnyToolDefinition, 'name'>): boolean {
  return tool.name === 'shell' || DIRECT_FILE_TOOLS.has(tool.name) || RUN_CODE_PROHIBITED_TOOLS.has(tool.name);
}
