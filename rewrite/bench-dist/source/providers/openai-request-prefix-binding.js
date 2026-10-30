import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
class OpenAIRequestPrefixBindingScope {
    #prepared;
    #ambiguous = false;
    #consumed = false;
    prepare(binding, expectedInput) {
        if (this.#ambiguous)
            return;
        if (this.#prepared) {
            // A scope does not have an invocation identity. Once two preparations
            // overlap, input contents cannot establish which builder caused either.
            this.#prepared = undefined;
            this.#ambiguous = true;
            return;
        }
        try {
            this.#prepared = {
                binding: Object.freeze({ ...binding }),
                // Input equality can reject a mismatched builder, but cannot establish
                // causality between two independently prepared invocations.
                expectedInput: structuredClone(expectedInput),
            };
        }
        catch {
            // Instrumentation is fail-closed and must never alter a model call.
            this.#prepared = undefined;
        }
    }
    consume(input) {
        try {
            if (this.#ambiguous) {
                // One consume retires the ambiguous overlap, leaving both invocations
                // unbound rather than allowing stale evidence to bind a later build.
                this.#ambiguous = false;
                this.#consumed = true;
                return { outcome: 'already_consumed' };
            }
            const prepared = this.#prepared;
            this.#prepared = undefined;
            const wasConsumed = this.#consumed;
            this.#consumed = true;
            if (!prepared)
                return { outcome: wasConsumed ? 'already_consumed' : 'not_prepared' };
            return isDeepStrictEqual(prepared.expectedInput, input)
                ? { binding: prepared.binding }
                : { outcome: 'input_mismatch' };
        }
        catch {
            return { outcome: 'input_mismatch' };
        }
    }
}
const scopeStorage = new AsyncLocalStorage();
export const runWithOpenAIRequestPrefixBindingScope = (run) => scopeStorage.run(new OpenAIRequestPrefixBindingScope(), run);
export const prepareOpenAIRequestPrefixBinding = (binding, expectedInput) => {
    try {
        scopeStorage.getStore()?.prepare(binding, expectedInput);
    }
    catch {
        // AsyncLocalStorage/instrumentation failure is observational only.
    }
};
export const consumeOpenAIRequestPrefixBindingWithOutcome = (input) => {
    try {
        const scope = scopeStorage.getStore();
        if (!scope)
            return { outcome: 'not_prepared' };
        return scope.consume(input);
    }
    catch {
        return { outcome: 'input_mismatch' };
    }
};
//# sourceMappingURL=openai-request-prefix-binding.js.map