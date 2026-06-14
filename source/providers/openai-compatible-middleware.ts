import type { ISessionContextService } from '../services/service-interfaces.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { mergeAssistantMessages } from './ai-sdk-message-normalizer.js';
import { addCacheControlToLastTwoMessages } from './common/openai-compatible-messages.js';
import { applyLlamaCppRequestTransform } from './llama-cpp.provider.js';
import { createOpencodeSessionInjector } from './opencode-session.js';

function preserveReasoningContentForOpenAICompatibleMessages(messages: any[]): any[] {
  return messages.map((message) => {
    if (message?.role !== 'assistant' || typeof message.reasoning !== 'string') {
      return message;
    }
    const { reasoning, ...rest } = message;
    return {
      ...rest,
      reasoning_content: typeof message.reasoning_content === 'string' ? message.reasoning_content : reasoning,
    };
  });
}

function sanitizeOpenAICompatibleMessages(messages: any[]): any[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;

    const { index: _strayIndex, ...message_ } = message;
    message = message_;

    let newContent = message.content;
    if (Array.isArray(message.content)) {
      const isAllText = message.content.every((part: any) => part && part.type === 'text');
      if (isAllText) {
        newContent = message.content.map((part: any) => part.text || '').join('');
      } else {
        newContent = message.content.map((part: any) => {
          if (!part || typeof part !== 'object') return part;
          const { annotations, ...rest } = part;
          return rest;
        });
      }
    }

    return {
      ...message,
      content: newContent,
    };
  });
}

function hasReasoningPayload(message: any): boolean {
  const candidates = [message, message?.providerData, message?.provider_data].filter(Boolean);
  return candidates.some(
    (candidate: any) =>
      typeof candidate.reasoning === 'string' ||
      typeof candidate.reasoning_content === 'string' ||
      (Array.isArray(candidate.reasoning_details) && candidate.reasoning_details.length > 0),
  );
}

export function sanitizeResponsesApiBody(body: any): any {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) {
    return body;
  }

  const sanitizedInput = body.input.filter((item: any) => {
    const rawItem = item?.rawItem ?? item;
    if (!rawItem || typeof rawItem !== 'object') {
      return true;
    }

    const isMessage = rawItem.type === 'message' || (rawItem.role && rawItem.content !== undefined);
    if (!isMessage) {
      return true;
    }

    if (hasReasoningPayload(rawItem)) {
      return true;
    }

    return !Array.isArray(rawItem.content) || rawItem.content.length > 0;
  });

  if (sanitizedInput.length === body.input.length) {
    return body;
  }

  return {
    ...body,
    input: sanitizedInput,
  };
}

export function createOpenAICompatibleMiddleware(
  providerType: string,
  baseUrl?: string,
  options?: {
    sessionContextService?: ISessionContextService;
    fallbackSessionIdOverride?: string;
  },
): FetchMiddleware {
  const injectSession = createOpencodeSessionInjector({ type: providerType, baseUrl }, options);

  return async (ctx, next) => {
    if (typeof ctx.init?.body === 'string') {
      try {
        const body = JSON.parse(ctx.init.body);
        let changed = false;

        if (Array.isArray(body?.messages)) {
          body.messages = sanitizeOpenAICompatibleMessages(
            preserveReasoningContentForOpenAICompatibleMessages(mergeAssistantMessages(body.messages)),
          );
          addCacheControlToLastTwoMessages(body.messages, body.model);
          changed = true;
        }

        if (applyLlamaCppRequestTransform(body, providerType)) {
          changed = true;
        }

        if (changed || injectSession) {
          let newInit: RequestInit = { ...ctx.init, body: JSON.stringify(body) };
          if (injectSession) {
            const sessionInit = injectSession(newInit);
            if (sessionInit) newInit = sessionInit;
          }
          return next({ url: ctx.url, init: newInit });
        }
      } catch {
        return next(ctx);
      }
    }

    return next(ctx);
  };
}

export function createCacheControlMiddleware(): FetchMiddleware {
  return async (ctx, next) => {
    if (typeof ctx.init?.body === 'string') {
      try {
        const body = JSON.parse(ctx.init.body);
        if (Array.isArray(body?.messages)) {
          addCacheControlToLastTwoMessages(body.messages, body.model);
          return next({ url: ctx.url, init: { ...ctx.init, body: JSON.stringify(body) } });
        }
      } catch {
        /* fall through */
      }
    }
    return next(ctx);
  };
}

export function createOpenAIResponsesMiddleware(): FetchMiddleware {
  return async (ctx, next) => {
    if (typeof ctx.init?.body === 'string') {
      try {
        const body = sanitizeResponsesApiBody(JSON.parse(ctx.init.body));
        return next({ url: ctx.url, init: { ...ctx.init, body: JSON.stringify(body) } });
      } catch {
        return next(ctx);
      }
    }

    return next(ctx);
  };
}
