import type { ILoggingService } from '../services/service-interfaces.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { createOpencodeSessionInjector } from './opencode-session.js';

/**
 * Creates a fetch middleware for Anthropic-compatible provider requests.
 *
 * The only transform this middleware performs is injecting an
 * `x-opencode-session` header when the provider targets opencode.ai,
 * using the same opencode-specific logic as `createOpenAICompatibleMiddleware`.
 *
 * Prompt caching is NOT handled here — the {@link AiSdkAnthropicProvider} already
 * manages it via the AI SDK `anthropicPromptCachingMiddleware` in
 * `ai-sdk-anthropic.provider.ts`, which operates at the correct layer.
 *
 * @param providerType - Provider type (e.g. `'anthropic'`, `'opencode'`).
 * @param baseUrl      - Base URL used for opencode host detection.
 * @param loggingService - Optional logging service for resolving traffic context.
 * @param fallbackSessionIdOverride - Optional explicit session ID override
 *   (takes precedence over traffic context).
 */
export function createAnthropicMiddleware(
  providerType: string,
  baseUrl?: string,
  loggingService?: ILoggingService,
  fallbackSessionIdOverride?: string,
): FetchMiddleware {
  const injectSession = createOpencodeSessionInjector(
    { type: providerType, baseUrl },
    { loggingService, fallbackSessionIdOverride },
  );

  return async (ctx, next) => {
    if (injectSession) {
      const newInit = injectSession(ctx.init ?? {});
      if (newInit) {
        return next({ url: ctx.url, init: newInit });
      }
    }

    return next(ctx);
  };
}
