import type { SessionAccessState } from '../../session/session/session-access-state.js';
import { ShellAutoApprovalResolver } from '../../session/approval/shell-auto-approval-resolver.js';
import { decideApproval, describeApproval } from '../../session/approval/approval-route.js';
import type { ILoggingService, ISessionContextService, ISettingsService } from '../../shared/service-interfaces.js';
import type { ProviderInputItem } from '../../shared/contracts/provider-input.js';
/** Tool-free model bridge used by the application's approval evaluators. */
import { randomUUID } from 'node:crypto';
import type { Item, ModelAffinity, ModelRegistry, ItemId } from '../../model/index.js';
import type { ShellAutoApprovalAgentClient } from '../../session/conversation-agent-client.js';
import type { AgentSurface, ProfileSelection } from '../tool-contract.js';
import type { DirectRuntimeRecord } from '../application-runtime.js';
import type { WorkspaceSnapshotPort } from '../../session/types.js';
import type { Workspace } from '../../tools/index.js';
import { describeWorkspaceSnapshot, takeWorkspaceSnapshot } from '../../tools/workspace/workspace-snapshot.js';

/** One tool-free model request for the existing approval evaluator; never starts an agent loop. */
export function createApprovalModelClient(
  models: ModelRegistry,
  { settings }: ProfileSelection,
  surfaceSignal: AbortSignal,
  parentAffinity: ModelAffinity,
): ShellAutoApprovalAgentClient {
  const key = `${parentAffinity.conversationKey}:evaluator`;
  const affinity = { conversationKey: key, cacheKey: key, routingKey: key };
  return {
    async chat(message, options = {}) {
      const configured = settings.get('agent.modelSelection');
      const model = { provider: options.provider ?? configured.provider, model: options.model ?? configured.model };
      const effort = options.reasoningEffort;
      const signal = options.signal ? AbortSignal.any([options.signal, surfaceSignal]) : surfaceSignal;
      signal.throwIfAborted();
      let deltas = '';
      const completed: string[] = [];
      let ended = false;
      for await (const event of models.resolve(model).stream(
        {
          model,
          instructions: options.instructions ?? '',
          affinity,
          tools: [],
          input: [
            {
              type: 'user_message',
              id: `approval:${randomUUID()}` as ItemId,
              content: [{ type: 'text', text: message }],
            },
          ],
          ...(effort && effort !== 'default' ? { reasoning: effort } : {}),
          ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        },
        signal,
      )) {
        if (event.type === 'text_delta') deltas += event.delta;
        if (event.type === 'item' && event.item.type === 'assistant_message') {
          completed.push(
            event.item.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          );
        }
        if (event.type === 'done') {
          if (event.stopReason !== 'end_turn') throw new Error(`Approval model stopped with ${event.stopReason}`);
          ended = true;
        }
      }
      if (!ended) throw new Error('Approval model ended without a completion');
      return completed.length > 0 ? completed.join('') : deltas;
    },
  };
}

/**
 * Review an open approval through the shared decision table
 * (src/session/approval/approval-route.ts). Every surface uses this one
 * function; it never branches on the surface or the tool name.
 */
export function createAssistedApprovalReview({
  agentClient,
  settings,
  logger,
  sessionContext,
  sessionAccess,
  withWorkspace,
  isSandboxEscape,
  isProtectedWrite,
}: {
  isSandboxEscape?: (toolName: string, input: unknown) => boolean;
  isProtectedWrite?: (toolName: string, input: unknown) => boolean;
  agentClient: ShellAutoApprovalAgentClient;
  settings: ISettingsService;
  logger: ILoggingService;
  sessionContext: ISessionContextService;
  sessionAccess: SessionAccessState;
  withWorkspace: <T>(operation: () => T) => T;
}): NonNullable<AgentSurface['reviewApproval']> {
  return async (request, history, signal) => {
    const profile = describeApproval(request, {
      isDockerHostControl: (toolName, input) => isDockerRequest(toolName, input, sessionAccess),
      ...(isSandboxEscape ? { isSandboxEscape } : {}),
      ...(isProtectedWrite ? { isProtectedWrite } : {}),
    });
    return decideApproval({
      request,
      profile,
      signal,
      currentMode: () => settings.get('shell.autoApproveMode'),
      routeOptions: () => ({
        showReview: settings.get('shell.showReview') === true,
        reviewEscapes: settings.get('shell.unattendedEscapeReview') === true,
      }),
      review: () => {
        const resolver = new ShellAutoApprovalResolver({
          record: { getHistory: () => approvalHistory(history) },
          agentClient: { chat: (message, options) => agentClient.chat(message, { ...options, signal }) },
          logger,
          settingsService: settings,
          sessionContextService: sessionContext,
          sessionAccess,
        });
        const interruption = { name: request.toolName, arguments: request.input, callId: request.requestId };
        return withWorkspace(() => resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] }));
      },
    });
  };
}

export function isDockerRequest(name: string, input: unknown, access: SessionAccessState): boolean {
  return (
    name === 'shell' &&
    !!input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string' &&
    access.requiresDockerApproval(input.command)
  );
}

function approvalHistory(history: readonly Item[]): ProviderInputItem[] {
  return history.flatMap((item): ProviderInputItem[] => {
    switch (item.type) {
      case 'user_message':
      case 'assistant_message':
        return [
          {
            type: 'message',
            role: item.type === 'user_message' ? 'user' : 'assistant',
            content: item.content
              .filter((part) => part.type === 'text')
              .map((part) => ({ type: 'input_text', text: part.text })),
          },
        ];
      case 'tool_call':
        return [
          {
            type: 'function_call',
            name: item.toolName,
            call_id: item.callId,
            arguments: item.rawArguments ?? JSON.stringify(item.input),
          },
        ];
      case 'tool_result':
        return [{ type: 'function_call_output', call_id: item.callId, output: item.output }];
      default:
        return [];
    }
  });
}

/** Cancellation stops waiting on advisory policy; surface disposal stops the policy itself. */
async function untilAborted(
  operation: Promise<import('../../engine/index.js').InteractionDecision>,
  signal: AbortSignal,
): Promise<import('../../engine/index.js').InteractionDecision> {
  const cancelled: import('../../engine/index.js').InteractionDecision = { kind: 'deny' };
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return cancelled;
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<import('../../engine/index.js').InteractionDecision>((resolve) => {
    onAbort = () => resolve(cancelled);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The session's reviewer (src/session/approval/approval-arbiter.ts), read from the
 * session's current tool generation for every request, so a rebuilt surface and
 * its live mode apply at once.
 */
export function sessionApprovalReview(
  record: () => Pick<DirectRuntimeRecord, 'surface' | 'scope'> | undefined,
): import('../../session/approval/approval-arbiter.js').ApprovalReviewPort {
  return {
    willReview: (request) => {
      const kind = record()?.surface.approvalRoute?.(request).kind;
      return kind === 'decide' || kind === 'advise' || kind === 'judge' || kind === 'bypass';
    },
    mayApprove: (request) => {
      const kind = record()?.surface.approvalRoute?.(request).kind;
      return kind === 'decide' || kind === 'judge' || kind === 'bypass';
    },
    route: (request) => record()?.surface.approvalRoute?.(request) ?? { kind: 'ask_user' },
    unattended: () => record()?.surface.unattended?.() === true,
    isHeadless: () => record()?.surface.headlessPolicy === true,
    async decideHeadless(request, history, review, signal) {
      const current = record();
      if (!current) {
        return request.kind === 'question'
          ? { kind: 'answer', answer: '', stopAfterApprovalResolution: true }
          : { kind: 'deny', reason: 'No person is available to approve this in a non-interactive run.' };
      }
      return current.scope(() => untilAborted(current.surface.decideInteraction(request, history, review), signal));
    },
    async review(request, history, signal) {
      const current = record();
      const review = current?.surface.reviewApproval;
      if (!current || !review) return { kind: 'not_reviewed', approved: false };
      return current.scope(() => review(request, history, signal));
    },
  };
}

/** Unattended turns snapshot a local workspace; an SSH workspace has no snapshot, and the turn says so. */
export function workspaceSnapshotPort(workspace: Workspace): WorkspaceSnapshotPort {
  return {
    take: (label) =>
      workspace.target === 'local'
        ? takeWorkspaceSnapshot(workspace.root, label)
        : Promise.resolve({ kind: 'none', reason: 'the workspace is on an SSH host' }),
    describe: describeWorkspaceSnapshot,
  };
}
