import type { AgentClient } from './lib/agent-client.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from './services/service-interfaces.js';
import { createConversationSession } from './services/session/session-composition.js';
import { SessionContextService } from './services/session/session-context-service.js';
import type { ConversationEvent } from './services/conversation/conversation-events.js';
import type { UserTurn } from './types/user-turn.js';
import type { ConversationTerminal } from './contracts/conversation.js';
import type {
  SendMessageOptions,
  HandleApprovalDecisionOptions,
} from './services/conversation/conversation-adapter.js';
import type { SavedToolExecution } from './services/tool-execution-ledger.js';
import { randomUUID } from 'node:crypto';
import { classifyCommandDetailed } from './utils/shell/command-safety/index.js';
import { SafetyStatus } from './utils/shell/command-safety/constants.js';
import { evaluateShellAutoApprovalAdvisories } from './services/approval/shell-auto-approval-evaluator.js';

export interface NonInteractiveConfig {
  prompt: string;
  autoApprove: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  settingsService?: ISettingsService;
  agentClient?: AgentClient;
  logger?: ILoggingService;
  sessionContextService?: ISessionContextService;
}

export const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';

export const createNonInteractiveSessionId = (): string => `non-interactive-${randomUUID()}`;

export interface ConversationSessionLike {
  sendMessage(input: string | UserTurn, options?: SendMessageOptions): Promise<ConversationTerminal>;
  handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    options?: HandleApprovalDecisionOptions,
  ): Promise<ConversationTerminal | null>;
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

  const onEvent = (event: ConversationEvent) => {
    if (event.type === 'text_delta') {
      stdout.write(event.delta);
      stderr.write(event.delta);
      return;
    }

    if (event.type === 'reasoning_delta') {
      stderr.write(event.delta);
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

    let result: SendResult | ApprovalResult = await session.sendMessage(config.prompt, { onEvent } as any);

    while (result?.type === 'approval_required') {
      if (config.autoApprove) {
        const approval = result.approval;
        let shouldApprove = true;
        let rejectionReason: string | undefined;

        if (approval.toolName === 'shell' || approval.toolName === 'bash') {
          const command = approval.argumentsText;
          const classification = classifyCommandDetailed(command, config.logger);

          if (classification.status === SafetyStatus.RED) {
            shouldApprove = false;
            rejectionReason = `Heuristic validation failed: command is RED (dangerous) and cannot be executed automatically: ${command}`;
          } else if (classification.status === SafetyStatus.YELLOW) {
            const autoApproveModel = config.settingsService?.get<string>('agent.autoApproveModel');
            if (!autoApproveModel) {
              shouldApprove = false;
              rejectionReason = `Heuristic validation failed: command is YELLOW (suspicious) and no auto-approve model is configured: ${command}`;
            } else {
              const history = session.exportState ? session.exportState().history : [];
              try {
                const advisories = await evaluateShellAutoApprovalAdvisories({
                  commands: [{ id: approval.callId || '__single__', command }],
                  history: history as any,
                  settingsService: config.settingsService,
                  agentClient: config.agentClient!,
                  logger:
                    config.logger ??
                    ({
                      debug: () => {},
                      info: () => {},
                      warn: () => {},
                      error: () => {},
                      security: () => {},
                    } as any),
                  sessionContextService,
                });
                const advisory = advisories.get(approval.callId || '__single__');
                if (advisory?.approved) {
                  shouldApprove = true;
                } else {
                  shouldApprove = false;
                  rejectionReason = `LLM evaluation rejected the command: ${
                    advisory?.reasoning ?? 'No reasoning provided'
                  }`;
                }
              } catch (err) {
                shouldApprove = false;
                rejectionReason = `LLM auto-approval evaluation failed: ${
                  err instanceof Error ? err.message : String(err)
                }`;
              }
            }
          }
        }

        if (shouldApprove) {
          result = await session.handleApprovalDecision('y', undefined, {
            onEvent,
          } as any);
        } else {
          stderr.write(`Approval Rejected: ${rejectionReason}\n`);
          result = await session.handleApprovalDecision('n', rejectionReason, {
            onEvent,
          } as any);
        }
      } else {
        result = await session.handleApprovalDecision('n', NON_INTERACTIVE_REJECTION_REASON, { onEvent } as any);
      }

      if (result === null) {
        stderr.write('error No pending approval context (unexpected in non-interactive mode).\n');
        return 1;
      }
    }

    if (result?.type === 'response') {
      stdout.write('\n');
      stderr.write('\n');
      return 0;
    }

    stderr.write('error Unexpected conversation result.\n');
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`error ${message}\n`);
    return 1;
  }
}

export async function runNonInteractive(
  config: NonInteractiveConfig & {
    agentClient: AgentClient;
    logger: ILoggingService;
    settingsService: ISettingsService;
  },
): Promise<number> {
  const sessionContextService = config.sessionContextService ?? new SessionContextService();
  const { terminalAdapter, dispose } = createConversationSession({
    sessionId: createNonInteractiveSessionId(),
    agentClient: config.agentClient,
    deps: {
      logger: config.logger,
      settingsService: config.settingsService,
      sessionContextService,
    },
  });

  try {
    return await runWithSession(terminalAdapter, { ...config, sessionContextService });
  } finally {
    dispose();
  }
}
