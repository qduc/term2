var _a;
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';
import { createSandboxRuntimeConfig } from './sandbox-policy.js';
import { requestSandboxNetworkApproval } from './sandbox-network-approval.js';
export class AnthropicShellSandboxRunner {
    // SandboxManager is a process-wide singleton. Keep configuration and wrapping
    // together so every generated sandbox command gets the policy it requested.
    // The lock does not cover process execution: wrapped commands still run concurrently.
    static #initializedForKey;
    static #initializationFailure;
    static #managerOperation = Promise.resolve();
    #heldLease = false;
    async availability() {
        if (!SandboxManager.isSupportedPlatform()) {
            return { type: 'unsupported_platform', reason: 'Sandbox runtime does not support this platform.' };
        }
        const dependencyCheck = SandboxManager.checkDependencies();
        if (dependencyCheck.errors.length > 0) {
            return { type: 'missing_dependency', reason: dependencyCheck.errors.join('; ') };
        }
        if (_a.#initializationFailure) {
            return _a.#initializationFailure;
        }
        return { type: 'available' };
    }
    async wrap(command, options) {
        const operation = async () => {
            await this.#initialize(options.cwd, options.config);
            const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, options.signal);
            const diagnostics = SandboxManager.getLinuxGlobPatternWarnings?.() ?? [];
            return { command: wrapped, diagnostics };
        };
        return this.#heldLease ? operation() : this.#withManagerLock(operation);
    }
    async acquire() {
        const previous = _a.#managerOperation;
        let release;
        _a.#managerOperation = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        this.#heldLease = true;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.#heldLease = false;
            release();
        };
    }
    cleanupAfterCommand() {
        SandboxManager.cleanupAfterCommand();
    }
    annotateFailure(command, stderr) {
        return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
    }
    async #initialize(cwd, config = createSandboxRuntimeConfig({ cwd, tmpDir: SANDBOX_TEMP_DIR })) {
        const initializationKey = JSON.stringify({ cwd, config });
        if (_a.#initializedForKey === initializationKey) {
            return;
        }
        try {
            if (_a.#initializedForKey) {
                await SandboxManager.reset();
            }
            const sandboxAskCallback = async ({ host, port }) => {
                return requestSandboxNetworkApproval({ host, port });
            };
            await SandboxManager.initialize(config, sandboxAskCallback);
            _a.#initializedForKey = initializationKey;
            _a.#initializationFailure = undefined;
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            _a.#initializationFailure = { type: 'initialization_failed', reason };
            throw error;
        }
    }
    async #withManagerLock(operation) {
        const previous = _a.#managerOperation;
        let release;
        _a.#managerOperation = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
}
_a = AnthropicShellSandboxRunner;
let defaultRunner;
export function getDefaultShellSandboxRunner() {
    defaultRunner ??= new AnthropicShellSandboxRunner();
    return defaultRunner;
}
//# sourceMappingURL=shell-sandbox-runner.js.map