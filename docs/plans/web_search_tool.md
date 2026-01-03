# Web Search Tool Implementation Plan

## Overview

Add a `web_search` tool to the terminal-based AI assistant that uses the Tavily API for search functionality, with an architecture designed for easy provider swapping in the future.

---

## Architecture Design

### Provider Pattern

Following the existing provider pattern in `source/providers/`, we'll create a **web search provider registry** similar to the LLM provider registry. This ensures:

1. **Pluggable backends**: Tavily today, other providers (Serper, Brave, etc.) tomorrow
2. **Consistent interface**: All providers implement the same contract
3. **Configuration flexibility**: API keys and settings per provider

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    web_search tool                          │
│         (source/tools/web-search.ts)                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Web Search Provider Registry                   │
│       (source/providers/web-search/registry.ts)             │
├─────────────────────────────────────────────────────────────┤
│  - registerWebSearchProvider()                              │
│  - getWebSearchProvider()                                   │
│  - getDefaultWebSearchProvider()                            │
└─────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
    │    Tavily     │  │    Future     │  │    Future     │
    │   Provider    │  │   Provider    │  │   Provider    │
    └───────────────┘  └───────────────┘  └───────────────┘
```

---

## File Structure

### New Files to Create

```
source/
├── providers/
│   └── web-search/
│       ├── index.ts              # Re-exports registry + auto-register providers
│       ├── registry.ts           # WebSearchProvider registry
│       ├── types.ts              # Interfaces for web search providers
│       └── tavily.provider.ts    # Tavily implementation
└── tools/
    └── web-search.ts             # The web_search tool definition
    └── web-search.test.ts        # Tests for the tool
```

### Files to Modify

| File | Changes |
|------|---------|
| `source/agent.ts` | Add `createWebSearchToolDefinition` to tools list |
| `source/services/settings-service.ts` | Add web search settings schema (`webSearch.provider`, `webSearch.tavily.apiKey`) |
| `source/providers/index.ts` | Import web search providers for auto-registration |

---

## Detailed Implementation

### 1. Web Search Provider Types (`source/providers/web-search/types.ts`)

```typescript
/**
 * Result from a single web search result item
 */
export interface WebSearchResult {
    title: string;
    url: string;
    content: string;       // Snippet or extracted content
    score?: number;        // Relevance score if available
    publishedDate?: string;
}

/**
 * Response from a web search query
 */
export interface WebSearchResponse {
    query: string;
    results: WebSearchResult[];
    answerBox?: string;    // Direct answer if available (Tavily returns this)
}

/**
 * Interface that all web search providers must implement
 */
export interface WebSearchProvider {
    /** Unique identifier for the provider (e.g., 'tavily', 'serper') */
    id: string;

    /** Human-readable label for display */
    label: string;

    /**
     * Execute a web search query
     * @param query - The search query string
     * @param deps - Dependencies (settings service, logging service)
     * @returns Promise resolving to search results
     */
    search: (
        query: string,
        deps: { settingsService: any; loggingService: any }
    ) => Promise<WebSearchResponse>;

    /**
     * Check if the provider is properly configured (has API key, etc.)
     */
    isConfigured: (deps: { settingsService: any }) => boolean;

    /** Settings keys that are sensitive (API keys) */
    sensitiveSettingKeys?: string[];
}
```

### 2. Web Search Provider Registry (`source/providers/web-search/registry.ts`)

```typescript
import type { WebSearchProvider } from './types.js';

const providers = new Map<string, WebSearchProvider>();
let defaultProviderId: string | null = null;

/**
 * Register a web search provider
 */
export function registerWebSearchProvider(
    provider: WebSearchProvider,
    options?: { isDefault?: boolean }
): void {
    if (providers.has(provider.id)) {
        throw new Error(`Web search provider '${provider.id}' is already registered`);
    }
    providers.set(provider.id, provider);

    if (options?.isDefault || !defaultProviderId) {
        defaultProviderId = provider.id;
    }
}

/**
 * Get a specific web search provider by ID
 */
export function getWebSearchProvider(id: string): WebSearchProvider | undefined {
    return providers.get(id);
}

/**
 * Get the default web search provider
 */
export function getDefaultWebSearchProvider(): WebSearchProvider | undefined {
    return defaultProviderId ? providers.get(defaultProviderId) : undefined;
}

/**
 * Get all registered web search providers
 */
export function getAllWebSearchProviders(): WebSearchProvider[] {
    return Array.from(providers.values());
}

/**
 * Get the configured provider based on settings, falling back to default
 */
export function getConfiguredWebSearchProvider(
    deps: { settingsService: any }
): WebSearchProvider | undefined {
    const providerId = deps.settingsService.get('webSearch.provider');
    if (providerId) {
        const provider = getWebSearchProvider(providerId);
        if (provider) return provider;
    }
    return getDefaultWebSearchProvider();
}
```

### 3. Tavily Provider (`source/providers/web-search/tavily.provider.ts`)

```typescript
import { registerWebSearchProvider } from './registry.js';
import type { WebSearchProvider, WebSearchResponse, WebSearchResult } from './types.js';

/**
 * Tavily API response structure (relevant fields only)
 */
interface TavilyAPIResponse {
    query: string;
    answer?: string;
    results: Array<{
        title: string;
        url: string;
        content: string;
        score?: number;
        published_date?: string;
    }>;
}

const TAVILY_API_URL = 'https://api.tavily.com/search';

async function searchTavily(
    query: string,
    deps: { settingsService: any; loggingService: any }
): Promise<WebSearchResponse> {
    const { settingsService, loggingService } = deps;

    const apiKey = settingsService.get('webSearch.tavily.apiKey');
    if (!apiKey) {
        throw new Error(
            'Tavily API key is not configured. ' +
            'Set TAVILY_API_KEY environment variable or configure webSearch.tavily.apiKey.'
        );
    }

    loggingService.debug('Executing Tavily web search', { query });

    const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            api_key: apiKey,
            query: query,
            // Leave all other parameters at default values per requirements
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        loggingService.error('Tavily API error', {
            status: response.status,
            error: errorText
        });
        throw new Error(`Tavily API error (${response.status}): ${errorText}`);
    }

    const data: TavilyAPIResponse = await response.json();

    loggingService.debug('Tavily search completed', {
        resultCount: data.results?.length || 0,
        hasAnswer: !!data.answer
    });

    return {
        query: data.query,
        results: (data.results || []).map(r => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
            publishedDate: r.published_date,
        })),
        answerBox: data.answer,
    };
}

function isConfigured(deps: { settingsService: any }): boolean {
    const apiKey = deps.settingsService.get('webSearch.tavily.apiKey');
    return !!apiKey;
}

// Register the Tavily provider
registerWebSearchProvider({
    id: 'tavily',
    label: 'Tavily',
    search: searchTavily,
    isConfigured,
    sensitiveSettingKeys: ['webSearch.tavily.apiKey'],
}, { isDefault: true });
```

### 4. Web Search Provider Index (`source/providers/web-search/index.ts`)

```typescript
// Import provider modules to trigger registration
import './tavily.provider.js';

// Re-export registry API and types
export {
    registerWebSearchProvider,
    getWebSearchProvider,
    getDefaultWebSearchProvider,
    getAllWebSearchProviders,
    getConfiguredWebSearchProvider,
} from './registry.js';

export type {
    WebSearchProvider,
    WebSearchResponse,
    WebSearchResult,
} from './types.js';
```

### 5. Web Search Tool (`source/tools/web-search.ts`)

```typescript
import { z } from 'zod';
import type { ToolDefinition, CommandMessage } from './types.js';
import {
    getOutputText,
    normalizeToolArguments,
    createBaseMessage,
    getCallIdFromItem,
} from './format-helpers.js';
import {
    getConfiguredWebSearchProvider,
    type WebSearchResponse,
    type WebSearchResult,
} from '../providers/web-search/index.js';
import type {
    ISettingsService,
    ILoggingService,
} from '../services/service-interfaces.js';

const webSearchSchema = z.object({
    query: z.string().min(1).describe('The search query to look up on the web.'),
});

export type WebSearchParams = z.infer<typeof webSearchSchema>;

/**
 * Convert Tavily/web search results to a markdown-formatted string
 */
function formatResultsAsMarkdown(response: WebSearchResponse): string {
    const parts: string[] = [];

    // Add answer box if available (Tavily's synthesized answer)
    if (response.answerBox) {
        parts.push('## Answer\n');
        parts.push(response.answerBox);
        parts.push('\n');
    }

    // Add search results
    if (response.results.length > 0) {
        parts.push('## Search Results\n');

        response.results.forEach((result, index) => {
            parts.push(`### ${index + 1}. ${result.title}\n`);
            parts.push(`**URL:** ${result.url}\n`);
            if (result.publishedDate) {
                parts.push(`**Published:** ${result.publishedDate}\n`);
            }
            parts.push(`\n${result.content}\n`);
            parts.push('\n---\n');
        });
    } else {
        parts.push('No results found for this query.\n');
    }

    return parts.join('\n');
}

/**
 * Format command message for display in the terminal
 */
export const formatWebSearchCommandMessage = (
    item: any,
    index: number,
    toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
    const callId = getCallIdFromItem(item);
    const fallbackArgs =
        callId && toolCallArgumentsById.has(callId)
            ? toolCallArgumentsById.get(callId)
            : null;
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args =
        normalizeToolArguments(normalizedArgs) ??
        normalizeToolArguments(fallbackArgs) ??
        {};

    const query = args?.query ?? 'unknown query';
    const command = `web_search: "${query}"`;
    const output = getOutputText(item) || 'No results';
    const success = !output.startsWith('Error:');

    return [
        createBaseMessage(item, index, 0, false, {
            command,
            output,
            success,
            toolName: 'web_search',
            toolArgs: args,
        }),
    ];
};

/**
 * Factory function to create the web_search tool definition
 */
export const createWebSearchToolDefinition = (deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
}): ToolDefinition<WebSearchParams> => {
    const { settingsService, loggingService } = deps;

    return {
        name: 'web_search',
        description:
            'Search the web for current information. Use this when you need up-to-date information ' +
            'that may not be in your training data, such as recent news, current events, ' +
            'documentation updates, or any time-sensitive information.',
        parameters: webSearchSchema,
        needsApproval: () => false, // Web search is read-only, safe operation
        execute: async (params) => {
            const { query } = params;

            try {
                const provider = getConfiguredWebSearchProvider({ settingsService });

                if (!provider) {
                    return 'Error: No web search provider is configured.';
                }

                if (!provider.isConfigured({ settingsService })) {
                    return `Error: Web search provider '${provider.id}' is not properly configured. ` +
                           `Please set the required API key.`;
                }

                const response = await provider.search(query, {
                    settingsService,
                    loggingService,
                });

                return formatResultsAsMarkdown(response);
            } catch (error: any) {
                loggingService.error('Web search failed', {
                    query,
                    error: error.message || String(error),
                });
                return `Error: ${error.message || String(error)}`;
            }
        },
        formatCommandMessage: formatWebSearchCommandMessage,
    };
};
```

---

## Changes to Existing Files

### 6. Update Agent Definition (`source/agent.ts`)

Add import at the top:
```typescript
import { createWebSearchToolDefinition } from './tools/web-search.js';
```

Add to the tools array in `getAgentDefinition()` (around line 140-180):

```typescript
// Add web search tool (available in all modes except lite)
if (!liteMode) {
    tools.push(
        createWebSearchToolDefinition({
            settingsService,
            loggingService,
        })
    );
}
```

**Note:** This is our custom implementation. The SDK's `webSearchTool()` (currently used in `openai-agent-client.ts`) is a hosted tool that runs on OpenAI's servers. Our custom tool runs locally and uses Tavily, giving us:
- Control over the search provider
- Proper display formatting via `formatCommandMessage`
- Ability to work with any LLM provider, not just OpenAI

We should **remove or conditionally disable** the SDK's `webSearchTool()` in `openai-agent-client.ts` (around line 816-825) when our custom tool is active, or keep both and let the model choose.

### 7. Update Settings Service (`source/services/settings-service.ts`)

Add to the settings schema (around line 100-150, with other schema definitions):

```typescript
const webSearchSettingsSchema = z.object({
    provider: z.string().optional(),
    tavily: z.object({
        apiKey: z.string().optional(),
    }).optional(),
});
```

Add to `SettingsData` type and `DEFAULT_SETTINGS`:

```typescript
// In SettingsData type
webSearch: {
    provider?: string;
    tavily: {
        apiKey?: string;
    };
};

// In DEFAULT_SETTINGS
webSearch: {
    provider: 'tavily',
    tavily: {},
},
```

Add to `SETTING_KEYS`:
```typescript
WEB_SEARCH_PROVIDER: 'webSearch.provider',
WEB_SEARCH_TAVILY_API_KEY: 'webSearch.tavily.apiKey',
```

Add to `buildEnvOverrides()` function:
```typescript
const webSearch: any = {};
if (env.TAVILY_API_KEY) {
    webSearch.tavily = { apiKey: env.TAVILY_API_KEY };
}
if (env.WEB_SEARCH_PROVIDER) {
    webSearch.provider = env.WEB_SEARCH_PROVIDER;
}

// Include in return object
return {
    // ...existing fields
    webSearch,
};
```

### 8. Update Providers Index (`source/providers/index.ts`)

Add import to register web search providers:

```typescript
// Import web search provider registration
import './web-search/index.js';
```

---

## Implementation Steps (In Order)

### Phase 1: Infrastructure (Core Types & Registry)
1. Create `source/providers/web-search/types.ts` - Define interfaces
2. Create `source/providers/web-search/registry.ts` - Registry implementation
3. Create `source/providers/web-search/index.ts` - Export aggregation

### Phase 2: Tavily Provider
4. Create `source/providers/web-search/tavily.provider.ts` - Tavily implementation
5. Update `source/providers/index.ts` - Import web search module

### Phase 3: Settings Integration
6. Update `source/services/settings-service.ts`:
   - Add schema for webSearch settings
   - Add to DEFAULT_SETTINGS
   - Add to SETTING_KEYS
   - Update `buildEnvOverrides()` for TAVILY_API_KEY

### Phase 4: Tool Implementation
7. Create `source/tools/web-search.ts` - Tool definition with markdown formatting
8. Update `source/agent.ts` - Add tool to agent's tool list

### Phase 5: SDK Tool Integration Decision
9. Decide on SDK `webSearchTool()` usage in `source/lib/openai-agent-client.ts`:
   - Option A: Remove SDK tool, use only custom tool (recommended for consistency)
   - Option B: Keep SDK tool for OpenAI provider, use custom for others
   - Option C: Keep both and let model choose

### Phase 6: Testing
10. Create `source/tools/web-search.test.ts`
11. Create `source/providers/web-search/registry.test.ts`
12. Create `source/providers/web-search/tavily.provider.test.ts`

---

## Testing Considerations

### Unit Tests

**Registry Tests (`source/providers/web-search/registry.test.ts`):**
```typescript
- registerWebSearchProvider registers a provider
- registerWebSearchProvider throws on duplicate ID
- getWebSearchProvider returns registered provider
- getWebSearchProvider returns undefined for unknown ID
- getDefaultWebSearchProvider returns first registered provider
- getConfiguredWebSearchProvider uses settings preference
- getConfiguredWebSearchProvider falls back to default
```

**Tavily Provider Tests (`source/providers/web-search/tavily.provider.test.ts`):**
```typescript
- isConfigured returns true when API key is set
- isConfigured returns false when API key is missing
- search throws error when API key is missing
- search makes correct API request
- search handles API errors gracefully
- search transforms response correctly
```

**Tool Tests (`source/tools/web-search.test.ts`):**
```typescript
- createWebSearchToolDefinition defines tool correctly
- needsApproval returns false (read-only operation)
- execute returns error when provider not configured
- execute returns formatted markdown on success
- execute handles provider errors gracefully
- formatResultsAsMarkdown formats results correctly
- formatResultsAsMarkdown handles empty results
- formatResultsAsMarkdown includes answer box when available
- formatWebSearchCommandMessage extracts query correctly
```

### Integration Tests

1. **End-to-end with mock Tavily API** - Verify full flow
2. **Provider switching** - Verify settings-based provider selection
3. **Error handling** - Network failures, API errors, rate limits

### Manual Testing Checklist

- [ ] Set `TAVILY_API_KEY` environment variable
- [ ] Run assistant and invoke web search via natural language
- [ ] Verify markdown output displays correctly
- [ ] Test without API key - verify error message
- [ ] Test with invalid API key - verify error handling

---

## Configuration & Environment Setup

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TAVILY_API_KEY` | API key from Tavily | Yes (for Tavily provider) |
| `WEB_SEARCH_PROVIDER` | Override default provider (e.g., 'tavily') | No |

### Getting a Tavily API Key

1. Go to https://tavily.com/
2. Sign up for an account
3. Navigate to API Keys section
4. Create a new API key
5. Set as environment variable: `export TAVILY_API_KEY=tvly-xxxxx`

### Configuration File (Optional)

Users can also configure via `~/.config/term2/settings.json`:

```json
{
    "webSearch": {
        "provider": "tavily",
        "tavily": {
            "apiKey": "tvly-xxxxx"
        }
    }
}
```

**Note:** Storing API keys in config files is discouraged. Environment variables are the recommended approach for sensitive credentials.

---

## Future Provider Implementation Guide

To add a new web search provider (e.g., Serper, Brave Search):

1. Create `source/providers/web-search/serper.provider.ts`:

```typescript
import { registerWebSearchProvider } from './registry.js';
import type { WebSearchProvider, WebSearchResponse } from './types.js';

async function searchSerper(
    query: string,
    deps: { settingsService: any; loggingService: any }
): Promise<WebSearchResponse> {
    // Implementation...
}

registerWebSearchProvider({
    id: 'serper',
    label: 'Serper',
    search: searchSerper,
    isConfigured: (deps) => !!deps.settingsService.get('webSearch.serper.apiKey'),
    sensitiveSettingKeys: ['webSearch.serper.apiKey'],
});
```

2. Add import to `source/providers/web-search/index.ts`:
```typescript
import './serper.provider.js';
```

3. Update settings schema for new provider's API key.

4. Update environment variable support in `buildEnvOverrides()`.

---

## Potential Challenges & Mitigations

### 1. API Rate Limits
- **Challenge:** Tavily may rate limit requests
- **Mitigation:** Return clear error messages; consider implementing retry with backoff

### 2. Response Size
- **Challenge:** Large search results may overwhelm context
- **Mitigation:** Limit result count or truncate content per result

### 3. Network Failures
- **Challenge:** Tavily API may be unreachable
- **Mitigation:** Proper error handling with informative messages

### 4. SDK webSearchTool Conflict
- **Challenge:** Two web search tools may confuse the model
- **Mitigation:** Remove SDK tool or use conditional logic based on provider

---

## Critical Files for Implementation

1. [source/providers/web-search/types.ts](source/providers/web-search/types.ts) - Core interfaces that all providers must implement
2. [source/providers/web-search/tavily.provider.ts](source/providers/web-search/tavily.provider.ts) - Primary provider implementation with Tavily API integration
3. [source/tools/web-search.ts](source/tools/web-search.ts) - Tool definition with markdown formatting
4. [source/agent.ts](source/agent.ts) - Integration point to add tool to agent's toolkit
5. [source/services/settings-service.ts](source/services/settings-service.ts) - Settings schema and environment variable support for API keys
