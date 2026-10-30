export function composeFetch(baseFetch, middlewares) {
    if (middlewares.length === 0) {
        return baseFetch;
    }
    return async (input, init) => {
        const ctx = { url: input, init };
        // Build the chain: each middleware calls next, the innermost next calls baseFetch
        let index = 0;
        const next = async (currentCtx) => {
            if (index < middlewares.length) {
                const middleware = middlewares[index];
                index++;
                return middleware(currentCtx, next);
            }
            return baseFetch(currentCtx.url, currentCtx.init);
        };
        return next(ctx);
    };
}
//# sourceMappingURL=compose.js.map