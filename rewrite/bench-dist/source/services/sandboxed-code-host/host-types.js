export function isCapabilityOutcome(value) {
    return (typeof value === 'object' &&
        value !== null &&
        (value.kind === 'result' || value.kind === 'fail'));
}
//# sourceMappingURL=host-types.js.map