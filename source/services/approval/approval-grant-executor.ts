import path from 'node:path';
import { getProjectAllowReadStore } from '../../utils/shell/sandbox/denied-read-stores.js';
import {
  isDeniedReadApproveAnswer,
  isDockerHostControlApproveAnswer,
  isReadFileSessionApproveAnswer,
  supportsFolderSessionRead,
} from '../../contracts/conversation.js';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import { isDockerHostControlShellApproval } from './shell-sandbox-approval.js';
import { resolveSessionReadFolder } from './session-read-grant-target.js';
import type { SessionAccessState } from '../session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import type { ILoggingService } from '../service-interfaces.js';
import { getToolInfoFromInterruption } from '../interruption-info.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { extractToolTargetPaths } from './shell-auto-approval-resolver.js';
import { resolveOutsideWorkspaceEdit } from './approval-descriptor.js';

export type ApprovalGrantExecutorDeps = {
  sessionId: string;
  sessionAccess?: SessionAccessState;
  nestedCompatibility?: NestedToolCompatibilityState;
  logger?: ILoggingService;
};

export type ApprovalGrantInput = {
  answer: string;
  toolName?: string;
  rawArguments?: unknown;
  callId?: string;
  interruption?: unknown;
};

export type ApprovalGrantResult = {
  isApproved: boolean;
  isDockerRequest: boolean;
  deniedReadDecision: boolean;
  parsedArguments: Record<string, unknown> | null;
};

/** The one domain seam that applies the existing approval grants. */
export function applyApprovalGrant(deps: ApprovalGrantExecutorDeps, input: ApprovalGrantInput): ApprovalGrantResult {
  const toolName = input.toolName;
  const parsed = parseToolCallArguments(input.rawArguments, {
    callId: input.callId ?? String(Date.now()),
    toolName: toolName ?? 'unknown',
    sessionId: deps.sessionId,
    traceId:
      typeof deps.logger?.getCorrelationId === 'function'
        ? deps.logger.getCorrelationId() ?? 'trace-unknown'
        : 'trace-unknown',
  }).arguments;
  const parsedArguments =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const deniedRead = isDeniedReadApproveAnswer(input.answer);
  const dockerDecision = isDockerHostControlApproveAnswer(input.answer);
  const isDockerRequest = isDockerHostControlShellApproval(
    toolName,
    parsedArguments,
    deps.sessionId,
    deps.sessionAccess,
    deps.nestedCompatibility,
  );
  const allowReadFolderForSession = isReadFileSessionApproveAnswer(input.answer) && supportsFolderSessionRead(toolName);
  const editSessionGrants = getEditSessionGrants(input.answer, toolName, parsedArguments);
  const isApproved = isDockerRequest
    ? dockerDecision
    : input.answer === 'y' || deniedRead || allowReadFolderForSession || editSessionGrants.length > 0;

  if (isApproved && allowReadFolderForSession) {
    const folder = resolveSessionReadFolder(toolName, parsedArguments);
    if (folder) {
      if (deps.sessionAccess) deps.sessionAccess.allowReadFolder(folder);
      else deps.nestedCompatibility?.readAccess.allowFolder(deps.sessionId, folder);
    }
  }
  if (isApproved && deps.sessionAccess) {
    for (const editSessionGrant of editSessionGrants) {
      if (editSessionGrant.kind === 'file') deps.sessionAccess.allowEditFile(editSessionGrant.path);
      else deps.sessionAccess.allowEditFolder(editSessionGrant.path);
    }
  }
  if (isApproved && deniedRead && input.interruption) {
    applyDeniedReadDecision(deps, input.answer, input.interruption, input.callId);
  }
  if (isApproved && dockerDecision && isDockerRequest && typeof parsedArguments?.command === 'string') {
    const cwd = typeof parsedArguments.cwd === 'string' ? parsedArguments.cwd : getActiveWorkspaceRoot();
    const scope =
      input.answer === 'docker-allow-once' ? 'once' : input.answer === 'docker-allow-session' ? 'session' : 'project';
    if (deps.sessionAccess) deps.sessionAccess.grantDocker(parsedArguments.command, cwd, scope);
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

function getEditSessionGrants(
  answer: string,
  toolName: string | undefined,
  args: Record<string, unknown> | null,
): Array<{ kind: 'file' | 'folder'; path: string }> {
  if (answer !== 'allow-edit-file-session' && answer !== 'allow-edit-folder-session') return [];
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
      ? { kind: 'file' as const, path: target }
      : { kind: 'folder' as const, path: path.dirname(target) };
  });
}

function applyDeniedReadDecision(
  deps: ApprovalGrantExecutorDeps,
  answer: string,
  interruption: unknown,
  callId: string | undefined,
): void {
  const { rawArguments } = getToolInfoFromInterruption(interruption);
  const parsedArgs = parseToolCallArguments(rawArguments, {
    callId: callId ?? String(Date.now()),
    toolName: 'shell',
    sessionId: deps.sessionId,
    traceId:
      typeof deps.logger?.getCorrelationId === 'function'
        ? deps.logger.getCorrelationId() ?? 'trace-unknown'
        : 'trace-unknown',
  });
  const shellCommand = (parsedArgs.arguments as { command?: string } | null)?.command;
  if (typeof shellCommand !== 'string') return;
  const stagedInfo = deps.nestedCompatibility?.deniedReads.consumeStaged(shellCommand);
  if (!stagedInfo) return;
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
  } else if (answer === 'unsandboxed-once') {
    deps.nestedCompatibility?.executionOverrides.set(shellCommand, { forceUnsandboxed: true });
  }
}
