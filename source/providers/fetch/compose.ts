export type FetchContext = {
  url: RequestInfo | URL;
  init?: RequestInit;
};

export type FetchMiddleware = (ctx: FetchContext, next: (ctx: FetchContext) => Promise<Response>) => Promise<Response>;

export function composeFetch(baseFetch: typeof fetch, middlewares: FetchMiddleware[]): typeof fetch {
  if (middlewares.length === 0) {
    return baseFetch;
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctx: FetchContext = { url: input, init };

    // Build the chain: each middleware calls next, the innermost next calls baseFetch
    let index = 0;

    const next = async (currentCtx: FetchContext): Promise<Response> => {
      if (index < middlewares.length) {
        const middleware = middlewares[index]!;
        index++;
        return middleware(currentCtx, next);
      }
      return baseFetch(currentCtx.url, currentCtx.init);
    };

    return next(ctx);
  };
}
