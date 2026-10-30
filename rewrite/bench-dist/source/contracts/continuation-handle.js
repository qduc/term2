const values = new WeakMap();
export function createContinuationHandle(value) {
    const source = value;
    const handle = Object.freeze({
        kind: 'continuation',
        ...(typeof source?.approve === 'function'
            ? { approve: (interruption) => source.approve(interruption) }
            : {}),
        ...(typeof source?.reject === 'function'
            ? { reject: (interruption, options) => source.reject(interruption, options) }
            : {}),
    });
    values.set(handle, value);
    return handle;
}
export function unwrapContinuationHandle(handle) {
    if (!handle || handle.kind !== 'continuation' || !values.has(handle)) {
        throw new Error('Invalid continuation handle');
    }
    return values.get(handle);
}
//# sourceMappingURL=continuation-handle.js.map