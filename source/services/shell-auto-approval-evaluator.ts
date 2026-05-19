import type { AgentInputItem } from '@openai/agents';
import type { LLMAdvisory } from '../contracts/conversation.js';
import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import { classifyCommandDetailed, SafetyStatus } from '../utils/command-safety/index.js';
import type { ILoggingService, ISettingsService } from './service-interfaces.js';
import {
  SHELL_AUTO_APPROVAL_INSTRUCTIONS,
  SHELL_AUTO_APPROVAL_PROMPT_VERSION,
} from '../prompts/shell-auto-approval.js';

export type ShellAutoApprovalCommand = {
  id: string;
  command: string;
};

export type ShellAutoApprovalAdvisory = LLMAdvisory;

export { SHELL_AUTO_APPROVAL_PROMPT_VERSION };

const MAX_HISTORY_ITEMS = 8;
const MAX_CONTEXT_CHARS = 3_000;
const MAX_MESSAGE_CHARS = 500;

const truncate = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
};

const asRecord = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, any>) : undefined;

const extractTextContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
};

const getCompactHistoryLine = (item: AgentInputItem): string | undefined => {
  const record = asRecord(item);
  const raw = asRecord(record?.rawItem) ?? record;
  if (!raw) return undefined;

  const type = typeof raw.type === 'string' ? raw.type : 'item';
  const role = typeof raw.role === 'string' ? raw.role : undefined;

  if (role === 'user' || role === 'assistant') {
    const text = extractTextContent(raw.content);
    if (!text.trim()) return `[${role}] (${type})`;
    return `[${role}] ${truncate(text.replace(/\s+/g, ' ').trim(), MAX_MESSAGE_CHARS)}`;
  }

  return undefined;
};

const buildCompactHistoryContext = (history: AgentInputItem[]): string => {
  const lines = history
    .slice(-MAX_HISTORY_ITEMS)
    .map(getCompactHistoryLine)
    .filter((line): line is string => !!line);

  const text = lines.length > 0 ? lines.join('\n') : '(no recent conversation context)';
  return truncate(text, MAX_CONTEXT_CHARS);
};

const buildRedSystemReasoning = (detail: string, llmReasoning?: string): string => {
  const base = `Blocked by safety heuristics (RED): ${detail}. Manual approval is strictly required.`;
  return llmReasoning ? `${base}\n\nModel advisory: ${llmReasoning}` : base;
};

const buildPrompt = (commands: ShellAutoApprovalCommand[], history: AgentInputItem[]): string => {
  const historyText = buildCompactHistoryContext(history);

  const commandsToEvaluateText = commands.map((c, i) => `[Command ${i + 1}]\n${c.command}`).join('\n\n');

  return `Task context (compact recent user and assistant messages; reasoning and tool items are omitted):
${historyText}

Commands to evaluate:
${commandsToEvaluateText}`;
};

export async function evaluateShellAutoApprovalAdvisories({
  commands,
  history,
  settingsService,
  agentClient,
  logger,
  throwOnError = false,
}: {
  commands: ShellAutoApprovalCommand[];
  history: AgentInputItem[];
  settingsService?: ISettingsService;
  agentClient: Pick<OpenAIAgentClient, 'chat'>;
  logger: ILoggingService;
  throwOnError?: boolean;
}): Promise<Map<string, ShellAutoApprovalAdvisory>> {
  const out = new Map<string, ShellAutoApprovalAdvisory>();
  if (!settingsService) return out;

  const mode = settingsService.get<'off' | 'advisory' | 'auto'>('shell.autoApproveMode');
  if (mode === 'off') return out;

  const autoApproveModel = settingsService.get<string>('agent.autoApproveModel');
  const autoApproveProvider = settingsService.get<string>('agent.autoApproveProvider');

  const toEvaluateByLLM: ShellAutoApprovalCommand[] = [];
  const redSafetyDetails = new Map<string, string>();
  for (const { id, command } of commands) {
    try {
      const { status: safetyStatus, reasons } = classifyCommandDetailed(command, logger);
      if (safetyStatus === SafetyStatus.RED) {
        const detail = reasons.length > 0 ? reasons.join('; ') : 'matched a dangerous pattern';
        redSafetyDetails.set(id, detail);
      }
    } catch {
      // Ignore parsing errors for LLM check fallback
    }
    toEvaluateByLLM.push({ id, command });
  }

  if (toEvaluateByLLM.length === 0) return out;

  const instructions = SHELL_AUTO_APPROVAL_INSTRUCTIONS;
  const prompt = buildPrompt(toEvaluateByLLM, history);

  try {
    logger.debug('Shell auto-approval evaluation request', {
      eventType: 'evaluator.request.started',
      direction: 'sent',
      provider: autoApproveProvider,
      model: autoApproveModel,
      payload: {
        prompt,
        instructions,
      },
    });

    const responseText = await agentClient.chat(prompt, {
      model: autoApproveModel,
      provider: autoApproveProvider,
      reasoningEffort: 'none',
      instructions,
    });

    logger.debug('Shell auto-approval evaluation response', {
      eventType: 'evaluator.response.received',
      direction: 'received',
      provider: autoApproveProvider,
      model: autoApproveModel,
      payload: { response: responseText },
    });

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.results) && parsed.results.length === toEvaluateByLLM.length) {
        for (const [index, res] of parsed.results.entries()) {
          const command = toEvaluateByLLM[index];
          if (
            command &&
            typeof res.reasoning === 'string' &&
            typeof res.approved === 'boolean' &&
            !out.has(command.id)
          ) {
            const redDetail = redSafetyDetails.get(command.id);
            if (redDetail) {
              out.set(command.id, {
                model: autoApproveModel,
                reasoning: buildRedSystemReasoning(redDetail, res.reasoning),
                approved: false,
                source: 'system',
              });
              continue;
            }

            out.set(command.id, {
              model: autoApproveModel,
              reasoning: res.reasoning,
              approved: res.approved,
              source: 'llm',
            });
          }
        }
      }
    }

    for (const { id } of toEvaluateByLLM) {
      if (!out.has(id)) {
        const redDetail = redSafetyDetails.get(id);
        if (redDetail) {
          out.set(id, {
            model: autoApproveModel,
            reasoning: buildRedSystemReasoning(redDetail),
            approved: false,
            source: 'system',
          });
          continue;
        }

        out.set(id, {
          model: autoApproveModel,
          reasoning: 'LLM did not provide a valid ordered evaluation for this command.',
          approved: false,
          source: 'llm',
        });
      }
    }
  } catch (error) {
    logger.error('Batch auto-approval evaluation failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    if (throwOnError) {
      throw error;
    }

    for (const { id } of toEvaluateByLLM) {
      if (!out.has(id)) {
        const redDetail = redSafetyDetails.get(id);
        if (redDetail) {
          out.set(id, {
            model: autoApproveModel,
            reasoning: buildRedSystemReasoning(redDetail),
            approved: false,
            source: 'system',
          });
          continue;
        }

        out.set(id, {
          model: autoApproveModel,
          reasoning: 'LLM evaluation encountered an error.',
          approved: false,
          source: 'llm',
          isError: true,
        });
      }
    }
  }

  return out;
}
