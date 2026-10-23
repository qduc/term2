# Refactoring Provider Fetch Interception to Composable Middleware

This plan outlines the refactoring of `source/providers/ai-sdk-logging-fetch.ts` to separate concerns between request logging, request decoration, and provider-specific preprocessing. It introduces a lightweight middleware pipeline (`composeFetch`) to support modularity and easy integration of new providers.

## User Review Required

> [!IMPORTANT]
> - **Deprecating `ai-sdk-logging-fetch.ts`**: The old file `source/providers/ai-sdk-logging-fetch.ts` will be deleted.
> - **Middleware Ordering**: Preprocessing and decoration middlewares (e.g. Codex authentication, OpenRouter preprocessors) will execute first in the list. The `loggingMiddleware` will execute last, immediately wrapping the base `fetch` call. This ensures that the logged requests match the actual outbound HTTP payloads.
> - **Codex Details**: Existing Codex fetch quirks—such as refreshing tokens, sanitizing request bodies, lowercasing incoming headers, and injecting authorization and ChatGPT account headers—will be fully migrated into modular Codex-specific middlewares inside `codex.provider.ts`.
> - **Dynamic Session Resolution**: The Codex headers middleware will receive `loggingService` and resolve `session_id` dynamically at request time using `loggingService.getTrafficContext()?.sessionId` to prevent caching a single session ID.
> - **Provider Test Coverage**: Beyond writing the new `composer.test.ts`, we will also update and verify all provider-specific tests (`codex.provider.test.ts`, `openrouter.provider.request-preprocessing.test.ts`, and `openai-compatible.provider.test.ts`) to ensure that all custom headers and mutations continue to function.
> - **Fetch Implementation Dependency Injection**: `createProviderFetch` will accept an optional `fetchImpl` parameter, falling back to the global `fetch`. This is critical for testing where mock responses are returned.

## Proposed Changes

### Core Fetch Middleware Infrastructure

#### [NEW] [compose.ts](file:///ub/home/qduc/src/term2/source/providers/fetch/compose.ts)
- Implement `FetchContext` and `FetchMiddleware` type definitions:
  ```typescript
  export type FetchContext = {
    url: RequestInfo | URL;
    init?: RequestInit;
  };
  export type FetchMiddleware = (
    ctx: FetchContext,
    next: (ctx: FetchContext) => Promise<Response>
  ) => Promise<Response>;
  ```
- Implement `composeFetch(baseFetch: typeof fetch, middlewares: FetchMiddleware[])` function to execute a list of middlewares sequentially.

#### [NEW] [logging-middleware.ts](file:///ub/home/qduc/src/term2/source/providers/fetch/logging-middleware.ts)
- Implement `createLoggingMiddleware(options)` factory:
  ```typescript
  export function createLoggingMiddleware({
    provider,
    model,
    loggingService,
  }: CreateLoggingMiddlewareOptions): FetchMiddleware
  ```
- Port the generic logging and traffic context extraction logic from `ai-sdk-logging-fetch.ts` into the returned middleware.
- Remove any provider-specific checks (e.g., `provider === 'codex'`).

#### [NEW] [composer.ts](file:///ub/home/qduc/src/term2/source/providers/fetch/composer.ts)
- Implement `createProviderFetch(options)` helper:
  ```typescript
  export function createProviderFetch({
    providerId,
    defaultModel,
    deps,
    middlewares = [],
    fetchImpl = fetch,
  }: CreateProviderFetchOptions): typeof fetch {
    return composeFetch(fetchImpl, [
      ...middlewares, // 1. Preprocessing and decorators execute first
      createLoggingMiddleware({
        provider: providerId,
        model: defaultModel,
        loggingService: deps.loggingService,
      }), // 2. Logging runs last, logging final mutated request
    ]);
  }
  ```

#### [DELETE] [ai-sdk-logging-fetch.ts](file:///ub/home/qduc/src/term2/source/providers/ai-sdk-logging-fetch.ts)
- Remove this file entirely.

### Provider Migrations & Preserved Behaviors

#### [MODIFY] [openai.provider.ts](file:///ub/home/qduc/src/term2/source/providers/openai.provider.ts)
- Replace `createAiSdkLoggingFetch` with `createProviderFetch`.

#### [MODIFY] [openrouter.provider.ts](file:///ub/home/qduc/src/term2/source/providers/openrouter.provider.ts)
- Convert `createOpenRouterRequestPreprocessingFetch` into a clean `openRouterPreprocessingMiddleware`.
- Use `createProviderFetch` with `openRouterPreprocessingMiddleware`.

#### [MODIFY] [openai-compatible.provider.ts](file:///ub/home/qduc/src/term2/source/providers/openai-compatible.provider.ts)
- Convert `createOpenAICompatibleFetch`, `createCacheControlFetch`, and `createOpenAIResponsesFetch` into standard middlewares or reuse them within composer-compatible middlewares.
- Replace usage of `createAiSdkLoggingFetch` with `createProviderFetch`.

#### [MODIFY] [codex.provider.ts](file:///ub/home/qduc/src/term2/source/providers/codex.provider.ts)
Extract Codex custom fetch logic into three self-contained middlewares in `codex.provider.ts`:
1. `codexSanitizeRequestMiddleware`: Sanitizes the request body (`sanitizeCodexRequestInit`).
2. `codexAuthMiddleware(tokenManager)`: Refreshes access tokens, lowercases headers, and injects the `authorization` and `chatgpt-account-id` headers.
3. `codexHeadersMiddleware(loggingService)`: Resolves `sessionId` dynamically via `loggingService.getTrafficContext()?.sessionId` and injects `originator`, `User-Agent`, and `session_id`.
Pass these middlewares to `createProviderFetch`.

### Tests

#### [NEW] [composer.test.ts](file:///ub/home/qduc/src/term2/source/providers/fetch/composer.test.ts)
- Verify `composeFetch` sequentially runs middlewares in correct order.
- Verify logging middleware correctly logs requests and responses (migrating standard logging tests).
- Verify dynamic header resolution is mockable and fetch implementation dependency injection works.

#### [DELETE] [ai-sdk-logging-fetch.test.ts](file:///ub/home/qduc/src/term2/source/providers/ai-sdk-logging-fetch.test.ts)
- Remove this file.

#### [MODIFY] [codex.provider.test.ts](file:///ub/home/qduc/src/term2/source/providers/codex.provider.test.ts)
- Update tests verifying custom headers and token refresh to run through the new composed fetch middleware chain.

#### [MODIFY] [openrouter.provider.request-preprocessing.test.ts](file:///ub/home/qduc/src/term2/source/providers/openrouter.provider.request-preprocessing.test.ts)
- Update request preprocessing tests to verify the converted middleware.

#### [MODIFY] [openai-compatible.provider.test.ts](file:///ub/home/qduc/src/term2/source/providers/openai-compatible.provider.test.ts)
- Update tests verifying custom headers, Opencode sessions, and reasoning controls to run through the new composed fetch middleware.

## Verification Plan

### Automated Tests
- Run composer tests:
  ```bash
  npm run test:verbose -- source/providers/fetch/composer.test.ts
  ```
- Run the provider-specific test suites:
  ```bash
  npx ava source/providers/codex.provider.test.ts \
           source/providers/openrouter.provider.request-preprocessing.test.ts \
           source/providers/openai-compatible.provider.test.ts
  ```
- Run the full test suite to check for regressions:
  ```bash
  npm test
  ```
