import { pathToFileURL } from 'node:url';

import type { Term2HookRegistration } from './hook-contracts.js';

export interface HookModuleLoader {
  load(path: string): Promise<Term2HookRegistration>;
}

export type HookModuleImporter = (path: string) => unknown | Promise<unknown>;

export type JitiModuleLoader = (path: string) => unknown | Promise<unknown>;

export class HookModuleLoadError extends Error {
  readonly path: string;

  constructor(path: string, message: string, options?: { readonly cause?: unknown }) {
    super(`${message}: ${path}`, options);
    this.name = 'HookModuleLoadError';
    this.path = path;
  }
}

function registrationFromModule(path: string, moduleValue: unknown): Term2HookRegistration {
  const candidate =
    typeof moduleValue === 'function'
      ? moduleValue
      : typeof moduleValue === 'object' && moduleValue !== null
      ? (moduleValue as { default?: unknown }).default
      : undefined;

  if (typeof candidate !== 'function') {
    throw new HookModuleLoadError(path, 'Hook module must default-export a registration function');
  }
  return candidate as Term2HookRegistration;
}

/**
 * Loader for environments where Node's native ESM loader can evaluate the
 * discovered file (notably JavaScript, and TypeScript under an embedding
 * loader). It is intentionally injected so the application does not depend on
 * its development-only tsx runner.
 */
export class NativeHookModuleLoader implements HookModuleLoader {
  readonly #importer: HookModuleImporter;

  constructor(importer?: HookModuleImporter) {
    this.#importer = importer ?? ((path) => import(pathToFileURL(path).href));
  }

  async load(path: string): Promise<Term2HookRegistration> {
    let moduleValue: unknown;
    try {
      moduleValue = await this.#importer(path);
    } catch (error) {
      throw new HookModuleLoadError(path, 'Could not evaluate hook module', { cause: error });
    }
    return registrationFromModule(path, moduleValue);
  }
}

/**
 * Adapter for a production jiti instance. jiti is deliberately not imported
 * here: it is an optional application composition dependency, while tests and
 * embedders can provide the same small callable interface without installing
 * it. The adapter supports both jiti's synchronous result and async wrappers.
 */
export class JitiHookModuleLoader implements HookModuleLoader {
  readonly #loadWithJiti: JitiModuleLoader;

  constructor(loadWithJiti: JitiModuleLoader) {
    if (typeof loadWithJiti !== 'function') {
      throw new TypeError('A jiti module loader function is required');
    }
    this.#loadWithJiti = loadWithJiti;
  }

  async load(path: string): Promise<Term2HookRegistration> {
    let moduleValue: unknown;
    try {
      moduleValue = await this.#loadWithJiti(path);
    } catch (error) {
      throw new HookModuleLoadError(path, 'Could not evaluate hook module', { cause: error });
    }
    return registrationFromModule(path, moduleValue);
  }
}

export const validateHookModuleDefaultExport = registrationFromModule;
