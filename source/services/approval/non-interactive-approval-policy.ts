import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import { classifyCommandDetailed } from '../../utils/shell/command-safety/index.js';
import { SafetyStatus } from '../../utils/shell/command-safety/constants.js';
import { evaluateShellAutoApprovalAdvisories } from './shell-auto-approval-evaluator.js';

export const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';

export type NonInteractiveApprovalDecision =
  | { answer: 'y' }
  | {
      answer: 'n';
      rejectionReason: string;
      /** Whether the non-interactive presenter should print the rejection. */
      reportRejection: boolean;
    };

export interface NonInteractiveApprovalPolicyDeps {
  settingsService?: ISettingsService;
  agentClient?: ConversationAgentClient;
  logger?: ILoggingService;
  sessionContextService: ISessionContextService;
}

const noOpLogger: ILoggingService = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

/**
 * Decides whether a tool approval paused in a non-interactive session can be
 * resumed. This is deliberately policy-only: callers retain the continuation
 * loop and their own output handling.
 */
export class NonInteractiveApprovalPolicy {
  constructor(private readonly deps: NonInteractiveApprovalPolicyDeps) {}

  async decide(input: {
    autoApprove: boolean;
    approval: ApprovalDescriptor;
    getHistory?: () => unknown[];
  }): Promise<NonInteractiveApprovalDecision> {
    if (!input.autoApprove) {
      return { answer: 'n', rejectionReason: NON_INTERACTIVE_REJECTION_REASON, reportRejection: false };
    }

    const { approval } = input;
    if (approval.toolName !== 'shell' && approval.toolName !== 'bash') {
      return { answer: 'y' };
    }

    const command = approval.argumentsText;
    const classification = classifyCommandDetailed(command, this.deps.logger);
    if (classification.status === SafetyStatus.RED) {
      return {
        answer: 'n',
        rejectionReason: `Heuristic validation failed: command is RED (dangerous) and cannot be executed automatically: ${command}`,
        reportRejection: true,
      };
    }

    if (classification.status !== SafetyStatus.YELLOW) {
      return { answer: 'y' };
    }

    const autoApproveModel =
      this.deps.settingsService && this.deps.agentClient
        ? this.deps.settingsService.get('agent.choreModel') ?? this.deps.settingsService.get('agent.autoApproveModel')
        : undefined;
    if (!autoApproveModel) {
      return {
        answer: 'n',
        rejectionReason: `Heuristic validation failed: command is YELLOW (suspicious) and no auto-approve model is configured: ${command}`,
        reportRejection: true,
      };
    }

    try {
      const callId = approval.callId || '__single__';
      const advisories = await evaluateShellAutoApprovalAdvisories({
        commands: [{ id: callId, command }],
        history: (input.getHistory?.() ?? []) as ProviderInputItem[],
        settingsService: this.deps.settingsService,
        agentClient: this.deps.agentClient!,
        logger: this.deps.logger ?? noOpLogger,
        sessionContextService: this.deps.sessionContextService,
      });
      const advisory = advisories.get(callId);
      if (advisory?.approved) {
        return { answer: 'y' };
      }
      return {
        answer: 'n',
        rejectionReason: `LLM evaluation rejected the command: ${advisory?.reasoning ?? 'No reasoning provided'}`,
        reportRejection: true,
      };
    } catch (error) {
      return {
        answer: 'n',
        rejectionReason: `LLM auto-approval evaluation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        reportRejection: true,
      };
    }
  }
}
