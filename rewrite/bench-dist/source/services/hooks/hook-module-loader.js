import { pathToFileURL } from 'node:url';
export class HookModuleLoadError extends Error {
    path;
    constructor(path, message, options) {
        super(`${message}: ${path}`, options);
        this.name = 'HookModuleLoadError';
        this.path = path;
    }
}
function registrationFromModule(path, moduleValue) {
    const candidate = typeof moduleValue === 'function'
        ? moduleValue
        : typeof moduleValue === 'object' && moduleValue !== null
            ? moduleValue.default
            : undefined;
    if (typeof candidate !== 'function') {
        throw new HookModuleLoadError(path, 'Hook module must default-export a registration function');
    }
    return candidate;
}
/**
 * Loader for environments where Node's native ESM loader can evaluate the
 * discovered file (notably JavaScript, and TypeScript under an embedding
 * loader). It is intentionally injected so the application does not depend on
 * its development-only tsx runner.
 */
export class NativeHookModuleLoader {
    #importer;
    constructor(importer) {
        this.#importer = importer ?? ((path) => import(pathToFileURL(path).href));
    }
    async load(path) {
        let moduleValue;
        try {
            moduleValue = await this.#importer(path);
        }
        catch (error) {
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
export class JitiHookModuleLoader {
    #loadWithJiti;
    constructor(loadWithJiti) {
        if (typeof loadWithJiti !== 'function') {
            throw new TypeError('A jiti module loader function is required');
        }
        this.#loadWithJiti = loadWithJiti;
    }
    async load(path) {
        let moduleValue;
        try {
            moduleValue = await this.#loadWithJiti(path);
        }
        catch (error) {
            throw new HookModuleLoadError(path, 'Could not evaluate hook module', { cause: error });
        }
        return registrationFromModule(path, moduleValue);
    }
}
//# sourceMappingURL=hook-module-loader.js.map