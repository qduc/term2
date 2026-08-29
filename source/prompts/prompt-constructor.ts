import type { ExecutionContext } from '../services/execution-context.js';
import { selectPromptProfile } from './prompt-profiles.js';
import { getSearchViaShellAddendum } from './search-via-shell.js';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';
import { getShellSandboxAddendum } from './shell-sandbox.js';
import { getBackgroundShellAddendum } from './background-shell.js';

export type PromptConstructorOptions = {
  model: string;
  liteMode: boolean;
  orchestratorMode?: boolean;
  mentorMode?: boolean;
  planMode?: boolean;
  searchViaShell?: boolean;
  codeContextEnabled?: boolean;
  runSubagentEnabled?: boolean;
  runSubagentForegroundEnabled?: boolean;
  runSubagentAsyncEnabled?: boolean;
  asyncSubagentControlsEnabled?: boolean;
  backgroundShellEnabled?: boolean;
  sandboxEnabled?: boolean;
  memoryEnabled?: boolean;
  memoryGuidance?: string;
  sessionBrowserEnabled?: boolean;
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
    runSubagentForegroundEnabled = false,
    runSubagentAsyncEnabled = false,
    asyncSubagentControlsEnabled = false,
    backgroundShellEnabled = false,
    sandboxEnabled = true,
    memoryEnabled = false,
    memoryGuidance = '',
    sessionBrowserEnabled = false,
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

  // Every non-lite prompt states how the approval layer works. Without it a
  // model has no mechanism for "requires confirmation" other than stopping the
  // turn to ask, which it then does even under auto-approval.
  if (!liteMode) {
    fragmentFiles.push('approval-model.md');
  }

  if (shouldIncludeWorktreeHygiene) {
    fragmentFiles.push('worktree-hygiene.md');
  }

  if (sandboxEnabled) {
    inlineSections.push(getShellSandboxAddendum());
  }

  if (backgroundShellEnabled) {
    inlineSections.push(getBackgroundShellAddendum());
  }

  if (mentorMode && isRegularMode) {
    fragmentFiles.push('mentor-addon.md');
  }

  if (isAgentMode && searchViaShell) {
    inlineSections.push(getSearchViaShellAddendum({ executionContext }));
  }

  if (runSubagentEnabled && !liteMode) {
    inlineSections.push(
      getSubagentDelegationAddendum({
        memoryEnabled,
        orchestratorMode,
        foregroundEnabled: runSubagentForegroundEnabled,
        backgroundEnabled: runSubagentAsyncEnabled,
        controlsEnabled: asyncSubagentControlsEnabled,
      }),
    );
  }

  if (isRegularMode && isAgentMode) {
    // Always the stub. The workflow body rides on PLAN_MODE_ENTER_NOTICE so a
    // toggle cannot change the instruction prefix (prompt cache + chained
    // Responses-Lite HTTP omit developer instructions).
    fragmentFiles.push('plan-mode-stub.md');
  }

  if (memoryEnabled && isAgentMode) {
    fragmentFiles.push('memory.md');
  }

  if (sessionBrowserEnabled) {
    fragmentFiles.push('session-browser.md');
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
