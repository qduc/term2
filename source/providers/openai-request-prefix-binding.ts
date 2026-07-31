import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

/**
 * The Agents SDK input filter sees AgentInputItems, while the private Responses
 * builder records the provider-shaped request input. For the one representation
 * change this scope can establish without guessing, normalize an SDK message
 * wrapper to its equivalent Responses message. Everything else is left exact.
 */
const normalizeComparableInput = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeComparableInput);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'undefined') continue;
    // `getMessageItem()` drops the SDK-only message discriminant before the
    // Responses request is built. Do not normalize any other item type.
    if (key === 'type' && entry === 'message' && typeof record.role === 'string') continue;
    normalized[key] = normalizeComparableInput(entry);
  }
  return normalized;
};

/**
 * Provider-private, observational handoff between the Agents input filter and
 * the OpenAI model's final request builder. Nothing here is sent on the wire.
 */
export type OpenAIRequestPrefixBinding = Readonly<{
  snapshotIdentity: string;
  snapshotRevision: number;
  /** Captured while planning the request; never read from live session state. */
  lineage: number;
}>;

class OpenAIRequestPrefixBindingScope {
  #prepared: { binding: OpenAIRequestPrefixBinding; expectedInput: unknown } | undefined;
  #ambiguous = false;

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

  consume(requestData: Record<string, unknown>): OpenAIRequestPrefixBinding | undefined {
    try {
      if (this.#ambiguous) {
        // One consume retires the ambiguous overlap, leaving both invocations
        // unbound rather than allowing stale evidence to bind a later build.
        this.#ambiguous = false;
        return undefined;
      }

      const prepared = this.#prepared;
      this.#prepared = undefined;
      return prepared &&
        isDeepStrictEqual(normalizeComparableInput(prepared.expectedInput), normalizeComparableInput(requestData.input))
        ? prepared.binding
        : undefined;
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
  expectedInput: unknown,
): void => {
  try {
    scopeStorage.getStore()?.prepare(binding, expectedInput);
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
