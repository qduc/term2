import type { Runner } from '@openai/agents';
import type { ISettingsService, ILoggingService, ISessionContextService } from '../services/service-interfaces.js';
import { getProvider } from '../providers/index.js';

export interface RunnerManagerDeps {
  settings: ISettingsService;
  logger: ILoggingService;
  sessionContextService: ISessionContextService;
  /** Returns the current provider ID — used to key the cached runner */
  getProvider: () => string;
}

export class RunnerManager {
  #runner: Runner | null = null;
  #maxTurns: number;
  #retryAttempts: number;
  #retryCallback: (() => void) | null = null;

  #settings: ISettingsService;
  #logger: ILoggingService;
  #sessionContextService: ISessionContextService;
  #getProvider: () => string;

  constructor(config: { maxTurns: number; retryAttempts: number }, deps: RunnerManagerDeps) {
    this.#maxTurns = config.maxTurns;
    this.#retryAttempts = config.retryAttempts;
    this.#settings = deps.settings;
    this.#logger = deps.logger;
    this.#sessionContextService = deps.sessionContextService;
    this.#getProvider = deps.getProvider;
  }

  get maxTurns(): number {
    return this.#maxTurns;
  }

  get retryAttempts(): number {
    return this.#retryAttempts;
  }

  setRetryCallback(callback: () => void): void {
    this.#retryCallback = callback;
  }

  invalidateRunner(): void {
    this.#runner = null;
  }

  getOrCreateRunner(providerId: string): Runner | null {
    // For non-primary providers, always create fresh (no caching)
    if (providerId !== this.#getProvider()) {
      return this.#createRunner(providerId);
    }

    // For the primary provider, cache and reuse
    if (this.#runner) {
      return this.#runner;
    }

    this.#runner = this.#createRunner(providerId);
    return this.#runner;
  }

  #createRunner(providerId: string): Runner | null {
    const providerDef = getProvider(providerId);
    if (!providerDef?.createRunner) {
      return null;
    }

    return providerDef.createRunner({
      settingsService: this.#settings,
      loggingService: this.#logger,
      sessionContextService: this.#sessionContextService,
      onRetry: () => this.#retryCallback?.(),
    });
  }
}
