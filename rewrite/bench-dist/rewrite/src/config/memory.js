/** Fixed in-memory settings. Enough for the tracer; no persistence or scoping. */
export function memorySettings(values = {}) {
    const map = new Map(Object.entries(values));
    return {
        get: (key) => map.get(key),
        watch: (_listener) => () => { },
    };
}
//# sourceMappingURL=memory.js.map