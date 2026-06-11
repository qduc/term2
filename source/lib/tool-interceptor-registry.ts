import type { ToolInterceptor } from '../services/conversation-agent-client.js';
import type { ILoggingService } from '../services/service-interfaces.js';

export class ToolInterceptorRegistry {
  #interceptors: ToolInterceptor[] = [];
  #logger: ILoggingService;

  constructor(deps: { logger: ILoggingService }) {
    this.#logger = deps.logger;
  }

  add(interceptor: ToolInterceptor): () => void {
    this.#interceptors.push(interceptor);
    return () => {
      this.#interceptors = this.#interceptors.filter((i) => i !== interceptor);
    };
  }

  async check(name: string, params: unknown, toolCallId?: string): Promise<string | null> {
    for (const interceptor of this.#interceptors) {
      try {
        const result = await interceptor(name, params, toolCallId);
        if (result !== null) {
          return result;
        }
      } catch (error) {
        this.#logger.error('Tool interceptor threw an error', {
          name,
          params,
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return `Tool execution intercepted but failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  }
}
