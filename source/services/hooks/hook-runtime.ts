import process from 'node:process';
import type { HookDiscoveryOptions } from './hook-discovery.js';
import { HookService, type HookServiceOptions } from './hook-service.js';

export interface LocalHookRuntimeOptions
  extends Omit<HookDiscoveryOptions, 'cwd'>,
    Pick<HookServiceOptions, 'logger' | 'registryOptions'> {
  /** Injectable for embeddings and tests; the CLI uses this process's cwd. */
  readonly cwd?: string;
}

export interface LocalHookRuntime {
  /** The local Term2 process directory represented in hook discovery and events. */
  readonly cwd: string;
  readonly hookService: HookService;
}

/**
 * Hooks are local trusted process extensions, even when an ExecutionContext
 * sends tools to SSH. Keep the local session directory in one composition
 * result so startup cannot accidentally reuse the remote execution directory.
 */
export function createLocalHookRuntime(options: LocalHookRuntimeOptions = {}): LocalHookRuntime {
  const { cwd = process.cwd(), logger, registryOptions, ...discoveryOptions } = options;
  return {
    cwd,
    hookService: new HookService({
      discoveryOptions: { cwd, ...discoveryOptions },
      registryOptions,
      logger,
    }),
  };
}
