/**
 * Neuralwatt requires an explicit effort to emit reasoning. Preserve the
 * existing case-insensitive configured-id match for its default effort.
 */
export function neuralwattDefaultReasoningLevel(providerId) {
    return providerId.toLowerCase() === 'neuralwatt' ? 'high' : undefined;
}
//# sourceMappingURL=neuralwatt.provider.js.map