import { HookDiscovery, } from './hook-discovery.js';
import { HookRegistry, } from './hook-registry.js';
import { JitiHookModuleLoader } from './hook-module-loader.js';
import { ensureHookEditorShim } from './hook-editor-shim.js';
/**
 * Composition boundary for public hooks. Discovery and module evaluation live
 * here; lifecycle owners only need the HookLifecyclePort and never need to
 * know where callbacks came from.
 */
export class HookService {
    #discovery;
    #moduleLoader;
    #registry;
    #logger;
    #started = false;
    #shutdown = false;
    #startupResult;
    constructor(options = {}) {
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
    get registry() {
        return this.#registry;
    }
    get started() {
        return this.#started;
    }
    get startupResult() {
        return this.#startupResult;
    }
    /** Load and register all hooks once, preserving discovery order. */
    async start() {
        if (this.#shutdown)
            throw new Error('HookService has already been shut down');
        if (this.#startupResult)
            return this.#startupResult;
        const diagnostics = [];
        const loadedFiles = [];
        const skippedFiles = [];
        let discovered = [];
        try {
            const result = await this.#discovery.discover();
            discovered = result.files;
            diagnostics.push(...result.diagnostics);
            for (const diagnostic of result.diagnostics)
                this.#log(diagnostic);
            if (result.userRoot) {
                await ensureHookEditorShim(result.userRoot);
            }
            if (result.projectRoot && result.files.some((f) => f.scope === 'project')) {
                await ensureHookEditorShim(result.projectRoot);
            }
        }
        catch (error) {
            const diagnostic = {
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
            }
            catch (error) {
                const diagnostic = {
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
            }
            catch (error) {
                const diagnostic = {
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
    initialize() {
        return this.start();
    }
    async emit(event) {
        if (this.#shutdown)
            return;
        await this.#registry.dispatch(event);
    }
    async shutdown() {
        if (this.#shutdown)
            return;
        this.#shutdown = true;
        this.#registry.clear();
    }
    dispose() {
        return this.shutdown();
    }
    #log(diagnostic) {
        if (!this.#logger)
            return;
        try {
            this.#logger(diagnostic);
        }
        catch (error) {
            void error;
        }
    }
}
//# sourceMappingURL=hook-service.js.map