import os from 'node:os';
import process from 'node:process';
import { getModelContextWindow } from '../../providers/model-catalog/catalog.js';
import { TOOL_NAME_ASK_USER } from '../../tools/tool-names.js';
import type { UsageAccumulator } from '../../utils/ai/token-usage.js';
import type { PendingApproval } from '../../contracts/conversation.js';
import type { ConversationOrchestrator } from '../conversation/conversation-orchestrator.js';
import type { ConversationService } from '../conversation/conversation-service.js';
import { getAskUserQuestions } from '../session/pending-interaction-state.js';
import type { SettingsService } from '../settings/settings-service.js';
import {
  projectControlPhase,
  type ControlSessionPort,
  type ControlSocketServer,
  type ControlTopic,
} from './control-socket.js';

export interface ControlSessionMetadata {
  workspaceRoot: string | null;
  version: string;
  createdAt: string;
  logPath: string;
}

export function createControlSessionPort(input: {
  conversationService: ConversationService;
  orchestrator: ConversationOrchestrator;
  settingsService: SettingsService;
  usageAccumulator: UsageAccumulator;
  controlSocket: ControlSocketServer;
  addSystemMessage?: (text: string) => void;
  cancelAskUser?: () => void;
  stopProcessing?: () => void;
  stopProcessingWithNotice?: () => void;
  sessionMetadata: () => ControlSessionMetadata;
}): ControlSessionPort {
  const { conversationService, orchestrator, settingsService, usageAccumulator, controlSocket } = input;
  const contextWindow = () => {
    const provider = settingsService.get('agent.provider');
    const model = settingsService.get('agent.model');
    return provider && model ? getModelContextWindow(provider, model) ?? null : null;
  };
  const toolCalls = () => conversationService.getUnsettledToolExecutions();
  const mutate = async (
    text: string,
    busyMode: 'steer' | 'follow_up',
    onSteerSettled?: () => void,
  ): Promise<import('./control-socket.js').ControlMutationReceipt> => {
    const large = conversationService.previewLargeUncachedInput(text);
    const surge = conversationService.previewInputSurge(text);
    if (large.action !== 'allow' || surge.action !== 'allow') {
      return { delivery: 'rejected', reason: 'needs_confirmation' };
    }
    return new Promise((resolve, reject) => {
      let admissionReported = false;
      const send = orchestrator.sendUserMessage(text, {
        busyMode,
        onSteerSettled,
        onAdmitted: (messageId, delivery) => {
          if (admissionReported) return;
          admissionReported = true;
          input.addSystemMessage?.(`Control ${busyMode === 'steer' ? 'steer' : 'submit'} ${messageId}`);
          resolve({ messageId, delivery });
        },
      });
      void send.then(() => {
        if (!admissionReported) {
          admissionReported = true;
          resolve({ delivery: 'rejected', reason: 'not_admitted' });
        }
      }, reject);
    });
  };
  return {
    submit: ({ text }) => mutate(text, 'follow_up'),
    steer: ({ text, onSteerSettled }) => mutate(text, 'steer', onSteerSettled),
    interrupt: async () => {
      const pending = conversationService.getPendingInteractionSnapshot();
      const nested = conversationService.getNestedApprovalSnapshot();
      if (pending?.approval.toolName === 'ask_user') input.cancelAskUser?.();
      else if (nested || pending) input.stopProcessing?.();
      else if (orchestrator.isTurnActive() || conversationService.isQueueOwningSubmissions()) {
        input.stopProcessingWithNotice?.();
      } else return { accepted: false, reason: 'idle' };
      return { accepted: true };
    },
    status: () => {
      const pending = conversationService.getPendingInteractionSnapshot();
      const nested = conversationService.getNestedApprovalSnapshot();
      const projection = projectControlPhase({
        foregroundToolName: pending?.approval.toolName,
        hasNestedApproval: !pending && nested !== null,
        activeTurn: orchestrator.isTurnActive(),
        queueOwnsSubmissions: conversationService.isQueueOwningSubmissions(),
        queueActive: conversationService.isQueueActive(),
      });
      const calls = toolCalls();
      return {
        ...projection,
        queueStateKind: conversationService.queueStateKind(),
        sessionId: conversationService.sessionId,
        queue: orchestrator.listOutstandingSubmissions().map((submission) => ({
          ...submission,
          text: submission.text.slice(0, 500),
        })),
        currentTool: calls[0] ?? null,
        context: { contextWindow: contextWindow(), promptTokens: null },
        cost: orchestrator.getCostSummary(),
        model: settingsService.get('agent.model') ?? null,
        provider: settingsService.get('agent.provider') ?? null,
        reasoningEffort: settingsService.get('agent.reasoningEffort') ?? null,
      };
    },
    get: (topic: ControlTopic) => {
      if (topic === 'session') {
        return {
          sessionId: conversationService.sessionId,
          socketName: controlSocket.name,
          pid: process.pid,
          host: os.hostname(),
          cwd: process.cwd(),
          ...input.sessionMetadata(),
          startedAt: controlSocket.startedAt,
          profileId: settingsService.get('app.activeProfileId') ?? null,
        };
      }
      if (topic === 'model') {
        return {
          provider: settingsService.get('agent.provider') ?? null,
          model: settingsService.get('agent.model') ?? null,
          reasoningEffort: settingsService.get('agent.reasoningEffort') ?? null,
          autoApproveMode: settingsService.get('shell.autoApproveMode') ?? null,
        };
      }
      if (topic === 'usage') {
        const usage = usageAccumulator.get();
        return {
          cumulative: {
            prompt_tokens: usage.prompt_tokens ?? 0,
            completion_tokens: usage.completion_tokens ?? 0,
            cache_read_tokens: usage.cache_read_tokens ?? 0,
            cache_creation_tokens: usage.cache_creation_tokens ?? 0,
          },
          contextWindow: contextWindow(),
          cost: orchestrator.getCostSummary(),
          lastRequest: null,
        };
      }
      if (topic === 'pending') return getPendingSnapshot(conversationService);
      if (topic === 'tools') return { calls: toolCalls() };
      return {
        tasks: conversationService.backgroundTaskControl
          .listDetails()
          .slice(0, 32)
          .map((task) => ({
            kind: task.kind,
            id: task.id,
            status: task.status,
            startedAt: task.startedAt,
            labelExcerpt: (task.kind === 'subagent' ? task.taskPreview : task.command).slice(0, 500),
          })),
      };
    },
  };
}

function getPendingSnapshot(conversationService: ConversationService) {
  const pending = conversationService.getPendingInteractionSnapshot();
  const nested = conversationService.getNestedApprovalSnapshot();
  return {
    foreground: pending
      ? {
          interactionId: pending.interactionId,
          revision: pending.revision,
          toolName: pending.approval.toolName,
          callId: pending.approval.callId,
          checkIn: pending.approval.checkIn ?? false,
          currentAskUserQuestionIndex: pending.currentAskUserQuestionIndex,
          argumentsExcerpt: pending.approval.argumentsText.slice(0, 500),
          ...(pending.approval.toolName === TOOL_NAME_ASK_USER
            ? { questions: projectAskUserQuestions(pending.approval) }
            : {}),
        }
      : null,
    nested: nested
      ? {
          requestId: nested.requestId,
          nestedCallId: nested.nestedCallId,
          toolName: nested.approval.toolName,
          argumentsExcerpt: nested.approval.argumentsText.slice(0, 500),
        }
      : null,
  };
}

function projectAskUserQuestions(approval: PendingApproval): {
  question: string;
  options: { label: string }[];
  is_multi_select: boolean;
}[] {
  return getAskUserQuestions(approval)
    .slice(0, 5)
    .flatMap((item) => {
      if (typeof item.question !== 'string') return [];
      return [
        {
          question: item.question,
          options: (Array.isArray(item.options) ? item.options : [])
            .slice(0, 8)
            .flatMap((option: any) =>
              option && typeof option.label === 'string' ? [{ label: option.label.slice(0, 80) }] : [],
            ),
          is_multi_select: item.is_multi_select === true,
        },
      ];
    });
}
