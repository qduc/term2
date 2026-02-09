import { type Model, type ModelRequest, type ModelResponse, type ResponseStreamEvent } from '@openai/agents-core';
import { randomUUID } from 'node:crypto';
import type { ILoggingService, ISettingsService } from '../../services/service-interfaces.js';
import { callOpenRouter } from './api.js';
import { buildMessagesFromRequest, extractFunctionToolsFromRequest } from './converters.js';
import { normalizeUsage, decodeHtmlEntities, normalizeToolCallName } from './utils.js';

export class OpenRouterModel implements Model {
  name: string;
  #modelId: string;
  #settingsService: ISettingsService;
  #loggingService: ILoggingService;

  constructor(deps: { settingsService: ISettingsService; loggingService: ILoggingService; modelId?: string }) {
    this.name = 'OpenRouter';
    this.#settingsService = deps.settingsService;
    this.#loggingService = deps.loggingService;
    this.#modelId = deps.modelId || this.#settingsService.get('agent.model') || 'openrouter/auto';
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.#settingsService.get('agent.openrouter.apiKey');
    if (!apiKey) {
      throw new Error(
        'OpenRouter API key is not configured. Please set the OPENROUTER_API_KEY environment variable. ' +
          'Get your API key from: https://openrouter.ai/keys',
      );
    }
    // OpenRouter does not support server-side response chaining the same way
    // as OpenAI Responses. We intentionally ignore previousResponseId and
    // expect the caller to provide full conversation context in `input`.
    // Note: History is managed by the SDK, not by this provider.
    const resolvedModelId = this.#resolveModelFromRequest(request) || this.#modelId;
    const messages = buildMessagesFromRequest(request, resolvedModelId, this.#loggingService);

    this.#loggingService.debug('OpenRouter message', { messages });

    // Extract function tools from ModelRequest
    // SDK Property: tools (SerializedTool[])
    // Note: SDK-specific tools (shell, computer, etc.) are filtered out here
    const tools = extractFunctionToolsFromRequest(request);

    const res = await callOpenRouter({
      apiKey,
      model: resolvedModelId,
      messages,
      stream: false,
      signal: request.signal,
      settings: request.modelSettings,
      tools,
      settingsService: this.#settingsService,
    });
    const json: any = await res.json();
    const choice = json?.choices?.[0];
    const contentFromChoice = choice?.message?.content ?? '';
    const textContent = typeof contentFromChoice === 'string' ? contentFromChoice : JSON.stringify(contentFromChoice);

    const responseId = json?.id ?? randomUUID();

    const usage = normalizeUsage(json?.usage || {}) as any;
    const reasoning = choice?.message?.reasoning || choice?.message?.reasoning_content;
    const reasoningDetails = choice?.message?.reasoning_details;
    const toolCalls = choice?.message?.tool_calls;

    // Build output array with message, reasoning, and tool calls
    const output: any[] = [];

    // Add reasoning items as separate output items (if present)
    if (reasoningDetails && Array.isArray(reasoningDetails)) {
      for (const reasoningItem of reasoningDetails) {
        const outputItem: any = {
          type: 'reasoning',
          id: reasoningItem.id || `reasoning-${Date.now()}-${reasoningItem.index || 0}`,
          content: [],
          providerData: reasoningItem,
        };

        // Handle different reasoning types
        if (reasoningItem.type === 'reasoning.text' && reasoningItem.text) {
          outputItem.content.push({
            type: 'input_text',
            text: reasoningItem.text,
            providerData: {
              format: reasoningItem.format,
              index: reasoningItem.index,
            },
          });
        } else if (reasoningItem.type === 'reasoning.summary' && reasoningItem.summary) {
          outputItem.content.push({
            type: 'input_text',
            text: reasoningItem.summary,
            providerData: {
              format: reasoningItem.format,
              index: reasoningItem.index,
            },
          });
        } else if (reasoningItem.type === 'reasoning.encrypted') {
          // Encrypted reasoning has no text content, only providerData
          outputItem.content = [];
        }
        // For any other reasoning types, store in providerData and leave content empty

        output.push(outputItem);
      }
    }

    const hasTextContent = textContent.length > 0;
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    const shouldAddFallbackMessage = !hasTextContent && !hasToolCalls;
    const assistantText = hasTextContent ? textContent : shouldAddFallbackMessage ? 'No response from model.' : '';

    // Add assistant message when we have text or we need a fallback
    // (Don't add empty message when there are only tool calls)
    if (hasTextContent || shouldAddFallbackMessage) {
      output.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: assistantText,
          },
        ],
        ...(typeof reasoning === 'string' ? { reasoning } : {}),
        ...(reasoningDetails != null ? { reasoning_details: reasoningDetails } : {}),
      } as any);
    }

    // Add tool calls as separate output items
    // Note: Non-streaming response has OpenRouter format with nested function object
    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        if (toolCall.type === 'function') {
          output.push({
            type: 'function_call',
            callId: toolCall.id,
            name: normalizeToolCallName(toolCall.function.name),
            arguments: decodeHtmlEntities(toolCall.function.arguments),
            status: 'completed',
            // Preserve reasoning blocks/tokens on tool calls so that when the
            // caller replays history, we can attach them back onto the assistant
            // tool_calls message (OpenRouter best practice).
            ...(typeof reasoning === 'string' ? { reasoning } : {}),
            ...(reasoningDetails != null ? { reasoning_details: reasoningDetails } : {}),
          } as any);
        }
      }
    }

    const response: ModelResponse = {
      usage,
      output,
      responseId,
      providerData: json,
    };
    return response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const apiKey = this.#settingsService.get('agent.openrouter.apiKey');
    if (!apiKey) {
      throw new Error(
        'OpenRouter API key is not configured. Please set the OPENROUTER_API_KEY environment variable. ' +
          'Get your API key from: https://openrouter.ai/keys',
      );
    }
    // See getResponse(): caller-managed history; do not chain via previousResponseId.
    // Note: History is managed by the SDK, not by this provider.
    const resolvedModelId = this.#resolveModelFromRequest(request) || this.#modelId;
    const messages = buildMessagesFromRequest(request, resolvedModelId, this.#loggingService);

    const tools = extractFunctionToolsFromRequest(request);

    this.#loggingService.debug('OpenRouter stream start', {
      messageCount: Array.isArray(messages) ? messages.length : 0,
      modelRequest: request,
      messages,
      toolsCount: Array.isArray(tools) ? tools.length : 0,
      tools,
    });

    const res = await callOpenRouter({
      apiKey,
      model: resolvedModelId,
      messages,
      stream: true,
      signal: request.signal,
      settings: request.modelSettings,
      tools,
      settingsService: this.#settingsService,
    });

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    let responseId = 'unknown';
    let usageData: any = null;
    let accumulatedReasoningText = '';
    const accumulatedReasoning: any[] = [];
    const accumulatedToolCalls: any[] = [];

    if (!reader) {
      const full = await this.getResponse(request);
      yield {
        type: 'response_done',
        response: {
          id: full.responseId || 'unknown',
          usage: normalizeUsage(full.usage),
          output: full.output,
        },
      } as any;
      return;
    }

    const state = {
      accumulated,
      responseId,
      usageData,
      accumulatedReasoningText,
      accumulatedReasoning,
      accumulatedToolCalls,
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      for (const line of this.#splitBufferIntoLines(buffer)) {
        buffer = line.remainingBuffer;
        if (!line.content) continue;

        const events = this.#processSSELine(line.content, state);
        for (const event of events) {
          yield event;
        }
      }
    }
  }

  #buildStreamOutput(accumulated: string, reasoningDetails?: any, toolCalls?: any[], reasoningText?: string): any[] {
    const output: any[] = [];

    // Add reasoning items as separate output items (if present)
    if (reasoningDetails && Array.isArray(reasoningDetails)) {
      for (const reasoningItem of reasoningDetails) {
        const outputItem: any = {
          type: 'reasoning',
          id: reasoningItem.id || `reasoning-${Date.now()}-${reasoningItem.index || 0}`,
          content: [],
          providerData: reasoningItem,
        };

        // Handle different reasoning types
        if (reasoningItem.type === 'reasoning.text' && reasoningItem.text) {
          outputItem.content.push({
            type: 'input_text',
            text: reasoningItem.text,
            providerData: {
              format: reasoningItem.format,
              index: reasoningItem.index,
            },
          });
        } else if (reasoningItem.type === 'reasoning.summary' && reasoningItem.summary) {
          outputItem.content.push({
            type: 'input_text',
            text: reasoningItem.summary,
            providerData: {
              format: reasoningItem.format,
              index: reasoningItem.index,
            },
          });
        } else if (reasoningItem.type === 'reasoning.encrypted') {
          // Encrypted reasoning has no text content, only providerData
          outputItem.content = [];
        }
        // For any other reasoning types, store in providerData and leave content empty

        output.push(outputItem);
      }
    }

    // Add assistant message only if there's text content
    // (Don't add empty message when there are only tool calls)
    if (accumulated) {
      output.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: accumulated,
          },
        ],
        ...(typeof reasoningText === 'string' && reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
        ...(reasoningDetails != null ? { reasoning_details: reasoningDetails } : {}),
      } as any);
    }

    // Add tool calls as separate output items
    // Note: Streaming response has SDK format with flat structure
    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        if (toolCall.type === 'function_call') {
          output.push({
            type: 'function_call',
            callId: toolCall.callId,
            name: normalizeToolCallName(toolCall.name),
            arguments: decodeHtmlEntities(toolCall.arguments),
            status: 'completed',
            ...(typeof reasoningText === 'string' && reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
            ...(reasoningDetails != null ? { reasoning_details: reasoningDetails } : {}),
          } as any);
        }
      }
    }

    return output;
  }

  #mergeToolCalls(accumulated: any[], deltas: any[]): void {
    for (const delta of deltas) {
      const index = delta.index ?? accumulated.length;
      const existing =
        accumulated[index] ??
        ({
          type: 'function_call',
          callId: '',
          name: '',
          arguments: '',
        } as any);

      // Accumulate the callId (id comes in deltas)
      if (delta.id) {
        existing.callId += delta.id;
      }

      // Accumulate function name and arguments
      if (delta.function?.name) {
        existing.name += delta.function.name;
      }
      if (delta.function?.arguments) {
        existing.arguments += decodeHtmlEntities(delta.function.arguments);
      }

      accumulated[index] = existing;
    }
  }

  *#splitBufferIntoLines(buffer: string): Generator<{ content: string; remainingBuffer: string }> {
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      yield { content: line, remainingBuffer: buffer };
    }
    yield { content: '', remainingBuffer: buffer };
  }

  *#processSSELine(line: string, state: any): Generator<any> {
    if (!line.startsWith('data:')) return;

    const data = line.slice(5).trim();
    yield* this.#processSSEDataLine(data, state);
  }

  *#processSSEDataLine(data: string, state: any): Generator<any> {
    if (data === '[DONE]') {
      yield* this.#buildStreamCompleteEvent(state);
      return;
    }

    try {
      const json = JSON.parse(data);
      // this.#loggingService.debug('OpenRouter SSE chunk', json);
      yield* this.#processStreamEventJSON(json, state);
    } catch (err) {
      // Ignore parse errors for keep-alive lines
      this.#loggingService.error('OpenRouter stream parse error', { err });
    }
  }

  *#buildStreamCompleteEvent(state: any): Generator<any> {
    if (!state.responseId || state.responseId === 'unknown') {
      state.responseId = randomUUID();
    }

    const reasoningDetails = state.accumulatedReasoning.length > 0 ? state.accumulatedReasoning : undefined;

    this.#loggingService.debug('OpenRouter stream done', {
      text: state.accumulated,
      reasoningDetails,
      toolCalls: state.accumulatedToolCalls,
    });

    yield {
      type: 'response_done',
      response: {
        id: state.responseId,
        usage: normalizeUsage(state.usageData),
        output: this.#buildStreamOutput(
          state.accumulated,
          reasoningDetails,
          state.accumulatedToolCalls,
          state.accumulatedReasoningText,
        ),
      },
    } as any;

    yield {
      type: 'model',
      event: '[DONE]',
    };
  }

  *#processStreamEventJSON(json: any, state: any): Generator<any> {
    this.#extractStreamMetadata(json, state);
    this.#accumulateReasoningFromStream(json, state);
    this.#accumulateToolCallsFromStream(json, state);

    const contentDeltaEvent = this.#extractContentDelta(json, state);
    if (contentDeltaEvent) {
      yield contentDeltaEvent;
    }

    yield {
      type: 'model',
      event: json,
    };
  }

  #extractStreamMetadata(json: any, state: any): void {
    if (json?.id && state.responseId === 'unknown') {
      state.responseId = json.id;
    }
    if (json?.usage) {
      state.usageData = json.usage;
    }
  }

  #accumulateReasoningFromStream(json: any, state: any): void {
    const reasoningDetails = json?.choices?.[0]?.delta?.reasoning_details;
    if (reasoningDetails) {
      const TYPE_FIELD_MAP = {
        'reasoning.text': 'text',
        'reasoning.summary': 'summary',
        'reasoning.encrypted': 'data',
      };

      // Create a Map for O(1) lookup instead of O(n) array search
      const reasoningMap = new Map(state.accumulatedReasoning.map((item: any) => [`${item.type}:${item.index}`, item]));

      const details = !Array.isArray(reasoningDetails) ? [reasoningDetails] : reasoningDetails;

      for (const detail of details) {
        const { type, index } = detail;
        const fieldName = TYPE_FIELD_MAP[type];
        if (!fieldName) return; // ignore unknown types safely

        const key = `${type}:${index}`;
        const existing = reasoningMap.get(key);

        if (existing) {
          existing[fieldName] += detail[fieldName];
        } else {
          const newItem = {
            ...detail,
            [fieldName]: detail[fieldName],
          };
          state.accumulatedReasoning.push(newItem);
          reasoningMap.set(key, newItem);
        }
      }
    }

    const reasoningDelta = json?.choices?.[0]?.delta?.reasoning || json?.choices?.[0]?.delta?.reasoning_content;
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      state.accumulatedReasoningText += reasoningDelta;
    }
  }

  #accumulateToolCallsFromStream(json: any, state: any): void {
    const deltaToolCalls = json?.choices?.[0]?.delta?.tool_calls;
    if (deltaToolCalls) {
      this.#mergeToolCalls(state.accumulatedToolCalls, deltaToolCalls);
    }
  }

  #extractContentDelta(json: any, state: any): any | null {
    const delta = json?.choices?.[0]?.delta?.content ?? '';
    if (delta) {
      state.accumulated += delta;
      return {
        type: 'output_text_delta',
        delta,
      } as any;
    }
    return null;
  }

  #resolveModelFromRequest(req: ModelRequest): string | undefined {
    // If the agent explicitly set a model override in the prompt, prefer the runtime model.
    // For now, just return undefined to use constructor/default.
    if ((req as any)?.providerData?.model) return (req as any).providerData.model;
    return undefined;
  }
}
