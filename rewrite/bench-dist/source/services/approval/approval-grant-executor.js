import path from 'node:path';
import { getProjectAllowReadStore } from '../../utils/shell/sandbox/denied-read-stores.js';
import { isDeniedReadApproveAnswer, isDockerHostControlApproveAnswer, isReadFileSessionApproveAnswer, supportsFolderSessionRead, } from '../../contracts/conversation.js';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import { isDockerHostControlShellApproval } from './shell-sandbox-approval.js';
import { resolveSessionReadFolder } from './session-read-grant-target.js';
import { getToolInfoFromInterruption } from '../interruption-info.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { extractToolTargetPaths } from './shell-auto-approval-resolver.js';
import { resolveOutsideWorkspaceEdit } from './approval-descriptor.js';
/** Validate a disclosed grant against trusted source arguments without applying it. */
export function validateApprovalGrant(deps, input, approval) {
    const answer = input.answer;
    const parsed = parseToolCallArguments(input.rawArguments, {
        callId: input.callId ?? 'control',
        toolName: input.toolName ?? 'unknown',
        sessionId: deps.sessionId,
        traceId: deps.logger?.getCorrelationId() ?? 'trace-unknown',
    }).arguments;
    const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    if (answer === 'allow-folder-session') {
        if (!supportsFolderSessionRead(input.toolName) || !resolveSessionReadFolder(input.toolName, args))
            throw new Error('Invalid read grant target');
    }
    else if (answer === 'allow-edit-file-session' || answer === 'allow-edit-folder-session') {
        const target = resolveOutsideWorkspaceEdit(input.toolName, args);
        if (!target ||
            !approval.outsideWorkspaceEdit ||
            target.path !== approval.outsideWorkspaceEdit.path ||
            target.folder !== approval.outsideWorkspaceEdit.folder)
            throw new Error('Invalid edit grant target');
    }
    else if (isDockerHostControlApproveAnswer(answer)) {
        if (!approval.dockerHostControl ||
            typeof args?.command !== 'string' ||
            !isDockerHostControlShellApproval(input.toolName, args, deps.sessionId, deps.sessionAccess, deps.nestedCompatibility))
            throw new Error('Invalid Docker grant target');
    }
    else if (isDeniedReadApproveAnswer(answer)) {
        if (!approval.deniedRead ||
            !input.interruption ||
            input.toolName !== 'shell' ||
            typeof args?.command !== 'string' ||
            (answer === 'allow-remember' && approval.deniedRead.sensitive))
            throw new Error('Invalid denied-read grant');
    }
    else {
        throw new Error('Invalid approval grant');
    }
}
/** The one domain seam that applies the existing approval grants. */
export function applyApprovalGrant(deps, input) {
    const toolName = input.toolName;
    const parsed = parseToolCallArguments(input.rawArguments, {
        callId: input.callId ?? String(Date.now()),
        toolName: toolName ?? 'unknown',
        sessionId: deps.sessionId,
        traceId: typeof deps.logger?.getCorrelationId === 'function'
            ? deps.logger.getCorrelationId() ?? 'trace-unknown'
            : 'trace-unknown',
    }).arguments;
    const parsedArguments = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    const deniedRead = isDeniedReadApproveAnswer(input.answer);
    const dockerDecision = isDockerHostControlApproveAnswer(input.answer);
    const isDockerRequest = isDockerHostControlShellApproval(toolName, parsedArguments, deps.sessionId, deps.sessionAccess, deps.nestedCompatibility);
    const allowReadFolderForSession = isReadFileSessionApproveAnswer(input.answer) && supportsFolderSessionRead(toolName);
    const editSessionGrants = getEditSessionGrants(input.answer, toolName, parsedArguments);
    const isApproved = isDockerRequest
        ? dockerDecision
        : input.answer === 'y' || deniedRead || allowReadFolderForSession || editSessionGrants.length > 0;
    if (isApproved && allowReadFolderForSession) {
        const folder = resolveSessionReadFolder(toolName, parsedArguments);
        if (folder) {
            if (deps.sessionAccess)
                deps.sessionAccess.allowReadFolder(folder);
            else
                deps.nestedCompatibility?.readAccess.allowFolder(deps.sessionId, folder);
        }
    }
    if (isApproved && deps.sessionAccess) {
        for (const editSessionGrant of editSessionGrants) {
            if (editSessionGrant.kind === 'file')
                deps.sessionAccess.allowEditFile(editSessionGrant.path);
            else
                deps.sessionAccess.allowEditFolder(editSessionGrant.path);
        }
    }
    if (isApproved && deniedRead && input.interruption) {
        applyDeniedReadDecision(deps, input.answer, input.interruption, input.callId);
    }
    if (isApproved && dockerDecision && isDockerRequest && typeof parsedArguments?.command === 'string') {
        const cwd = typeof parsedArguments.cwd === 'string' ? parsedArguments.cwd : getActiveWorkspaceRoot();
        const scope = input.answer === 'docker-allow-once' ? 'once' : input.answer === 'docker-allow-session' ? 'session' : 'project';
        if (deps.sessionAccess)
            deps.sessionAccess.grantDocker(parsedArguments.command, cwd, scope);
        else {
            deps.nestedCompatibility?.docker.grant({
                command: parsedArguments.command,
                cwd,
                scope,
                sessionId: deps.sessionId,
            });
        }
    }
    return {
        isApproved,
        isDockerRequest,
        deniedReadDecision: deniedRead,
        parsedArguments,
    };
}
function getEditSessionGrants(answer, toolName, args) {
    if (answer !== 'allow-edit-file-session' && answer !== 'allow-edit-folder-session')
        return [];
    // Persistent grants must match the singular scope the descriptor/prompt discloses.
    // One-time approval of the current call is independent: isApproved is true as
    // long as this returns at least one grant.
    const disclosed = resolveOutsideWorkspaceEdit(toolName, args);
    if (disclosed) {
        return answer === 'allow-edit-file-session'
            ? [{ kind: 'file', path: disclosed.path }]
            : [{ kind: 'folder', path: disclosed.folder }];
    }
    return extractToolTargetPaths(toolName ?? '', args).map((rawPath) => {
        const target = path.resolve(getActiveWorkspaceRoot(), rawPath);
        return answer === 'allow-edit-file-session'
            ? { kind: 'file', path: target }
            : { kind: 'folder', path: path.dirname(target) };
    });
}
function applyDeniedReadDecision(deps, answer, interruption, callId) {
    const { rawArguments } = getToolInfoFromInterruption(interruption);
    const parsedArgs = parseToolCallArguments(rawArguments, {
        callId: callId ?? String(Date.now()),
        toolName: 'shell',
        sessionId: deps.sessionId,
        traceId: typeof deps.logger?.getCorrelationId === 'function'
            ? deps.logger.getCorrelationId() ?? 'trace-unknown'
            : 'trace-unknown',
    });
    const shellCommand = parsedArgs.arguments?.command;
    if (typeof shellCommand !== 'string')
        return;
    const stagedInfo = deps.nestedCompatibility?.deniedReads.consumeStaged(shellCommand);
    if (!stagedInfo)
        return;
    if (answer === 'allow-once' || answer === 'allow-remember') {
        deps.nestedCompatibility?.executionOverrides.set(shellCommand, {
            extraAllowRead: [stagedInfo.suggestedParent],
        });
        if (answer === 'allow-remember') {
            getProjectAllowReadStore(getActiveWorkspaceRoot()).append(stagedInfo.suggestedParent);
            deps.logger?.security('Sandbox allowed-read path remembered for project', {
                path: stagedInfo.suggestedParent,
                deniedPath: stagedInfo.path,
                sensitive: stagedInfo.sensitive,
                sessionId: deps.sessionId,
            });
        }
    }
    else if (answer === 'unsandboxed-once') {
        deps.nestedCompatibility?.executionOverrides.set(shellCommand, { forceUnsandboxed: true });
    }
}
//# sourceMappingURL=approval-grant-executor.js.map