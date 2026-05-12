import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

type AiSdkModelLike = {
  doGenerate: (options: any) => PromiseLike<any> | any;
  doStream: (options: any) => PromiseLike<any> | any;
};

function hasContent(content: any): boolean {
  return content !== null && content !== undefined && content !== '';
}

function hasAssistantPayload(message: any): boolean {
  if (message?.role !== 'assistant') {
    return true;
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }

  if (!Array.isArray(message.content)) {
    return hasContent(message.content);
  }

  return message.content.some((part: any) => part?.type !== 'reasoning');
}

function contentToParts(content: any): any[] {
  if (!hasContent(content)) {
    return [];
  }

  if (Array.isArray(content)) {
    return content;
  }

  return [{ type: 'text', text: String(content) }];
}

function mergeAssistantContent(existing: any, incoming: any): any {
  if (!hasContent(existing)) {
    return incoming;
  }

  if (!hasContent(incoming)) {
    return existing;
  }

  if (typeof existing === 'string' && typeof incoming === 'string') {
    return `${existing}\n${incoming}`;
  }

  return [...contentToParts(existing), ...contentToParts(incoming)];
}

function appendStringField(message: any, field: 'reasoning' | 'reasoning_content', value: any): void {
  if (typeof value !== 'string') {
    return;
  }

  message[field] = typeof message[field] === 'string' ? `${message[field]}${value}` : value;
}

function appendArrayLikeField(message: any, field: 'tool_calls' | 'reasoning_details', value: any): void {
  if (value == null) {
    return;
  }

  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return;
  }

  message[field] = [...(Array.isArray(message[field]) ? message[field] : []), ...values];
}

function mergeAssistantMessagePair(existing: any, incoming: any): any {
  const merged = {
    ...existing,
    ...incoming,
    role: 'assistant',
    content: mergeAssistantContent(existing.content, incoming.content),
    tool_calls: undefined,
    reasoning: undefined,
    reasoning_content: undefined,
    reasoning_details: undefined,
  };

  appendArrayLikeField(merged, 'tool_calls', existing.tool_calls);
  appendArrayLikeField(merged, 'tool_calls', incoming.tool_calls);
  appendStringField(merged, 'reasoning', existing.reasoning);
  appendStringField(merged, 'reasoning', incoming.reasoning);
  appendStringField(merged, 'reasoning_content', existing.reasoning_content);
  appendStringField(merged, 'reasoning_content', incoming.reasoning_content);
  appendArrayLikeField(merged, 'reasoning_details', existing.reasoning_details);
  appendArrayLikeField(merged, 'reasoning_details', incoming.reasoning_details);

  for (const field of ['tool_calls', 'reasoning', 'reasoning_content', 'reasoning_details'] as const) {
    if (merged[field] === undefined) {
      delete merged[field];
    }
  }
  if (merged.content === undefined) {
    delete merged.content;
  }

  return merged;
}

export function mergeAssistantMessages(messages: any[]): any[] {
  const merged: any[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];

    if (previous?.role === 'assistant' && message?.role === 'assistant') {
      merged[merged.length - 1] = mergeAssistantMessagePair(previous, message);
      continue;
    }

    merged.push(message);
  }

  return merged.filter(hasAssistantPayload);
}

function normalizeMessageOptions(options: any): any {
  if (!Array.isArray(options?.prompt) && !Array.isArray(options?.messages)) {
    return options;
  }

  return {
    ...options,
    ...(Array.isArray(options.prompt) ? { prompt: mergeAssistantMessages(options.prompt) } : {}),
    ...(Array.isArray(options.messages) ? { messages: mergeAssistantMessages(options.messages) } : {}),
  };
}

const mergeAssistantMessagesMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: ({ params }) => normalizeMessageOptions(params),
};

export function withMergedAssistantMessages<T extends AiSdkModelLike>(model: T): T {
  return wrapLanguageModel({
    model: model as unknown as LanguageModelV3,
    middleware: mergeAssistantMessagesMiddleware,
  }) as unknown as T;
}
