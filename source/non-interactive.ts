import type { OpenAIAgentClient } from './lib/openai-agent-client.js';
import type { ILoggingService, ISettingsService } from './services/service-interfaces.js';
import { ConversationSession } from './services/conversation-session.js';
import type { ConversationEvent } from './services/conversation-events.js';
import { classifyCommandDetailed } from './utils/command-safety/index.js';
import { SafetyStatus } from './utils/command-safety/constants.js';
import { evaluateShellAutoApprovalAdvisories } from './services/shell-auto-approval-evaluator.js';

export interface NonInteractiveConfig {
  prompt: string;
  autoApprove: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  settingsService?: ISettingsService;
  agentClient?: OpenAIAgentClient;
  logger?: ILoggingService;
}

export const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';

export interface ConversationSessionLike {
  sendMessage: ConversationSession['sendMessage'];
  handleApprovalDecision: ConversationSession['handleApprovalDecision'];
  exportState?: ConversationSession['exportState'];
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
    agentClient: OpenAIAgentClient;
    logger: ILoggingService;
    settingsService: ISettingsService;
  },
): Promise<number> {
  const session = new ConversationSession('non-interactive', {
    agentClient: config.agentClient,
    deps: { logger: config.logger, settingsService: config.settingsService },
  });

  return runWithSession(session, config);
}
