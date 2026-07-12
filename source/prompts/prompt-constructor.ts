import type { ExecutionContext } from '../services/execution-context.js';
import { selectPromptProfile } from './prompt-profiles.js';
import { getSearchViaShellAddendum } from './search-via-shell.js';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';
import { getShellSandboxAddendum } from './shell-sandbox.js';

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
  memoryEnabled?: boolean;
  memoryGuidance?: string;
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
    runSubagentEnabled = false,
    sandboxEnabled = true,
    memoryEnabled = false,
    memoryGuidance = '',
    executionContext,
  } = options;

  const profile = selectPromptProfile({ model, liteMode, orchestratorMode });
  const fragmentFiles = [...(profile.fragmentFiles ?? [])];
  const inlineSections: string[] = [];

  const isRegularMode = !liteMode;
  const isAgentMode = !orchestratorMode;
  // Orchestrators can directly modify the worktree, so every non-lite prompt
  // receives the shared dirty-state and validation safeguards.
  const shouldIncludeWorktreeHygiene = !liteMode;

  if (shouldIncludeWorktreeHygiene) {
    fragmentFiles.push('worktree-hygiene.md');
  }

  if (sandboxEnabled) {
    inlineSections.push(getShellSandboxAddendum());
  }

  if (mentorMode && isRegularMode) {
    fragmentFiles.push('mentor-addon.md');
  }

  if (isAgentMode && searchViaShell) {
    inlineSections.push(getSearchViaShellAddendum({ executionContext }));
  }

  if (orchestratorMode && runSubagentEnabled) {
    inlineSections.push(getSubagentDelegationAddendum({ orchestratorMode }));
  }

  if (isRegularMode && isAgentMode) {
    fragmentFiles.push('plan-mode-info.md');
  }

  if (memoryEnabled && isAgentMode) {
    fragmentFiles.push('memory.md');
  }

  if (memoryGuidance) {
    inlineSections.push(memoryGuidance);
  }

  return {
    basePromptFile: profile.basePromptFile,
    fragmentFiles,
    inlineSections,
  };
}
