import process from 'node:process';
import { HookService } from './hook-service.js';
/**
 * Builds root-session hooks at the CLI composition boundary. Tool execution
 * may use a remote directory, while hook extensions remain local to Term2.
 */
export function createRootHookRuntime(options) {
    const { executionContext, logger, registryOptions, ...discoveryOptions } = options;
    const cwd = executionContext.isRemote() ? process.cwd() : executionContext.getCwd();
    return {
        cwd,
        hookService: new HookService({
            discoveryOptions: { cwd, ...discoveryOptions },
            registryOptions,
            logger,
        }),
    };
}
//# sourceMappingURL=hook-composition.js.map