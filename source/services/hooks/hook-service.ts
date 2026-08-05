import type { Term2HookEvent, Term2HookEventName } from './hook-contracts.js';
import {
  HookDiscovery,
  type HookDiscoveryOptions,
  type DiscoveredHookFile,
  type HookDiscoveryResult,
} from './hook-discovery.js';
import {
  HookRegistry,
  type HookDiagnostic,
  type HookDiagnosticLogger,
  type HookRegistryOptions,
} from './hook-registry.js';
import { JitiHookModuleLoader, type HookModuleLoader } from './hook-module-loader.js';

export interface HookServiceOptions {
  readonly discovery?: HookDiscoveryPort;
  readonly discoveryOptions?: HookDiscoveryOptions;
  readonly moduleLoader?: HookModuleLoader;
  readonly registry?: HookRegistry;
  readonly registryOptions?: HookRegistryOptions;
  readonly logger?: HookDiagnosticLogger;
}

export interface HookDiscoveryPort {
  discover(): Promise<HookDiscoveryResult>;
}

export interface HookStartupResult {
  readonly loadedFiles: readonly string[];
  readonly skippedFiles: readonly string[];
  readonly diagnostics: readonly HookDiagnostic[];
}

export interface HookLifecyclePort {
  emit<Name extends Term2HookEventName>(event: Term2HookEvent<Name>): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Composition boundary for public hooks. Discovery and module evaluation live
 * here; lifecycle owners only need the HookLifecyclePort and never need to
 * know where callbacks came from.
 */
export class HookService implements HookLifecyclePort {
  readonly #discovery: HookDiscoveryPort;
  readonly #moduleLoader: HookModuleLoader;
  readonly #registry: HookRegistry;
  readonly #logger?: HookDiagnosticLogger;
  #started = false;
  #shutdown = false;
  #startupResult: HookStartupResult | undefined;

  constructor(options: HookServiceOptions = {}) {
    this.#logger = options.logger;
    this.#discovery = options.discovery ?? new HookDiscovery(options.discoveryOptions);
    this.#moduleLoader =
      options.moduleLoader ??
      new JitiHookModuleLoader((path) => {
        // jiti is a production dependency so packaged/global Term2 installs can
        // load TypeScript hooks without relying on the development tsx runner.
        // Keep the import lazy so embedders that inject a loader need not pay the
        // module initialization cost.
        return import('jiti').then(({ createJiti }) => createJiti(import.meta.url, { interopDefault: true })(path));
      });
    this.#registry = options.registry ?? new HookRegistry({ ...options.registryOptions, logger: options.logger });
  }

  get registry(): HookRegistry {
    return this.#registry;
  }

  get started(): boolean {
    return this.#started;
  }

  get startupResult(): HookStartupResult | undefined {
    return this.#startupResult;
  }

  /** Load and register all hooks once, preserving discovery order. */
  async start(): Promise<HookStartupResult> {
    if (this.#shutdown) throw new Error('HookService has already been shut down');
    if (this.#startupResult) return this.#startupResult;

    const diagnostics: HookDiagnostic[] = [];
    const loadedFiles: string[] = [];
    const skippedFiles: string[] = [];
    let discovered: readonly DiscoveredHookFile[] = [];

    try {
      const result = await this.#discovery.discover();
      discovered = result.files;
      diagnostics.push(...result.diagnostics);
      for (const diagnostic of result.diagnostics) this.#log(diagnostic);
    } catch (error) {
      const diagnostic: HookDiagnostic = {
        code: 'discovery_failed',
        message: 'Hook discovery failed; continuing without discovered hooks',
        error,
      };
      diagnostics.push(diagnostic);
      this.#log(diagnostic);
    }

    for (const file of discovered) {
      let registration;
      try {
        registration = await this.#moduleLoader.load(file.path);
      } catch (error) {
        const diagnostic: HookDiagnostic = {
          code: 'module_load_failed',
          message: 'Hook module failed to load and was skipped',
          source: { path: file.path, scope: file.scope },
          error,
        };
        diagnostics.push(diagnostic);
        skippedFiles.push(file.path);
        this.#log(diagnostic);
        continue;
      }

      try {
        await this.#registry.register({ path: file.path, scope: file.scope }, registration);
        loadedFiles.push(file.path);
      } catch (error) {
        const diagnostic: HookDiagnostic = {
          code: 'registration_rejected',
          message: 'Hook registration failed and was rolled back; module was skipped',
          source: { path: file.path, scope: file.scope },
          error,
        };
        diagnostics.push(diagnostic);
        skippedFiles.push(file.path);
      }
    }

    this.#started = true;
    this.#startupResult = { loadedFiles, skippedFiles, diagnostics };
    return this.#startupResult;
  }

  /** Alias for callers that describe startup as initialization. */
  initialize(): Promise<HookStartupResult> {
    return this.start();
  }

  async emit<Name extends Term2HookEventName>(event: Term2HookEvent<Name>): Promise<void> {
    if (this.#shutdown) return;
    await this.#registry.dispatch(event);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.#registry.clear();
  }

  dispose(): Promise<void> {
    return this.shutdown();
  }

  #log(diagnostic: HookDiagnostic): void {
    if (!this.#logger) return;
    try {
      this.#logger(diagnostic);
    } catch (error) {
      void error;
    }
  }
}
