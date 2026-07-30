import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

/**
 * Provider-private, observational handoff between the Agents input filter and
 * the OpenAI model's final request builder. Nothing here is sent on the wire.
 */
export type OpenAIRequestPrefixBinding = Readonly<{
  snapshotIdentity: string;
  snapshotRevision: number;
}>;

type PreparedInvocation = {
  binding: OpenAIRequestPrefixBinding;
  expectedInput: unknown;
};

class OpenAIRequestPrefixBindingScope {
  #prepared: PreparedInvocation[] = [];

  prepare(binding: OpenAIRequestPrefixBinding, projectedInput: unknown): void {
    try {
      // Keep only the evidence needed to compare the final builder projection.
      this.#prepared.push({ binding: Object.freeze({ ...binding }), expectedInput: structuredClone(projectedInput) });
    } catch {
      // Instrumentation is fail-closed and must never alter a model call.
    }
  }

  consume(requestData: Record<string, unknown>): OpenAIRequestPrefixBinding | undefined {
    try {
      const matches = this.#prepared.filter((prepared) => isDeepStrictEqual(prepared.expectedInput, requestData.input));
      if (matches.length !== 1) {
        // No exact causal correspondence (or identical overlapping calls) must
        // not leave stale evidence available to a later builder invocation.
        this.#prepared = [];
        return undefined;
      }

      const [match] = matches;
      this.#prepared = this.#prepared.filter((prepared) => prepared !== match);
      return match.binding;
    } catch {
      return undefined;
    }
  }
}

const scopeStorage = new AsyncLocalStorage<OpenAIRequestPrefixBindingScope>();

export const runWithOpenAIRequestPrefixBindingScope = <T>(run: () => Promise<T>): Promise<T> =>
  scopeStorage.run(new OpenAIRequestPrefixBindingScope(), run);

export const prepareOpenAIRequestPrefixBinding = (
  binding: OpenAIRequestPrefixBinding,
  projectedInput: unknown,
): void => {
  try {
    scopeStorage.getStore()?.prepare(binding, projectedInput);
  } catch {
    // AsyncLocalStorage/instrumentation failure is observational only.
  }
};

export const consumeOpenAIRequestPrefixBinding = (
  requestData: Record<string, unknown>,
): OpenAIRequestPrefixBinding | undefined => {
  try {
    return scopeStorage.getStore()?.consume(requestData);
  } catch {
    return undefined;
  }
};
