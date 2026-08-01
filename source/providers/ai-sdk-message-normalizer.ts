import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

function hasContent(content: unknown): boolean {
  return content !== null && content !== undefined && content !== '';
}

function hasReasoningPayload(message: Record<string, unknown>): boolean {
  if (message.role !== 'assistant') {
    return false;
  }

  const candidates: Record<string, unknown>[] = [
    message,
    ...(typeof message.providerData === 'object' && message.providerData !== null
      ? [message.providerData as Record<string, unknown>]
      : []),
    ...(typeof message.provider_data === 'object' && message.provider_data !== null
      ? [message.provider_data as Record<string, unknown>]
      : []),
  ];

  return candidates.some(
    (candidate) =>
      typeof candidate.reasoning === 'string' ||
      typeof candidate.reasoning_content === 'string' ||
      (Array.isArray(candidate.reasoning_details) && candidate.reasoning_details.length > 0),
  );
}

function hasAssistantPayload(message: Record<string, unknown>): boolean {
  if (message.role !== 'assistant') {
    return true;
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }

  if (hasReasoningPayload(message)) {
    return true;
  }

  if (!Array.isArray(message.content)) {
    return hasContent(message.content);
  }

  return message.content.length > 0;
}

function contentToParts(content: unknown): unknown[] {
  if (!hasContent(content)) {
    return [];
  }

  if (Array.isArray(content)) {
    return content;
  }

  return [{ type: 'text', text: String(content) }];
}

function mergeAssistantContent(existing: unknown, incoming: unknown): unknown {
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

function appendStringField(
  message: Record<string, unknown>,
  field: 'reasoning' | 'reasoning_content',
  value: unknown,
): void {
  if (typeof value !== 'string') {
    return;
  }

  message[field] = typeof message[field] === 'string' ? `${message[field] as string}${value}` : value;
}

function appendArrayLikeField(
  message: Record<string, unknown>,
  field: 'tool_calls' | 'reasoning_details',
  value: unknown,
): void {
  if (value == null) {
    return;
  }

  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return;
  }

  const existingArray = Array.isArray(message[field]) ? (message[field] as unknown[]) : [];
  message[field] = [...existingArray, ...values];
}

function mergeAssistantMessagePair(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
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

export function mergeAssistantMessages<T extends Record<string, unknown>>(messages: readonly T[]): T[] {
  const merged: T[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      merged.push(message);
      continue;
    }

    const previous = merged[merged.length - 1];

    if (previous?.role === 'assistant' && message.role === 'assistant') {
      merged[merged.length - 1] = mergeAssistantMessagePair(
        previous as Record<string, unknown>,
        message as Record<string, unknown>,
      ) as unknown as T;
      continue;
    }

    merged.push(message);
  }

  return merged.filter((msg) => hasAssistantPayload(msg as Record<string, unknown>));
}

function normalizeMessageOptions(options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  const opts = options as unknown as Record<string, unknown>;
  if (!Array.isArray(opts.prompt) && !Array.isArray(opts.messages)) {
    return options;
  }

  return {
    ...options,
    ...(Array.isArray(opts.prompt)
      ? { prompt: mergeAssistantMessages(opts.prompt as Record<string, unknown>[]) }
      : {}),
    ...(Array.isArray(opts.messages)
      ? { messages: mergeAssistantMessages(opts.messages as Record<string, unknown>[]) }
      : {}),
  } as unknown as LanguageModelV3CallOptions;
}

const mergeAssistantMessagesMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => normalizeMessageOptions(params as LanguageModelV3CallOptions),
};

export function withMergedAssistantMessages<T extends LanguageModelV3>(model: T): T {
  return wrapLanguageModel({
    model,
    middleware: mergeAssistantMessagesMiddleware,
  }) as T;
}
