import { shouldPreferPatchEditingModel } from '../lib/tool-selection-policy.js';
import type { ExecutionContext } from '../services/execution-context.js';
import { ASK_USER_DECLINE_RESULT } from '../tools/agent/ask-user-constants.js';
import { selectPromptProfile } from './prompt-profiles.js';
import { getSearchViaShellAddendum } from './search-via-shell.js';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';

export type PromptConstructorOptions = {
  model: string;
  liteMode: boolean;
  orchestratorMode?: boolean;
  mentorMode?: boolean;
  planMode?: boolean;
  searchViaShell?: boolean;
  codeContextEnabled?: boolean;
  runSubagentEnabled?: boolean;
  sandboxEnabled?: boolean;
  executionContext?: ExecutionContext;
};

export type PromptSpec = {
  basePromptFile: string;
  fragmentFiles: string[];
  inlineSections: string[];
};

export function buildPromptSpec(options: PromptConstructorOptions): PromptSpec {
  const {
    model,
    liteMode,
    orchestratorMode = false,
    mentorMode = false,
    searchViaShell = false,
    codeContextEnabled = false,
    runSubagentEnabled = false,
    sandboxEnabled = true,
    executionContext,
  } = options;

  const profile = selectPromptProfile({ model, liteMode, orchestratorMode });
  const fragmentFiles = [...(profile.fragmentFiles ?? [])];
  const inlineSections: string[] = [];

  const isRegularMode = !liteMode;
  const isAgentMode = !orchestratorMode;
  const shouldUseDedicatedSearchTools =
    isAgentMode && !searchViaShell && (liteMode || !shouldPreferPatchEditingModel(model));

  if (isRegularMode) {
    fragmentFiles.push('worktree-hygiene.md');
  }

  if (sandboxEnabled) {
    fragmentFiles.push('shell-sandbox.md');
  }

  if (mentorMode && isRegularMode) {
    fragmentFiles.push('mentor-addon.md');
  }

  if (isAgentMode && codeContextEnabled) {
    inlineSections.push(getCodeContextSection({ liteMode }));
  }

  if (isAgentMode && searchViaShell) {
    inlineSections.push(getSearchViaShellAddendum({ executionContext }));
  }

  if (shouldUseDedicatedSearchTools) {
    inlineSections.push(getDedicatedSearchToolsSection({ liteMode }));
  }

  if (orchestratorMode && runSubagentEnabled) {
    inlineSections.push(getSubagentDelegationAddendum({ orchestratorMode }));
  }

  if (isRegularMode && isAgentMode) {
    fragmentFiles.push('plan-mode-info.md');
  }

  inlineSections.push(getAskUserAddendum());

  return {
    basePromptFile: profile.basePromptFile,
    fragmentFiles,
    inlineSections,
  };
}

function getCodeContextSection({ liteMode }: { liteMode: boolean }): string {
  if (liteMode) {
    return [
      '### Code Context Tools',
      '',
      '- `read_code_outline`: inspect file structure.',
      '- `code_context_search`: find related files or symbol declarations. Use `read_file` before editing.',
    ].join('\n');
  }

  return [
    '### Code Context Tools',
    '',
    '- Use `read_code_outline` for a compact file outline.',
    '- Use `code_context_search` for related files or symbol declarations.',
    '- Use `read_file` before editing.',
  ].join('\n');
}

function getDedicatedSearchToolsSection({ liteMode }: { liteMode: boolean }): string {
  if (liteMode) {
    return ['### Search Tools', '', '- `glob`: locate files by name or glob.', '- `grep`: search file contents.'].join(
      '\n',
    );
  }

  return [
    '### Search Tools',
    '',
    '- Prefer `glob` for locating files by name or glob.',
    '- Prefer `grep` for searching code content or symbols.',
  ].join('\n');
}

function getAskUserAddendum(): string {
  return [
    '### ask_user Tool Guidance',
    '',
    "- Use the `ask_user` tool when the user's request is short, vague, or ambiguous, or when an architecture or product-behavior decision needs to be made.",
    '- Provide concise options whenever possible; the first option should be the recommended (default) choice.',
    `- If the tool result is \`${ASK_USER_DECLINE_RESULT}\`, proceed using the safest reasonable default and state the assumption in your final response.`,
  ].join('\n');
}
