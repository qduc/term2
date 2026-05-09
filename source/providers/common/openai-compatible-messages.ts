import { type ModelRequest } from '@openai/agents-core';
import type { ILoggingService } from '../../services/service-interfaces.js';
import { isAnthropicModel } from './openai-compatible-utils.js';

const noOpLogger: ILoggingService = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

function convertAgentItemToOpenAICompatibleMessage(item: any, loggingService: ILoggingService): any | null {
  if (!item) {
    return null;
  }

  const rawItem = item.rawItem || item;

  if (rawItem.type === 'input_text' && typeof rawItem.text === 'string') {
    return { role: 'user', content: rawItem.text };
  }

  if (rawItem.role === 'assistant' && rawItem.type === 'message') {
    const message: any = { role: 'assistant' };
    if (Array.isArray(rawItem.content)) {
      const textContent = rawItem.content
        .filter((c: any) => c?.type === 'output_text' && c?.text)
        .map((c: any) => c.text)
        .join('');
      if (textContent) {
        message.content = textContent;
      }
    }

    const providerData = rawItem.providerData ?? item.providerData;
    const reasoning = rawItem.reasoning ?? item.reasoning ?? providerData?.reasoning;
    if (typeof reasoning === 'string') {
      message.reasoning = reasoning;
    }

    const reasoningContent = rawItem.reasoning_content ?? item.reasoning_content ?? providerData?.reasoning_content;
    if (typeof reasoningContent === 'string') {
      message.reasoning_content = reasoningContent;
    }

    const reasoningDetails = rawItem.reasoning_details ?? item.reasoning_details ?? providerData?.reasoning_details;
    if (reasoningDetails != null) {
      loggingService.debug('convertAgentItemToOpenAICompatibleMessage: reasoning_details', reasoningDetails);
      message.reasoning_details = reasoningDetails;
    }

    const toolCalls = rawItem.tool_calls ?? item.tool_calls;
    if (toolCalls != null) {
      message.tool_calls = toolCalls;
    }

    return message;
  }

  if (rawItem.role === 'user' && rawItem.type === 'message') {
    if (typeof rawItem.content === 'string') {
      return { role: 'user', content: rawItem.content };
    }

    if (Array.isArray(rawItem.content)) {
      const textContent = rawItem.content
        .filter((c: any) => (c?.type === 'input_text' || c?.type === 'output_text') && c?.text)
        .map((c: any) => c.text)
        .join('');
      if (textContent) {
        return { role: 'user', content: textContent };
      }
    }
  }

  if (rawItem?.type === 'function_call') {
    const providerData = rawItem.providerData ?? item.providerData;
    const reasoning = rawItem.reasoning ?? item.reasoning ?? providerData?.reasoning;
    const reasoningContent = rawItem.reasoning_content ?? item.reasoning_content ?? providerData?.reasoning_content;
    const reasoningDetails = rawItem.reasoning_details ?? item.reasoning_details ?? providerData?.reasoning_details;

    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: rawItem.callId || rawItem.id,
          type: 'function',
          function: {
            name: rawItem.name,
            arguments: rawItem.arguments ?? (rawItem.args ? JSON.stringify(rawItem.args) : ''),
          },
        },
      ],
      ...(typeof reasoning === 'string' ? { reasoning } : {}),
      ...(typeof reasoningContent === 'string' ? { reasoning_content: reasoningContent } : {}),
      ...(reasoningDetails != null ? { reasoning_details: reasoningDetails } : {}),
    };
  }

  if (
    rawItem?.type === 'function_call_output' ||
    rawItem?.type === 'function_call_result' ||
    rawItem?.type === 'function_call_output_result'
  ) {
    let outputContent = '';
    if (typeof rawItem.output === 'string') {
      outputContent = rawItem.output;
    } else if (rawItem.output && typeof rawItem.output === 'object') {
      outputContent = JSON.stringify(rawItem.output);
    }

    return {
      role: 'tool',
      tool_call_id: rawItem.callId || rawItem.id,
      content: outputContent,
    };
  }

  return null;
}

export function addCacheControlToLastUserMessage(messages: any[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        msg.content = [
          {
            type: 'text',
            text: msg.content,
            cache_control: { type: 'ephemeral' },
          },
        ];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const item = msg.content[j];
          if (item.type === 'text') {
            item.cache_control = { type: 'ephemeral' };
            break;
          }
        }
      }
      break;
    }
  }
}

export function addCacheControlToLastToolMessage(messages: any[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'tool') {
      if (typeof msg.content === 'string') {
        msg.content = [
          {
            type: 'text',
            text: msg.content,
            cache_control: { type: 'ephemeral' },
          },
        ];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const item = msg.content[j];
          if (item.type === 'text') {
            item.cache_control = { type: 'ephemeral' };
            break;
          }
        }
      }
      break;
    }
  }
}

export function buildMessagesFromRequest(req: ModelRequest, modelId?: string, loggingService?: ILoggingService): any[] {
  const messages: any[] = [];
  let pendingReasoningDetails: any[] = [];

  const logger = loggingService || noOpLogger;
  logger.debug('buildMessagesFromRequest: req.input', {
    inputType: typeof req.input,
    isArray: Array.isArray(req.input),
    inputLength: Array.isArray(req.input) ? req.input.length : typeof req.input === 'string' ? req.input.length : 'N/A',
    inputPreview: Array.isArray(req.input)
      ? req.input.map((item: any) => ({
          role: item?.role || item?.rawItem?.role,
          type: item?.type || item?.rawItem?.type,
        }))
      : typeof req.input === 'string'
      ? req.input.substring(0, 100)
      : 'non-string, non-array',
  });

  if (req.systemInstructions && req.systemInstructions.trim().length > 0) {
    if (modelId && isAnthropicModel(modelId)) {
      messages.push({
        role: 'system',
        content: [
          {
            type: 'text',
            text: req.systemInstructions,
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    } else {
      messages.push({ role: 'system', content: req.systemInstructions });
    }
  }

  if (typeof req.input === 'string') {
    const userMessage = { role: 'user', content: req.input };
    messages.push(userMessage);
  } else if (Array.isArray(req.input)) {
    for (const item of req.input as any[]) {
      const raw = (item as any)?.rawItem ?? item;
      if (raw?.type === 'reasoning') {
        const detail = raw?.providerData ?? (item as any)?.providerData;
        if (detail && typeof detail === 'object') {
          pendingReasoningDetails.push(detail);
        }
        continue;
      }

      const converted = convertAgentItemToOpenAICompatibleMessage(item, loggingService || noOpLogger);
      if (converted) {
        if (
          pendingReasoningDetails.length > 0 &&
          converted.role === 'assistant' &&
          converted.reasoning_details == null
        ) {
          converted.reasoning_details = pendingReasoningDetails;
          pendingReasoningDetails = [];
        }

        const lastMessage = messages[messages.length - 1];

        if (lastMessage && lastMessage.role === converted.role) {
          if (converted.role === 'assistant') {
            if (converted.content != null) {
              if (lastMessage.content == null) {
                lastMessage.content = converted.content;
              } else {
                lastMessage.content = String(lastMessage.content) + '\n' + String(converted.content);
              }
            }

            if (converted.tool_calls) {
              if (!lastMessage.tool_calls) {
                lastMessage.tool_calls = [];
              }
              lastMessage.tool_calls.push(...converted.tool_calls);
            }

            if (converted.reasoning != null) {
              if (!lastMessage.reasoning) {
                lastMessage.reasoning = converted.reasoning;
              } else {
                lastMessage.reasoning += converted.reasoning;
              }
            }
            if (converted.reasoning_content != null) {
              if (!lastMessage.reasoning_content) {
                lastMessage.reasoning_content = converted.reasoning_content;
              } else {
                lastMessage.reasoning_content += converted.reasoning_content;
              }
            }

            if (converted.reasoning_details) {
              if (!lastMessage.reasoning_details) {
                lastMessage.reasoning_details = [];
              }
              lastMessage.reasoning_details.push(
                ...(Array.isArray(converted.reasoning_details)
                  ? converted.reasoning_details
                  : [converted.reasoning_details]),
              );
            }
            continue;
          }

          if (converted.role === 'user') {
            if (converted.content != null) {
              if (lastMessage.content == null) {
                lastMessage.content = converted.content;
              } else {
                lastMessage.content = String(lastMessage.content) + '\n' + String(converted.content);
              }
            }
            continue;
          }
        }

        messages.push(converted);
      }
    }
  }

  if (modelId && isAnthropicModel(modelId)) {
    addCacheControlToLastUserMessage(messages);
    addCacheControlToLastToolMessage(messages);
  }

  return messages;
}

export function extractFunctionToolsFromRequest(req: ModelRequest): any[] {
  if (!req.tools || req.tools.length === 0) {
    return [];
  }

  const functionTools: any[] = [];

  for (const tool of req.tools as any[]) {
    if (tool.type === 'function') {
      functionTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      });
    }
  }

  return functionTools;
}

export function extractModelSettingsForRequest(settings: any): any {
  const body: any = {};

  if (settings) {
    if (settings.temperature != null) body.temperature = settings.temperature;

    if (settings.topP != null) body.top_p = settings.topP;

    if (settings.maxTokens != null) body.max_tokens = settings.maxTokens;

    if (settings.topK != null) body.top_k = settings.topK;

    if (settings.frequencyPenalty != null) body.frequency_penalty = settings.frequencyPenalty;

    if (settings.presencePenalty != null) body.presence_penalty = settings.presencePenalty;

    const hasReasoningObj = settings.reasoning && typeof settings.reasoning === 'object';
    if (hasReasoningObj) {
      body.reasoning = { ...settings.reasoning };
    }

    const reasoningEffort = settings.reasoningEffort ?? settings.reasoning?.effort;
    const normalizedEffort = reasoningEffort === 'default' ? 'medium' : reasoningEffort;

    if (normalizedEffort && normalizedEffort !== 'none') {
      body.reasoning = {
        ...(body.reasoning ?? {}),
        effort: normalizedEffort,
      };
    }
  }

  return body;
}
