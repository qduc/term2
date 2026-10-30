/** Applies provider-specific call-option conventions at the AI SDK model boundary. */
export function withForwardedProviderSettings(model, forwardSettings) {
    return new Proxy(model, {
        get(target, property, receiver) {
            if (property === 'doStream' || property === 'doGenerate')
                return (options) => target[property](forwardSettings(options));
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
export function forwardExplicitProviderSettings(options, providerName) {
    const providerData = options.providerOptions;
    if (!providerData || typeof providerData !== 'object')
        return options;
    const { providerOptions, [providerName]: nestedProviderData, ...extraProviderData } = providerData;
    if (!Object.keys(extraProviderData).length)
        return options;
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
/** Translate the application's named effort into the shared SDK thinking-token scale. */
export function resolveThinkingBudget(effort) {
    const budgets = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384 };
    return effort ? budgets[effort] : undefined;
}
//# sourceMappingURL=ai-sdk-provider-settings.js.map