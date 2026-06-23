import { shouldPreferPatchEditingModel } from '../lib/tool-selection-policy.js';
import type { ExecutionContext } from '../services/execution-context.js';
// import { getReasoningEfficiencyAddendum } from './reasoning-efficiency.js';
import { getSearchViaShellAddendum } from './search-via-shell.js';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';
import { selectPromptProfile } from './prompt-profiles.js';
import { ASK_USER_DECLINE_RESULT } from '../tools/agent/ask-user-constants.js';

export type PromptConstructorOptions = {
  model: string;
  liteMode: boolean;
  orchestratorMode?: boolean;
  mentorMode?: boolean;
  planMode?: boolean;
  searchViaShell?: boolean;
  codeContextEnabled?: boolean;
  runSubagentEnabled?: boolean;
  executionContext?: ExecutionContext;
};

export type PromptSpec = {
  basePromptFile: string;
  fragmentFiles: string[];
  inlineSections: string[];
};

// const GPT_OVER_THINKING_MODEL_KEYS = ['kimi', 'deepseek', 'glm', 'qwen', 'minimax', 'mimo'];

export function buildPromptSpec(options: PromptConstructorOptions): PromptSpec {
  const {
    model,
    liteMode,
    orchestratorMode,
    mentorMode,
    searchViaShell,
    codeContextEnabled,
    runSubagentEnabled,
    executionContext,
  } = options;
  // const normalizedModel = model.trim().toLowerCase();
  const profile = selectPromptProfile({ model, liteMode, orchestratorMode });
  const fragmentFiles = [...(profile.fragmentFiles ?? [])];
  const inlineSections: string[] = [];

  if (!liteMode) {
    fragmentFiles.push('worktree-hygiene.md');
  }

  if (mentorMode && !liteMode) {
    fragmentFiles.push('mentor-addon.md');
  }

  if (!orchestratorMode && codeContextEnabled) {
    inlineSections.push(getCodeContextSection({ liteMode }));
  }

  if (!orchestratorMode && searchViaShell) {
    inlineSections.push(getSearchViaShellAddendum({ executionContext }));
  } else if (!orchestratorMode && (liteMode || !shouldPreferPatchEditingModel(model))) {
    inlineSections.push(getDedicatedSearchToolsSection({ liteMode }));
  }

  if (orchestratorMode && runSubagentEnabled) {
    inlineSections.push(getSubagentDelegationAddendum({ orchestratorMode }));
  }

  if (!liteMode && !orchestratorMode) {
    fragmentFiles.push('plan-mode-info.md');
  }

  // if (GPT_OVER_THINKING_MODEL_KEYS.some((key) => normalizedModel.includes(key))) {
  //   inlineSections.push(getReasoningEfficiencyAddendum());
  // }

  inlineSections.push(getAskUserAddendum());

  return {
    basePromptFile: profile.basePromptFile,
    fragmentFiles,
    inlineSections,
  };
}

function getCodeContextSection({ liteMode }: { liteMode: boolean }): string {
  return liteMode
    ? '### Code Context Tools\n\n- `read_code_outline`: inspect file structure.\n- `code_context_search`: find related files or symbol declarations. Use `read_file` before editing.'
    : '### Code Context Tools\n\n- Use `read_code_outline` for a compact file outline.\n- Use `code_context_search` for related files or symbol declarations.\n- Use `read_file` before editing.';
}

function getDedicatedSearchToolsSection({ liteMode }: { liteMode: boolean }): string {
  return liteMode
    ? '### Search Tools\n\n- `glob`: locate files by name or glob.\n- `grep`: search file contents.'
    : '### Search Tools\n\n- Prefer `glob` for locating files by name or glob.\n- Prefer `grep` for searching code content or symbols.';
}

function getAskUserAddendum(): string {
  return `### ask_user Tool Guidance

- Use the \`ask_user\` tool when the user's request is short, vague, or ambiguous, or when an architecture or product-behavior decision needs to be made.
- Provide concise options whenever possible; the first option should be the recommended (default) choice.
- If the tool result is \`${ASK_USER_DECLINE_RESULT}\`, proceed using the safest reasonable default and state the assumption in your final response.`;
}
