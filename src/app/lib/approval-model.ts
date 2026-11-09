import type { SessionAccessState } from '../../session/session/session-access-state.js';
import {
  isAutoApprovableTool,
  ShellAutoApprovalResolver,
} from '../../session/approval/shell-auto-approval-resolver.js';
import type { ILoggingService, ISessionContextService, ISettingsService } from '../../shared/service-interfaces.js';
import type { ProviderInputItem } from '../../shared/contracts/provider-input.js';
/** Tool-free model bridge used by the application's approval evaluators. */
import { randomUUID } from 'node:crypto';
import type { Item, ModelAffinity, ModelRegistry, ItemId } from '../../model/index.js';
import type { ShellAutoApprovalAgentClient } from '../../session/conversation-agent-client.js';
import type { DirectSession } from '../../session/facade-types.js';
import type { DirectRuntimeRecord } from '../application-runtime.js';
import type { AgentSurface, ProfileSelection } from '../tool-contract.js';

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

/** Only an authorized, low-risk review can replace a foreground permission exchange. */
export function createAssistedApprovalReview({
  agentClient,
  settings,
  logger,
  sessionContext,
  sessionAccess,
  withWorkspace,
}: {
  agentClient: ShellAutoApprovalAgentClient;
  settings: ISettingsService;
  logger: ILoggingService;
  sessionContext: ISessionContextService;
  sessionAccess: SessionAccessState;
  withWorkspace: <T>(operation: () => T) => T;
}): NonNullable<AgentSurface['reviewApproval']> {
  return async (request, history, signal) => {
    if (
      signal.aborted ||
      settings.get('shell.autoApproveMode') !== 'auto' ||
      request.kind !== 'approval' ||
      request.risk === 'high' ||
      !isAutoApprovableTool(request.toolName) ||
      request.presentation?.requiresExplicitUser === true ||
      request.presentation?.deniedRead ||
      isExplicitShellRequest(request.toolName, request.input) ||
      isDockerRequest(request.toolName, request.input, sessionAccess)
    )
      return false;
    const review = new ShellAutoApprovalResolver({
      record: { getHistory: () => approvalHistory(history) },
      agentClient: { chat: (message, options) => agentClient.chat(message, { ...options, signal }) },
      logger,
      settingsService: settings,
      sessionContextService: sessionContext,
      sessionAccess,
    });
    const interruption = { name: request.toolName, arguments: request.input, callId: request.requestId };
    const advisory = await withWorkspace(() =>
      review.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] }),
    );
    return !signal.aborted && advisory?.riskLevel === 'low' && review.shouldAutoApprove(advisory);
  };
}

function isExplicitShellRequest(name: string, input: unknown): boolean {
  return (
    (name === 'shell' || name === 'bash') &&
    input !== null &&
    typeof input === 'object' &&
    (('sandbox' in input && input.sandbox === 'unsandboxed') || ('background' in input && input.background === true))
  );
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

export function approvalHistory(history: readonly Item[]): ProviderInputItem[] {
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

/** Review an exact foreground request still owned by the installed tool generation. */
export async function reviewLiveApproval(
  session: DirectSession,
  runtime: DirectRuntimeRecord | undefined,
  requestId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const review = runtime?.surface.reviewApproval;
  if (signal.aborted || !runtime || !review || runtime.configurationSettings.get('shell.autoApproveMode') !== 'auto')
    return false;
  const { state, unsubscribe } = session.capture(() => undefined);
  unsubscribe();
  const request = state.pendingInteractions.find((pending) => pending.requestId === requestId);
  if (!request || request.turnId !== state.activeTurnId || 'taskId' in request) return false;
  return await runtime.scope(() => review(request, session.acceptedHistory(), signal));
}
