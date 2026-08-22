import path from 'node:path';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ILoggingService } from '../service-interfaces.js';
import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../interruption-info.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { createInvalidToolCallDiagnostic } from '../logging/logging-contract.js';
import { getProjectAllowReadStore } from '../../utils/shell/sandbox/denied-read-stores.js';
import {
  isDeniedReadApproveAnswer,
  isDockerHostControlApproveAnswer,
  isReadFileSessionApproveAnswer,
  supportsFolderSessionRead,
} from '../../contracts/conversation.js';
import { isDockerHostControlShellApproval } from './shell-sandbox-approval.js';
import { resolveSessionReadFolder } from './session-read-grant-target.js';
import type { PendingApprovalContext } from './approval-state.js';
import type { SessionAccessState } from '../session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';
import { getActiveWorkspaceRoot } from '../workspace/active-workspace-root.js';
import type { ToolOwnershipRegistry } from './tool-ownership-registry.js';

export type ApprovalDecisionSource = 'user' | 'policy' | 'system';

export type ApprovalDecisionResolution = {
  readonly pendingApprovalContext: PendingApprovalContext;
  readonly isApproved: boolean;
  readonly toolStartedEvent?: ConversationEvent;
};

export type ApprovalDecisionExecutorDeps = {
  logger: ILoggingService;
  sessionId: string;
  /** Session-owned ownership claims for approval calls. */
  toolOwnership: ToolOwnershipRegistry;
  /** Handle-owned root capability. Do not replace this with a fresh access state. */
  sessionAccess?: SessionAccessState;
  /** Explicit isolated compatibility state for a nested execution. */
  nestedCompatibility?: NestedToolCompatibilityState;
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
  toolCallMarkers?: ToolCallMarkerStore;
};

export type ResolveApprovalDecisionInput = {
  pendingApprovalContext: PendingApprovalContext;
  answer: string;
  rejectionReason?: string;
  source?: ApprovalDecisionSource;
};

/**
 * Applies one already-authorized approval decision to the continuation that
 * owns it. This is deliberately independent of root `ApprovalState`, turn
 * generations, and continuation planning so a transferred child lease can use
 * the exact same capability policy without taking over the root interaction.
 */
export class ApprovalDecisionExecutor {
  readonly #toolCallMarkers: ToolCallMarkerStore;

  constructor(private readonly deps: ApprovalDecisionExecutorDeps) {
    this.#toolCallMarkers = deps.toolCallMarkers ?? new ToolCallMarkerStore();
  }

  resolve(input: ResolveApprovalDecisionInput): ApprovalDecisionResolution {
    const decisionCallId = getCallIdFromObject(input.pendingApprovalContext.interruption);
    try {
      return this.#resolve(input);
    } finally {
      if (decisionCallId) this.deps.toolOwnership.release(decisionCallId);
    }
  }

  #resolve({
    pendingApprovalContext,
    answer,
    rejectionReason,
    source = 'user',
  }: ResolveApprovalDecisionInput): ApprovalDecisionResolution {
    const { state, interruption } = pendingApprovalContext;
    const decisionCallId = getCallIdFromObject(interruption);
    pendingApprovalContext.decisionsByCallId ??= new Map();

    const { toolName: decisionToolName, rawArguments: decisionRawArguments } =
      getToolInfoFromInterruption(interruption);
    const parsedDecisionArgs = parseToolCallArguments(decisionRawArguments, {
      callId: decisionCallId ?? String(Date.now()),
      toolName: decisionToolName,
      sessionId: this.deps.sessionId,
      traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
    }).arguments as { command?: unknown; cwd?: unknown } | null;
    const deniedReadDecision = isDeniedReadApproveAnswer(answer);
    const dockerDecision = isDockerHostControlApproveAnswer(answer);
    const isDockerRequest = isDockerHostControlShellApproval(
      decisionToolName,
      parsedDecisionArgs,
      this.deps.sessionId,
      this.deps.sessionAccess,
      this.deps.nestedCompatibility,
    );
    const allowReadFolderForSession =
      isReadFileSessionApproveAnswer(answer) && supportsFolderSessionRead(decisionToolName);
    const editSessionGrant = this.#getEditSessionGrant(answer, decisionToolName, parsedDecisionArgs);

    if (allowReadFolderForSession) {
      const folder = resolveSessionReadFolder(decisionToolName, parsedDecisionArgs);
      if (folder) {
        if (this.deps.sessionAccess) this.deps.sessionAccess.allowReadFolder(folder);
        else this.deps.nestedCompatibility?.readAccess.allowFolder(this.deps.sessionId, folder);
      }
    }
    if (editSessionGrant) {
      if (this.deps.sessionAccess) {
        if (editSessionGrant.kind === 'file') this.deps.sessionAccess.allowEditFile(editSessionGrant.path);
        else this.deps.sessionAccess.allowEditFolder(editSessionGrant.path);
      }
    }

    // Docker host control is a distinct capability. Generic resume answers
    // remain rejected even if the tool call otherwise looks approvable.
    const isApproved = isDockerRequest
      ? dockerDecision
      : answer === 'y' || deniedReadDecision || allowReadFolderForSession || editSessionGrant !== null;
    let toolStartedEvent: ConversationEvent | undefined;

    if (isApproved) {
      this.#applyDeniedReadDecision(answer, deniedReadDecision, interruption, decisionCallId);
      this.#applyDockerDecision(answer, dockerDecision, isDockerRequest, parsedDecisionArgs);

      this.deps.logger.debug('Tool approval granted', {
        eventType: 'approval.granted',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
        ...(deniedReadDecision ? { deniedReadDecision: answer } : {}),
      });

      const { toolName, rawArguments } = getToolInfoFromInterruption(interruption);
      const parseResult = parseToolCallArguments(rawArguments, {
        callId: decisionCallId ?? String(Date.now()),
        toolName,
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
      });
      if (parseResult.invalidJsonDiagnostic) {
        const diagnostic = createInvalidToolCallDiagnostic(parseResult.invalidJsonDiagnostic);
        this.deps.logger.error('Invalid tool call argument payload', {
          ...diagnostic,
          sessionId: this.deps.sessionId,
          messageId: decisionCallId ?? String(Date.now()),
        });
      }

      const toolCallId = decisionCallId ?? String(Date.now());
      toolStartedEvent =
        pendingApprovalContext.owner.kind === 'subagent'
          ? {
              type: 'subagent_tool_started',
              agentId: pendingApprovalContext.owner.agentId,
              role: pendingApprovalContext.owner.role,
              toolCallId,
              toolName,
              arguments: parseResult.arguments,
            }
          : {
              type: 'tool_started',
              toolCallId,
              toolName,
              arguments: parseResult.arguments,
            };

      state.approve?.(interruption);
      if (decisionCallId) pendingApprovalContext.decisionsByCallId.set(decisionCallId, 'approved');
    } else {
      const message = rejectionReason
        ? `Tool execution was not approved. User's reason: ${rejectionReason}`
        : 'Tool execution was not approved.';

      // Rejection settles an indirect Docker denial, otherwise the same
      // command would require the abandoned prompt again forever.
      if (isDockerRequest && typeof parsedDecisionArgs?.command === 'string') {
        if (this.deps.sessionAccess) this.deps.sessionAccess.consumeDockerDenial(parsedDecisionArgs.command);
        else this.deps.nestedCompatibility?.docker.consumeDenial(this.deps.sessionId, parsedDecisionArgs.command);
      }

      this.#toolCallMarkers.markToolCallAsApprovalRejection(decisionCallId);
      state.reject?.(interruption, { message });
      if (decisionCallId) pendingApprovalContext.decisionsByCallId.set(decisionCallId, 'rejected');

      this.deps.logger.debug('Tool approval rejected', {
        eventType: 'approval.rejected',
        category: 'approval',
        phase: 'approval',
        sessionId: this.deps.sessionId,
        traceId: this.deps.logger.getCorrelationId(),
      });
    }

    if (this.deps.hookLifecycle && this.deps.hookEvents) {
      void this.deps.hookLifecycle.emit(
        this.deps.hookEvents.create(
          'approval.resolved',
          {
            resolution: isApproved ? (source === 'policy' ? 'auto_approved' : 'approved') : 'rejected',
            source,
            executionFollowed: isApproved,
          },
          { toolCallId: decisionCallId },
        ),
      );
    }

    return { pendingApprovalContext, isApproved, toolStartedEvent };
  }

  #getEditSessionGrant(
    answer: string,
    toolName: string | undefined,
    args: unknown,
  ): { kind: 'file' | 'folder'; path: string } | null {
    if (toolName !== 'apply_patch' && toolName !== 'create_file' && toolName !== 'search_replace') return null;
    const record = args && typeof args === 'object' ? (args as { path?: unknown; operations?: unknown }) : null;
    const operation = Array.isArray(record?.operations) ? record.operations[0] : record;
    const rawPath =
      operation && typeof operation === 'object' && typeof (operation as { path?: unknown }).path === 'string'
        ? (operation as { path: string }).path
        : undefined;
    if (!rawPath) return null;
    const target = path.resolve(rawPath);
    if (answer === 'allow-edit-file-session') return { kind: 'file', path: target };
    if (answer === 'allow-edit-folder-session') return { kind: 'folder', path: path.dirname(target) };
    return null;
  }

  #applyDeniedReadDecision(
    answer: string,
    deniedReadDecision: boolean,
    interruption: unknown,
    decisionCallId: string | undefined,
  ): void {
    if (!deniedReadDecision) return;

    const { rawArguments } = getToolInfoFromInterruption(interruption);
    const parsedArgs = parseToolCallArguments(rawArguments, {
      callId: decisionCallId ?? String(Date.now()),
      toolName: 'shell',
      sessionId: this.deps.sessionId,
      traceId: this.deps.logger.getCorrelationId() ?? 'trace-unknown',
    });
    const shellCommand = (parsedArgs.arguments as { command?: string } | null)?.command;
    if (typeof shellCommand !== 'string') return;

    const stagedInfo = this.deps.nestedCompatibility?.deniedReads.consumeStaged(shellCommand);
    if (!stagedInfo) return;

    if (answer === 'allow-once' || answer === 'allow-remember') {
      this.deps.nestedCompatibility?.executionOverrides.set(shellCommand, {
        extraAllowRead: [stagedInfo.suggestedParent],
      });
      if (answer === 'allow-remember') {
        // Key the grant to the root the command actually ran under, so a grant
        // made in one worktree does not silently authorize another.
        getProjectAllowReadStore(getActiveWorkspaceRoot()).append(stagedInfo.suggestedParent);
        this.deps.logger.security('Sandbox allowed-read path remembered for project', {
          path: stagedInfo.suggestedParent,
          deniedPath: stagedInfo.path,
          sensitive: stagedInfo.sensitive,
          sessionId: this.deps.sessionId,
        });
      }
    } else if (answer === 'unsandboxed-once') {
      this.deps.nestedCompatibility?.executionOverrides.set(shellCommand, { forceUnsandboxed: true });
    }
  }

  #applyDockerDecision(
    answer: string,
    dockerDecision: boolean,
    isDockerRequest: boolean,
    parsedDecisionArgs: { command?: unknown; cwd?: unknown } | null,
  ): void {
    if (!dockerDecision || !isDockerRequest || typeof parsedDecisionArgs?.command !== 'string') return;

    const cwd = typeof parsedDecisionArgs.cwd === 'string' ? parsedDecisionArgs.cwd : getActiveWorkspaceRoot();
    const scope = answer === 'docker-allow-once' ? 'once' : answer === 'docker-allow-session' ? 'session' : 'project';
    if (this.deps.sessionAccess) this.deps.sessionAccess.grantDocker(parsedDecisionArgs.command, cwd, scope);
    else
      this.deps.nestedCompatibility?.docker.grant({
        command: parsedDecisionArgs.command,
        cwd,
        scope,
        sessionId: this.deps.sessionId,
      });
  }
}
