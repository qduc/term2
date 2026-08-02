import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

/**
 * Request preparation sees canonical application input, while the private
 * Responses builder records the provider-shaped request input. For the one
 * representation change this scope can establish without guessing, normalize
 * an input message wrapper to its equivalent Responses message. Everything
 * else is left exact.
 */
/**
 * Provider-private, observational handoff between application input
 * preparation and the inherited transport's final request builder. Nothing
 * here is sent on the wire.
 */
export type OpenAIRequestPrefixBinding = Readonly<{
  snapshotIdentity: string;
  snapshotRevision: number;
  /** Captured while planning the request; never read from live session state. */
  lineage: number;
}>;

export type OpenAIRequestPrefixBindingOutcome = 'not_prepared' | 'already_consumed' | 'input_mismatch';

export type OpenAIRequestPrefixBindingConsumption = Readonly<{
  binding?: OpenAIRequestPrefixBinding;
  outcome?: OpenAIRequestPrefixBindingOutcome;
}>;

class OpenAIRequestPrefixBindingScope {
  #prepared: { binding: OpenAIRequestPrefixBinding; expectedInput: unknown } | undefined;
  #ambiguous = false;
  #consumed = false;

  prepare(binding: OpenAIRequestPrefixBinding, expectedInput: unknown): void {
    if (this.#ambiguous) return;
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
    } catch {
      // Instrumentation is fail-closed and must never alter a model call.
      this.#prepared = undefined;
    }
  }

  consume(input: unknown): OpenAIRequestPrefixBindingConsumption {
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
      if (!prepared) return { outcome: wasConsumed ? 'already_consumed' : 'not_prepared' };
      return isDeepStrictEqual(prepared.expectedInput, input)
        ? { binding: prepared.binding }
        : { outcome: 'input_mismatch' };
    } catch {
      return { outcome: 'input_mismatch' };
    }
  }
}

const scopeStorage = new AsyncLocalStorage<OpenAIRequestPrefixBindingScope>();

export const runWithOpenAIRequestPrefixBindingScope = <T>(run: () => Promise<T>): Promise<T> =>
  scopeStorage.run(new OpenAIRequestPrefixBindingScope(), run);

export const prepareOpenAIRequestPrefixBinding = (
  binding: OpenAIRequestPrefixBinding,
  expectedInput: unknown,
): void => {
  try {
    scopeStorage.getStore()?.prepare(binding, expectedInput);
  } catch {
    // AsyncLocalStorage/instrumentation failure is observational only.
  }
};

export const consumeOpenAIRequestPrefixBinding = (input: unknown): OpenAIRequestPrefixBinding | undefined => {
  return consumeOpenAIRequestPrefixBindingWithOutcome(input).binding;
};

export const consumeOpenAIRequestPrefixBindingWithOutcome = (input: unknown): OpenAIRequestPrefixBindingConsumption => {
  try {
    const scope = scopeStorage.getStore();
    if (!scope) return { outcome: 'not_prepared' };
    return scope.consume(input);
  } catch {
    return { outcome: 'input_mismatch' };
  }
};
