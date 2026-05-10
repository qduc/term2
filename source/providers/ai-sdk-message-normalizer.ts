type AiSdkModelLike = {
  doGenerate: (options: any) => PromiseLike<any> | any;
  doStream: (options: any) => PromiseLike<any> | any;
};

function isAssistantReasoningOnlyMessage(message: any): boolean {
  const content = message?.content;

  if (
    message?.role === 'assistant' &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => part?.type === 'reasoning') &&
    !Array.isArray(message.tool_calls)
  ) {
    return true;
  }

  return (
    message?.role === 'assistant' &&
    typeof message.reasoning_content === 'string' &&
    (message.content === '' || message.content === null || message.content === undefined) &&
    !Array.isArray(message.tool_calls)
  );
}

function isAssistantToolCallMessage(message: any): boolean {
  const content = message?.content;

  if (
    message?.role === 'assistant' &&
    Array.isArray(content) &&
    content.some((part) => part?.type === 'tool-call') &&
    message.reasoning_content === undefined
  ) {
    return true;
  }

  return message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.reasoning_content === undefined;
}

export function mergeAssistantReasoningIntoToolCalls(messages: any[]): any[] {
  const merged: any[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];

    if (isAssistantReasoningOnlyMessage(previous) && isAssistantToolCallMessage(message)) {
      if (Array.isArray(previous.content) && Array.isArray(message.content)) {
        merged[merged.length - 1] = {
          ...message,
          content: [...previous.content, ...message.content],
        };
        continue;
      }

      merged[merged.length - 1] = {
        ...message,
        reasoning_content: previous.reasoning_content,
      };
      continue;
    }

    merged.push(message);
  }

  return merged;
}

function normalizeOptions(options: any): any {
  if (!Array.isArray(options?.prompt) && !Array.isArray(options?.messages)) {
    return options;
  }

  return {
    ...options,
    ...(Array.isArray(options.prompt) ? { prompt: mergeAssistantReasoningIntoToolCalls(options.prompt) } : {}),
    ...(Array.isArray(options.messages) ? { messages: mergeAssistantReasoningIntoToolCalls(options.messages) } : {}),
  };
}

export function withMergedAssistantReasoning<T extends AiSdkModelLike>(model: T): T {
  return new Proxy(model, {
    get(target, property) {
      if (property === 'doGenerate') {
        return (options: any) => target.doGenerate(normalizeOptions(options));
      }

      if (property === 'doStream') {
        return (options: any) => target.doStream(normalizeOptions(options));
      }

      return Reflect.get(target, property, target);
    },
  });
}
