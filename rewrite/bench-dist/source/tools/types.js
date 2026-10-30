/** The request snapshot carried by `details`, if the caller supplied one. */
export function getRequestSnapshot(details) {
    if (!details || typeof details !== 'object' || !('request' in details))
        return undefined;
    const request = details.request;
    return request && typeof request === 'object' && 'goal' in request ? request : undefined;
}
/** Runtime discriminator for the executable Zod side of {@link ToolParameterSchema}. */
export function isZodToolParameterSchema(schema) {
    return typeof schema?.safeParse === 'function';
}
//# sourceMappingURL=types.js.map