import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

/** Applies provider-specific call-option conventions at the AI SDK model boundary. */
export function withForwardedProviderSettings<T extends LanguageModelV3>(
  model: T,
  forwardSettings: (options: LanguageModelV3CallOptions) => LanguageModelV3CallOptions,
): T {
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doStream')
        return (options: LanguageModelV3CallOptions) => target.doStream(forwardSettings(options));
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
