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
import { pruneStaleTempArtifacts } from './utils/shell/temp-sweep.js';
import { primeActiveProfileNoticeIfActive } from './services/mode-notices.js';
import { formatBackgroundSubagentNotifications } from './services/conversation/conversation-orchestrator.js';
import type { BackgroundSubagentNotificationPort } from './services/subagents/subagent-notification-store.js';

export const DEFAULT_NON_INTERACTIVE_BACKGROUND_WAIT_MS = 5 * 60 * 1000;
const MAX_NON_INTERACTIVE_BACKGROUND_WAIT_MS = 24 * 60 * 60 * 1000;

export interface NonInteractiveOutstandingWork {
  id: string;
  kind: string;
  status: string;
  name?: string;
  role?: string;
  task?: string;
}

export interface NonInteractiveBackgroundWork {
  notifications: BackgroundSubagentNotificationPort & {
    setObserver?: (observer: (() => void) | null) => void;
  };
  getOutstanding: () => readonly NonInteractiveOutstandingWork[];
  cancel: () => void;
}

export interface NonInteractiveConfig {
  prompt: string;
  autoApprove: boolean;
  quiet?: boolean;
  showReasoning?: boolean;
  json?: boolean;
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
  /** Internal/runtime seam for draining work that outlives the launch turn. */
  backgroundWork?: NonInteractiveBackgroundWork;
  /** Overall bound for waiting on background work; defaults to five minutes. */
  backgroundWaitTimeoutMs?: number;
  /** Abort the active foreground turn when the process receives a signal. */
  abort?: () => void;
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

const normalizeBackgroundWaitTimeout = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_NON_INTERACTIVE_BACKGROUND_WAIT_MS;
  if (!Number.isFinite(value)) return DEFAULT_NON_INTERACTIVE_BACKGROUND_WAIT_MS;
  return Math.min(MAX_NON_INTERACTIVE_BACKGROUND_WAIT_MS, Math.max(1, Math.floor(value)));
};

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

const formatToolSummary = (toolName: string, args: unknown): string => {
  if (!args || typeof args !== 'object') {
    return `[tool] ${toolName}`;
  }
  const obj = args as Record<string, unknown>;
  if (toolName === 'shell' || toolName === 'bash') {
    if (typeof obj.command === 'string') {
      return `[tool] ${toolName}: ${safePreview(obj.command, 80)}`;
    }
  }
  if (
    toolName === 'read_file' ||
    toolName === 'create_file' ||
    toolName === 'write_to_file' ||
    toolName === 'replace_file_content' ||
    toolName === 'search_replace' ||
    toolName === 'apply_patch'
  ) {
    const file = obj.TargetFile || obj.targetFile || obj.path || obj.filePath || obj.file;
    if (typeof file === 'string') {
      return `[tool] ${toolName}: ${file}`;
    }
  }
  if (toolName === 'grep_search' || toolName === 'search_web') {
    const q = obj.Query || obj.query;
    if (typeof q === 'string') {
      return `[tool] ${toolName}: ${safePreview(q, 60)}`;
    }
  }
  if (toolName === 'find_by_name' || toolName === 'list_dir') {
    const dirOrPattern = obj.Pattern || obj.DirectoryPath || obj.path || obj.SearchPath;
    if (typeof dirOrPattern === 'string') {
      return `[tool] ${toolName}: ${dirOrPattern}`;
    }
  }
  const firstStr = Object.values(obj).find((v) => typeof v === 'string') as string | undefined;
  if (firstStr) {
    return `[tool] ${toolName}: ${safePreview(firstStr, 60)}`;
  }
  return `[tool] ${toolName}`;
};

const formatEventForStderr = (event: ConversationEvent, quiet = false): string | null => {
  if (event.type === 'error') {
    return `error ${event.message}\n`;
  }
  if (quiet) {
    return null;
  }
  switch (event.type) {
    case 'tool_started':
      return `${formatToolSummary(event.toolName, event.arguments)}\n`;
    case 'subagent_tool_started':
      return `[subagent: ${event.role}] ${formatToolSummary(event.toolName, event.arguments).replace(
        /^\[tool\]\s*/,
        '',
      )}\n`;
    case 'command_message':
      return null;
    case 'approval_required':
      return `[approval required] ${event.approval.toolName}\n`;
    case 'retry':
      if (event.retryType === 'flex_service_tier') {
        return `[retry] service_tier: ${event.errorMessage}\n`;
      }
      return `[retry] ${event.toolName} (${event.attempt}/${event.maxRetries}): ${event.errorMessage}\n`;
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
    if (config.json) {
      stdout.write(JSON.stringify(event) + '\n');
      return;
    }

    if (event.type === 'text_delta') {
      streamedTextLength += event.delta.length;
      stdout.write(event.delta);
      return;
    }

    if (event.type === 'reasoning_delta') {
      if (config.showReasoning) {
        stderr.write(event.delta);
      }
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

    const line = formatEventForStderr(event, config.quiet);
    if (line) {
      stderr.write(line);
    }
  };

  const backgroundWork = config.backgroundWork;
  const backgroundWaitTimeoutMs = normalizeBackgroundWaitTimeout(config.backgroundWaitTimeoutMs);
  let receivedSignal: NodeJS.Signals | null = null;
  let backgroundCancellationRequested = false;
  let wakeBackgroundWaiter: (() => void) | null = null;
  const cancelBackgroundWork = (): void => {
    config.abort?.();
    if (backgroundWork && !backgroundCancellationRequested) {
      backgroundCancellationRequested = true;
      backgroundWork.cancel();
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (receivedSignal) return;
    receivedSignal = signal;
    cancelBackgroundWork();
    wakeBackgroundWaiter?.();
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  if (backgroundWork) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    backgroundWork.notifications.setObserver?.(() => wakeBackgroundWaiter?.());
  }

  const reportBackgroundFailure = (
    code: 'background_work_timeout' | 'background_work_interrupted',
    outstanding: readonly NonInteractiveOutstandingWork[],
  ): number => {
    const signal = receivedSignal ?? undefined;
    const message = signal
      ? 'Background work interrupted by ' + signal + '; unfinished work was cancelled.'
      : 'Background work did not finish within ' + backgroundWaitTimeoutMs + 'ms; unfinished work was cancelled.';
    const payload = {
      type: 'error',
      code,
      error: message,
      ...(signal ? { signal } : {}),
      outstanding,
      pendingNotifications: backgroundWork?.notifications.pendingCount ?? 0,
    };
    config.logger?.warn('Non-interactive background work did not finish', {
      eventType: code,
      category: 'subagent',
      ...payload,
    });
    if (config.json) {
      stdout.write(JSON.stringify(payload) + '\n');
    } else {
      const details = outstanding.map((work) => work.kind + ' ' + work.id + ' (' + work.status + ')').join(', ');
      stderr.write('error ' + message + ' Outstanding: ' + (details || 'none') + '\n');
    }
    return 1;
  };

  try {
    type SendResult = Awaited<ReturnType<ConversationSessionLike['sendMessage']>>;
    type ApprovalResult = Awaited<ReturnType<ConversationSessionLike['handleApprovalDecision']>>;

    const supportsPersistentEventSink = typeof session.setEventSink === 'function';
    if (supportsPersistentEventSink) {
      session.setEventSink!(onEvent);
    }

    const sendTurn = async (
      input: string,
      suppressUserMessageDisplay = false,
    ): Promise<SendResult | ApprovalResult> => {
      streamedTextLength = 0;
      return supportsPersistentEventSink
        ? await session.sendMessage(input, suppressUserMessageDisplay ? { suppressUserMessageDisplay } : undefined)
        : await session.sendMessage(input, { onEvent, suppressUserMessageDisplay } as any);
    };

    const sendTurnAndResolveApprovals = async (
      input: string,
      suppressUserMessageDisplay = false,
    ): Promise<SendResult | ApprovalResult | null> => {
      let result: SendResult | ApprovalResult = await sendTurn(input, suppressUserMessageDisplay);
      while (result?.type === 'approval_required') {
        const decision = await approvalPolicy.decide({
          autoApprove: config.autoApprove,
          approval: result.approval,
          getHistory: () => session.exportState?.().history ?? [],
        });
        const rejectionReason = decision.answer === 'n' ? decision.rejectionReason : undefined;
        if (decision.answer === 'n' && decision.reportRejection) {
          if (config.json) {
            stdout.write(JSON.stringify({ type: 'approval_rejected', reason: rejectionReason }) + '\n');
          } else {
            stderr.write('Approval Rejected: ' + rejectionReason + '\n');
          }
        }
        result = supportsPersistentEventSink
          ? await session.handleApprovalDecision(decision.answer, rejectionReason)
          : await session.handleApprovalDecision(decision.answer, rejectionReason, { onEvent } as any);

        if (result === null) {
          if (config.json) {
            stdout.write(
              JSON.stringify({
                type: 'error',
                error: 'No pending approval context (unexpected in non-interactive mode).',
              }) + '\n',
            );
          } else {
            stderr.write('error No pending approval context (unexpected in non-interactive mode).\n');
          }
          return null;
        }
      }
      return result;
    };

    let result = await sendTurnAndResolveApprovals(config.prompt);
    if (result === null) return 1;

    if (result?.type === 'response') {
      if (backgroundWork) {
        const deadline = Date.now() + backgroundWaitTimeoutMs;
        while (true) {
          if (receivedSignal) {
            const outstanding = backgroundWork.getOutstanding();
            cancelBackgroundWork();
            return reportBackgroundFailure('background_work_interrupted', outstanding);
          }

          const outstanding = backgroundWork.getOutstanding();
          if (backgroundWork.notifications.pendingCount > 0) {
            const notifications = backgroundWork.notifications.drain();
            if (notifications.length > 0) {
              const remainingForTurn = deadline - Date.now();
              if (remainingForTurn <= 0) {
                cancelBackgroundWork();
                return reportBackgroundFailure('background_work_timeout', outstanding);
              }
              let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
              const notificationResult = await Promise.race([
                sendTurnAndResolveApprovals(formatBackgroundSubagentNotifications(notifications), true).then(
                  (value) => ({ timedOut: false as const, value }),
                ),
                new Promise<{ timedOut: true }>((resolve) => {
                  timeoutHandle = setTimeout(() => resolve({ timedOut: true }), remainingForTurn);
                }),
              ]);
              if (timeoutHandle) clearTimeout(timeoutHandle);
              if (notificationResult.timedOut) {
                cancelBackgroundWork();
                return reportBackgroundFailure('background_work_timeout', backgroundWork.getOutstanding());
              }
              result = notificationResult.value;
              if (result === null) return 1;
              if (result?.type !== 'response') {
                if (config.json) {
                  stdout.write(JSON.stringify({ type: 'error', error: 'Unexpected conversation result.' }) + '\n');
                } else {
                  stderr.write('error Unexpected conversation result.\n');
                }
                return 1;
              }
              continue;
            }
          }
          if (outstanding.length === 0) break;
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            cancelBackgroundWork();
            return reportBackgroundFailure('background_work_timeout', outstanding);
          }

          const woke = await new Promise<'woke' | 'deadline'>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              wakeBackgroundWaiter = null;
              resolve('deadline');
            }, remainingMs);
            wakeBackgroundWaiter = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              wakeBackgroundWaiter = null;
              resolve('woke');
            };
          });
          if (woke === 'deadline') {
            const stillOutstanding = backgroundWork.getOutstanding();
            cancelBackgroundWork();
            return reportBackgroundFailure('background_work_timeout', stillOutstanding);
          }
        }
      }
      if (config.json) {
        stdout.write(JSON.stringify({ type: 'completed', finalText: result.finalText }) + '\n');
      } else {
        stdout.write('\n');
      }
      return 0;
    }

    if (config.json) {
      stdout.write(JSON.stringify({ type: 'error', error: 'Unexpected conversation result.' }) + '\n');
    } else {
      stderr.write('error Unexpected conversation result.\n');
    }
    return 1;
  } catch (error) {
    if (receivedSignal && backgroundWork) {
      return reportBackgroundFailure('background_work_interrupted', backgroundWork.getOutstanding());
    }
    const message = error instanceof Error ? error.message : String(error);
    if (config.json) {
      stdout.write(JSON.stringify({ type: 'error', error: message }) + '\n');
    } else {
      stderr.write(`error ${message}\n`);
    }
    return 1;
  } finally {
    if (backgroundWork) {
      backgroundWork.notifications.setObserver?.(null);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
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
  // Non-blocking sweep of dead-PID and stale temp artifacts from prior sessions.
  void pruneStaleTempArtifacts().catch(() => {});

  const clientFactory =
    config.sessionClientFactory ?? createCallerOwnedSessionClientFactory(config.agentClient!, config.toolOwnership!);
  const sessionId = createNonInteractiveSessionId();
  const clientHandle = clientFactory.create(sessionId, { allowBackgroundShell: false, allowAskUser: false });
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
    // run_subagent expresses the supported background capability through its
    // execution parameter. It is deliberately allowed here; runWithSession
    // owns the wait/notification lifecycle instead of rejecting the launch.
    if (name === 'run_subagent') {
      const execution =
        params !== null && typeof params === 'object' && !Array.isArray(params)
          ? (params as { execution?: unknown }).execution
          : undefined;
      if (execution === 'background') return null;
      // Foreground is also governed by the tool schema/capability; neither
      // parameterized execution mode is rejected by this lifecycle guard.
      return null;
    }
    // This is the legacy standalone async tool name, not the parameterized
    // run_subagent capability above, and remains unavailable headlessly.
    if (name === 'run_subagent_async') {
      return 'Error: Asynchronous subagent execution is unavailable in non-interactive mode. Use synchronous run_subagent instead.';
    }
    if (name === 'ask_user') {
      return 'Error: ask_user is unavailable in non-interactive mode.';
    }
    return null;
  });

  let runtime: ReturnType<typeof createConversationRuntime>['runtime'] | undefined;
  let fatal = false;
  try {
    const createdRuntime = createConversationRuntime({
      sessionId,
      enableNestedApproval: false,
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
    if (config.settingsService) {
      primeActiveProfileNoticeIfActive(config.settingsService, (text) => {
        createdRuntime.runtime.state.queueModeNotice(text);
      });
    }
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
      abort: () => clientHandle.agentClient.abort(),
      backgroundWork: {
        notifications: createdRuntime.runtime.backgroundSubagentNotifications,
        getOutstanding: () =>
          createdRuntime.runtime.backgroundTaskControl
            .listDetails()
            .filter((details) => details.status === 'running' || details.status === 'cancelling')
            .map((details) =>
              details.kind === 'subagent'
                ? {
                    id: details.id,
                    kind: details.kind,
                    status: details.status,
                    ...(details.name === undefined ? {} : { name: details.name }),
                    role: details.role,
                    task: details.task,
                  }
                : { id: details.id, kind: details.kind, status: details.status },
            ),
        cancel: () => {
          clientHandle.agentClient.cancelBackgroundRuns?.();
          clientHandle.agentClient.cancelBackgroundShellJobs?.();
        },
      },
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
