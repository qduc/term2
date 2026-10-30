export function parseModelProviderArg(value) {
    const trimmed = value.trim();
    const providerMatch = trimmed.match(/\s+--provider=(.+)$/);
    if (!providerMatch || providerMatch.index === undefined) {
        return {
            modelId: trimmed,
            provider: undefined,
        };
    }
    return {
        modelId: trimmed.slice(0, providerMatch.index).trim(),
        provider: providerMatch[1].trim() || undefined,
    };
}
//# sourceMappingURL=model-provider-arg.js.map