export const TOOL_NAME_APPLY_PATCH = 'apply_patch';
export const TOOL_NAME_SEARCH_REPLACE = 'search_replace';
export const TOOL_NAME_CREATE_FILE = 'create_file';
export const TOOL_NAME_READ_CODE_OUTLINE = 'read_code_outline';
export const TOOL_NAME_CODE_CONTEXT_SEARCH = 'code_context_search';
export const TOOL_NAME_ASK_USER = 'ask_user';
export const TOOL_NAME_PROPOSE_GOAL = 'propose_goal';
export const TOOL_NAME_GOAL_CHECK = 'goal_check';
export const TOOL_NAME_MEMORY_LIST = 'memory_list';
export const TOOL_NAME_MEMORY_GET = 'memory_get';
export const TOOL_NAME_MEMORY_SEARCH = 'memory_search';
export const TOOL_NAME_MEMORY_CREATE = 'memory_create';
export const TOOL_NAME_MEMORY_UPDATE = 'memory_update';
export const TOOL_NAME_MEMORY_DELETE = 'memory_delete';

/**
 * Tool names policy withholds from `run_code` scripts.
 *
 * The union is the compile-time half of the withholding decision; the runtime
 * half is `RUN_CODE_PROHIBITED_TOOLS` in
 * `tools/system/run-code/run-code-runtime.ts`, which is built from this list
 * and fails to compile if it gains a name the union does not have. Registry
 * types reference the union so a tool definition cannot claim to be withheld
 * under a name that is not actually withheld.
 */
export type ProhibitedToolName =
  | 'ask_user'
  | 'run_subagent'
  | 'run_agent_workflow'
  | 'run_code'
  | 'ask_mentor'
  | 'session_rollover'
  | 'goal_check'
  | 'bash'
  | 'enter_worktree'
  | 'exit_worktree';
