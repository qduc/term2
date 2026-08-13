import process from 'node:process';
import type { ExecutionContext } from '../execution-context.js';
import type { HookDiscoveryOptions } from './hook-discovery.js';
import { HookService, type HookServiceOptions } from './hook-service.js';

export interface RootHookRuntimeOptions
  extends Omit<HookDiscoveryOptions, 'cwd'>,
    Pick<HookServiceOptions, 'logger' | 'registryOptions'> {
  readonly executionContext: Pick<ExecutionContext, 'getCwd' | 'isRemote'>;
}

export interface RootHookRuntime {
  /** The directory represented in root-session hook discovery and events. */
  readonly cwd: string;
  readonly hookService: HookService;
}

/**
 * Builds root-session hooks at the CLI composition boundary. Tool execution
 * may use a remote directory, while hook extensions remain local to Term2.
 */
export function createRootHookRuntime(options: RootHookRuntimeOptions): RootHookRuntime {
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
