import { selectPromptProfile } from './prompt-profiles.js';
import { getSearchViaShellAddendum } from './search-via-shell.js';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';
import { getShellSandboxAddendum } from './shell-sandbox.js';
import { getBackgroundShellAddendum } from './background-shell.js';
import { getDirectEditorToolsAddendum, getScriptPrimaryToolsAddendum } from './tool-surface-guidance.js';
/** Bare owns its whole prompt: no model-family base, fragments, or inline sections. */
export function isBareProfile(profile) {
    return profile.identity.id === 'builtin:bare';
}
export function buildPromptSpec(options) {
    const { model, profile, searchViaShell = false, runSubagentEnabled = false, runSubagentForegroundEnabled = false, runSubagentAsyncEnabled = false, asyncSubagentControlsEnabled = false, backgroundShellEnabled = false, sandboxEnabled = true, memoryEnabled = false, memoryGuidance = '', memoryContext = '', sessionBrowserEnabled = false, executionContext, runCodeEnabled = false, editorSurface = 'none', } = options;
    if (isBareProfile(profile)) {
        return {
            basePromptContent: profile.instructions.identity.kind === 'markdown' ? profile.instructions.identity.content : '',
            fragmentFiles: [],
            inlineSections: [],
        };
    }
    // Runtime modes are intentionally absent from model-family profile selection.
    // Their full workflows ride on the next user turn so rebuilding the agent does
    // not invalidate the provider's instruction prefix.
    const promptProfile = selectPromptProfile({ model });
    const fragmentFiles = [...(promptProfile.fragmentFiles ?? [])];
    const inlineSections = [];
    // Every model-family prompt states how the approval layer works. Without it a
    // model has no mechanism for "requires confirmation" other than stopping the
    // turn to ask, which it then does even under auto-approval.
    fragmentFiles.push('approval-model.md');
    // Orchestrators can directly modify the worktree, so every model-family
    // prompt receives the shared dirty-state and validation safeguards.
    fragmentFiles.push('worktree-hygiene.md');
    if (sandboxEnabled) {
        inlineSections.push(getShellSandboxAddendum());
    }
    if (backgroundShellEnabled) {
        inlineSections.push(getBackgroundShellAddendum());
    }
    if (searchViaShell) {
        inlineSections.push(getSearchViaShellAddendum({ executionContext }));
    }
    if (runSubagentEnabled) {
        inlineSections.push(getSubagentDelegationAddendum({
            memoryEnabled,
            sessionsEnabled: sessionBrowserEnabled,
            orchestratorMode: false,
            foregroundEnabled: runSubagentForegroundEnabled,
            backgroundEnabled: runSubagentAsyncEnabled,
            controlsEnabled: asyncSubagentControlsEnabled,
        }));
    }
    // Keep all mode stubs in every model-family prompt. The full workflows ride on
    // mode notices so a toggle cannot change the instruction prefix (prompt
    // cache + chained Responses-Lite HTTP omit developer instructions).
    fragmentFiles.push('plan-mode-stub.md');
    fragmentFiles.push('pair-mode-stub.md');
    fragmentFiles.push('mentor-mode-stub.md');
    fragmentFiles.push('orchestrator-mode-stub.md');
    if (sessionBrowserEnabled) {
        fragmentFiles.push('session-browser.md');
    }
    if (memoryGuidance) {
        inlineSections.push(memoryGuidance);
    }
    if (memoryContext && memoryEnabled)
        inlineSections.push(memoryContext);
    inlineSections.push(runCodeEnabled ? getScriptPrimaryToolsAddendum(editorSurface) : getDirectEditorToolsAddendum());
    return {
        basePromptFile: promptProfile.basePromptFile,
        fragmentFiles,
        inlineSections,
    };
}
//# sourceMappingURL=prompt-constructor.js.map