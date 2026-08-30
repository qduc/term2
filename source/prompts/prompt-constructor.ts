import type { ExecutionContext } from '../services/execution-context.js';
import { selectPromptProfile } from './prompt-profiles.js';
import { getSearchViaShellAddendum } from './search-via-shell.js';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';
import { getShellSandboxAddendum } from './shell-sandbox.js';
import { getBackgroundShellAddendum } from './background-shell.js';

export type PromptConstructorOptions = {
  model: string;
  liteMode: boolean;
  /** Runtime-only mode flags; mode-specific workflows are sent as notices. */
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

  // Runtime modes are intentionally absent from profile selection. Their full
  // workflows ride on the next user turn so rebuilding the agent does not
  // invalidate the provider's instruction prefix.
  const profile = selectPromptProfile({ model, liteMode });
  const fragmentFiles = [...(profile.fragmentFiles ?? [])];
  const inlineSections: string[] = [];

  const isRegularMode = !liteMode;
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

  if (isRegularMode && searchViaShell) {
    inlineSections.push(getSearchViaShellAddendum({ executionContext }));
  }

  if (runSubagentEnabled && !liteMode) {
    inlineSections.push(
      getSubagentDelegationAddendum({
        memoryEnabled,
        orchestratorMode: false,
        foregroundEnabled: runSubagentForegroundEnabled,
        backgroundEnabled: runSubagentAsyncEnabled,
        controlsEnabled: asyncSubagentControlsEnabled,
      }),
    );
  }

  if (isRegularMode) {
    // Keep all mode stubs in every non-lite prompt. The full workflows ride on
    // mode notices so a toggle cannot change the instruction prefix (prompt
    // cache + chained Responses-Lite HTTP omit developer instructions).
    fragmentFiles.push('plan-mode-stub.md');
    fragmentFiles.push('mentor-mode-stub.md');
    fragmentFiles.push('orchestrator-mode-stub.md');
  }

  if (memoryEnabled && isRegularMode) {
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
