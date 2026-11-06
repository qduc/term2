import type { LanguageModelV3, LanguageModelV3CallOptions, SharedV3ProviderOptions } from '@ai-sdk/provider';

/** Applies provider-specific call-option conventions at the AI SDK model boundary. */
export function withForwardedProviderSettings<T extends LanguageModelV3>(
  model: T,
  forwardSettings: (options: LanguageModelV3CallOptions) => LanguageModelV3CallOptions,
): T {
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doStream' || property === 'doGenerate')
        return (options: LanguageModelV3CallOptions) => target[property](forwardSettings(options));
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Retains the legacy explicit-provider convention: top-level provider data is
 * available to the model and is copied into that provider's options, where
 * explicitly nested options win.
 */
export function forwardExplicitProviderSettings(
  options: LanguageModelV3CallOptions,
  providerName: string,
): LanguageModelV3CallOptions {
  const providerData = options.providerOptions as ExplicitProviderData | undefined;
  if (!providerData || typeof providerData !== 'object') return options;

  const { providerOptions, [providerName]: nestedProviderData, ...extraProviderData } = providerData;
  if (!Object.keys(extraProviderData).length) return options;

  return {
    ...options,
    ...extraProviderData,
    providerOptions: {
      ...(providerOptions ?? {}),
      [providerName]: {
        ...(nestedProviderData ?? {}),
        ...extraProviderData,
        ...(providerOptions?.[providerName] ?? {}),
      },
    },
  };
}

type ExplicitProviderData = SharedV3ProviderOptions & {
  providerOptions?: SharedV3ProviderOptions;
};

/** Translate the application's named effort into the shared SDK thinking-token scale. */
export function resolveThinkingBudget(effort: string | null | undefined): number | undefined {
  const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384 };
  return effort ? budgets[effort] : undefined;
}
