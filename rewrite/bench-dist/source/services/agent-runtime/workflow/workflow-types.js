export const DEFAULT_WORKFLOW_LIMITS = {
    timeoutMs: 120_000,
    maxRuns: 8,
    maxConcurrency: 3,
    maxCodeBytes: 16_384,
    maxOutputBytes: 65_536,
    maxConsoleBytes: 16_384,
};
export function isJsonValue(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value))
        return false;
    ancestors.add(value);
    const values = Array.isArray(value) ? value : Object.values(value);
    const valid = values.every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
}
//# sourceMappingURL=workflow-types.js.map