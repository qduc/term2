import type { ILoggingService, ISettingsService, ISessionContextService } from './services/service-interfaces.js';
import { createConversationRuntime } from './services/conversation/conversation-runtime-factory.js';
import { SessionContextService } from './services/session/session-context-service.js';
import {
  createCallerOwnedSessionClientFactory,
  type SessionClientFactory,
} from './services/session/session-client-factory.js';
import type { ConversationAgentClient } from './services/conversation-agent-client.js';
import type { ConversationEvent } from './services/conversation/conversation-events.js';
import type { UserTurn } from './types/user-turn.js';
import type { ConversationTerminal } from './contracts/conversation.js';
import type {
  SendMessageOptions,
  HandleApprovalDecisionOptions,
} from './services/conversation/conversation-adapter.js';
import type { SavedToolExecution } from './services/tool-execution-ledger.js';
import { randomUUID } from 'node:crypto';
import { ToolOwnershipRegistry } from './services/approval/tool-ownership-registry.js';
import { NonInteractiveApprovalPolicy } from './services/approval/non-interactive-approval-policy.js';
import type { HookLifecyclePort } from './services/hooks/hook-service.js';
import type { HookEventFactory } from './services/hooks/hook-event-factory.js';

export interface NonInteractiveConfig {
  prompt: string;
  autoApprove: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  settingsService?: ISettingsService;
  /** Compatibility seam; the caller continues to own this client. */
  agentClient?: ConversationAgentClient;
  /** Required with a caller-owned client to preserve approval/nested identity. */
  toolOwnership?: ToolOwnershipRegistry;
  /** Production seam; creates a client owned by this one-shot session. */
  sessionClientFactory?: SessionClientFactory;
  logger?: ILoggingService;
  sessionContextService?: ISessionContextService;
  hookLifecycle?: HookLifecyclePort;
  hookEvents?: HookEventFactory;
}

export { NON_INTERACTIVE_REJECTION_REASON } from './services/approval/non-interactive-approval-policy.js';

export const createNonInteractiveSessionId = (): string => `non-interactive-${randomUUID()}`;

export interface ConversationSessionLike {
  sendMessage(input: string | UserTurn, options?: SendMessageOptions): Promise<ConversationTerminal>;
  handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    options?: HandleApprovalDecisionOptions,
  ): Promise<ConversationTerminal | null>;
  setEventSink?: (sink: ((event: ConversationEvent) => void) | null) => void;
  exportState?(): { history: unknown[]; previousResponseId: string | null; toolLedger: SavedToolExecution[] };
}

const safePreview = (value: unknown, maxLen = 500): string => {
  try {
    if (typeof value === 'string') {
      return value.length > maxLen ? value.slice(0, maxLen) + '…' : value;
    }
    const json = JSON.stringify(value);
    if (!json) {
      return '';
    }
    return json.length > maxLen ? json.slice(0, maxLen) + '…' : json;
  } catch {
    return '';
  }
};

const formatEventForStderr = (event: ConversationEvent): string | null => {
  switch (event.type) {
    case 'tool_started':
      return `tool_started ${event.toolName} ${safePreview(event.arguments)}\n`;
    case 'subagent_tool_started':
      return `subagent_tool_started ${event.role} ${event.toolName} ${safePreview(event.arguments)}\n`;
    case 'command_message':
      return `command_message ${event.message.status} ${event.message.command}\n`;
    case 'approval_required':
      return `approval_required ${event.approval.toolName}\n`;
    case 'retry':
      if (event.retryType === 'flex_service_tier') {
        return `retry service_tier: ${event.errorMessage}\n`;
      }
      return `retry ${event.toolName} ${event.attempt}/${event.maxRetries}: ${event.errorMessage}\n`;
    case 'error':
      return `error ${event.message}\n`;
    default:
      return null;
  }
};

export async function runWithSession(session: ConversationSessionLike, config: NonInteractiveConfig): Promise<number> {
  const stdout = config.stdout ?? process.stdout;
  const stderr = config.stderr ?? process.stderr;
  const sessionContextService = config.sessionContextService ?? new SessionContextService();
  const approvalPolicy = new NonInteractiveApprovalPolicy({
    settingsService: config.settingsService,
    agentClient: config.agentClient,
    logger: config.logger,
    sessionContextService,
  });

  let streamedTextLength = 0;

  const onEvent = (event: ConversationEvent) => {
    if (event.type === 'text_delta') {
      streamedTextLength += event.delta.length;
      stdout.write(event.delta);
      return;
    }

    if (event.type === 'reasoning_delta') {
      stderr.write(event.delta);
      return;
    }

    if (event.type === 'final') {
      // Some completion paths (e.g. tool-only turns, or providers that don't
      // stream token deltas) deliver the response text solely via `finalText`
      // rather than `text_delta`. Write whatever wasn't already streamed so
      // the response isn't silently dropped.
      if (event.finalText && event.finalText.length > streamedTextLength) {
        stdout.write(event.finalText.slice(streamedTextLength));
      }
      return;
    }

    const line = formatEventForStderr(event);
    if (line) {
      stderr.write(line);
    }
  };

  if (config.autoApprove) {
    stderr.write('Warning: --auto-approve enabled. Tools may run without prompting.\n');
  }

  try {
    type SendResult = Awaited<ReturnType<ConversationSessionLike['sendMessage']>>;
    type ApprovalResult = Awaited<ReturnType<ConversationSessionLike['handleApprovalDecision']>>;

    const supportsPersistentEventSink = typeof session.setEventSink === 'function';
    if (supportsPersistentEventSink) {
      session.setEventSink!(onEvent);
    }

    let result: SendResult | ApprovalResult;
    result = supportsPersistentEventSink
      ? await session.sendMessage(config.prompt)
      : await session.sendMessage(config.prompt, { onEvent } as any);

    while (result?.type === 'approval_required') {
      const decision = await approvalPolicy.decide({
        autoApprove: config.autoApprove,
        approval: result.approval,
        getHistory: () => session.exportState?.().history ?? [],
      });
      const rejectionReason = decision.answer === 'n' ? decision.rejectionReason : undefined;
      if (decision.answer === 'n' && decision.reportRejection) {
        stderr.write(`Approval Rejected: ${rejectionReason}\n`);
      }
      result = supportsPersistentEventSink
        ? await session.handleApprovalDecision(decision.answer, rejectionReason)
        : await session.handleApprovalDecision(decision.answer, rejectionReason, { onEvent } as any);

      if (result === null) {
        stderr.write('error No pending approval context (unexpected in non-interactive mode).\n');
        return 1;
      }
    }

    if (result?.type === 'response') {
      stdout.write('\n');
      return 0;
    }

    stderr.write('error Unexpected conversation result.\n');
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`error ${message}\n`);
    return 1;
  } finally {
    if (typeof session.setEventSink === 'function') {
      session.setEventSink(null);
    }
  }
}

export async function runNonInteractive(
  config: NonInteractiveConfig & {
    logger: ILoggingService;
    settingsService: ISettingsService;
  },
): Promise<number> {
  const sessionContextService = config.sessionContextService ?? new SessionContextService();
  if (!config.sessionClientFactory && !config.agentClient) {
    throw new Error('runNonInteractive requires an agentClient or sessionClientFactory');
  }
  if (!config.sessionClientFactory && !config.toolOwnership) {
    throw new Error('runNonInteractive requires toolOwnership with an agentClient');
  }
  const clientFactory =
    config.sessionClientFactory ?? createCallerOwnedSessionClientFactory(config.agentClient!, config.toolOwnership!);
  const sessionId = createNonInteractiveSessionId();
  const clientHandle = clientFactory.create(sessionId, { allowBackgroundShell: false });
  const removeBackgroundShellInterceptor = clientHandle.agentClient.addToolInterceptor(async (name, params) => {
    if (
      name === 'shell' &&
      params !== null &&
      typeof params === 'object' &&
      !Array.isArray(params) &&
      (params as { background?: unknown }).background === true
    ) {
      return 'Error: Background shell execution is unavailable in non-interactive mode.';
    }
    return null;
  });

  let runtime: ReturnType<typeof createConversationRuntime>['runtime'] | undefined;
  let fatal = false;
  try {
    const createdRuntime = createConversationRuntime({
      sessionId,
      agentClient: clientHandle.agentClient,
      toolOwnership: clientHandle.toolOwnership,
      deps: {
        logger: config.logger,
        settingsService: config.settingsService,
        sessionContextService,
      },
      hookLifecycle: config.hookLifecycle ?? clientHandle.hookLifecycle,
      hookEvents: config.hookEvents ?? clientHandle.hookEvents,
    });
    runtime = createdRuntime.runtime;
    if (config.hookLifecycle && clientHandle.hookEvents) {
      await config.hookLifecycle.emit(
        clientHandle.hookEvents.create('session.start', {
          cwd: process.cwd(),
          mode: 'non-interactive',
          providerName: clientHandle.agentClient.getProvider?.() ?? config.settingsService.get('agent.provider'),
          modelName: config.settingsService.get('agent.model'),
        }),
      );
    }
    return await runWithSession(createdRuntime.adapter, {
      ...config,
      agentClient: clientHandle.agentClient,
      sessionContextService,
    });
  } catch (error) {
    fatal = true;
    throw error;
  } finally {
    removeBackgroundShellInterceptor();
    if (config.hookLifecycle && clientHandle.hookEvents) {
      await config.hookLifecycle.emit(
        clientHandle.hookEvents.create('session.end', {
          reason: fatal ? 'fatal_error' : 'normal',
          sessionDuration: runtime ? Math.max(0, Date.now() - Date.parse(runtime.sessionStartedAt)) : 0,
        }),
      );
    }
    await runtime?.shutdown();
    clientHandle.dispose();
  }
}
