export class ToolInterceptorRegistry {
    #interceptors = [];
    #logger;
    constructor(deps) {
        this.#logger = deps.logger;
    }
    add(interceptor) {
        this.#interceptors.push(interceptor);
        return () => {
            this.#interceptors = this.#interceptors.filter((i) => i !== interceptor);
        };
    }
    async check(name, params, toolCallId) {
        for (const interceptor of this.#interceptors) {
            try {
                const result = await interceptor(name, params, toolCallId);
                if (result !== null) {
                    return result;
                }
            }
            catch (error) {
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
//# sourceMappingURL=tool-interceptor-registry.js.map