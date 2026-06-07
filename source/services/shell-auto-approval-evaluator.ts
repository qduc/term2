import type { AgentInputItem, JsonSchemaDefinition } from '@openai/agents';
import type { LLMAdvisory } from '../contracts/conversation.js';
import { executeWithRetry } from '../lib/retry-executor.js';
import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import { classifyCommandDetailed, SafetyStatus } from '../utils/command-safety/index.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from './service-interfaces.js';
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
const STRUCTURED_SUPPORT_CACHE_TTL_MS = 60 * 60 * 1_000;
const SHELL_AUTO_APPROVAL_UPSTREAM_RETRY_ATTEMPTS = 1;

type StructuredSupport = 'supported' | 'unsupported';

const structuredSupportCache = new Map<string, { value: StructuredSupport; expiresAt: number }>();

const SHELL_AUTO_APPROVAL_OUTPUT_SCHEMA: JsonSchemaDefinition = {
  type: 'json_schema',
  name: 'shell_auto_approval_evaluation',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reasoning: { type: 'string' },
            approved: { type: 'boolean' },
          },
          required: ['reasoning', 'approved'],
        },
      },
    },
    required: ['results'],
  },
};

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

  return `Task context:
${historyText}

Commands to evaluate:
${commandsToEvaluateText}`;
};

const buildRepairPrompt = (originalPrompt: string, invalidResponse: unknown, validationError: string): string => {
  const responseText = typeof invalidResponse === 'string' ? invalidResponse : JSON.stringify(invalidResponse);
  return `${originalPrompt}

The previous shell auto-approval response was invalid.
Validation error: ${validationError}
Invalid response: ${truncate(responseText ?? '', 2_000)}

Return the corrected JSON response only.`;
};

const getCacheKey = (provider: string, model: string): string => `${provider}:${model}`;

const getStructuredSupport = (provider: string, model: string): StructuredSupport | 'unknown' => {
  const cacheKey = getCacheKey(provider, model);
  const cached = structuredSupportCache.get(cacheKey);
  if (!cached) return 'unknown';
  if (cached.expiresAt <= Date.now()) {
    structuredSupportCache.delete(cacheKey);
    return 'unknown';
  }
  return cached.value;
};

const setStructuredSupport = (provider: string, model: string, value: StructuredSupport): void => {
  structuredSupportCache.set(getCacheKey(provider, model), {
    value,
    expiresAt: Date.now() + STRUCTURED_SUPPORT_CACHE_TTL_MS,
  });
};

const isUnsupportedStructuredOutputError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const mentionsStructuredOutput =
    lower.includes('structured output') ||
    lower.includes('structured outputs') ||
    lower.includes('response_format') ||
    lower.includes('json_schema') ||
    lower.includes('json schema');
  const indicatesUnsupported =
    lower.includes('unsupported') ||
    lower.includes('not supported') ||
    lower.includes('does not support') ||
    lower.includes('invalid parameter') ||
    lower.includes('unsupported parameter');
  return mentionsStructuredOutput && indicatesUnsupported;
};

type EvaluationResult = {
  reasoning: string;
  approved: boolean;
};

const parsePromptJson = (response: string): unknown => {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('response did not contain a JSON object');
  }
  return JSON.parse(jsonMatch[0]);
};

const validateEvaluationBatch = (value: unknown, expectedLength: number): EvaluationResult[] => {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.results)) {
    throw new Error('top-level results must be an array');
  }
  if (record.results.length !== expectedLength) {
    throw new Error(`results length ${record.results.length} did not match command count ${expectedLength}`);
  }

  return record.results.map((result: unknown, index: number) => {
    const resultRecord = asRecord(result);
    if (!resultRecord) {
      throw new Error(`result ${index + 1} must be an object`);
    }
    if (typeof resultRecord.reasoning !== 'string') {
      throw new Error(`result ${index + 1} reasoning must be a string`);
    }
    if (typeof resultRecord.approved !== 'boolean') {
      throw new Error(`result ${index + 1} approved must be a boolean`);
    }
    return {
      reasoning: resultRecord.reasoning,
      approved: resultRecord.approved,
    };
  });
};

const buildAdvisoriesFromResults = ({
  commands,
  results,
  redSafetyDetails,
  model,
}: {
  commands: ShellAutoApprovalCommand[];
  results: EvaluationResult[];
  redSafetyDetails: Map<string, string>;
  model: string;
}): Map<string, ShellAutoApprovalAdvisory> => {
  const out = new Map<string, ShellAutoApprovalAdvisory>();
  for (const [index, result] of results.entries()) {
    const command = commands[index];
    const redDetail = redSafetyDetails.get(command.id);
    if (redDetail) {
      out.set(command.id, {
        model,
        reasoning: buildRedSystemReasoning(redDetail, result.reasoning),
        approved: false,
        source: 'system',
      });
      continue;
    }

    out.set(command.id, {
      model,
      reasoning: result.reasoning,
      approved: result.approved,
      source: 'llm',
    });
  }
  return out;
};

const buildInvalidEvaluationAdvisories = ({
  commands,
  redSafetyDetails,
  model,
  reasoning,
  isError,
}: {
  commands: ShellAutoApprovalCommand[];
  redSafetyDetails: Map<string, string>;
  model: string;
  reasoning: string;
  isError?: boolean;
}): Map<string, ShellAutoApprovalAdvisory> => {
  const out = new Map<string, ShellAutoApprovalAdvisory>();
  for (const { id } of commands) {
    const redDetail = redSafetyDetails.get(id);
    if (redDetail) {
      out.set(id, {
        model,
        reasoning: buildRedSystemReasoning(redDetail),
        approved: false,
        source: 'system',
      });
      continue;
    }

    out.set(id, {
      model,
      reasoning,
      approved: false,
      source: 'llm',
      ...(isError ? { isError: true } : {}),
    });
  }
  return out;
};

export async function evaluateShellAutoApprovalAdvisories({
  commands,
  history,
  settingsService,
  agentClient,
  logger,
  sessionContextService,
  throwOnError = false,
  retryOptions,
}: {
  commands: ShellAutoApprovalCommand[];
  history: AgentInputItem[];
  settingsService?: ISettingsService;
  agentClient: Pick<OpenAIAgentClient, 'chat'> & Partial<Pick<OpenAIAgentClient, 'chatJson'>>;
  logger: ILoggingService;
  sessionContextService: ISessionContextService;
  throwOnError?: boolean;
  retryOptions?: {
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  };
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
    const currentContext = sessionContextService.getContext();
    const evaluatorContext = currentContext ? { ...currentContext, evaluator: true as const } : null;

    const runPromptChat = (message: string) =>
      agentClient.chat(message, {
        model: autoApproveModel,
        provider: autoApproveProvider,
        reasoningEffort: 'none',
        instructions,
      });

    const runStructuredChat = (message: string) => {
      if (!agentClient.chatJson) {
        throw new Error('structured chatJson is not available');
      }
      return agentClient.chatJson(message, {
        model: autoApproveModel,
        provider: autoApproveProvider,
        reasoningEffort: 'none',
        instructions,
        outputType: SHELL_AUTO_APPROVAL_OUTPUT_SCHEMA,
      });
    };

    const runWithContext = async <T>(fn: () => Promise<T>): Promise<T> =>
      evaluatorContext ? await sessionContextService.runWithContext(evaluatorContext, fn) : await fn();

    const runWithUpstreamRetry = async <T>(operation: () => Promise<T>): Promise<T> =>
      executeWithRetry({
        operation,
        retryAttempts: SHELL_AUTO_APPROVAL_UPSTREAM_RETRY_ATTEMPTS,
        provider: autoApproveProvider,
        model: autoApproveModel,
        traceId: logger.getCorrelationId?.(),
        logger,
        ...(retryOptions?.sleep ? { sleep: retryOptions.sleep } : {}),
        ...(retryOptions?.random ? { random: retryOptions.random } : {}),
      });

    const tryPromptMode = async (): Promise<Map<string, ShellAutoApprovalAdvisory>> => {
      let responseText = await runWithContext(() => runWithUpstreamRetry(() => runPromptChat(prompt)));
      logger.debug('Shell auto-approval evaluation response', {
        eventType: 'evaluator.response.received',
        direction: 'received',
        provider: autoApproveProvider,
        model: autoApproveModel,
        payload: { response: responseText, structured: false },
      });

      try {
        const parsed = parsePromptJson(responseText);
        const results = validateEvaluationBatch(parsed, toEvaluateByLLM.length);
        return buildAdvisoriesFromResults({
          commands: toEvaluateByLLM,
          results,
          redSafetyDetails,
          model: autoApproveModel,
        });
      } catch (validationError) {
        const repairPrompt = buildRepairPrompt(
          prompt,
          responseText,
          validationError instanceof Error ? validationError.message : String(validationError),
        );
        responseText = await runWithContext(() =>
          runWithUpstreamRetry(() =>
            agentClient.chat(repairPrompt, {
              model: autoApproveModel,
              provider: autoApproveProvider,
              reasoningEffort: 'none',
              instructions,
            }),
          ),
        );
        logger.debug('Shell auto-approval repair response', {
          eventType: 'evaluator.response.received',
          direction: 'received',
          provider: autoApproveProvider,
          model: autoApproveModel,
          payload: { response: responseText, structured: false, repair: true },
        });

        try {
          const repaired = parsePromptJson(responseText);
          const results = validateEvaluationBatch(repaired, toEvaluateByLLM.length);
          return buildAdvisoriesFromResults({
            commands: toEvaluateByLLM,
            results,
            redSafetyDetails,
            model: autoApproveModel,
          });
        } catch {
          return buildInvalidEvaluationAdvisories({
            commands: toEvaluateByLLM,
            redSafetyDetails,
            model: autoApproveModel,
            reasoning: 'LLM did not provide a valid ordered evaluation for this command.',
          });
        }
      }
    };

    const tryStructuredMode = async (): Promise<Map<string, ShellAutoApprovalAdvisory>> => {
      let response: unknown = await runWithContext(() => runWithUpstreamRetry(() => runStructuredChat(prompt)));
      setStructuredSupport(autoApproveProvider, autoApproveModel, 'supported');
      logger.debug('Shell auto-approval evaluation response', {
        eventType: 'evaluator.response.received',
        direction: 'received',
        provider: autoApproveProvider,
        model: autoApproveModel,
        payload: { response, structured: true },
      });

      try {
        const parsed = typeof response === 'string' ? parsePromptJson(response) : response;
        const results = validateEvaluationBatch(parsed, toEvaluateByLLM.length);
        return buildAdvisoriesFromResults({
          commands: toEvaluateByLLM,
          results,
          redSafetyDetails,
          model: autoApproveModel,
        });
      } catch (validationError) {
        const repairPrompt = buildRepairPrompt(
          prompt,
          response,
          validationError instanceof Error ? validationError.message : String(validationError),
        );
        response = await runWithContext(() => runWithUpstreamRetry(() => runStructuredChat(repairPrompt)));
        logger.debug('Shell auto-approval repair response', {
          eventType: 'evaluator.response.received',
          direction: 'received',
          provider: autoApproveProvider,
          model: autoApproveModel,
          payload: { response, structured: true, repair: true },
        });

        try {
          const repaired = typeof response === 'string' ? parsePromptJson(response) : response;
          const results = validateEvaluationBatch(repaired, toEvaluateByLLM.length);
          return buildAdvisoriesFromResults({
            commands: toEvaluateByLLM,
            results,
            redSafetyDetails,
            model: autoApproveModel,
          });
        } catch {
          return buildInvalidEvaluationAdvisories({
            commands: toEvaluateByLLM,
            redSafetyDetails,
            model: autoApproveModel,
            reasoning: 'LLM did not provide a valid ordered evaluation for this command.',
          });
        }
      }
    };

    const shouldTryStructured =
      !!agentClient.chatJson && getStructuredSupport(autoApproveProvider, autoApproveModel) !== 'unsupported';

    if (shouldTryStructured) {
      try {
        return await tryStructuredMode();
      } catch (error) {
        if (!isUnsupportedStructuredOutputError(error)) {
          throw error;
        }
        setStructuredSupport(autoApproveProvider, autoApproveModel, 'unsupported');
        logger.debug('Shell auto-approval structured output unsupported; falling back to prompt JSON', {
          provider: autoApproveProvider,
          model: autoApproveModel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return await tryPromptMode();
  } catch (error) {
    logger.error('Batch auto-approval evaluation failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    if (throwOnError) {
      throw error;
    }

    return buildInvalidEvaluationAdvisories({
      commands: toEvaluateByLLM,
      redSafetyDetails,
      model: autoApproveModel,
      reasoning: 'LLM evaluation encountered an error.',
      isError: true,
    });
  }

  return out;
}
