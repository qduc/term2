import { evaluateShellAutoApprovalAdvisories, } from './shell-auto-approval-evaluator.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import { TOOL_NAME_ASK_USER, TOOL_NAME_PROPOSE_GOAL } from '../../tools/tool-names.js';
import { extractPatchPaths } from '../../tools/file/upstream-apply-patch.js';
const FILE_READ_AUTO_APPROVE_TOOLS = new Set([
    'read_file',
    'grep',
    'find_files',
    'glob',
    'read_code_outline',
    'code_context_search',
]);
const FILE_MUTATION_AUTO_APPROVE_TOOLS = new Set(['create_file', 'search_replace', 'apply_patch']);
export function isAutoApprovableTool(toolName) {
    if (!toolName)
        return false;
    return (toolName === 'shell' ||
        toolName === 'bash' ||
        FILE_READ_AUTO_APPROVE_TOOLS.has(toolName) ||
        FILE_MUTATION_AUTO_APPROVE_TOOLS.has(toolName));
}
export function extractToolTargetPaths(toolName, rawArgs) {
    if (typeof rawArgs === 'string') {
        try {
            rawArgs = JSON.parse(rawArgs);
        }
        catch {
            return [];
        }
    }
    if (!rawArgs || typeof rawArgs !== 'object')
        return [];
    const rec = rawArgs;
    if (toolName === 'apply_patch') {
        return extractPatchPaths(rec.patch);
    }
    if (typeof rec.path === 'string') {
        return [rec.path];
    }
    if (Array.isArray(rec.paths)) {
        return rec.paths.filter((p) => typeof p === 'string');
    }
    if (Array.isArray(rec.operations)) {
        return rec.operations.map((op) => op?.path).filter((p) => typeof p === 'string');
    }
    return [];
}
function formatToolOperationDescription(toolName, rawArgs) {
    if (typeof rawArgs === 'string') {
        try {
            rawArgs = JSON.parse(rawArgs);
        }
        catch {
            return toolName;
        }
    }
    const rec = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
    if (toolName === 'read_file') {
        const range = rec.start_line ? ` (lines ${rec.start_line}-${rec.end_line ?? ''})` : '';
        return `read file outside workspace${range}`;
    }
    if (toolName === 'grep' || toolName === 'find_files') {
        const pat = rec.pattern ? ` pattern "${rec.pattern}"` : '';
        return `search outside workspace${pat}`;
    }
    if (toolName === 'read_code_outline' || toolName === 'code_context_search') {
        return `code outline / search outside workspace`;
    }
    if (toolName === 'create_file') {
        return `create / overwrite file outside workspace`;
    }
    if (toolName === 'search_replace') {
        return `search and replace edit outside workspace`;
    }
    if (toolName === 'apply_patch') {
        return `apply patch outside workspace`;
    }
    return `${toolName} outside workspace`;
}
/**
 * YOLO suppresses approval prompts for every tool. `ask_user` is different:
 * it is the model's user-input interaction, not an authority decision.
 * `propose_goal` is also exempt: it mutates user-authored durable state and
 * only an explicit human approval may persist it (durable-goal plan, decision 6b).
 */
export function shouldBypassToolApproval(toolName, mode) {
    return mode === 'always' && toolName !== TOOL_NAME_ASK_USER && toolName !== TOOL_NAME_PROPOSE_GOAL;
}
const MAX_TRACKED_MANUAL_DECISIONS = 20;
const parseUnsandboxedFlag = (rawArguments) => {
    if (typeof rawArguments === 'string') {
        try {
            const parsed = JSON.parse(rawArguments);
            return parsed?.sandbox === 'unsandboxed';
        }
        catch {
            return false;
        }
    }
    if (!rawArguments || typeof rawArguments !== 'object')
        return false;
    return rawArguments.sandbox === 'unsandboxed';
};
export class ShellAutoApprovalResolver {
    deps;
    advisoriesByCallId = new Map();
    manualDecisions = [];
    constructor(deps) {
        this.deps = deps;
    }
    /** Records a human approve/reject decision on a shell command, offered as precedent for later evaluations. */
    recordManualDecision(command, decision) {
        this.manualDecisions.push({ command, decision });
        if (this.manualDecisions.length > MAX_TRACKED_MANUAL_DECISIONS) {
            this.manualDecisions.shift();
        }
    }
    getAutoApproveMode() {
        return this.deps.settingsService?.get('shell.autoApproveMode');
    }
    /**
     * Whether an unsandboxed shell request may be evaluated by the LLM
     * auto-approval path instead of being forced to a human prompt. Requires the
     * sandbox to be enabled (escape is meaningful) and auto-approval mode to be
     * advisory or auto. Read per call so mid-session setting toggles apply
     * immediately.
     */
    isUnsandboxedApprovalEligible() {
        const mode = this.getAutoApproveMode();
        const sandboxEnabled = this.deps.settingsService?.get('sandbox.enabled') !== false;
        // In 'always' mode every shell command runs unrestricted, so unsandboxed
        // escapes and Docker host control are not forced to a human prompt.
        if (mode === 'always')
            return true;
        return sandboxEnabled && (mode === 'advisory' || mode === 'auto');
    }
    shouldAutoApprove(advisory) {
        if (this.getAutoApproveMode() === 'always') {
            // YOLO: bypass the LLM gate entirely and approve every shell command.
            return true;
        }
        return (this.getAutoApproveMode() === 'auto' &&
            advisory?.approved === true &&
            advisory.source === 'llm' &&
            (advisory.riskLevel === 'low' || advisory.riskLevel === 'medium') &&
            (advisory.authorization === 'explicit' || advisory.authorization === 'implied') &&
            advisory.confidence === 'high');
    }
    async resolveAdvisoryForInterruption(input) {
        const { interruption, siblings } = input;
        const { toolName, argumentsText, rawArguments } = getToolInfoFromInterruption(interruption);
        if (!isAutoApprovableTool(toolName)) {
            return undefined;
        }
        const callId = getCallIdFromObject(interruption);
        const eligibleItems = [];
        for (const i of siblings) {
            const info = getToolInfoFromInterruption(i);
            const id = getCallIdFromObject(i);
            if (!id || !isAutoApprovableTool(info.toolName)) {
                continue;
            }
            if (info.toolName === 'shell' || info.toolName === 'bash') {
                eligibleItems.push({
                    id,
                    toolName: info.toolName,
                    command: info.argumentsText,
                    unsandboxed: parseUnsandboxedFlag(info.rawArguments),
                });
            }
            else {
                const targetPaths = extractToolTargetPaths(info.toolName, info.rawArguments);
                eligibleItems.push({
                    id,
                    toolName: info.toolName,
                    targetPath: targetPaths[0],
                    targetPaths,
                    description: formatToolOperationDescription(info.toolName, info.rawArguments),
                });
            }
        }
        const unevaluated = eligibleItems.filter((c) => !this.advisoriesByCallId.has(c.id));
        if (unevaluated.length > 0) {
            const results = await evaluateShellAutoApprovalAdvisories({
                commands: unevaluated,
                history: this.deps.record.getHistory(),
                manualDecisions: this.manualDecisions,
                settingsService: this.deps.settingsService,
                agentClient: this.deps.agentClient,
                logger: this.deps.logger,
                sessionContextService: this.deps.sessionContextService,
                sessionAccess: this.deps.sessionAccess,
            });
            for (const [id, advisory] of results) {
                this.advisoriesByCallId.set(id, advisory);
            }
        }
        if (callId) {
            return this.advisoriesByCallId.get(callId);
        }
        // No callId: evaluate this single item inline without caching.
        const isShell = toolName === 'shell' || toolName === 'bash';
        const singlePaths = isShell ? [] : extractToolTargetPaths(toolName, rawArguments);
        const single = await evaluateShellAutoApprovalAdvisories({
            commands: [
                {
                    id: '__single__',
                    toolName,
                    ...(isShell
                        ? {
                            command: argumentsText,
                            ...(parseUnsandboxedFlag(rawArguments) ? { unsandboxed: true } : {}),
                        }
                        : {
                            targetPath: singlePaths[0],
                            targetPaths: singlePaths,
                            description: formatToolOperationDescription(toolName, rawArguments),
                        }),
                },
            ],
            history: this.deps.record.getHistory(),
            manualDecisions: this.manualDecisions,
            settingsService: this.deps.settingsService,
            agentClient: this.deps.agentClient,
            logger: this.deps.logger,
            sessionContextService: this.deps.sessionContextService,
            sessionAccess: this.deps.sessionAccess,
        });
        return single.get('__single__');
    }
    clearCache() {
        this.advisoriesByCallId.clear();
    }
}
export class DelegatingShellAutoApprovalResolver extends ShellAutoApprovalResolver {
    delegate;
    constructor(deps) {
        super(deps);
    }
    setDelegate(delegate) {
        this.delegate = delegate;
    }
    getAutoApproveMode() {
        return this.delegate ? this.delegate.getAutoApproveMode?.() : super.getAutoApproveMode();
    }
    isUnsandboxedApprovalEligible() {
        return this.delegate ? this.delegate.isUnsandboxedApprovalEligible() : super.isUnsandboxedApprovalEligible();
    }
    shouldAutoApprove(advisory) {
        return this.delegate ? this.delegate.shouldAutoApprove(advisory) : super.shouldAutoApprove(advisory);
    }
    async resolveAdvisoryForInterruption(input) {
        return this.delegate
            ? this.delegate.resolveAdvisoryForInterruption(input)
            : super.resolveAdvisoryForInterruption(input);
    }
    recordManualDecision(command, decision) {
        if (this.delegate) {
            this.delegate.recordManualDecision(command, decision);
        }
        else {
            super.recordManualDecision(command, decision);
        }
    }
    clearCache() {
        if (this.delegate) {
            this.delegate.clearCache();
        }
        else {
            super.clearCache();
        }
    }
}
//# sourceMappingURL=shell-auto-approval-resolver.js.map