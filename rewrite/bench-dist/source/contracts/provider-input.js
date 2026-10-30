export const isLocalContextSummary = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return false;
    const marker = item.contextSummary;
    return marker?.version === 1 && marker.strategy === 'local';
};
//# sourceMappingURL=provider-input.js.map